"""认证路由：SSH 指纹（私钥）登录。

- 业务员与管理员一律使用私钥文件登录（服务器保存公钥指纹，登录时由私钥推导公钥比对）。
- 用户/密钥的生成与管理在独立的「私钥管理工具」中完成（见项目根 keyadmin.py），不开放注册。
- 连续失败按账号分级锁定（规则见 app/login_guard.py），Web 端与移动端 PWA 共用同一套。
"""
import hmac
from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import login_guard as guard
from ..auth import (
    COOKIE_NAME,
    TOKEN_MAX_AGE,
    get_current_user,
    make_token,
)
from ..database import (
    current_warehouse_name,
    get_current_key,
    get_default_key,
    get_user_db,
)
from ..keys import public_from_private
from ..models import User

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    username: str
    private_key: str


def _reject(username: str) -> NoReturn:
    """记一次失败并抛出对应错误：到档位返回 429（带等待时长），否则 401。"""
    wait = guard.record_fail(guard.SCOPE_ERP, username)
    if wait:
        raise HTTPException(
            429,
            f"连续失败次数过多，账号已锁定 {guard.humanize(wait)}，请稍后再试",
        )
    raise HTTPException(401, "用户名或私钥不匹配")


@router.post("/login")
def login(data: LoginIn, response: Response, db: Session = Depends(get_user_db)):
    """私钥登录。

    账号注册表固定在默认仓（keyadmin 只写这里），所以登录不受任何"当前分仓"影响；
    新会话从默认分仓起步，之后各人可自行切仓（切仓只重签自己的令牌，无需重新登录）。

    连续失败按 app/login_guard.py 的规则锁定该账号：每累计 3 次失败依次等待
    1 分钟 → 3 分钟 → 5 分钟 → 1 小时 → 24 小时（之后每 3 次继续 24 小时），
    登录成功立即清零。锁定期内即使私钥正确也一律拒绝。
    """
    username = data.username.strip()
    if not username:
        raise HTTPException(401, "用户名或私钥不匹配")

    left = guard.locked_left(guard.SCOPE_ERP, username)
    if left:
        raise HTTPException(429, f"账号已锁定，请 {guard.humanize(left)} 后再试")

    user = db.scalar(select(User).where(User.username == username))
    if not user or not user.is_active:
        _reject(username)
    try:
        _, fp = public_from_private(data.private_key)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not user.fingerprint or not hmac.compare_digest(fp, user.fingerprint):
        _reject(username)

    guard.reset(guard.SCOPE_ERP, username)

    wh = get_default_key()
    token = make_token(user.id, wh)
    response.set_cookie(
        COOKIE_NAME, token, max_age=TOKEN_MAX_AGE, httponly=True, path="/", samesite="lax"
    )
    return {
        "ok": True,
        "user": {"id": user.id, "username": user.username, "name": user.name, "role": user.role},
        "warehouse": {"key": wh, "name": current_warehouse_name(wh)},
    }


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(get_current_user)):
    key = get_current_key()  # 本登录会话自己的分仓
    return {
        "id": user.id, "username": user.username, "name": user.name, "role": user.role,
        "warehouse": {"key": key, "name": current_warehouse_name(key)},
    }
