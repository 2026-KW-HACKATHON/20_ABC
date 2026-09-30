"""간단 가입/로그인 — 아이디·비밀번호, 서명 토큰(Bearer)."""
import base64
import hashlib
import hmac
import os
import time

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from .config import SECRET_KEY, TOKEN_DAYS
from .db import get_db
from .models import User

_ITER = 200_000


def hash_password(pw: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, _ITER)
    return f"pbkdf2${_ITER}${salt.hex()}${dk.hex()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        _, it, salt, dk = stored.split("$")
        test = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(it))
        return hmac.compare_digest(test.hex(), dk)
    except Exception:
        return False


def _sign(msg: str) -> str:
    sig = hmac.new(SECRET_KEY.encode(), msg.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(sig).decode().rstrip("=")


def _fingerprint(user: User) -> str:
    """비밀번호가 바뀌거나 계정이 지워지면 예전 토큰이 무효가 되도록 토큰에 넣는 값."""
    return hashlib.sha256(f"{user.id}:{user.password_hash}".encode()).hexdigest()[:12]


def make_token(user: User) -> str:
    exp = int(time.time()) + TOKEN_DAYS * 86400
    msg = f"{user.id}.{exp}.{_fingerprint(user)}"
    return f"{msg}.{_sign(msg)}"


def read_token(token: str, db: Session) -> User | None:
    try:
        uid, exp, fp, sig = token.split(".")
        if not hmac.compare_digest(sig, _sign(f"{uid}.{exp}.{fp}")) or int(exp) < time.time():
            return None
        user = db.get(User, int(uid))
        if not user or not hmac.compare_digest(fp, _fingerprint(user)):
            return None
        return user
    except Exception:
        return None


def sign_value(value: str, ttl: int = 3600) -> str:
    """이미지 주소 등에 붙이는 짧은 서명 (로그인 토큰을 주소에 넣지 않기 위해)."""
    exp = int(time.time()) + ttl
    return f"{exp}.{_sign(f'{value}.{exp}')}"


def check_value(value: str, sig: str | None) -> bool:
    try:
        exp, s = (sig or "").split(".")
        return int(exp) >= time.time() and hmac.compare_digest(s, _sign(f"{value}.{exp}"))
    except Exception:
        return False


def optional_user(authorization: str | None = Header(default=None), db: Session = Depends(get_db)) -> User | None:
    """Authorization: Bearer 헤더의 토큰으로 사용자 확인 (토큰은 주소에 싣지 않음)."""
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    return read_token(authorization.split(" ", 1)[1].strip(), db)


def require_user(user: User | None = Depends(optional_user)) -> User:
    if not user:
        raise HTTPException(401, "로그인이 필요합니다.")
    return user


def require_admin(user: User = Depends(require_user)) -> User:
    if not user.is_admin:
        raise HTTPException(403, "관리자만 사용할 수 있습니다.")
    return user
