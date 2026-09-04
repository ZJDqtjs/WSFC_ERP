"""认证路由：SSH 指纹（私钥）登录。

- 业务员与管理员一律使用私钥文件登录（服务器保存公钥指纹，登录时由私钥推导公钥比对）。
- 用户/密钥的生成与管理在独立的「私钥管理工具」中完成（见项目根 keyadmin.py），不开放注册。
"""
import hmac

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import (
    COOKIE_NAME,
    TOKEN_MAX_AGE,
    get_current_user,
    make_token,
)
from ..database import get_db
from ..keys import public_from_private
from ..models import User

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    username: str
    private_key: str


@router.post("/login")
def login(data: LoginIn, response: Response, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.username == data.username.strip()))
    if not user or not user.is_active:
        raise HTTPException(401, "用户名或私钥不匹配")
    try:
        _, fp = public_from_private(data.private_key)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not user.fingerprint or not hmac.compare_digest(fp, user.fingerprint):
        raise HTTPException(401, "用户名或私钥不匹配")

    token = make_token(user.id)
    response.set_cookie(
        COOKIE_NAME, token, max_age=TOKEN_MAX_AGE, httponly=True, path="/", samesite="lax"
    )
    return {
        "ok": True,
        "user": {"id": user.id, "username": user.username, "name": user.name, "role": user.role},
    }


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(get_current_user)):
    return {"id": user.id, "username": user.username, "name": user.name, "role": user.role}
