"""认证：会话令牌、SSH 指纹（Ed25519 私钥）登录。

- 所有用户（含管理员）一律使用私钥文件登录：服务器保存公钥指纹，登录时由私钥推导公钥并比对指纹。
- 账号与私钥的生成/管理在独立的「私钥管理工具」中完成（项目根 keyadmin.py，单独端口/启动脚本），
  不开放注册；本模块不处理密码登录。
- 种子账号 admin1 的密码仅用于私钥管理工具的访问门禁（见 keyadmin），不用于 ERP 登录。
"""
import base64
import hashlib
import hmac
import json
import secrets
import time
from pathlib import Path

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import DATA_DIR, get_user_db
from .models import User

COOKIE_NAME = "erp_token"
TOKEN_MAX_AGE = 60 * 60 * 24 * 7  # 7 天

ROOT = Path(__file__).resolve().parent.parent.parent
CONFIG_FILE = ROOT / "product_rules.json"

# 兜底账号（配置文件缺失/无 accounts 时使用）
_FALLBACK_USERS = [
    {"username": "admin1", "password": "admin1", "name": "管理员", "role": "admin"},
]


def _load_seed_users() -> list[dict]:
    """从 product_rules.json 读取账号配置，用于数据库初始化。"""
    try:
        cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        accs = cfg.get("accounts") or []
        return [
            {
                "username": str(a.get("username", "")).strip(),
                "password": str(a.get("password", "")),
                "name": str(a.get("name", "")).strip(),
                "role": str(a.get("role", "user")).strip() or "user",
            }
            for a in accs
            if a.get("username")
        ]
    except Exception:
        return _FALLBACK_USERS


SEED_USERS = _load_seed_users()

SECRET_FILE = DATA_DIR / ".secret"


def _get_secret() -> bytes:
    if not SECRET_FILE.exists():
        SECRET_FILE.write_bytes(secrets.token_bytes(32))
    return SECRET_FILE.read_bytes()


_SECRET = _get_secret()


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000).hex()
    return f"{salt}${dk}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, dk = stored.split("$", 1)
    except ValueError:
        return False
    return hmac.compare_digest(hash_password(password, salt), stored)


def make_token(user_id: int, warehouse: str | None = None) -> str:
    """签发会话令牌。

    payload.wh = 该会话所属分仓（登录时取默认分仓；切仓时重签一份即可，无需重新登录）。
    分仓只写在令牌里，服务端不再维护"全局当前分仓"，因此谁的会话属于哪个仓互不影响。
    """
    from .database import get_current_key

    payload = {
        "uid": user_id,
        "wh": warehouse or get_current_key(),
        "exp": int(time.time()) + TOKEN_MAX_AGE,
    }
    # 去掉 base64 的 "=" 填充：令牌里就不会出现 "="，cookie 值无需被加引号包裹，
    # 避免个别浏览器/代理对引号处理不一致导致取不到令牌（老令牌带填充仍可解析）。
    raw = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    sig = hmac.new(_SECRET, raw.encode(), hashlib.sha256).hexdigest()
    return f"{raw}.{sig}"


def decode_token(token: str | None) -> dict | None:
    """校验签名与有效期，返回 payload（含 uid / wh）；非法或过期返回 None。

    注意：**不再**拿 payload.wh 去和某个全局"当前仓"比对——那样任何一次切仓都会让所有
    旧令牌失效（历史 bug：一人切仓，全员被登出）。
    """
    if not token:
        return None
    try:
        raw, sig = token.split(".")
        expect = hmac.new(_SECRET, raw.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expect):
            return None
        # 兼容两种编码：新版无 "=" 填充，历史令牌带填充（补足到 4 的倍数即可）
        payload = json.loads(base64.urlsafe_b64decode((raw + "=" * (-len(raw) % 4)).encode()))
        if payload["exp"] < time.time():
            return None
        if not payload.get("uid"):
            return None
        return payload
    except Exception:
        return None


def token_warehouse(token: str | None) -> str | None:
    """令牌所属分仓；旧令牌无 wh 字段视为默认仓。

    分仓已不在注册表里时返回 None（由调用方回退默认仓），避免用废弃 key 建出野库。
    """
    from .database import DEFAULT_WAREHOUSE_KEY, key_exists

    payload = decode_token(token)
    if not payload:
        return None
    wh = payload.get("wh") or DEFAULT_WAREHOUSE_KEY
    return wh if key_exists(wh) else None


def verify_token(token: str | None) -> int | None:
    """兼容旧调用：返回令牌对应的用户 id（不再做分仓比对）。"""
    payload = decode_token(token)
    return int(payload["uid"]) if payload else None


def ensure_seed_users(db: Session) -> None:
    for u in SEED_USERS:
        user = db.scalar(select(User).where(User.username == u["username"]))
        if user:
            if not verify_password(u["password"], user.password_hash):
                user.password_hash = hash_password(u["password"])
            user.name = u["name"]
            user.role = u["role"]
            user.is_active = True
        else:
            db.add(
                User(
                    username=u["username"],
                    password_hash=hash_password(u["password"]),
                    name=u["name"],
                    role=u["role"],
                )
            )
    db.commit()


def get_current_user(request: Request, db: Session = Depends(get_user_db)) -> User:
    """当前登录用户。

    账号注册表（用户/私钥/角色）固定在默认仓，由 keyadmin 维护：业务数据按会话分仓隔离，
    但"你是谁"必须与当前分仓无关，否则切到某仓发现该仓没有此账号就会被判 401 掉线。
    """
    payload = decode_token(request.cookies.get(COOKIE_NAME))
    if not payload:
        raise HTTPException(401, "未登录")
    user = db.get(User, int(payload["uid"]))
    if not user or not user.is_active:
        raise HTTPException(401, "账号不可用")
    return user
