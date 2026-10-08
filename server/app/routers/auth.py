import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import hash_password, make_token, require_user, verify_password
from ..db import get_db
from ..models import EVENT_CATEGORIES, User

router = APIRouter(prefix="/api/auth", tags=["auth"])


class RegisterIn(BaseModel):
    username: str = Field(min_length=3, max_length=20)
    password: str = Field(min_length=6, max_length=100)
    nickname: str = Field(min_length=1, max_length=20)


class LoginIn(BaseModel):
    username: str
    password: str


class MeIn(BaseModel):
    nickname: str | None = Field(default=None, min_length=1, max_length=20)
    notify_categories: list[str] | None = None
    password: str | None = Field(default=None, min_length=6, max_length=100)


def user_out(u: User) -> dict:
    return {"id": u.id, "username": u.username, "nickname": u.nickname, "is_admin": u.is_admin,
            "notify_categories": [c for c in (u.notify_categories or "").split(",") if c]}


@router.post("/register")
def register(body: RegisterIn, db: Session = Depends(get_db)):
    if not re.fullmatch(r"[A-Za-z0-9_]+", body.username):
        raise HTTPException(400, "아이디는 영문, 숫자, 밑줄(_)만 쓸 수 있습니다.")
    if db.scalar(select(User.id).where(User.username == body.username.lower())):
        raise HTTPException(409, "이미 사용 중인 아이디입니다.")
    u = User(username=body.username.lower(), nickname=body.nickname.strip(), password_hash=hash_password(body.password))
    db.add(u)
    db.commit()
    return {"token": make_token(u), "user": user_out(u)}


@router.post("/login")
def login(body: LoginIn, db: Session = Depends(get_db)):
    u = db.scalar(select(User).where(User.username == body.username.lower().strip()))
    if not u or not verify_password(body.password, u.password_hash):
        raise HTTPException(401, "아이디 또는 비밀번호가 맞지 않습니다.")
    return {"token": make_token(u), "user": user_out(u)}


@router.get("/me")
def me(user: User = Depends(require_user)):
    return user_out(user)


@router.patch("/me")
def update_me(body: MeIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    if body.nickname is not None:
        user.nickname = body.nickname.strip()
    if body.notify_categories is not None:
        user.notify_categories = ",".join(c for c in body.notify_categories if c in EVENT_CATEGORIES)
    token = None
    if body.password:
        user.password_hash = hash_password(body.password)
        token = make_token(user)          # 다른 기기의 예전 토큰은 무효가 됨
    db.commit()
    out = user_out(user)
    if token:
        out["token"] = token
    return out


@router.delete("/me")
def delete_me(user: User = Depends(require_user), db: Session = Depends(get_db)):
    if user.is_admin:
        raise HTTPException(400, "관리자 계정은 앱에서 탈퇴할 수 없습니다.")
    from ..models import Review
    from .media import delete_review_files
    for r in db.query(Review).filter(Review.user_id == user.id).all():   # 후기 사진·영상 파일도 지움
        delete_review_files(r)
        db.delete(r)
    db.delete(user)
    db.commit()
    return {"ok": True}
