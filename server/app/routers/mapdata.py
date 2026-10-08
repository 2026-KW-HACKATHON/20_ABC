"""지도 데이터, 보행 그래프, 가게 목록, 공사 구간, 길 제보."""
import hashlib
import json
import threading

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import require_user
from ..db import get_db
from ..models import PATH_KINDS, Construction, PathEdit, User, now
from ..services import geo
from ..services.poi_labels import POI_LABELS
from .events import iso

router = APIRouter(prefix="/api/map", tags=["map"])

_graph_lock = threading.Lock()
_graph_cache: dict = {}


def _json(request: Request, payload, max_age=300) -> Response:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    etag = '"' + hashlib.md5(body).hexdigest() + '"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return Response(body, media_type="application/json",
                    headers={"ETag": etag, "Cache-Control": f"public, max-age={max_age}"})


def active_constructions(db: Session) -> list[Construction]:
    t = now()
    return list(db.scalars(select(Construction).where(
        Construction.active.is_(True),
        or_(Construction.start_date.is_(None), Construction.start_date <= t),
        or_(Construction.end_date.is_(None), Construction.end_date >= t.replace(hour=0, minute=0)))))


def construction_out(c: Construction) -> dict:
    return {"id": c.id, "title": c.title, "lat": c.lat, "lng": c.lng, "radius_m": c.radius_m,
            "start_date": iso(c.start_date), "end_date": iso(c.end_date), "dust": c.dust, "note": c.note,
            "active": c.active}


def graph_with_overlays(db: Session) -> dict:
    edits = list(db.scalars(select(PathEdit).where(PathEdit.status == "approved").order_by(PathEdit.id)))
    cons = active_constructions(db)
    sig = json.dumps([[e.id, iso(e.updated_at)] for e in edits] + [[c.id, iso(c.updated_at)] for c in cons]
                     + [geo.osm_path().stat().st_mtime_ns, geo.generation])
    with _graph_lock:
        if _graph_cache.get("sig") == sig:
            return _graph_cache["data"]
        base = geo.base_graph()
        g = geo.apply_overlays(
            base,
            [{"kind": e.kind, "open_hours": e.open_hours, **_geom(e.coords)} for e in edits],
            [{"lat": c.lat, "lng": c.lng, "radius_m": c.radius_m} for c in cons])
        g["z"] = [construction_out(c) for c in cons]
        _graph_cache.update(sig=sig, data=g)
        return g


@router.get("/basemap")
def basemap(request: Request):
    return _json(request, geo.basemap(), 3600)


@router.get("/graph")
def graph(request: Request, db: Session = Depends(get_db)):
    return _json(request, graph_with_overlays(db), 60)


@router.get("/pois")
def pois(request: Request):
    return _json(request, {"labels": POI_LABELS, "items": geo.pois()}, 3600)


@router.get("/constructions")
def constructions(db: Session = Depends(get_db)):
    return [construction_out(c) for c in active_constructions(db)]


# ------------------------------------------------------------------ 길 제보
class PathIn(BaseModel):
    kind: str
    coords: list[list[float]] = Field(default_factory=list, max_length=60)
    # 계단·가파른 길은 손가락으로 칠한 범위: 여러 획(각 획은 점 목록) + 붓 반지름(m)
    strokes: list[list[list[float]]] | None = Field(default=None, max_length=30)
    brush_m: float = Field(default=8, ge=3, le=25)
    note: str = Field(default="", max_length=500)
    open_hours: str = Field(default="", max_length=40)


PAINT_KINDS = ("stairs", "steep")


def _geom(raw: str) -> dict:
    """저장된 좌표 JSON → {coords, strokes, brush_m}. 칠하기 제보는 {"strokes": [...], "r": 8} 형태로 저장."""
    c = json.loads(raw)
    if isinstance(c, dict):
        return {"coords": [], "strokes": c.get("strokes") or [], "brush_m": c.get("r", 8)}
    return {"coords": c, "strokes": None, "brush_m": None}


def path_coords_json(body: PathIn) -> str:
    if body.strokes:
        return json.dumps({"strokes": [[[round(a, 6), round(b, 6)] for a, b in s] for s in body.strokes],
                           "r": round(body.brush_m, 1)})
    return json.dumps(body.coords)


def path_out(p: PathEdit) -> dict:
    return {"id": p.id, "kind": p.kind, "kind_label": PATH_KINDS.get(p.kind, ""), **_geom(p.coords),
            "note": p.note, "open_hours": p.open_hours, "status": p.status, "created_at": iso(p.created_at)}


def validate_path(body: PathIn) -> None:
    if body.kind not in PATH_KINDS:
        raise HTTPException(400, "제보 종류가 올바르지 않습니다.")
    if body.strokes is not None:
        if body.kind not in PAINT_KINDS:
            raise HTTPException(400, "칠하기는 계단·가파른 길 제보에서만 쓸 수 있습니다.")
        pts = [c for s in body.strokes for c in s]
        if not pts or any(not s for s in body.strokes):
            raise HTTPException(400, "지도 위를 손가락으로 칠해주세요.")
        if len(pts) > 1500:
            raise HTTPException(400, "칠한 범위가 너무 넓습니다. 나눠서 제보해주세요.")
    else:
        pts = body.coords
        if not pts:
            raise HTTPException(400, "지도에 위치를 찍어주세요.")
    if body.kind in ("add", "gate") and len(body.coords) < 2:
        raise HTTPException(400, "길은 두 점 이상 찍어주세요.")
    for c in pts:
        if len(c) != 2 or not (37.55 < c[0] < 37.70 and 126.98 < c[1] < 127.15):
            raise HTTPException(400, "월계1동 근처 좌표만 제보할 수 있습니다.")
    if body.open_hours and not _valid_hours(body.open_hours):
        raise HTTPException(400, "통행 시간은 06:00-23:00 형식으로 적어주세요.")


def _valid_hours(h: str) -> bool:
    import re
    m = re.fullmatch(r"(\d{2}):(\d{2})-(\d{2}):(\d{2})", h.strip())
    return bool(m) and all(0 <= int(x) < 60 for x in m.groups()[1::2]) and all(0 <= int(x) <= 24 for x in m.groups()[::2])


@router.get("/paths/meta")
def path_meta():
    return PATH_KINDS


@router.post("/paths")
def submit_path(body: PathIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    validate_path(body)
    recent = db.scalar(select(func.count()).select_from(PathEdit).where(
        PathEdit.user_id == user.id, PathEdit.status == "pending"))
    if recent >= 20 and not user.is_admin:
        raise HTTPException(429, "검토 대기 중인 길 제보가 너무 많습니다. 승인 후 다시 제보해주세요.")
    p = PathEdit(user_id=user.id, kind=body.kind, coords=path_coords_json(body), note=body.note.strip(),
                 open_hours=body.open_hours.strip(), status="approved" if user.is_admin else "pending")
    db.add(p)
    db.commit()
    return path_out(p)


@router.get("/paths/mine")
def my_paths(user: User = Depends(require_user), db: Session = Depends(get_db)):
    return [path_out(p) for p in db.scalars(select(PathEdit).where(PathEdit.user_id == user.id).order_by(PathEdit.id.desc()))]


@router.get("/paths/approved")
def approved_paths(db: Session = Depends(get_db)):
    return [path_out(p) for p in db.scalars(select(PathEdit).where(PathEdit.status == "approved"))]
