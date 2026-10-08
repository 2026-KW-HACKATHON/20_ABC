"""안드로이드 앱이 15분마다 가져가는 알림 묶음 (휴대폰 알림으로 띄움).

  /api/app/feed?after_bc=<마지막 공지 id>&after_nt=<마지막 내 알림 id>&promo=1&last_promo=<마지막 추천 행사 id>
  · after_* 가 -1 이면 처음 연결: 지난 알림은 보내지 않고 현재 마지막 id만 알려줌 (설치하자마자 알림 폭탄 방지)
  · promo=1 이면 가까운 날(3일 안) 월계동 행사 하나를 추천 문구와 함께 줌 (하루 몇 번 띄울지는 앱이 정함)
"""
import random
from datetime import timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import optional_user
from ..db import get_db
from ..models import Broadcast, Notification, User, now
from ..services.push import promo_text
from .live import upcoming_nearby

router = APIRouter(prefix="/api/app", tags=["app"])


@router.get("/feed")
def feed(after_bc: int = -1, after_nt: int = -1, promo: bool = False, last_promo: int = 0,
         user: User | None = Depends(optional_user), db: Session = Depends(get_db)):
    latest_bc = db.scalar(select(func.max(Broadcast.id))) or 0
    out = {"latest_bc": latest_bc, "broadcasts": [], "notifications": [], "promo": None, "latest_nt": 0}
    if after_bc >= 0:
        rows = db.scalars(select(Broadcast).where(Broadcast.id > after_bc, Broadcast.created_at >= now() - timedelta(days=2))
                          .order_by(Broadcast.id).limit(5))
        out["broadcasts"] = [{"id": b.id, "title": b.title, "body": b.body, "link": b.link or "#/news"} for b in rows]
    if user:
        out["latest_nt"] = db.scalar(select(func.max(Notification.id)).where(Notification.user_id == user.id)) or 0
        if after_nt >= 0:
            rows = db.scalars(select(Notification).where(
                Notification.user_id == user.id, Notification.id > after_nt, Notification.read.is_(False),
                Notification.kind != "notice")            # 공지는 broadcasts 로 이미 감
                .order_by(Notification.id).limit(10))
            out["notifications"] = [{"id": n.id, "title": n.title, "body": n.body, "link": n.link or "#/notifications"} for n in rows]
    if promo:
        t = now()
        cands = [e for e in upcoming_nearby(db, days=3) if e.id != last_promo] or upcoming_nearby(db, days=3)
        if cands:
            e = random.choice(cands)
            title, body = promo_text(e, t)
            out["promo"] = {"id": e.id, "title": title, "body": body, "link": f"#/event/{e.id}"}
    return out
