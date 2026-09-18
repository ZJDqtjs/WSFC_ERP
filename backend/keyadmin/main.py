"""私钥管理工具：独立的登录密钥生成与账号管理后台。

- 单独端口、单独启动脚本（项目根 keyadmin.py），不随 ERP 一起启动。
- 打开即进入管理界面；首次使用需输入「管理员账号 + 密码」，校验来源见 _admin_password_ok，
  并对来源 IP 做失败限流，避免被在线爆破。
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

from app import login_guard as guard
from app import maintenance as mt
from app.auth import ensure_seed_users, verify_password
from app.clear_data import (
    CLEAR_ITEMS,
    all_item_keys,
    execute as clear_execute,
    preview as clear_preview,
    warehouse_choices,
)
from app.config import seed_accounts
from app.routers.backup import _list_backups, _safe_path, create_backup_file
from app.database import (
    DATA_DIR, DB_PATH, DEFAULT_WAREHOUSE_KEY, get_db_default as get_db,
    get_sessionmaker, get_warehouses,
)
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


# ---------- 门禁：账号 + 口令 ----------
# 口令来源有优先级（都要求账号名对得上）：
#   1) 只要 config.local.json 的 accounts 里写了 role=admin 的账号，就**以配置为唯一依据**，
#      库里残留的旧口令不再是一把备用钥匙（否则改了配置、库里旧口令仍能登录）；
#   2) 配置里一个管理员都没写时，才回退到库里 role=admin 且已设口令的账号
#      —— 老部署/配置为空时不会把自己锁在门外。
# 失败分级锁定（3 次→等 1 分钟、再 3 次→3 分钟……）统一由 app/login_guard.py 提供，
# 与业务主系统共用同一份状态文件，因此可以在这里直接解锁主系统被锁的账号。
def _admin_password_ok(db: Session, username: str, password: str) -> bool:
    """门禁校验：账号 + 口令（口令来源与优先级见上方注释）。"""
    username = (username or "").strip()
    if not username or not password:
        return False

    # 1) 配置里写了管理员 => 只认配置
    admins = [a for a in seed_accounts() if a.get("role") == "admin" and a.get("password")]
    if admins:
        return any(
            a["username"] == username and hmac.compare_digest(a["password"], password)
            for a in admins
        )

    # 2) 配置里没写管理员 => 兼容回退到库里已有口令的管理员
    user = db.scalar(select(User).where(User.username == username))
    if user and user.role == "admin" and user.password_hash:
        return verify_password(password, user.password_hash)
    return False


def _require(request: Request, db: Session = Depends(get_db)):
    if not _verify_token(request.cookies.get(COOKIE)):
        raise HTTPException(401, "未验证")
    return True


def _other_keys() -> list[str]:
    """默认仓以外的所有分仓 key（keyadmin 钉死操作默认仓，账号需同步到其他分仓）。"""
    return [w["key"] for w in get_warehouses() if w["key"] != DEFAULT_WAREHOUSE_KEY]


def sync_users_to_all() -> int:
    """把默认仓（奥斯迪）的全部用户同步到其他分仓：不存在则创建，存在则更新。

    供「同步到各分仓」按钮使用；返回同步的分仓数。
    """
    src = get_sessionmaker(DEFAULT_WAREHOUSE_KEY)()
    try:
        users = src.scalars(select(User).order_by(User.id)).all()
    finally:
        src.close()
    synced = 0
    for key in _other_keys():
        dst = get_sessionmaker(key)()
        try:
            existing = {u.username: u for u in dst.scalars(select(User)).all()}
            for u in users:
                e = existing.get(u.username)
                if e is None:
                    dst.add(User(
                        username=u.username, password_hash=u.password_hash,
                        name=u.name, role=u.role, public_key=u.public_key,
                        fingerprint=u.fingerprint, key_created_at=u.key_created_at,
                        is_active=u.is_active,
                    ))
                else:
                    e.name, e.role = u.name, u.role
                    e.is_active = u.is_active
                    if u.fingerprint:          # 默认仓有密钥才覆盖，避免误清目标仓密钥
                        e.public_key = u.public_key
                        e.fingerprint = u.fingerprint
                        e.key_created_at = u.key_created_at
            dst.commit()
            synced += 1
        finally:
            dst.close()
    return synced


class LoginIn(BaseModel):
    username: str
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
    """门禁登录；连续失败按 app/login_guard.py 的分级规则锁定该账号。"""
    username = (data.username or "").strip()
    if username:
        left = guard.locked_left(guard.SCOPE_KEYADMIN, username)
        if left:
            raise HTTPException(429, f"账号已锁定，请 {guard.humanize(left)} 后再试")

    if not _admin_password_ok(db, username, data.password):
        wait = guard.record_fail(guard.SCOPE_KEYADMIN, username) if username else 0
        if wait:
            raise HTTPException(
                429,
                f"连续失败次数过多，账号已锁定 {guard.humanize(wait)}，请稍后再试",
            )
        raise HTTPException(401, "账号或密码错误")

    guard.reset(guard.SCOPE_KEYADMIN, username)
    response.set_cookie(
        COOKIE, _make_token(), max_age=SESSION_MAX_AGE, httponly=True, path="/", samesite="lax"
    )
    return {"ok": True}


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


class UnlockIn(BaseModel):
    username: str = ""
    scope: str = guard.SCOPE_KEYADMIN   # keyadmin | erp


@app.get("/api/locks")
def locks(_: bool = Depends(_require)):
    """当前处于登录锁定状态的账号（本工具 / 业务主系统）。"""
    return {
        guard.SCOPE_KEYADMIN: guard.locked_list(guard.SCOPE_KEYADMIN),
        guard.SCOPE_ERP: guard.locked_list(guard.SCOPE_ERP),
    }


@app.post("/api/unlock")
def unlock(data: UnlockIn, _: bool = Depends(_require)):
    """手动解除登录锁定：用户名留空 = 清空该系统全部锁定。"""
    scope = guard.SCOPE_ERP if data.scope == guard.SCOPE_ERP else guard.SCOPE_KEYADMIN
    cleared = guard.clear(scope, data.username.strip())
    return {"ok": True, "scope": scope, "cleared": cleared}


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
    # 同步到其他分仓（同账号同一私钥可登录各仓）
    for key in _other_keys():
        s = get_sessionmaker(key)()
        try:
            if s.scalar(select(User).where(User.username == username)):
                continue
            s.add(User(
                username=username,
                name=data.name.strip(),
                role=user.role,
                public_key=public_ssh,
                fingerprint=fp,
                key_created_at=user.key_created_at,
            ))
            s.commit()
        finally:
            s.close()
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
    # 同步姓名/角色到其他分仓
    for key in _other_keys():
        s = get_sessionmaker(key)()
        try:
            u = s.scalar(select(User).where(User.username == user.username))
            if u:
                if data.name is not None:
                    u.name = data.name.strip()
                if data.role is not None:
                    u.role = data.role if data.role in ("admin", "user") else u.role
                s.commit()
        finally:
            s.close()
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
    # 同步新私钥到其他分仓（旧私钥在各仓同时失效）
    for key in _other_keys():
        s = get_sessionmaker(key)()
        try:
            u = s.scalar(select(User).where(User.username == user.username))
            if u:
                u.public_key = public_ssh
                u.fingerprint = fp
                u.key_created_at = user.key_created_at
                s.commit()
        finally:
            s.close()
    return {
        "user": _serialize(user),
        "private_key": private_pem,
        "public_key": public_ssh,
        "fingerprint": fp,
    }


@app.post("/api/users/sync")
def sync_users(_: bool = Depends(_require)):
    """把默认仓（奥斯迪）的全部账号/私钥同步到其他分仓。"""
    n = sync_users_to_all()
    return {"ok": True, "synced": n, "note": f"已将默认仓账号同步到 {n} 个分仓"}


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
    # 同步删除其他分仓的同名账号
    for key in _other_keys():
        s = get_sessionmaker(key)()
        try:
            u = s.scalar(select(User).where(User.username == user.username))
            if u:
                s.delete(u)
                s.commit()
        finally:
            s.close()
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
    """应急重置：确保初始管理员（product_rules.json accounts）恢复默认密码，并为其重新生成 ERP 登录私钥。

    同一把私钥写入所有分仓，保证初始管理员可登录任意分仓。
    """
    from app.auth import SEED_USERS

    all_keys = [DEFAULT_WAREHOUSE_KEY] + _other_keys()
    # 先确保各分仓种子账号存在并恢复默认密码
    for key in all_keys:
        s = get_sessionmaker(key)()
        try:
            ensure_seed_users(s)
            s.commit()
        finally:
            s.close()

    items = []
    for seed in SEED_USERS:
        private_pem, public_ssh, fp = generate_keypair()
        for key in all_keys:
            s = get_sessionmaker(key)()
            try:
                u = s.scalar(select(User).where(User.username == seed["username"]))
                if not u:
                    continue
                u.public_key = public_ssh
                u.fingerprint = fp
                u.key_created_at = datetime.now()
                u.is_active = True
                s.commit()
            finally:
                s.close()
        items.append(
            {"username": seed["username"], "name": seed["name"], "private_key": private_pem, "fingerprint": fp}
        )
    return {
        "ok": True,
        "note": "已重置初始管理员密码并重新生成 ERP 登录私钥（旧私钥已失效，同一私钥可用于所有分仓），请立即下载保存",
        "items": items,
    }


# ============================================================
#  数据清理：按分仓、按类别细化清除业务数据（原 clear_stock.py 功能）
# ============================================================
class ClearIn(BaseModel):
    key: str = DEFAULT_WAREHOUSE_KEY
    items: list[str] = []
    backup: bool = True


@app.get("/api/clear/warehouses")
def clear_warehouses(_: bool = Depends(_require)):
    """可选分仓列表。"""
    return {"warehouses": warehouse_choices()}


@app.get("/api/clear/items")
def clear_items(key: str = DEFAULT_WAREHOUSE_KEY, _: bool = Depends(_require)):
    """指定分仓各清除类别的当前行数。"""
    try:
        return clear_preview(key)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/clear/categories")
def clear_categories(_: bool = Depends(_require)):
    """清除类别说明（静态）。"""
    return {
        "items": [
            {"key": it["key"], "name": it["name"], "desc": it["desc"]}
            for it in CLEAR_ITEMS
        ],
        "all": all_item_keys(),
    }


@app.post("/api/clear")
def clear_execute_endpoint(data: ClearIn, _: bool = Depends(_require)):
    """执行细化清除：指定分仓 + 指定类别。清除前自动备份（可关）。"""
    try:
        return clear_execute(data.key, data.items, backup=bool(data.backup))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"清除失败：{e}")


# ============================================================
#  更新维护：停服公告 / 维护模式
#  状态写入 data/maintenance.json，ERP 主服务读取后经 /api/maintenance/status 下发给前端：
#    announce    → 前端顶部滚动提示「还有 X 分钟停服」并倒计时，到点自动切维护页
#    maintenance → 前端整屏「系统维护中」，直到主服务再次启动或在此手动结束
# ============================================================
class MaintenanceIn(BaseModel):
    lead_minutes: int = 10
    eta_minutes: int = 30
    message: str = ""
    auto_resume_on_start: bool = True


@app.get("/api/maintenance")
def maintenance_state(_: bool = Depends(_require)):
    """当前维护状态（含倒计时剩余秒数与实际生效模式）。"""
    return mt.admin_state()


@app.post("/api/maintenance/announce")
def maintenance_announce(data: MaintenanceIn, _: bool = Depends(_require)):
    """发布停服公告并开始倒计时（提前 lead_minutes 分钟通知用户）。"""
    return mt.start_announce(
        data.lead_minutes, data.eta_minutes, data.message, data.auto_resume_on_start
    )


@app.post("/api/maintenance/start")
def maintenance_start(data: MaintenanceIn, _: bool = Depends(_require)):
    """立即进入维护模式（不给倒计时，前端马上显示维护页）。"""
    return mt.start_maintenance(data.eta_minutes, data.message, data.auto_resume_on_start)


@app.post("/api/maintenance/cancel")
def maintenance_cancel(_: bool = Depends(_require)):
    """结束维护 / 取消公告，恢复正常访问。"""
    return mt.cancel_maintenance()


# ============================================================
#  网站日志：谁在访问、请求了什么、有没有报错
#  数据来自 ERP 主服务写入的 data/activity.db（独立库，与业务数据无关）
# ============================================================
mt.activity.ensure_table()  # keyadmin 先于主服务启动时也能正常读（并自动建表）


@app.get("/api/activity/summary")
def activity_summary(minutes: int = 5, _: bool = Depends(_require)):
    """概览：近 N 分钟在线人数 / 今日请求量 / 错误数 / 平均耗时 + 在线明细。"""
    return mt.activity.summary(minutes=minutes)


@app.get("/api/activity/logs")
def activity_logs(
    limit: int = 200,
    offset: int = 0,
    q: str = "",
    only_error: bool = False,
    minutes: int = 0,
    _: bool = Depends(_require),
):
    """请求流水（倒序）；q 可在账号/IP/路径/UA 中模糊匹配。"""
    return mt.activity.query(
        limit=limit, offset=offset, keyword=q, only_error=only_error, minutes=minutes
    )


@app.delete("/api/activity/logs")
def activity_clear(_: bool = Depends(_require)):
    return {"ok": True, "deleted": mt.activity.clear()}


@app.get("/api/activity/export")
def activity_export(minutes: int = 0, _: bool = Depends(_require)):
    """导出最近日志为 CSV（带 BOM，Excel 直接打开不乱码）。"""
    import csv
    import io

    from fastapi.responses import StreamingResponse

    rows = mt.activity.query(limit=1000, minutes=minutes)["items"]
    buf = io.StringIO()
    buf.write("\ufeff")
    writer = csv.writer(buf)
    writer.writerow(["时间", "账号", "IP", "方法", "路径", "查询串", "状态码", "耗时(ms)", "分仓", "User-Agent"])
    for r in rows:
        writer.writerow([
            r["time"], r["username"] or "", r["ip"], r["method"], r["path"],
            r["query"], r["status"], r["ms"], r["warehouse"], r["ua"],
        ])
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="activity.csv"'},
    )


app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="keyadmin_static")
