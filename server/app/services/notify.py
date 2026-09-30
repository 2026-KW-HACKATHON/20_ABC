"""앱 내 알림 (문자·카톡 발송 없음)."""
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import EVENT_CATEGORIES, Event, Notification, User


def notify(db: Session, user_id: int, kind: str, title: str, body: str = "", link: str = "", ref: str = "") -> bool:
    """ref가 같으면 중복 알림을 만들지 않는다."""
    if ref:
        exists = db.scalar(select(Notification.id).where(Notification.user_id == user_id,
                                                         Notification.kind == kind, Notification.ref == ref))
        if exists:
            return False
    db.add(Notification(user_id=user_id, kind=kind, title=title[:200], body=body, link=link, ref=ref))
    return True


def notify_new_event(db: Session, ev: Event) -> int:
    """승인된 새 행사를 해당 카테고리 알림을 켠 사용자에게 알린다."""
    n = 0
    for u in db.scalars(select(User)):
        cats = (u.notify_categories or "").split(",")
        if ev.category in cats:
            label = EVENT_CATEGORIES.get(ev.category, "")
            if notify(db, u.id, "event_new", f"새 {label} 행사: {ev.title}", ev.place_name or "",
                      f"#/event/{ev.id}", f"event:{ev.id}"):
                n += 1
    return n
