"""사진 신문고."""
import io
import logging
from collections import defaultdict
from datetime import date

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from PIL import Image, ImageOps
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import check_value, optional_user, require_user, sign_value
from ..config import MAX_UPLOAD_MB
from ..db import get_db
from ..models import REPORT_CATEGORIES, REPORT_STATUS, Report, User
from ..services import ai
from ..services.cluster import hotspots
from .events import iso

router = APIRouter(prefix="/api/reports", tags=["reports"])
log = logging.getLogger("wolgyeon.reports")

DAILY_AI_LIMIT = 30
_ai_usage: dict[tuple[int, date], int] = defaultdict(int)


def _prepare_image(raw: bytes) -> tuple[bytes, bytes]:
    if len(raw) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"사진은 {MAX_UPLOAD_MB:g}MB 이하만 올릴 수 있습니다.")
    try:
        img = Image.open(io.BytesIO(raw))
        img = ImageOps.exif_transpose(img).convert("RGB")
    except Exception:
        raise HTTPException(400, "사진 파일을 읽을 수 없습니다. JPG나 PNG로 다시 시도해주세요.")
    big = img.copy()
    big.thumbnail((1600, 1600))
    b1 = io.BytesIO()
    big.save(b1, "JPEG", quality=85, optimize=True)   # 위치정보 등 EXIF는 저장하지 않음
    small = img.copy()
    small.thumbnail((360, 360))
    b2 = io.BytesIO()
    small.save(b2, "JPEG", quality=80)
    return b1.getvalue(), b2.getvalue()


def report_out(r: Report, private: bool = False) -> dict:
    out = {"id": r.id, "lat": r.lat, "lng": r.lng, "category": r.category,
           "category_label": REPORT_CATEGORIES.get(r.category, "기타"),
           "status": r.status, "status_label": REPORT_STATUS.get(r.status, ""),
           "summary": r.ai_summary, "created_at": iso(r.created_at), "updated_at": iso(r.updated_at)}
    if private:
        out.update({"description": r.description, "admin_note": r.admin_note, "ai_category": r.ai_category,
                    "ai_confidence": r.ai_confidence, "ai_severity": r.ai_severity,
                    "image_url": f"/api/reports/{r.id}/image?sig={sign_value(f'img{r.id}')}",
                    "thumb_url": f"/api/reports/{r.id}/thumb?sig={sign_value(f'img{r.id}')}"})
    return out


@router.get("/meta")
def meta():
    return {"categories": REPORT_CATEGORIES, "status": REPORT_STATUS, "ai_enabled": ai.enabled(), "ai_label": ai.label()}


@router.post("/analyze")
async def analyze(photo: UploadFile = File(...), note: str = Form(""), user: User = Depends(require_user)):
    """사진을 AI로 분류해서 유형을 제안 (저장하지 않음)."""
    img, _ = _prepare_image(await photo.read())
    if not ai.enabled():
        return {"ai": False, "message": "AI 분류가 꺼져 있습니다. 유형을 직접 골라주세요."}
    key = (user.id, date.today())
    if _ai_usage[key] >= DAILY_AI_LIMIT and not user.is_admin:
        return {"ai": False, "message": "오늘 AI 분류 횟수를 모두 썼습니다. 유형을 직접 골라주세요."}
    _ai_usage[key] += 1
    try:
        res = ai.classify_report(img, note)
    except ai.QuotaError:
        return {"ai": False, "message": "AI 무료 사용 한도를 넘었습니다. 유형을 직접 골라주세요."}
    except Exception as e:
        log.warning("AI 분류 실패: %s", e)
        return {"ai": False, "message": "AI 분류에 실패했습니다. 유형을 직접 골라주세요."}
    res["ai"] = True
    res["category_label"] = REPORT_CATEGORIES.get(res["category"], "신고 대상 아님")
    return res


@router.post("")
async def create_report(
    photo: UploadFile = File(...),
    lat: float = Form(...),
    lng: float = Form(...),
    category: str = Form(...),
    description: str = Form(""),
    ai_category: str = Form(""),
    ai_confidence: float = Form(0),
    ai_summary: str = Form(""),
    ai_severity: int = Form(0),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    if category not in REPORT_CATEGORIES:
        raise HTTPException(400, "신고 유형을 골라주세요.")
    if not (37.55 < lat < 37.70 and 126.98 < lng < 127.15):
        raise HTTPException(400, "월계1동 근처 위치만 신고할 수 있습니다.")
    img, thumb = _prepare_image(await photo.read())
    r = Report(user_id=user.id, lat=lat, lng=lng, category=category, description=description.strip()[:1000],
               ai_category=ai_category[:30], ai_confidence=max(0.0, min(1.0, ai_confidence)),
               ai_summary=ai_summary[:200], ai_severity=ai_severity, image=img, thumb=thumb)
    db.add(r)
    db.commit()
    return report_out(r, private=True)


@router.get("")
def public_reports(db: Session = Depends(get_db)):
    """지도 표시용 — 위치·유형·상태만 공개 (사진·신고자는 비공개)."""
    rows = db.scalars(select(Report).where(Report.status != "rejected").order_by(Report.created_at.desc()).limit(1000))
    return [report_out(r) for r in rows]


@router.get("/hotspots")
def get_hotspots(db: Session = Depends(get_db)):
    rows = db.scalars(select(Report).where(Report.status != "rejected"))
    data = [{"lat": r.lat, "lng": r.lng, "category": r.category, "status": r.status, "created_at": iso(r.created_at)}
            for r in rows]
    hs = hotspots(data)
    for h in hs:
        h["top_label"] = REPORT_CATEGORIES.get(h["top_category"], "기타")
    return hs


@router.get("/mine")
def my_reports(user: User = Depends(require_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(Report).where(Report.user_id == user.id).order_by(Report.created_at.desc()))
    return [report_out(r, private=True) for r in rows]


def _owned(report_id: int, user: User | None, db: Session) -> Report:
    r = db.get(Report, report_id)
    if not r:
        raise HTTPException(404, "신고를 찾을 수 없습니다.")
    if not user or (r.user_id != user.id and not user.is_admin):
        raise HTTPException(403, "신고한 사람과 관리자만 볼 수 있습니다.")
    return r


@router.get("/{report_id}")
def get_report(report_id: int, user: User | None = Depends(optional_user), db: Session = Depends(get_db)):
    return report_out(_owned(report_id, user, db), private=True)


def _image_row(report_id: int, sig: str | None, user: User | None, db: Session) -> Report:
    """서명된 주소(1시간 유효)이거나, 신고자 본인·관리자면 사진을 보여줌."""
    if check_value(f"img{report_id}", sig):
        r = db.get(Report, report_id)
        if not r:
            raise HTTPException(404, "신고를 찾을 수 없습니다.")
        return r
    return _owned(report_id, user, db)


@router.get("/{report_id}/image")
def image(report_id: int, sig: str | None = None, user: User | None = Depends(optional_user), db: Session = Depends(get_db)):
    r = _image_row(report_id, sig, user, db)
    return Response(r.image, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3000"})


@router.get("/{report_id}/thumb")
def thumb(report_id: int, sig: str | None = None, user: User | None = Depends(optional_user), db: Session = Depends(get_db)):
    r = _image_row(report_id, sig, user, db)
    return Response(r.thumb, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3000"})


@router.delete("/{report_id}")
def delete_report(report_id: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    r = _owned(report_id, user, db)
    if r.status != "received" and not user.is_admin:
        raise HTTPException(400, "이미 처리 중인 신고는 취소할 수 없습니다.")
    db.delete(r)
    db.commit()
    return {"ok": True}
