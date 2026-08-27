"""认证：密码哈希、会话令牌、代码注册用户、登录依赖。

用户不开放注册。账号在项目根目录 product_rules.json 的 accounts 中维护
（用于数据库初始化，重启自动同步），默认 admin1 / admin1。新增业务员示例：
    {"username": "xiaowan", "password": "123456", "name": "小万", "role": "user"},
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

from .database import DATA_DIR, get_db
from .models import User

COOKIE_NAME = "erp_token"
TOKEN_MAX_AGE = 60 * 60 * 24 * 7  # 7 天

ROOT = Path(__file__).resolve().parent.parent
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


def make_token(user_id: int) -> str:
    payload = {"uid": user_id, "exp": int(time.time()) + TOKEN_MAX_AGE}
    raw = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    sig = hmac.new(_SECRET, raw.encode(), hashlib.sha256).hexdigest()
    return f"{raw}.{sig}"


def verify_token(token: str) -> int | None:
    try:
        raw, sig = token.split(".")
        expect = hmac.new(_SECRET, raw.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expect):
            return None
        payload = json.loads(base64.urlsafe_b64decode(raw.encode()))
        if payload["exp"] < time.time():
            return None
        return int(payload["uid"])
    except Exception:
        return None


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


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get(COOKIE_NAME)
    uid = verify_token(token) if token else None
    if not uid:
        raise HTTPException(401, "未登录")
    user = db.get(User, uid)
    if not user or not user.is_active:
        raise HTTPException(401, "账号不可用")
    return user
