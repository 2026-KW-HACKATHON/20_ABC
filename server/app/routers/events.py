from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import case, and_, func, or_, select
from sqlalchemy.orm import Session

from ..auth import optional_user, require_user
from ..db import get_db
from ..models import EVENT_CATEGORIES, Event, Favorite, Review, User, now
from ..services import geo
from ..services import search as search_svc
from ..services.kinds import KINDS, event_kind, kinds_meta

router = APIRouter(prefix="/api/events", tags=["events"])


def iso(d: datetime | None) -> str | None:
    return d.isoformat(timespec="minutes") if d else None


def in_area(e: Event) -> bool:
    """월계동 안 행사인지 (좌표가 없으면 '밖'으로 봄 — 지도·달력에는 안 나오고 검색에서만 나옴)."""
    return e.lat is not None and e.lng is not None and geo.area_contains(e.lat, e.lng)


def event_out(e: Event, stats: dict | None = None, fav: bool = False, full: bool = False) -> dict:
    s = stats or {}
    out = {
        "id": e.id, "title": e.title, "category": e.category, "category_label": EVENT_CATEGORIES.get(e.category, ""),
        "start_at": iso(e.start_at), "end_at": iso(e.end_at), "time_text": e.time_text,
        "place_name": e.place_name, "lat": e.lat, "lng": e.lng, "host": e.host, "fee": e.fee,
        "image_url": e.image_url, "source": e.source,
        "kind": (k := event_kind(e.title, e.description, e.category)), "kind_label": KINDS[k]["label"],
        "fav_count": s.get("fav", 0), "review_count": s.get("rev", 0), "avg_rating": s.get("avg"),
        "is_favorite": fav, "in_area": in_area(e),
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
    area: bool = Query(False, description="true 면 월계동 안 행사만 (지도·달력·목록)"),
    user: User | None = Depends(optional_user),
    db: Session = Depends(get_db),
):
    stmt = select(Event).where(Event.status == "approved")
    if area:      # 좌표가 있고 월계동 상자 안인 것만 먼저 거른 뒤, 아래에서 경계선으로 다시 확인
        s_, w_, n_, e_ = geo.area_bbox()
        stmt = stmt.where(Event.lat.between(s_, n_), Event.lng.between(w_, e_))
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
        stmt = stmt.order_by(Event.start_at.is_(None), nxt, end_or_start)
    else:
        stmt = stmt.order_by(Event.start_at.is_(None), Event.start_at.desc() if when == "past" else Event.start_at)
    rows = list(db.scalars(stmt.limit(1500 if area else 300)))
    if area:
        rows = [e for e in rows if in_area(e)][:300]
    ids = [e.id for e in rows]
    st, fv = _stats(db, ids), _favs(db, user, ids)
    return [event_out(e, st.get(e.id), e.id in fv) for e in rows]


@router.get("/search")
def search_events(
    q: str = Query(..., min_length=1, max_length=60),
    past: bool = False,
    category: str | None = None,
    user: User | None = Depends(optional_user),
    db: Session = Depends(get_db),
):
    """연관어까지 넓혀 찾는 검색. 월계동 밖 행사도 나오며 in_area 로 구분."""
    hits = search_svc.search(db, q, include_past=past, category=category)
    ids = [e.id for e, _, _ in hits]
    st, fv = _stats(db, ids), _favs(db, user, ids)
    toks = search_svc.tokens(q)
    related = []
    for t in toks:
        related += [w for w in search_svc.expand(t)[0] if w not in related]
    return {"q": q, "related": related[:12], "items": [
        {**event_out(e, st.get(e.id), e.id in fv), "score": round(sc, 1), "reasons": why} for e, sc, why in hits]}


@router.get("/favorites")
def my_favorites(user: User = Depends(require_user), db: Session = Depends(get_db)):
    rows = list(db.scalars(select(Event).join(Favorite, Favorite.event_id == Event.id)
                           .where(Favorite.user_id == user.id, Event.status == "approved")
                           .order_by(Event.start_at.is_(None), Event.start_at)))
    ids = [e.id for e in rows]
    st = _stats(db, ids)
    return [event_out(e, st.get(e.id), True) for e in rows]


@router.get("/meta/kinds")
def event_kinds():
    """세부 종류(아이콘·필터용)와 큰 분류."""
    return {"categories": EVENT_CATEGORIES, "kinds": kinds_meta()}


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
                       "media": [{"id": m.id, "kind": m.kind, "url": f"/api/media/reviews/{m.filename}"} for m in r.media],
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
    from .media import delete_review_files
    delete_review_files(r)
    db.delete(r)
    db.commit()
    return {"ok": True}
