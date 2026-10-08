"""휴대폰 알림에 쓰는 문구·대상 (앱이 주기적으로 /api/app/feed 를 가져가 알림으로 띄움)."""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Broadcast, Event, Favorite, User, now
from .notify import notify


def days_word(start: datetime, t: datetime | None = None) -> str:
    t = t or now()
    d = (start.date() - t.date()).days
    return "오늘" if d <= 0 else "내일" if d == 1 else "모레" if d == 2 else f"{d}일 뒤에"


def promo_text(ev: Event, t: datetime | None = None) -> tuple[str, str]:
    """'n일 뒤에 열리는 ~~ 행사는 어떠세요?'"""
    w = days_word(ev.start_at, t) if ev.start_at else "곧"
    started = ev.start_at and ev.start_at.date() < (t or now()).date()
    title = f"지금 열리고 있는 '{ev.title}' 행사는 어떠세요?" if started else f"{w} 열리는 '{ev.title}' 행사는 어떠세요?"
    body = " · ".join(x for x in (ev.place_name, ev.time_text) if x)[:200] or "월계온에서 자세히 보기"
    return title[:200], body


def broadcast_all(db: Session, title: str, body: str = "", link: str = "", kind: str = "custom") -> Broadcast:
    """모든 사용자 앱 안 알림 + 휴대폰 알림(로그인하지 않은 앱 사용자 포함)."""
    b = Broadcast(kind=kind, title=title[:200], body=body[:1000], link=link[:200])
    db.add(b)
    db.flush()
    n = 0
    for uid in db.scalars(select(User.id)):
        notify(db, uid, "notice", b.title, b.body, b.link, f"bc:{b.id}")
        n += 1
    b.sent = n
    db.commit()
    return b


def remind_favorites_now(db: Session, hours: int, template: str) -> int:
    """관리자 일괄: n시간 안에 시작하는 즐겨찾기 행사가 있는 사용자에게 알림. template 의 {n}, {title} 을 바꿔 넣음."""
    t = now()
    rows = db.execute(select(Favorite.user_id, Event).join(Event, Event.id == Favorite.event_id).where(
        Event.status == "approved", Event.start_at > t, Event.start_at <= t + timedelta(hours=hours)))
    n = 0
    for uid, ev in rows:
        left = max(1, round((ev.start_at - t).total_seconds() / 3600))
        title = template.replace("{n}", str(left)).replace("{title}", ev.title)
        if notify(db, uid, "event_soon", title, f"{ev.start_at:%m월 %d일 %H:%M} · {ev.place_name}",
                  f"#/event/{ev.id}", f"adm-soon:{ev.id}:{t:%Y%m%d%H}"):
            n += 1
    db.commit()
    return n
