"""로그인 사용자 전용: 알림, 달력 메모."""
import logging

import re

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..auth import require_user
from ..db import get_db
from ..models import CalendarNote, Notification, User
from ..services import prefs
from .events import iso

router = APIRouter(prefix="/api", tags=["me"])
log = logging.getLogger("wolgyeon.me")


# ------------------------------------------------------------------ 알림
@router.get("/notifications")
def notifications(user: User = Depends(require_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(Notification).where(Notification.user_id == user.id)
                      .order_by(Notification.created_at.desc()).limit(100))
    unread = db.scalar(select(func.count()).select_from(Notification)
                       .where(Notification.user_id == user.id, Notification.read.is_(False)))
    return {"unread": unread, "items": [{"id": n.id, "kind": n.kind, "title": n.title, "body": n.body, "link": n.link,
                                         "read": n.read, "created_at": iso(n.created_at)} for n in rows]}


@router.get("/notifications/unread")
def unread_count(user: User = Depends(require_user), db: Session = Depends(get_db)):
    return {"unread": db.scalar(select(func.count()).select_from(Notification)
                                .where(Notification.user_id == user.id, Notification.read.is_(False)))}


@router.post("/notifications/read-all")
def read_all(user: User = Depends(require_user), db: Session = Depends(get_db)):
    db.execute(update(Notification).where(Notification.user_id == user.id).values(read=True))
    db.commit()
    return {"ok": True}


@router.post("/notifications/{nid}/read")
def read_one(nid: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    n = db.get(Notification, nid)
    if n and n.user_id == user.id:
        n.read = True
        db.commit()
    return {"ok": True}


# ------------------------------------------------------------------ 알림 설정
class PrefIn(BaseModel):
    fav_hours: int | None = None
    promo: bool | None = None


@router.get("/me/prefs")
def get_prefs(user: User = Depends(require_user), db: Session = Depends(get_db)):
    return {**prefs.get(db, user.id), "fav_hours_options": list(prefs.FAV_HOURS)}


@router.put("/me/prefs")
def put_prefs(body: PrefIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    if body.fav_hours is not None and body.fav_hours not in prefs.FAV_HOURS:
        raise HTTPException(400, "알림 시간이 올바르지 않습니다.")
    return prefs.put(db, user.id, body.model_dump(exclude_none=True))


# ------------------------------------------------------------------ 달력 날짜별 메모
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class NoteIn(BaseModel):
    text: str = Field(default="", max_length=500)


@router.get("/me/notes")
def list_notes(year: int = Query(..., ge=2000, le=2100), month: int = Query(..., ge=1, le=12),
               user: User = Depends(require_user), db: Session = Depends(get_db)):
    pre = f"{year:04d}-{month:02d}-"
    rows = db.scalars(select(CalendarNote).where(CalendarNote.user_id == user.id, CalendarNote.day.like(pre + "%")))
    return {n.day: n.text for n in rows}


@router.put("/me/notes/{day}")
def put_note(day: str, body: NoteIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    """빈 글이면 그 날 메모를 지움."""
    if not DAY_RE.match(day):
        raise HTTPException(400, "날짜 형식은 YYYY-MM-DD 입니다.")
    text = body.text.strip()
    row = db.scalar(select(CalendarNote).where(CalendarNote.user_id == user.id, CalendarNote.day == day))
    if not text:
        if row:
            db.delete(row)
            db.commit()
        return {"ok": True, "day": day, "text": ""}
    if not row:
        if db.scalar(select(func.count()).select_from(CalendarNote).where(CalendarNote.user_id == user.id)) >= 2000:
            raise HTTPException(400, "메모는 2000개까지 저장할 수 있어요.")
        row = CalendarNote(user_id=user.id, day=day)
        db.add(row)
    row.text = text
    db.commit()
    return {"ok": True, "day": day, "text": text}
