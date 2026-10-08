"""월계1동 실시간 보드 — 가까운 시일 안에 열리는(또는 진행 중인) 월계동 행사를 무작위로 골라 알려줌.

뉴스·공사 소식은 넣지 않음. 앱은 받은 목록을 몇 초마다 돌려가며 한 개씩 보여준다.
"""
import random
from datetime import timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Event, now
from ..services import geo
from .events import event_out

router = APIRouter(prefix="/api", tags=["live"])


def upcoming_nearby(db: Session, days: int = 7) -> list[Event]:
    t = now()
    today = t.replace(hour=0, minute=0, second=0, microsecond=0)
    last = func.coalesce(Event.end_at, Event.start_at)
    rows = db.scalars(select(Event).where(
        Event.status == "approved", Event.lat.is_not(None), Event.start_at.is_not(None),
        Event.start_at < today + timedelta(days=days + 1), last >= today,
        or_(Event.end_at.is_not(None), Event.start_at >= today)))
    out = []
    for e in rows:
        if e.title.startswith("(예시)") or not geo.area_contains(e.lat, e.lng):
            continue
        if e.end_at is None and e.start_at.hour and e.start_at + timedelta(hours=3) < t:
            continue                     # 오늘 이미 끝난 짧은 행사
        if e.end_at is not None and e.end_at.hour and e.end_at < t:
            continue
        out.append(e)
    return out


@router.get("/live")
def live(days: int = Query(7, ge=1, le=30), db: Session = Depends(get_db)):
    """가까운 행사 목록을 무작위 순서로 (앱이 하나씩 돌려가며 보여줌)."""
    rows = upcoming_nearby(db, days)
    random.shuffle(rows)
    t = now()
    items = []
    for e in rows[:20]:
        d = event_out(e)
        if e.start_at <= t:
            d["when_label"] = "진행 중"
        else:
            gap = (e.start_at.date() - t.date()).days
            d["when_label"] = "오늘" if gap == 0 else "내일" if gap == 1 else f"{gap}일 뒤"
        items.append(d)
    return {"items": items}
