from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import COOKIE_NAME, TOKEN_MAX_AGE, get_current_user, make_token, verify_password
from ..database import get_db
from ..models import User

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(data: LoginIn, response: Response, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.username == data.username.strip()))
    if not user or not user.is_active or not verify_password(data.password, user.password_hash):
        raise HTTPException(401, "用户名或密码错误")
    token = make_token(user.id)
    response.set_cookie(
        COOKIE_NAME, token, max_age=TOKEN_MAX_AGE, httponly=True, path="/", samesite="lax"
    )
    return {"ok": True, "user": {"id": user.id, "username": user.username, "name": user.name, "role": user.role}}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(get_current_user)):
    return {"id": user.id, "username": user.username, "name": user.name, "role": user.role}
