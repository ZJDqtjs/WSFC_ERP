"""私钥管理工具：独立的登录密钥生成与账号管理后台。

- 单独端口、单独启动脚本（项目根 keyadmin.py），不随 ERP 一起启动。
- 打开即进入管理界面；首次使用需输入管理员密码（product_rules.json 中 accounts 的管理员密码，默认 admin1/admin1）。
- 复用 ERP 的用户表与密钥算法；私钥生成/重新生成时仅一次返回。
"""
import base64
import hashlib
import hmac
import json
import secrets
import sqlite3
import time
from datetime import datetime
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import ensure_seed_users, verify_password
from app.routers.backup import _list_backups, _safe_path, create_backup_file
from app.database import DATA_DIR, DB_PATH, DEFAULT_WAREHOUSE_KEY, get_db_default as get_db
from app.keys import generate_keypair
from app.models import User

STATIC_DIR = Path(__file__).resolve().parent / "static"

COOKIE = "keyadmin_token"
SESSION_MAX_AGE = 60 * 60 * 12  # 12 小时
SECRET_FILE = DATA_DIR / ".keyadmin_secret"


def _secret() -> bytes:
    if not SECRET_FILE.exists():
        SECRET_FILE.write_bytes(secrets.token_bytes(32))
    return SECRET_FILE.read_bytes()


def _make_token() -> str:
    payload = {"exp": int(time.time()) + SESSION_MAX_AGE}
    raw = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    sig = hmac.new(_secret(), raw.encode(), hashlib.sha256).hexdigest()
    return f"{raw}.{sig}"


def _verify_token(token: str | None) -> bool:
    if not token:
        return False
    try:
        raw, sig = token.split(".")
        expect = hmac.new(_secret(), raw.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expect):
            return False
        return json.loads(base64.urlsafe_b64decode(raw.encode()))["exp"] > time.time()
    except Exception:
        return False


app = FastAPI(title="私钥管理工具")


def _admin_password_ok(db: Session, password: str) -> bool:
    """任一管理员账号密码匹配即通过门禁。"""
    admins = db.scalars(select(User).where(User.role == "admin")).all()
    return any(a.password_hash and verify_password(password, a.password_hash) for a in admins)


def _require(request: Request, db: Session = Depends(get_db)):
    if not _verify_token(request.cookies.get(COOKIE)):
        raise HTTPException(401, "未验证")
    return True


class LoginIn(BaseModel):
    password: str


class UserCreate(BaseModel):
    username: str
    name: str = ""
    role: str = "user"


class UserUpdate(BaseModel):
    name: str | None = None
    role: str | None = None


def _serialize(u: User) -> dict:
    return {
        "id": u.id,
        "username": u.username,
        "name": u.name,
        "role": u.role,
        "is_active": u.is_active,
        "fingerprint": u.fingerprint,
        "has_key": bool(u.fingerprint),
        "key_created_at": u.key_created_at.isoformat() if u.key_created_at else None,
        "created_at": u.created_at.isoformat() if u.created_at else None,
    }


@app.post("/api/login")
def login(data: LoginIn, response: Response, db: Session = Depends(get_db)):
    if not _admin_password_ok(db, data.password):
        raise HTTPException(401, "管理密码错误")
    response.set_cookie(
        COOKIE, _make_token(), max_age=SESSION_MAX_AGE, httponly=True, path="/", samesite="lax"
    )
    return {"ok": True}


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@app.get("/api/session")
def session(request: Request):
    return {"authed": _verify_token(request.cookies.get(COOKIE))}


@app.get("/api/users")
def list_users(db: Session = Depends(get_db), _: bool = Depends(_require)):
    users = db.scalars(select(User).order_by(User.id)).all()
    return [_serialize(u) for u in users]


@app.post("/api/keys")
def create_user_with_key(
    data: UserCreate, db: Session = Depends(get_db), _: bool = Depends(_require)
):
    """输入用户名生成 Ed25519 私钥：创建用户并保存公钥指纹，私钥仅此一次返回。"""
    username = data.username.strip()
    if not username:
        raise HTTPException(400, "用户名不能为空")
    if db.scalar(select(User).where(User.username == username)):
        raise HTTPException(400, "用户名已存在，如需更换私钥请使用「重新生成」")

    private_pem, public_ssh, fp = generate_keypair()
    user = User(
        username=username,
        name=data.name.strip(),
        role=data.role if data.role in ("admin", "user") else "user",
        public_key=public_ssh,
        fingerprint=fp,
        key_created_at=datetime.now(),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {
        "user": _serialize(user),
        "private_key": private_pem,
        "public_key": public_ssh,
        "fingerprint": fp,
    }


@app.put("/api/users/{user_id}")
def update_user(
    user_id: int,
    data: UserUpdate,
    db: Session = Depends(get_db),
    _: bool = Depends(_require),
):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "用户不存在")
    if data.name is not None:
        user.name = data.name.strip()
    if data.role is not None:
        user.role = data.role if data.role in ("admin", "user") else user.role
    db.commit()
    return {"user": _serialize(user)}


@app.post("/api/users/{user_id}/regenerate")
def regenerate_key(
    user_id: int,
    db: Session = Depends(get_db),
    _: bool = Depends(_require),
):
    """重新生成密钥：旧私钥立即失效，新私钥仅此一次返回。"""
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "用户不存在")
    private_pem, public_ssh, fp = generate_keypair()
    user.public_key = public_ssh
    user.fingerprint = fp
    user.key_created_at = datetime.now()
    db.commit()
    db.refresh(user)
    return {
        "user": _serialize(user),
        "private_key": private_pem,
        "public_key": public_ssh,
        "fingerprint": fp,
    }


@app.delete("/api/users/{user_id}")
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    _: bool = Depends(_require),
):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "用户不存在")
    db.delete(user)
    db.commit()
    return {"ok": True}


# ============================================================
#  备份与应急抢救（后门）：ERP 主进程登录失效 / 数据异常时，
#  可在本私钥管理后台直接备份 / 恢复数据库，或重置初始管理员登录私钥。
# ============================================================
class RestoreBackupIn(BaseModel):
    name: str


@app.get("/api/backups")
def rescue_list_backups(_: bool = Depends(_require)):
    return {"backups": _list_backups(DEFAULT_WAREHOUSE_KEY)}


@app.post("/api/backup")
def rescue_create_backup(_: bool = Depends(_require)):
    name = create_backup_file(DEFAULT_WAREHOUSE_KEY)
    return {"ok": True, "name": name, "backups": _list_backups(DEFAULT_WAREHOUSE_KEY)}


@app.post("/api/backup/restore")
def rescue_restore_backup(data: RestoreBackupIn, _: bool = Depends(_require)):
    """用备份文件覆盖当前数据库（含 WAL 一致性）。恢复后旧登录令牌失效，需重新登录。"""
    src_path = _safe_path(data.name)
    if not src_path.exists():
        raise HTTPException(404, "备份文件不存在")
    src = sqlite3.connect(str(src_path))
    dst = sqlite3.connect(str(DB_PATH))
    try:
        src.backup(dst)
    except Exception as e:
        raise HTTPException(500, f"恢复失败：{e}")
    finally:
        dst.close()
        src.close()
    return {"ok": True, "restored": data.name, "backups": _list_backups()}


@app.delete("/api/backup/{name}")
def rescue_delete_backup(name: str, _: bool = Depends(_require)):
    src_path = _safe_path(name)
    if not src_path.exists():
        raise HTTPException(404, "备份文件不存在")
    src_path.unlink()
    return {"ok": True, "backups": _list_backups()}


@app.post("/api/rescue/reset-admin")
def rescue_reset_admin(db: Session = Depends(get_db), _: bool = Depends(_require)):
    """应急重置：确保初始管理员（product_rules.json accounts）恢复默认密码，并为其重新生成 ERP 登录私钥。"""
    ensure_seed_users(db)  # 恢复初始管理员的进入密码（keyadmin 门禁）
    from app.auth import SEED_USERS

    items = []
    for s in SEED_USERS:
        u = db.scalar(select(User).where(User.username == s["username"]))
        if not u:
            continue
        private_pem, public_ssh, fp = generate_keypair()
        u.public_key = public_ssh
        u.fingerprint = fp
        u.key_created_at = datetime.now()
        u.is_active = True
        items.append(
            {"username": u.username, "name": u.name, "private_key": private_pem, "fingerprint": fp}
        )
    db.commit()
    return {
        "ok": True,
        "note": "已重置初始管理员密码并重新生成 ERP 登录私钥（旧私钥已失效），请立即下载保存",
        "items": items,
    }


app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="keyadmin_static")
