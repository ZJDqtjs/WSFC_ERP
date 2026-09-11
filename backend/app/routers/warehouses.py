"""分仓管理：列表 / 新建（初始化 + 复制用户 + 切换）/ 切换。

切仓/新建成功后前端会重新登录（旧 token 绑定原仓，切仓后失效），本模块不签发新 token。
"""
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import get_current_user
from ..database import (
    get_current_key,
    get_warehouses,
    register_warehouse,
    set_current_key,
    warehouse_db_path,
)
from ..initdb import init_warehouse
from ..models import User

router = APIRouter(prefix="/api/warehouses", tags=["warehouses"])

KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,31}$")


class CreateIn(BaseModel):
    name: str
    key: str | None = None  # 可选显式 key；缺省自动生成 whNN


class SwitchIn(BaseModel):
    key: str


def _require_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(403, "仅管理员可操作分仓")


@router.get("")
def list_warehouses(user: User = Depends(get_current_user)):
    """分仓列表（全员可见，用于切换选择）。"""
    current = get_current_key()
    return {
        "current": current,
        "warehouses": [
            {**w, "is_current": w["key"] == current} for w in get_warehouses()
        ],
    }


@router.post("")
def create_warehouse(data: CreateIn, user: User = Depends(get_current_user)):
    """新建分仓：初始化独立库（含复制当前仓用户）并切换。仅管理员。"""
    _require_admin(user)
    name = (data.name or "").strip()
    if not name:
        raise HTTPException(400, "请输入分仓名称")
    if len(name) > 32:
        raise HTTPException(400, "分仓名称过长（≤32 字）")
    key = (data.key or "").strip().lower()
    if key and not KEY_RE.match(key):
        raise HTTPException(400, "key 仅允许小写字母/数字/下划线/连字符")
    if not key:
        n = 1
        used = {w["key"] for w in get_warehouses()}
        while f"wh{n:02d}" in used:
            n += 1
        key = f"wh{n:02d}"
    if any(w["key"] == key for w in get_warehouses()):
        raise HTTPException(400, f"分仓 key 已存在: {key}")
    if warehouse_db_path(key).exists():
        raise HTTPException(400, f"分仓库文件已存在: {warehouse_db_path(key).name}")
    try:
        init_warehouse(key, copy_users_from=get_current_key())
        register_warehouse(key, name)
        set_current_key(key)
    except Exception as e:
        raise HTTPException(500, f"分仓创建失败: {e}")
    return {
        "ok": True,
        "current": key,
        "warehouse": {"key": key, "name": name, "db": f"warehouses/{key}.db"},
    }


@router.post("/switch")
def switch_warehouse(data: SwitchIn, user: User = Depends(get_current_user)):
    """切换当前分仓。仅管理员。"""
    _require_admin(user)
    keys = {w["key"] for w in get_warehouses()}
    if data.key not in keys:
        raise HTTPException(404, "分仓不存在")
    if data.key != get_current_key():
        set_current_key(data.key)
    return {"ok": True, "current": data.key}
