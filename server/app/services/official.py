"""구청 등 공식 행사 자료 가져오기

1) 정리된 JSON (app/seed/official/*.json, data/official/*.json) — 서버가 켜질 때 자동 등록(승인 상태)
2) 관리자가 올린 월간 '주요행사계획' PDF — AI가 행사를 뽑아 승인 대기로 등록

JSON 형식
{"source": "nowon", "title": "노원구 2026년 9월 주요행사계획", "issuer": "노원구 기획예산과", "month": "2026-09",
 "url": "...", "events": [{"key": "고유키", "title": "...", "category": "culture|academic|community",
 "start": "YYYY-MM-DD[ HH:MM]", "end": "...", "time_text": "...", "place": "...", "lat": 37.6, "lng": 127.0,
 "description": "...", "host": "...", "target": "...", "fee": "..."}]}
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import re
from datetime import datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import DATA_DIR
from ..models import EVENT_CATEGORIES, Event
from . import ai

log = logging.getLogger("wolgyeon.official")
SEED_DIR = Path(__file__).resolve().parent.parent / "seed" / "official"


def _dt(s: str | None) -> datetime | None:
    if not s:
        return None
    s = s.strip().replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(s[:16] if " " in s else s[:10], fmt)
        except ValueError:
            continue
    return None


def _key(month: str, e: dict) -> str:
    k = e.get("key") or hashlib.sha1(f"{e.get('title','')}|{e.get('start','')}|{e.get('place','')}".encode()).hexdigest()[:12]
    return f"{month}:{k}"[:120]


def import_doc(db: Session, doc: dict, status: str = "approved") -> dict:
    """이미 있는 행사(같은 source·key)는 건드리지 않음 — 관리자가 고친 내용이 유지됨."""
    src = (doc.get("source") or "official")[:20]
    month = doc.get("month") or ""
    note = f"공식 자료: {doc.get('title', '')}" + (f" ({doc['issuer']})" if doc.get("issuer") else "")
    added = skipped = 0
    for e in doc.get("events", []):
        title = (e.get("title") or "").strip()
        if not title:
            continue
        sid = _key(month, e)
        if db.scalar(select(Event.id).where(Event.source == src, Event.source_id == sid)):
            skipped += 1
            continue
        start, end = _dt(e.get("start")), _dt(e.get("end"))
        if start and end and end < start:
            end = None
        desc = (e.get("description") or "").strip()
        if e.get("target"):
            desc += f"\n\n대상: {e['target']}"
        lat, lng = e.get("lat"), e.get("lng")
        ok_ll = isinstance(lat, (int, float)) and isinstance(lng, (int, float)) and 33 < lat < 39 and 124 < lng < 132
        db.add(Event(
            title=title[:300], category=e.get("category") if e.get("category") in EVENT_CATEGORIES else "community",
            start_at=start, end_at=end, time_text=(e.get("time_text") or "")[:200], place_name=(e.get("place") or "")[:200],
            lat=lat if ok_ll else None, lng=lng if ok_ll else None, description=desc[:4000],
            host=(e.get("host") or doc.get("issuer") or "")[:200], fee=(e.get("fee") or "")[:200],
            url=(doc.get("url") or "")[:500], source=src, source_id=sid, status=status, ai_note=note[:500],
        ))
        added += 1
    db.commit()
    return {"added": added, "skipped": skipped}


def import_bundled(db: Session) -> list[dict]:
    """서버 시작 시: 함께 들어 있는 공식 자료 JSON을 모두 등록 (새 행사만)."""
    out = []
    for d in (SEED_DIR, DATA_DIR / "official"):
        if not d.exists():
            continue
        for f in sorted(d.glob("*.json")):
            try:
                doc = json.loads(f.read_text(encoding="utf-8"))
                r = import_doc(db, doc)
                if r["added"]:
                    log.info("공식 행사 자료 %s: %d건 등록", f.name, r["added"])
                out.append({"file": f.name, **r})
            except Exception as e:
                db.rollback()
                log.warning("공식 행사 자료 %s 읽기 실패: %s", f.name, e)
    return out


# ------------------------------------------------------------------ PDF → AI 추출
_PDF_TOOL = {
    "name": "official_events",
    "description": "구청 월간 주요행사계획 문서에서 주민이 참여·관람할 수 있는 행사 목록을 뽑는다.",
    "input_schema": {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "문서 제목 (예: 노원구 2026년 10월 주요행사계획)"},
            "month": {"type": "string", "description": "문서 대상 연월 YYYY-MM"},
            "events": {"type": "array", "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "행사 이름"},
                    "category": {"type": "string", "enum": list(EVENT_CATEGORIES.keys()),
                                 "description": "; ".join(f"{k}={v}" for k, v in EVENT_CATEGORIES.items())},
                    "start": {"type": "string", "description": "시작 YYYY-MM-DD 또는 YYYY-MM-DD HH:MM"},
                    "end": {"type": "string", "description": "끝 (모르면 시작과 같은 날)"},
                    "time_text": {"type": "string", "description": "문서에 적힌 일시 그대로 짧게"},
                    "place": {"type": "string", "description": "장소 (주소가 있으면 괄호로)"},
                    "description": {"type": "string", "description": "주민이 보기 쉬운 1~2문장 소개"},
                    "host": {"type": "string", "description": "주최·주관 또는 담당 부서"},
                    "target": {"type": "string", "description": "참여 대상"},
                    "fee": {"type": "string", "description": "참가비·관람료 (없으면 빈 문자열)"},
                },
                "required": ["title", "category", "start", "end", "time_text", "place", "description", "host", "target", "fee"],
            }},
        },
        "required": ["title", "month", "events"],
    },
}
_PDF_SYSTEM = (
    "당신은 구청의 월간 '주요행사계획' 문서를 읽고 주민에게 알릴 행사를 고르는 담당자입니다. "
    "공연·전시·축제·강연·체험·체육대회·바자회처럼 주민이 참여하거나 관람할 수 있는 행사만 고르세요. "
    "위원회 회의, 직원 교육, 협약식, 내부 세미나, 특정 학교 학생만 대상인 행사, 급식 지원 대상자 전용 행사는 빼세요. "
    "표 안에 여러 행사가 있으면 각각 따로 적으세요. 연도가 없으면 문서의 연도를 쓰세요. 없는 정보는 지어내지 마세요."
)


def extract_pdf(pdf: bytes) -> dict:
    if not ai.enabled():
        raise RuntimeError("AI 키(GEMINI_API_KEY)가 없어 PDF에서 행사를 뽑을 수 없습니다. 정리된 JSON 파일을 올려주세요.")
    content = [
        {"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                        "data": base64.standard_b64encode(pdf).decode()}},
        {"type": "text", "text": "이 문서에서 주민 대상 행사를 모두 뽑아주세요."},
    ]
    out = ai.tool_call_long(_PDF_SYSTEM, content, _PDF_TOOL, 16000)
    month = out.get("month") or ""
    if not re.match(r"^\d{4}-\d{2}$", month):
        month = datetime.now().strftime("%Y-%m")
    return {"source": "nowon", "title": out.get("title") or "주요행사계획", "issuer": "노원구", "month": month,
            "url": "https://www.nowon.kr", "events": out.get("events") or []}


def import_upload(db: Session, filename: str, raw: bytes) -> dict:
    """관리자 업로드: .json 은 바로 승인, .pdf 는 AI로 뽑아서 승인 대기."""
    if raw[:5] == b"%PDF-":
        doc = extract_pdf(raw)
        status = "pending"
    else:
        doc = json.loads(raw.decode("utf-8"))
        if not isinstance(doc.get("events"), list):
            raise ValueError("JSON에 events 목록이 없습니다.")
        status = "approved"
    res = import_doc(db, doc, status=status)
    # 다음에 서버를 다시 켜도 남도록 원본 목록을 보관 (JSON만)
    if status == "approved":
        d = DATA_DIR / "official"
        d.mkdir(parents=True, exist_ok=True)
        safe = re.sub(r"[^\w.-]", "_", Path(filename or "upload.json").stem)[:60] or "upload"
        (d / f"{safe}.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"ok": True, "title": doc.get("title"), "month": doc.get("month"), "found": len(doc.get("events", [])),
            "status": status, **res}
