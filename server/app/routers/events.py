from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import case, and_, func, or_, select
from sqlalchemy.orm import Session

from ..auth import optional_user, require_user
from ..db import get_db
from ..models import EVENT_CATEGORIES, Event, Favorite, Review, User, now

router = APIRouter(prefix="/api/events", tags=["events"])


def iso(d: datetime | None) -> str | None:
    return d.isoformat(timespec="minutes") if d else None


def event_out(e: Event, stats: dict | None = None, fav: bool = False, full: bool = False) -> dict:
    s = stats or {}
    out = {
        "id": e.id, "title": e.title, "category": e.category, "category_label": EVENT_CATEGORIES.get(e.category, ""),
        "start_at": iso(e.start_at), "end_at": iso(e.end_at), "time_text": e.time_text,
        "place_name": e.place_name, "lat": e.lat, "lng": e.lng, "host": e.host, "fee": e.fee,
        "image_url": e.image_url, "source": e.source,
        "fav_count": s.get("fav", 0), "review_count": s.get("rev", 0), "avg_rating": s.get("avg"),
        "is_favorite": fav,
    }
    if full:
        out.update({"description": e.description, "contact": e.contact, "url": e.url})
    return out


def _stats(db: Session, ids: list[int]) -> dict[int, dict]:
    if not ids:
        return {}
    res: dict[int, dict] = {i: {} for i in ids}
    for eid, cnt in db.execute(select(Favorite.event_id, func.count()).where(Favorite.event_id.in_(ids)).group_by(Favorite.event_id)):
        res[eid]["fav"] = cnt
    for eid, cnt, avg in db.execute(select(Review.event_id, func.count(), func.avg(Review.rating))
                                    .where(Review.event_id.in_(ids)).group_by(Review.event_id)):
        res[eid]["rev"] = cnt
        res[eid]["avg"] = round(float(avg), 1) if avg is not None else None
    return res


def _favs(db: Session, user: User | None, ids: list[int]) -> set[int]:
    if not user or not ids:
        return set()
    return set(db.scalars(select(Favorite.event_id).where(Favorite.user_id == user.id, Favorite.event_id.in_(ids))))


@router.get("")
def list_events(
    category: str | None = None,
    when: str = Query("upcoming", pattern="^(upcoming|all|month|past)$"),
    year: int | None = Query(None, ge=2000, le=2100),
    month: int | None = Query(None, ge=1, le=12),
    q: str | None = None,
    user: User | None = Depends(optional_user),
    db: Session = Depends(get_db),
):
    stmt = select(Event).where(Event.status == "approved")
    if category in EVENT_CATEGORIES:
        stmt = stmt.where(Event.category == category)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Event.title.ilike(like), Event.place_name.ilike(like), Event.description.ilike(like)))
    today = now().replace(hour=0, minute=0, second=0, microsecond=0)
    end_or_start = func.coalesce(Event.end_at, Event.start_at)
    if when == "upcoming":
        # 날짜를 모르는 행사는 등록 후 45일까지만 보여줌 (영원히 '다가오는 행사'에 남지 않도록)
        stmt = stmt.where(or_(and_(Event.start_at.is_(None), Event.created_at >= today - timedelta(days=45)),
                              end_or_start >= today))
    elif when == "past":
        stmt = stmt.where(end_or_start < today)
    elif when == "month":
        y, m = year or today.year, month or today.month
        first = datetime(y, m, 1)
        nxt = datetime(y + (m == 12), (m % 12) + 1, 1)
        stmt = stmt.where(and_(Event.start_at < nxt, end_or_start >= first))
    if when == "upcoming":
        # 이미 시작한 긴 전시가 목록 맨 위를 차지하지 않도록: '오늘 기준 다음 날짜' → 먼저 끝나는 순
        nxt = case((Event.start_at < today, today), else_=Event.start_at)
        stmt = stmt.order_by(Event.start_at.is_(None), nxt, end_or_start).limit(300)
    else:
        stmt = stmt.order_by(Event.start_at.is_(None), Event.start_at.desc() if when == "past" else Event.start_at).limit(300)
    rows = list(db.scalars(stmt))
    ids = [e.id for e in rows]
    st, fv = _stats(db, ids), _favs(db, user, ids)
    return [event_out(e, st.get(e.id), e.id in fv) for e in rows]


@router.get("/favorites")
def my_favorites(user: User = Depends(require_user), db: Session = Depends(get_db)):
    rows = list(db.scalars(select(Event).join(Favorite, Favorite.event_id == Event.id)
                           .where(Favorite.user_id == user.id, Event.status == "approved")
                           .order_by(Event.start_at.is_(None), Event.start_at)))
    ids = [e.id for e in rows]
    st = _stats(db, ids)
    return [event_out(e, st.get(e.id), True) for e in rows]


@router.get("/{event_id}")
def get_event(event_id: int, user: User | None = Depends(optional_user), db: Session = Depends(get_db)):
    e = db.get(Event, event_id)
    if not e or (e.status != "approved" and not (user and user.is_admin)):
        raise HTTPException(404, "행사를 찾을 수 없습니다.")
    st, fv = _stats(db, [e.id]), _favs(db, user, [e.id])
    out = event_out(e, st.get(e.id), e.id in fv, full=True)
    reviews = db.scalars(select(Review).where(Review.event_id == e.id).order_by(Review.created_at.desc()).limit(100))
    out["reviews"] = [{"id": r.id, "rating": r.rating, "body": r.body, "created_at": iso(r.created_at),
                       "nickname": r.user.nickname if r.user else "탈퇴한 사용자",
                       "mine": bool(user and r.user_id == user.id)} for r in reviews]
    out["can_review"] = bool(user) and (e.start_at is None or e.start_at <= now() + timedelta(hours=1))
    return out


@router.post("/{event_id}/favorite")
def toggle_favorite(event_id: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    e = db.get(Event, event_id)
    if not e or e.status != "approved":
        raise HTTPException(404, "행사를 찾을 수 없습니다.")
    f = db.scalar(select(Favorite).where(Favorite.user_id == user.id, Favorite.event_id == event_id))
    if f:
        db.delete(f)
        db.commit()
        return {"is_favorite": False}
    db.add(Favorite(user_id=user.id, event_id=event_id))
    db.commit()
    return {"is_favorite": True}


class ReviewIn(BaseModel):
    rating: int = Field(ge=1, le=5)
    body: str = Field(min_length=2, max_length=1000)


@router.post("/{event_id}/reviews")
def add_review(event_id: int, body: ReviewIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    e = db.get(Event, event_id)
    if not e or e.status != "approved":
        raise HTTPException(404, "행사를 찾을 수 없습니다.")
    if e.start_at and e.start_at > now() + timedelta(hours=1):
        raise HTTPException(400, "행사가 시작된 뒤에 후기를 남길 수 있습니다.")
    r = Review(event_id=event_id, user_id=user.id, rating=body.rating, body=body.body.strip())
    db.add(r)
    db.commit()
    return {"id": r.id}


@router.delete("/reviews/{review_id}")
def delete_review(review_id: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    r = db.get(Review, review_id)
    if not r:
        raise HTTPException(404, "후기를 찾을 수 없습니다.")
    if r.user_id != user.id and not user.is_admin:
        raise HTTPException(403, "본인이 쓴 후기만 지울 수 있습니다.")
    db.delete(r)
    db.commit()
    return {"ok": True}
