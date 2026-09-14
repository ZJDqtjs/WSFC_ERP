"""分仓管理：列表 / 新建（初始化 + 复制用户 + 切到新仓）/ 切换。

分仓是**会话级**的：切换/新建只重签调用者自己的令牌（payload.wh），不写全局状态、
不签发他人令牌，因此：
- 其他在线用户完全不受影响（历史上"一人切仓，全员被登出"的根因已消除）；
- 切仓的人自己也不需要重新登录，前端刷新页面即可看到新仓数据。
"""
import re

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from ..auth import COOKIE_NAME, TOKEN_MAX_AGE, get_current_user, make_token
from ..database import (
    current_warehouse_name,
    get_current_key,
    get_warehouses,
    register_warehouse,
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


def _issue_warehouse_cookie(response: Response, user_id: int, key: str) -> None:
    """把「本会话的分仓」重签到令牌里（同 cookie、同有效期，故不会掉线）。"""
    response.set_cookie(
        COOKIE_NAME,
        make_token(user_id, key),
        max_age=TOKEN_MAX_AGE,
        httponly=True,
        path="/",
        samesite="lax",
    )


@router.get("")
def list_warehouses(user: User = Depends(get_current_user)):
    """分仓列表（全员可见，用于切换选择）；current 为**本登录会话**所在分仓。"""
    current = get_current_key()
    return {
        "current": current,
        "warehouses": [
            {**w, "is_current": w["key"] == current} for w in get_warehouses()
        ],
    }


@router.post("")
def create_warehouse(
    data: CreateIn, response: Response, user: User = Depends(get_current_user)
):
    """新建分仓：初始化独立库（含复制本会话所在仓的用户）并把**本会话**切过去。仅管理员。"""
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
    except Exception as e:
        raise HTTPException(500, f"分仓创建失败: {e}")
    _issue_warehouse_cookie(response, user.id, key)
    return {
        "ok": True,
        "current": key,
        "warehouse": {"key": key, "name": name, "db": f"warehouses/{key}.db"},
    }


@router.post("/switch")
def switch_warehouse(
    data: SwitchIn, response: Response, user: User = Depends(get_current_user)
):
    """切换**本登录会话**的分仓（重签令牌，立即生效，无需重新登录）。仅管理员。"""
    _require_admin(user)
    keys = {w["key"] for w in get_warehouses()}
    if data.key not in keys:
        raise HTTPException(404, "分仓不存在")
    _issue_warehouse_cookie(response, user.id, data.key)
    return {
        "ok": True,
        "current": data.key,
        "warehouse": {"key": data.key, "name": current_warehouse_name(data.key)},
    }
