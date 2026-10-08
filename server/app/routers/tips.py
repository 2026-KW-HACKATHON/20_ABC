"""주민 행사 제보 — 구청·서울시 사이트에 없는 작은 동네 행사를 주민이 알려주면 관리자가 확인 후 게시.

- 로그인한 주민만 제보 (처리 결과를 앱 알림으로 알려주기 위해)
- 포스터·전단 사진을 올리면 AI가 행사 이름·일시·장소를 미리 채워줌 (선택)
- 제보는 Event(source="tip", status="pending") 로 저장 → 관리자 '행사 승인'에서 승인/반려
- 제보자·연락처는 관리자만 볼 수 있는 메모(ai_note)에만 남김
"""
import io
import logging
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageOps
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import check_value, require_user, sign_value
from ..config import DATA_DIR, MAX_UPLOAD_MB
from ..db import get_db
from ..models import EVENT_CATEGORIES, Event, User, now
from ..services import ai, geo
from ..services.notify import notify
from .events import event_out, iso

router = APIRouter(prefix="/api", tags=["tips"])
log = logging.getLogger("wolgyeon.tips")

POSTER_DIR = DATA_DIR / "posters"
MAX_PENDING = 5            # 한 사람이 동시에 걸어둘 수 있는 대기 제보 수
DAILY_TIPS = 10
DAILY_AI = 20
_ai_usage: dict[tuple[int, date], int] = defaultdict(int)
STATUS_LABEL = {"pending": "확인 중", "approved": "등록됨", "rejected": "반려"}


# ------------------------------------------------------------------ 사진
def _prepare_image(raw: bytes) -> bytes:
    if len(raw) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"사진은 {MAX_UPLOAD_MB:g}MB 이하만 올릴 수 있습니다.")
    try:
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
    except Exception:
        raise HTTPException(400, "사진 파일을 읽을 수 없습니다. JPG나 PNG로 다시 시도해주세요.")
    img.thumbnail((1600, 1600))
    out = io.BytesIO()
    img.save(out, "JPEG", quality=85, optimize=True)      # 촬영 위치 등 EXIF 정보는 저장하지 않음
    return out.getvalue()


def _poster_path(e: Event):
    return POSTER_DIR / f"{e.source_id.replace(':', '_')}.jpg"


def poster_url(e: Event, signed: bool = False) -> str:
    url = f"/api/events/{e.id}/poster"
    return url + (f"?sig={sign_value(f'poster{e.id}')}" if signed else "")


def delete_poster(e: Event):
    if e.source == "tip":
        _poster_path(e).unlink(missing_ok=True)


@router.get("/events/{event_id}/poster", include_in_schema=False)
def get_poster(event_id: int, sig: str | None = None, db: Session = Depends(get_db)):
    """게시된 행사의 포스터는 누구나, 확인 중인 제보의 포스터는 서명된 주소(관리자)로만."""
    e = db.get(Event, event_id)
    if not e or e.source != "tip" or not e.image_url:
        raise HTTPException(404, "사진이 없습니다.")
    if e.status != "approved" and not check_value(f"poster{e.id}", sig):
        raise HTTPException(403, "아직 공개되지 않은 사진입니다.")
    p = _poster_path(e)
    if not p.exists():
        raise HTTPException(404, "사진이 없습니다.")
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=600"})


# ------------------------------------------------------------------ 제보
def _tipster_id(e: Event) -> int | None:
    try:
        return int(e.source_id.split(":")[0].lstrip("u"))
    except (ValueError, AttributeError, IndexError):
        return None


def notify_tipster(db: Session, e: Event):
    uid = _tipster_id(e)
    if uid is None or not db.get(User, uid):
        return
    if e.status == "approved":
        notify(db, uid, "tip_result", f"제보한 행사가 지도에 올라갔어요: {e.title}",
               "알려주셔서 고마워요. 이웃들이 볼 수 있게 됐어요.", f"#/event/{e.id}", f"tip:{e.id}:approved")
    elif e.status == "rejected":
        notify(db, uid, "tip_result", f"제보한 행사를 올리지 못했어요: {e.title}",
               "정보가 부족하거나 확인이 어려운 행사였어요. 내용을 보완해서 다시 제보해주세요.", "#/tip", f"tip:{e.id}:rejected")


def _parse_dt(d: str, t: str) -> datetime | None:
    d, t = (d or "").strip(), (t or "").strip()
    if not d:
        return None
    try:
        return datetime.strptime(f"{d} {t or '00:00'}", "%Y-%m-%d %H:%M")
    except ValueError:
        raise HTTPException(400, "날짜·시간 형식이 올바르지 않습니다.")


def tip_out(e: Event) -> dict:
    out = event_out(e)
    out.update({"status": e.status, "status_label": STATUS_LABEL.get(e.status, e.status), "created_at": iso(e.created_at)})
    return out


@router.get("/tips/meta")
def tips_meta():
    return {"categories": EVENT_CATEGORIES, "ai_enabled": ai.enabled(), "ai_label": ai.label()}


@router.post("/tips/analyze")
async def analyze_poster(photo: UploadFile = File(...), user: User = Depends(require_user)):
    """포스터 사진을 AI로 읽어 양식을 미리 채울 값을 돌려줌 (저장하지 않음)."""
    img = _prepare_image(await photo.read())
    if not ai.enabled():
        return {"ai": False, "message": "AI 읽기가 꺼져 있어요. 내용을 직접 적어주세요."}
    key = (user.id, date.today())
    if _ai_usage[key] >= DAILY_AI and not user.is_admin:
        return {"ai": False, "message": "오늘 AI 읽기 횟수를 모두 썼어요. 내용을 직접 적어주세요."}
    _ai_usage[key] += 1
    try:
        res = ai.extract_poster(img, now().strftime("%Y-%m-%d"))
    except ai.QuotaError:
        return {"ai": False, "message": "AI 무료 사용 한도를 넘었어요. 내용을 직접 적어주세요."}
    except Exception as e:
        log.warning("포스터 읽기 실패: %s", e)
        return {"ai": False, "message": "사진을 읽지 못했어요. 내용을 직접 적어주세요."}
    if not res.get("is_event"):
        return {"ai": False, "message": "행사 안내 사진이 아닌 것 같아요. 내용을 직접 적어주세요."}
    return {"ai": True, **res}


@router.post("/tips")
async def create_tip(
    title: str = Form(...),
    category: str = Form("community"),
    start_date: str = Form(...),
    start_time: str = Form(""),
    end_date: str = Form(""),
    end_time: str = Form(""),
    place_name: str = Form(...),
    lat: float = Form(...),
    lng: float = Form(...),
    description: str = Form(""),
    host: str = Form(""),
    fee: str = Form(""),
    url: str = Form(""),
    contact: str = Form(""),
    photo: UploadFile | None = File(None),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    title, place_name = title.strip(), place_name.strip()
    if not (2 <= len(title) <= 100):
        raise HTTPException(400, "행사 이름을 2~100자로 적어주세요.")
    if not place_name:
        raise HTTPException(400, "장소 이름을 적어주세요.")
    if category not in EVENT_CATEGORIES:
        category = "community"
    if not geo.area_contains(lat, lng):
        raise HTTPException(400, "월계동 안에서 열리는 행사만 제보할 수 있어요. 지도에서 위치를 다시 골라주세요.")
    start = _parse_dt(start_date, start_time)
    end = _parse_dt(end_date, end_time) if end_date else (_parse_dt(start_date, end_time) if end_time else None)
    if end and end < start:
        raise HTTPException(400, "끝나는 시간이 시작보다 빠릅니다.")
    if (end or start) < now().replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=1):
        raise HTTPException(400, "이미 끝난 행사는 제보할 수 없어요.")
    url = url.strip()
    if url and not url.startswith(("http://", "https://")):
        url = "https://" + url
    mine = select(func.count()).select_from(Event).where(Event.source == "tip", Event.source_id.like(f"u{user.id}:%"))
    if not user.is_admin:
        if db.scalar(mine.where(Event.status == "pending")) >= MAX_PENDING:
            raise HTTPException(429, f"확인을 기다리는 제보가 {MAX_PENDING}개 있어요. 처리된 뒤에 더 제보해주세요.")
        if db.scalar(mine.where(Event.created_at >= now() - timedelta(days=1))) >= DAILY_TIPS:
            raise HTTPException(429, "오늘은 제보를 충분히 해주셨어요. 내일 다시 제보해주세요.")
    img = _prepare_image(await photo.read()) if photo is not None and photo.filename else None

    time_text = start.strftime("%m월 %d일 ") + (start_time or "")
    if end:
        time_text += " ~ " + (end.strftime("%m월 %d일 ") if end.date() != start.date() else "") + (end_time or "")
    e = Event(
        title=title, category=category, start_at=start, end_at=end, time_text=time_text.strip()[:200],
        place_name=place_name[:200], lat=round(lat, 6), lng=round(lng, 6), description=description.strip()[:2000],
        host=host.strip()[:200], fee=fee.strip()[:200], url=url[:500], source="tip",
        source_id=f"u{user.id}:{uuid.uuid4().hex[:10]}", status="pending",
        ai_note=f"주민 제보 · 제보자 {user.nickname} (@{user.username})" + (f" · 연락처 {contact.strip()[:80]}" if contact.strip() else ""),
    )
    db.add(e)
    db.flush()
    if img:
        POSTER_DIR.mkdir(parents=True, exist_ok=True)
        _poster_path(e).write_bytes(img)
        e.image_url = poster_url(e)
    db.commit()
    return tip_out(e)


@router.get("/tips/mine")
def my_tips(user: User = Depends(require_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(Event).where(Event.source == "tip", Event.source_id.like(f"u{user.id}:%"))
                      .order_by(Event.created_at.desc()).limit(50))
    return [tip_out(e) for e in rows]


@router.delete("/tips/{event_id}")
def cancel_tip(event_id: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    """확인 전인 내 제보 취소."""
    e = db.get(Event, event_id)
    if not e or e.source != "tip" or _tipster_id(e) != user.id:
        raise HTTPException(404, "제보를 찾을 수 없습니다.")
    if e.status != "pending":
        raise HTTPException(400, "이미 처리된 제보는 취소할 수 없어요.")
    delete_poster(e)
    db.delete(e)
    db.commit()
    return {"ok": True}


# ------------------------------------------------------------------ 같은 장소의 다른 행사
@router.get("/events/{event_id}/same-place")
def same_place(event_id: int, radius: float = Query(35, ge=5, le=200), db: Session = Depends(get_db)):
    """상세 화면용: 같은 장소(반경 radius m)에서 열리는 다른 행사 — 진행 중·예정 먼저, 지난 행사는 최근 순."""
    e = db.get(Event, event_id)
    if not e or e.lat is None:
        return {"current": [], "past": []}
    d = radius / 111000
    rows = db.scalars(select(Event).where(Event.status == "approved", Event.id != e.id,
                                          Event.lat.between(e.lat - d, e.lat + d), Event.lng.between(e.lng - d * 1.3, e.lng + d * 1.3)))
    today = now().replace(hour=0, minute=0, second=0, microsecond=0)
    cur, past = [], []
    for x in rows:
        if geo.dist_m(e.lat, e.lng, x.lat, x.lng) > radius:
            continue
        last = x.end_at or x.start_at
        (past if last and last < today else cur).append(x)
    cur.sort(key=lambda x: (x.start_at or datetime.max))
    past.sort(key=lambda x: (x.end_at or x.start_at), reverse=True)
    return {"current": [event_out(x) for x in cur[:20]], "past": [event_out(x) for x in past[:10]]}
