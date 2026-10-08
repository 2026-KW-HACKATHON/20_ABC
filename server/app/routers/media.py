"""행사 후기에 붙이는 사진·영상.

- 후기 1개당 최대 4개. 사진은 1600px JPEG로 줄이고 촬영 위치 등 EXIF는 지움, 영상은 원본 그대로(용량 제한)
- 후기가 공개이므로 첨부도 공개 주소로 제공 (파일 이름은 추측할 수 없는 난수)
"""
import io
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageOps
from sqlalchemy.orm import Session

from ..auth import require_user
from ..config import DATA_DIR, MAX_UPLOAD_MB, env
from ..db import get_db
from ..models import Review, ReviewMedia, User

router = APIRouter(prefix="/api", tags=["media"])
MEDIA_DIR = DATA_DIR / "media" / "reviews"
MAX_FILES = 4
MAX_VIDEO_MB = float(env("MAX_VIDEO_MB", "30"))
VIDEO_TYPES = {"video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "video/3gpp": ".3gp"}


def _save_image(raw: bytes) -> tuple[str, str, int]:
    if len(raw) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"사진은 {MAX_UPLOAD_MB:g}MB 이하만 올릴 수 있어요.")
    try:
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
    except Exception:
        raise HTTPException(400, "사진 파일을 읽을 수 없어요. JPG나 PNG로 올려주세요.")
    img.thumbnail((1600, 1600))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85, optimize=True)
    name = f"{uuid.uuid4().hex}.jpg"
    (MEDIA_DIR / name).write_bytes(buf.getvalue())
    return name, "image/jpeg", buf.tell()


def _save_video(raw: bytes, mime: str) -> tuple[str, str, int]:
    if len(raw) > MAX_VIDEO_MB * 1024 * 1024:
        raise HTTPException(413, f"영상은 {MAX_VIDEO_MB:g}MB 이하만 올릴 수 있어요. 짧게 잘라서 올려주세요.")
    name = f"{uuid.uuid4().hex}{VIDEO_TYPES[mime]}"
    (MEDIA_DIR / name).write_bytes(raw)
    return name, mime, len(raw)


@router.post("/reviews/{review_id}/media")
async def add_media(review_id: int, files: list[UploadFile] = File(...), user: User = Depends(require_user),
                    db: Session = Depends(get_db)):
    r = db.get(Review, review_id)
    if not r:
        raise HTTPException(404, "후기를 찾을 수 없어요.")
    if r.user_id != user.id:
        raise HTTPException(403, "본인 후기에만 사진·영상을 붙일 수 있어요.")
    if len(r.media) + len(files) > MAX_FILES:
        raise HTTPException(400, f"사진·영상은 후기 하나에 {MAX_FILES}개까지 올릴 수 있어요.")
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    saved = []
    for f in files:
        mime = (f.content_type or "").split(";")[0].lower()
        raw = await f.read()
        if mime in VIDEO_TYPES:
            name, mime, size = _save_video(raw, mime)
            kind = "video"
        elif mime.startswith("image/") or not mime:
            name, mime, size = _save_image(raw)
            kind = "image"
        else:
            raise HTTPException(400, "사진(JPG·PNG)이나 영상(MP4·MOV·WEBM)만 올릴 수 있어요.")
        m = ReviewMedia(review_id=r.id, kind=kind, filename=name, mime=mime, size=size)
        db.add(m)
        saved.append(m)
    db.commit()
    return [{"id": m.id, "kind": m.kind, "url": f"/api/media/reviews/{m.filename}"} for m in saved]


@router.get("/media/reviews/{name}", include_in_schema=False)
def get_media(name: str, db: Session = Depends(get_db)):
    m = db.query(ReviewMedia).filter(ReviewMedia.filename == name).one_or_none()
    p = MEDIA_DIR / name
    if not m or not p.exists():
        raise HTTPException(404, "파일이 없어요.")
    return FileResponse(p, media_type=m.mime, headers={"Cache-Control": "public, max-age=86400"})


def delete_review_files(r: Review):
    for m in r.media:
        (MEDIA_DIR / m.filename).unlink(missing_ok=True)
