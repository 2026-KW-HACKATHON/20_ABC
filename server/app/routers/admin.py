"""관리자 — 행사 승인(주민 제보 포함), 길 제보 검토, 공사 구간, 지도 데이터."""
import json
import threading
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import require_admin
from ..config import APK_PATH, SEOUL_API_KEY
from ..db import SessionLocal, get_db
from ..models import EVENT_CATEGORIES, PATH_KINDS, Broadcast, CollectLog, Construction, Event, EventTag, PathEdit, User, now
from ..services import ai, collect, eventfill, official, osm_update, places
from ..services import push as push_svc
from ..services import search as search_svc
from ..services.notify import notify, notify_new_event
from .events import event_out, in_area, iso
from . import tips
from .mapdata import PathIn, construction_out, path_coords_json, path_out, validate_path

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])

_jobs: dict[str, dict] = {}


def _run_job(name: str, fn):
    if _jobs.get(name, {}).get("running"):
        raise HTTPException(409, "이미 실행 중입니다. 잠시 후 결과를 확인해주세요.")
    _jobs[name] = {"running": True, "started": iso(now()), "result": None}

    def work():
        try:
            _jobs[name]["result"] = fn()
        except Exception as e:
            _jobs[name]["result"] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        finally:
            _jobs[name]["running"] = False
            _jobs[name]["finished"] = iso(now())

    threading.Thread(target=work, daemon=True).start()
    return _jobs[name]


# ------------------------------------------------------------------ 요약
@router.get("/summary")
def summary(db: Session = Depends(get_db)):
    cnt = lambda stmt: db.scalar(stmt)  # noqa: E731
    logs = db.scalars(select(CollectLog).order_by(CollectLog.id.desc()).limit(10))
    return {
        "pending_events": cnt(select(func.count()).select_from(Event).where(Event.status == "pending")),
        "approved_events": cnt(select(func.count()).select_from(Event).where(Event.status == "approved")),
        "pending_tips": cnt(select(func.count()).select_from(Event).where(Event.status == "pending", Event.source == "tip")),
        "pending_paths": cnt(select(func.count()).select_from(PathEdit).where(PathEdit.status == "pending")),
        "users": cnt(select(func.count()).select_from(User)),
        "no_location": cnt(select(func.count()).select_from(Event).where(Event.status != "rejected", Event.lat.is_(None))),
        "tagged_events": cnt(select(func.count()).select_from(EventTag)),
        "ai_enabled": ai.enabled(),
        "ai_label": ai.label(),
        "seoul_sample_key": SEOUL_API_KEY == "sample",
        "collect_logs": [{"source": l.source, "at": iso(l.started_at), "found": l.found, "added": l.added,
                          "error": l.error} for l in logs],
        "jobs": _jobs,
        "meta": {"event_categories": EVENT_CATEGORIES, "path_kinds": PATH_KINDS},
    }


# ------------------------------------------------------------------ 모두에게 알림 보내기
@router.get("/broadcast/meta")
def broadcast_meta(db: Session = Depends(get_db)):
    """추천할 행사 목록(문구 미리 채움) + 최근 보낸 알림."""
    t = now()
    today = t.replace(hour=0, minute=0, second=0, microsecond=0)
    rows = db.scalars(select(Event).where(Event.status == "approved", Event.start_at.is_not(None), Event.start_at >= today,
                                          Event.start_at < today + timedelta(days=30)).order_by(Event.start_at).limit(80))
    evs = []
    for e in rows:
        title, body = push_svc.promo_text(e, t)
        evs.append({"id": e.id, "title": e.title, "start_at": iso(e.start_at), "in_area": in_area(e),
                    "msg_title": title, "msg_body": body})
    evs.sort(key=lambda x: not x["in_area"])
    recent = db.scalars(select(Broadcast).order_by(Broadcast.id.desc()).limit(10))
    return {"events": evs, "users": db.scalar(select(func.count()).select_from(User)),
            "recent": [{"id": b.id, "kind": b.kind, "title": b.title, "body": b.body, "sent": b.sent,
                        "at": iso(b.created_at)} for b in recent]}


class BroadcastIn(BaseModel):
    mode: str = Field(pattern="^(favorites|event|custom)$")
    hours: int = Field(3, ge=1, le=72)
    template: str = Field("즐겨찾기한 '{title}' 행사가 {n}시간 뒤에 시작합니다", max_length=200)
    event_id: int | None = None
    title: str = Field("", max_length=200)
    body: str = Field("", max_length=1000)
    link: str = Field("", max_length=200)


@router.post("/broadcast")
def broadcast(body: BroadcastIn, db: Session = Depends(get_db)):
    """모든 사용자에게 알림. favorites: n시간 안에 시작하는 즐겨찾기 행사가 있는 사람에게만,
    event: 행사 추천(모두), custom: 관리자가 쓴 문구 그대로(모두). 앱 사용자 휴대폰에도 15분 안에 뜸."""
    if body.mode == "favorites":
        n = push_svc.remind_favorites_now(db, body.hours, body.template or "즐겨찾기한 '{title}' 행사가 {n}시간 뒤에 시작합니다")
        return {"ok": True, "sent": n, "message": f"{n}명에게 즐겨찾기 행사 알림을 보냈습니다."}
    if body.mode == "event":
        e = db.get(Event, body.event_id or 0)
        if not e or e.status != "approved":
            raise HTTPException(400, "추천할 행사를 골라주세요.")
        t, b = push_svc.promo_text(e)
        bc = push_svc.broadcast_all(db, body.title.strip() or t, body.body.strip() or b, f"#/event/{e.id}", kind="event")
    else:
        if not body.title.strip():
            raise HTTPException(400, "알림 제목을 입력해주세요.")
        link = body.link.strip()
        if link and not (link.startswith("#/") or link.startswith("https://")):
            raise HTTPException(400, "링크는 #/ 로 시작하는 앱 화면이나 https:// 주소만 쓸 수 있습니다.")
        bc = push_svc.broadcast_all(db, body.title.strip(), body.body.strip(), link, kind="custom")
    return {"ok": True, "sent": bc.sent, "id": bc.id,
            "message": f"가입자 {bc.sent}명의 앱 알림함에 넣었습니다. 앱을 설치한 휴대폰에는 15분 안에 알림이 뜹니다."}


# ------------------------------------------------------------------ 행사
class EventIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    category: str = "community"
    start_at: datetime | None = None
    end_at: datetime | None = None
    time_text: str = ""
    place_name: str = ""
    lat: float | None = None
    lng: float | None = None
    description: str = ""
    host: str = ""
    contact: str = ""
    fee: str = ""
    url: str = ""
    image_url: str = ""
    status: str | None = None


def _admin_event(e: Event) -> dict:
    out = event_out(e, full=True)
    out.update({"status": e.status, "ai_note": e.ai_note, "source_id": e.source_id, "created_at": iso(e.created_at)})
    if e.source == "tip" and e.image_url:
        out["poster_admin_url"] = tips.poster_url(e, signed=True)
    return out


@router.get("/events")
def admin_events(status: str = "pending", source: str | None = None, area: str = "all", db: Session = Depends(get_db)):
    """area: all | in(월계동 안) | out(월계동 밖·위치 없음)"""
    stmt = select(Event).order_by(Event.created_at.desc()).limit(300 if area == "all" else 2000)
    if status != "all":
        stmt = stmt.where(Event.status == status)
    if source:
        stmt = stmt.where(Event.source == source)
    rows = list(db.scalars(stmt))
    if area in ("in", "out"):
        rows = [e for e in rows if in_area(e) == (area == "in")][:300]
    return [_admin_event(e) for e in rows]


class BulkIn(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=300)
    status: str = Field(pattern="^(approved|rejected|pending)$")


@router.post("/events/bulk")
def bulk_status(body: BulkIn, db: Session = Depends(get_db)):
    """여러 행사를 한 번에 승인·반려."""
    done = 0
    for e in db.scalars(select(Event).where(Event.id.in_(body.ids))):
        if e.status != body.status:
            _apply_event(e, EventIn(title=e.title, status=body.status), db)
            done += 1
    return {"ok": True, "changed": done}


class ApprovePendingIn(BaseModel):
    area: str = Field("all", pattern="^(all|in)$")      # in: 월계동 안 행사만


@router.post("/events/approve-pending")
def approve_pending(body: ApprovePendingIn, db: Session = Depends(get_db)):
    """승인 대기 행사를 한 번에 공개 (먼저 장소 이름으로 위치를 찾아 둠)."""
    places.fill_missing(db, statuses=("pending",))
    rows = list(db.scalars(select(Event).where(Event.status == "pending")))
    if body.area == "in":
        rows = [e for e in rows if in_area(e)]
    for e in rows:
        _apply_event(e, EventIn(title=e.title, status="approved"), db)
    return {"ok": True, "approved": len(rows), "inside": sum(1 for e in rows if in_area(e))}


@router.post("/events/locate")
def locate_events(db: Session = Depends(get_db)):
    """좌표 없는 행사의 장소 이름으로 지도 위치를 찾음 (월계동 지도 이름·별칭·카카오)."""
    places.reset()
    return {"ok": True, **places.fill_missing(db)}


@router.post("/search-tags")
def make_search_tags():
    """AI로 행사마다 검색용 연관 키워드를 붙임 (한 번에 최대 120개)."""
    if not ai.enabled():
        raise HTTPException(400, "AI 키(GEMINI_API_KEY)가 없어 쓸 수 없습니다. 연관어 사전 검색은 AI 없이도 동작합니다.")

    def job():
        with SessionLocal() as db:
            return search_svc.tag_batch(db, limit=120)
    return _run_job("tags", job)


def _apply_event(e: Event, body: EventIn, db: Session):
    was = e.status
    data = body.model_dump(exclude_unset=True)
    status = data.pop("status", None)
    if "category" in data and data["category"] not in EVENT_CATEGORIES:
        raise HTTPException(400, "카테고리가 올바르지 않습니다.")
    for k, v in data.items():
        setattr(e, k, v if v is not None or k in ("start_at", "end_at", "lat", "lng") else "")
    if status:
        if status not in ("pending", "approved", "rejected"):
            raise HTTPException(400, "상태가 올바르지 않습니다.")
        # 위치가 없어도 승인할 수 있음: 지도·달력에는 안 나오고 '검색'에서만 나옴 (월계동 밖 행사와 같음)
        if status == "approved" and e.lat is None and e.place_name:
            hit = places.locate(e.place_name)
            if hit:
                e.lat, e.lng = hit[0], hit[1]
        e.status = status
    db.commit()
    if was != "approved" and e.status == "approved":
        notify_new_event(db, e)
        db.commit()
    if e.source == "tip" and was != e.status and e.status in ("approved", "rejected"):
        tips.notify_tipster(db, e)
        db.commit()


@router.post("/events")
def create_event(body: EventIn, db: Session = Depends(get_db)):
    e = Event(source="manual", source_id="", status="pending", title=body.title)
    db.add(e)
    db.flush()
    e.source_id = f"m{e.id}"
    if body.status is None:
        body.status = "approved"
    _apply_event(e, body, db)
    return _admin_event(e)


@router.patch("/events/{event_id}")
def edit_event(event_id: int, body: EventIn, db: Session = Depends(get_db)):
    e = db.get(Event, event_id)
    if not e:
        raise HTTPException(404, "행사를 찾을 수 없습니다.")
    _apply_event(e, body, db)
    return _admin_event(e)


@router.delete("/events/{event_id}")
def delete_event(event_id: int, db: Session = Depends(get_db)):
    e = db.get(Event, event_id)
    if e:
        tips.delete_poster(e)
        db.delete(e)
        db.commit()
    return {"ok": True}


@router.post("/events/{event_id}/reextract")
def reextract_event(event_id: int, db: Session = Depends(get_db)):
    e = db.get(Event, event_id)
    if not e:
        raise HTTPException(404, "행사를 찾을 수 없습니다.")
    if e.source != "kw" or not e.url:
        raise HTTPException(400, "광운대 공지에서 수집한 행사만 다시 읽을 수 있습니다.")
    try:
        changed = collect.reextract_kw(e)
    except Exception as ex:
        raise HTTPException(502, f"공지를 다시 읽지 못했습니다: {type(ex).__name__}")
    db.commit()
    return {"changed": changed, "event": _admin_event(e)}


@router.post("/events/{event_id}/ai-fill")
def ai_fill_event(event_id: int, db: Session = Depends(get_db)):
    """빈칸 제안값만 돌려줌 (관리자가 확인 후 저장)."""
    e = db.get(Event, event_id)
    if not e:
        raise HTTPException(404, "행사를 찾을 수 없습니다.")
    if not ai.enabled():
        raise HTTPException(400, "AI 키(GEMINI_API_KEY)가 없어 쓸 수 없습니다.")
    if not eventfill.missing(e):
        return {"suggestions": {}, "message": "비어 있는 칸이 없습니다."}
    try:
        sug = eventfill.suggest(e)
    except ai.QuotaError as ex:
        raise HTTPException(429, str(ex))
    except Exception as ex:
        raise HTTPException(502, f"AI 호출에 실패했습니다: {type(ex).__name__}")
    out = {k: (iso(v) if isinstance(v, datetime) else v) for k, v in sug.items()}
    return {"suggestions": out, "message": "채울 수 있는 칸을 찾지 못했습니다." if not out else ""}


@router.post("/ai-fill")
def ai_fill_all(status: str = "pending"):
    statuses = ("pending", "approved") if status == "all" else (status,)

    def job():
        with SessionLocal() as db:
            return eventfill.batch(db, statuses)
    return _run_job("aifill", job)


@router.post("/collect")
def collect_now():
    def job():
        with SessionLocal() as db:
            return {"ok": True, "results": collect.collect_all(db)}
    return _run_job("collect", job)


@router.get("/jobs/{name}")
def job_status(name: str):
    return _jobs.get(name) or {"running": False, "result": None}


# ------------------------------------------------------------------ 길 제보
class PathPatch(BaseModel):
    status: str | None = None
    note: str | None = None
    open_hours: str | None = None


@router.get("/paths")
def admin_paths(status: str = "pending", db: Session = Depends(get_db)):
    stmt = select(PathEdit).order_by(PathEdit.id.desc()).limit(500)
    if status != "all":
        stmt = stmt.where(PathEdit.status == status)
    return [path_out(p) for p in db.scalars(stmt)]


@router.post("/paths")
def admin_add_path(body: PathIn, db: Session = Depends(get_db)):
    validate_path(body)
    p = PathEdit(user_id=None, kind=body.kind, coords=path_coords_json(body), note=body.note,
                 open_hours=body.open_hours, status="approved")
    db.add(p)
    db.commit()
    return path_out(p)


@router.patch("/paths/{path_id}")
def patch_path(path_id: int, body: PathPatch, db: Session = Depends(get_db)):
    p = db.get(PathEdit, path_id)
    if not p:
        raise HTTPException(404, "제보를 찾을 수 없습니다.")
    old = p.status
    if body.note is not None:
        p.note = body.note
    if body.open_hours is not None:
        p.open_hours = body.open_hours
    if body.status:
        if body.status not in ("pending", "approved", "rejected"):
            raise HTTPException(400, "상태가 올바르지 않습니다.")
        p.status = body.status
    db.commit()
    if p.user_id and old != p.status and p.status in ("approved", "rejected"):
        msg = "반영되었습니다. 이제 길찾기에 사용됩니다." if p.status == "approved" else "검토 결과 반영하지 않았습니다."
        notify(db, p.user_id, "path_status", f"길 제보가 {msg}", PATH_KINDS.get(p.kind, ""), "#/route",
               f"path:{p.id}:{p.status}")
        db.commit()
    return path_out(p)


@router.delete("/paths/{path_id}")
def delete_path(path_id: int, db: Session = Depends(get_db)):
    p = db.get(PathEdit, path_id)
    if p:
        db.delete(p)
        db.commit()
    return {"ok": True}


# ------------------------------------------------------------------ 공사 구간
class ConstructionIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    lat: float
    lng: float
    radius_m: float = Field(default=40, ge=5, le=300)
    start_date: datetime | None = None
    end_date: datetime | None = None
    dust: bool = True
    note: str = ""
    active: bool = True


@router.get("/constructions")
def list_constructions(db: Session = Depends(get_db)):
    return [construction_out(c) for c in db.scalars(select(Construction).order_by(Construction.id.desc()))]


@router.post("/constructions")
def add_construction(body: ConstructionIn, db: Session = Depends(get_db)):
    c = Construction(**body.model_dump())
    db.add(c)
    db.commit()
    return construction_out(c)


@router.patch("/constructions/{cid}")
def edit_construction(cid: int, body: ConstructionIn, db: Session = Depends(get_db)):
    c = db.get(Construction, cid)
    if not c:
        raise HTTPException(404, "공사 구간을 찾을 수 없습니다.")
    for k, v in body.model_dump().items():
        setattr(c, k, v)
    db.commit()
    return construction_out(c)


@router.delete("/constructions/{cid}")
def delete_construction(cid: int, db: Session = Depends(get_db)):
    c = db.get(Construction, cid)
    if c:
        db.delete(c)
        db.commit()
    return {"ok": True}


# ------------------------------------------------------------------ 행사 초기화
class ResetIn(BaseModel):
    scope: str = "all"          # all / collected / pending
    confirm: str = ""


RESET_SCOPES = {"all": "모든 행사", "collected": "자동 수집·구청 자료 행사 (직접 등록·주민 제보는 남김)", "pending": "승인 대기 행사"}


@router.post("/events/reset")
def reset_events(body: ResetIn, db: Session = Depends(get_db)):
    """행사를 한꺼번에 지움 (즐겨찾기·후기·후기 사진·제보 포스터·행사 알림도 함께). 되돌릴 수 없음."""
    if body.confirm.strip() != "초기화":
        raise HTTPException(400, "확인 칸에 '초기화'라고 적어주세요.")
    if body.scope not in RESET_SCOPES:
        raise HTTPException(400, "초기화 범위가 올바르지 않습니다.")
    from ..models import Notification, Review
    from .media import delete_review_files
    stmt = select(Event)
    if body.scope == "collected":
        stmt = stmt.where(Event.source.in_(("seoul", "kw", "nowon")))
    elif body.scope == "pending":
        stmt = stmt.where(Event.status == "pending")
    rows = list(db.scalars(stmt))
    n_rev = 0
    for e in rows:
        for r in db.scalars(select(Review).where(Review.event_id == e.id)):
            delete_review_files(r)
            n_rev += 1
        tips.delete_poster(e)
        db.query(Notification).filter(Notification.link == f"#/event/{e.id}").delete(synchronize_session=False)
        db.delete(e)
    db.commit()
    return {"ok": True, "deleted": len(rows), "reviews": n_rev, "scope": RESET_SCOPES[body.scope]}


@router.post("/official/reimport")
def official_reimport(db: Session = Depends(get_db)):
    """함께 들어 있는 구청 자료(예: 노원구 9월 주요행사계획)를 다시 넣음. 이미 있는 행사는 건너뜀."""
    res = official.import_bundled(db, force=True)
    return {"ok": True, "files": res, "added": sum(r.get("added", 0) for r in res)}


# ------------------------------------------------------------------ 공식 행사 자료 (구청 주요행사계획)
@router.post("/official/upload")
async def official_upload(file: UploadFile = File(...)):
    raw = await file.read()
    if len(raw) > 30 * 1024 * 1024:
        raise HTTPException(413, "파일이 너무 큽니다 (30MB 이하).")
    name = file.filename or "upload"

    def job():
        with SessionLocal() as db:
            return official.import_upload(db, name, raw)
    if raw[:5] == b"%PDF-":          # PDF는 AI가 읽는 데 1~3분 → 백그라운드 작업
        return _run_job("official", job)
    try:
        return await run_in_threadpool(job)
    except (ValueError, KeyError, UnicodeDecodeError, json.JSONDecodeError) as e:
        raise HTTPException(400, f"행사 파일을 읽지 못했습니다: {e}")


# ------------------------------------------------------------------ 지도 데이터
@router.post("/osm/refresh")
def osm_refresh():
    return _run_job("osm", osm_update.update_osm)


@router.post("/osm/upload")
async def osm_upload(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        return await run_in_threadpool(osm_update.import_geojson, raw)
    except (ValueError, KeyError, json.JSONDecodeError) as e:
        raise HTTPException(400, f"지도 파일을 읽지 못했습니다: {e}")


@router.post("/app/apk")
async def upload_apk(file: UploadFile = File(...)):
    """안드로이드 앱(APK) 올리기 → 웹으로 들어온 사람에게 설치 안내가 뜸 (/download/wolgyeon.apk)."""
    raw = await file.read()
    if len(raw) > 150 * 1024 * 1024:
        raise HTTPException(400, "파일이 너무 큽니다 (150MB까지).")
    if raw[:2] != b"PK" or not (file.filename or "").lower().endswith(".apk"):
        raise HTTPException(400, "APK 파일(.apk)만 올릴 수 있습니다.")
    APK_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = APK_PATH.with_suffix(".tmp")
    tmp.write_bytes(raw)
    tmp.replace(APK_PATH)
    return {"ok": True, "size_mb": round(len(raw) / 1048576, 1)}


@router.delete("/app/apk")
def delete_apk():
    APK_PATH.unlink(missing_ok=True)
    return {"ok": True}


@router.post("/elevation/refresh")
def elevation_refresh():
    return _run_job("elevation", osm_update.fetch_elevation)


# ------------------------------------------------------------------ 사용자
@router.get("/users")
def users(db: Session = Depends(get_db)):
    return [{"id": u.id, "username": u.username, "nickname": u.nickname, "is_admin": u.is_admin,
             "created_at": iso(u.created_at)} for u in db.scalars(select(User).order_by(User.id))]


@router.post("/users/{uid}/admin")
def set_admin(uid: int, value: bool, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    u = db.get(User, uid)
    if not u:
        raise HTTPException(404, "사용자를 찾을 수 없습니다.")
    if u.id == admin.id and not value:
        raise HTTPException(400, "자기 자신의 관리자 권한은 해제할 수 없습니다.")
    u.is_admin = value
    db.commit()
    return {"ok": True}
