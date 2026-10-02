"""관리자 — 행사 승인, 신고 처리, 길 제보 검토, 공사 구간, 지도 데이터."""
import json
import threading
from datetime import datetime

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import require_admin
from ..config import SEOUL_API_KEY
from ..db import SessionLocal, get_db
from ..models import (EVENT_CATEGORIES, PATH_KINDS, REPORT_CATEGORIES, REPORT_STATUS, CollectLog, Construction, Event,
                      PathEdit, Report, User, now)
from ..services import ai, collect, official, osm_update
from ..services.notify import notify, notify_new_event
from .events import event_out, iso
from .mapdata import PathIn, construction_out, path_out, validate_path
from .reports import report_out

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
        "open_reports": cnt(select(func.count()).select_from(Report).where(Report.status.in_(("received", "checking")))),
        "pending_paths": cnt(select(func.count()).select_from(PathEdit).where(PathEdit.status == "pending")),
        "users": cnt(select(func.count()).select_from(User)),
        "ai_enabled": ai.enabled(),
        "ai_label": ai.label(),
        "seoul_sample_key": SEOUL_API_KEY == "sample",
        "collect_logs": [{"source": l.source, "at": iso(l.started_at), "found": l.found, "added": l.added,
                          "error": l.error} for l in logs],
        "jobs": _jobs,
        "meta": {"event_categories": EVENT_CATEGORIES, "report_categories": REPORT_CATEGORIES,
                 "report_status": REPORT_STATUS, "path_kinds": PATH_KINDS},
    }


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
    return out


@router.get("/events")
def admin_events(status: str = "pending", db: Session = Depends(get_db)):
    stmt = select(Event).order_by(Event.created_at.desc()).limit(300)
    if status != "all":
        stmt = stmt.where(Event.status == status)
    return [_admin_event(e) for e in db.scalars(stmt)]


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
        if status == "approved" and (e.lat is None or e.lng is None):
            raise HTTPException(400, "지도에 표시할 위치를 먼저 지정해주세요.")
        e.status = status
    db.commit()
    if was != "approved" and e.status == "approved":
        notify_new_event(db, e)
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


@router.post("/collect")
def collect_now():
    def job():
        with SessionLocal() as db:
            return {"ok": True, "results": collect.collect_all(db)}
    return _run_job("collect", job)


@router.get("/jobs/{name}")
def job_status(name: str):
    return _jobs.get(name) or {"running": False, "result": None}


# ------------------------------------------------------------------ 신문고
class ReportPatch(BaseModel):
    status: str | None = None
    category: str | None = None
    admin_note: str | None = Field(default=None, max_length=1000)


@router.get("/reports")
def admin_reports(status: str = "open", db: Session = Depends(get_db)):
    stmt = select(Report).order_by(Report.created_at.desc()).limit(500)
    if status == "open":
        stmt = stmt.where(Report.status.in_(("received", "checking")))
    elif status != "all":
        stmt = stmt.where(Report.status == status)
    out = []
    for r in db.scalars(stmt):
        d = report_out(r, private=True)
        d["reporter"] = r.user.nickname if r.user else "-"
        out.append(d)
    return out


@router.patch("/reports/{report_id}")
def patch_report(report_id: int, body: ReportPatch, db: Session = Depends(get_db)):
    r = db.get(Report, report_id)
    if not r:
        raise HTTPException(404, "신고를 찾을 수 없습니다.")
    old = r.status
    if body.category:
        if body.category not in REPORT_CATEGORIES:
            raise HTTPException(400, "유형이 올바르지 않습니다.")
        r.category = body.category
    if body.admin_note is not None:
        r.admin_note = body.admin_note
    if body.status:
        if body.status not in REPORT_STATUS:
            raise HTTPException(400, "상태가 올바르지 않습니다.")
        r.status = body.status
    db.commit()
    if old != r.status:
        notify(db, r.user_id, "report_status", f"신고가 '{REPORT_STATUS[r.status]}' 상태로 바뀌었습니다",
               (REPORT_CATEGORIES.get(r.category, "") + (f" · {r.admin_note}" if r.admin_note else "")),
               f"#/report/{r.id}", f"report:{r.id}:{r.status}")
        db.commit()
    d = report_out(r, private=True)
    d["reporter"] = r.user.nickname if r.user else "-"
    return d


@router.post("/reports/{report_id}/to-construction")
def report_to_construction(report_id: int, db: Session = Depends(get_db)):
    r = db.get(Report, report_id)
    if not r:
        raise HTTPException(404, "신고를 찾을 수 없습니다.")
    c = Construction(title=r.ai_summary or "주민 제보 공사 구간", lat=r.lat, lng=r.lng, radius_m=40,
                     dust=True, note=r.description, report_id=r.id)
    db.add(c)
    r.status = "checking" if r.status == "received" else r.status
    db.commit()
    return construction_out(c)


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
    p = PathEdit(user_id=None, kind=body.kind, coords=json.dumps(body.coords), note=body.note,
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
