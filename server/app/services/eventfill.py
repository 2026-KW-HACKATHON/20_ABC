"""행사 정보 빈칸을 AI로 채우기.

원문 주소(url)가 있으면 그 페이지 글을 읽어 근거로 삼고, 없으면 알려진 정보로 소개만 정리한다.
날짜·장소·요금처럼 사실이 필요한 칸은 원문에 있을 때만 채움 (AI 지시 + 형식 검사).
"""
from __future__ import annotations

import logging
import re
import time
from datetime import datetime

import httpx
from bs4 import BeautifulSoup
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..models import Event, now
from . import ai

log = logging.getLogger("wolgyeon.fill")
UA = {"User-Agent": "Mozilla/5.0 (WolgyeON community app)"}
FIELDS = {"description": "소개", "start_at": "시작", "end_at": "끝", "time_text": "일시 설명",
          "place_name": "장소", "host": "주최", "fee": "요금"}


def missing(e: Event) -> list[str]:
    out = []
    if len((e.description or "").strip()) < 15:
        out.append("description")
    if e.start_at is None:
        out.append("start_at")
    if e.end_at is None:
        out.append("end_at")
    for f in ("time_text", "place_name", "host", "fee"):
        if not (getattr(e, f) or "").strip():
            out.append(f)
    return out


def source_text(e: Event) -> str:
    url = (e.url or "").strip()
    if not url.startswith(("http://", "https://")):
        return ""
    try:
        with httpx.Client(headers=UA, timeout=15, follow_redirects=True) as c:
            html = c.get(url).text
    except Exception as ex:
        log.info("원문을 못 읽음 %s: %s", url, ex)
        return ""
    if e.source == "kw":
        from .collect import parse_kw_body
        return parse_kw_body(html)
    soup = BeautifulSoup(html, "html.parser")
    for t in soup(["script", "style", "nav", "header", "footer", "noscript"]):
        t.decompose()
    return re.sub(r"\s+", " ", soup.get_text(" ", strip=True))[:8000]


def _dt(s: str) -> datetime | None:
    s = (s or "").strip()
    for fmt, n in (("%Y-%m-%d %H:%M", 16), ("%Y-%m-%d", 10)):
        try:
            return datetime.strptime(s[:n], fmt)
        except ValueError:
            continue
    return None


def suggest(e: Event, src: str | None = None) -> dict:
    """비어 있는 칸에 대한 제안값 (저장하지 않음). 키는 Event 필드 이름."""
    need = missing(e)
    if not need:
        return {}
    src = source_text(e) if src is None else src
    known = {"제목": e.title, "분류": e.category, "시작": e.start_at.isoformat(sep=" ", timespec="minutes") if e.start_at else "",
             "끝": e.end_at.isoformat(sep=" ", timespec="minutes") if e.end_at else "", "일시 설명": e.time_text,
             "장소": e.place_name, "주최": e.host, "요금": e.fee, "소개": e.description[:500]}
    out = ai.fill_event(known, src, now().strftime("%Y-%m-%d"))
    sug: dict = {}
    if "description" in need and out["description"]:
        desc = out["description"]
        if out["target"] and "대상" not in desc:
            desc += f"\n\n대상: {out['target']}"
        sug["description"] = desc[:2000]
    if src:     # 사실 정보는 원문이 있을 때만
        start, end = _dt(out["start"]), _dt(out["end"])
        base_start = e.start_at or start
        if "start_at" in need and start:
            sug["start_at"] = start
        if "end_at" in need and end and base_start and end >= base_start and (end - base_start).days <= 400:
            sug["end_at"] = end
        for f, k in (("time_text", "time_text"), ("place_name", "place"), ("host", "host"), ("fee", "fee")):
            if f in need and out[k]:
                sug[f] = out[k][:200]
    return sug


def apply(e: Event, sug: dict) -> list[str]:
    for k, v in sug.items():
        setattr(e, k, v)
    if sug:
        e.ai_note = ((e.ai_note or "") + " · AI로 채움: " + ", ".join(FIELDS[k] for k in sug)).strip(" ·")[:1000]
    return list(sug)


def batch(db: Session, statuses=("pending",), limit: int = 20, pause: float = 4.0) -> dict:
    """빈칸이 있는 행사를 AI로 채움 (무료 등급 속도 제한 때문에 호출 사이에 쉼)."""
    if not ai.enabled():
        return {"ok": False, "error": "AI 키가 없습니다 (GEMINI_API_KEY)."}
    rows = list(db.scalars(select(Event).where(Event.status.in_(statuses), or_(
        Event.description == "", Event.start_at.is_(None), Event.place_name == "", Event.time_text == "",
        Event.end_at.is_(None))).order_by(Event.created_at.desc()).limit(200)))
    rows = [e for e in rows if "AI로 채움" not in (e.ai_note or "") and missing(e)][:limit]
    done, filled = 0, []
    for i, e in enumerate(rows):
        try:
            got = apply(e, suggest(e))
        except ai.QuotaError:
            db.commit()
            return {"ok": True, "checked": done, "filled": filled, "stopped": "AI 무료 사용 한도에 걸려 멈췄습니다."}
        except Exception as ex:
            log.warning("빈칸 채우기 실패 %s: %s", e.id, ex)
            got = []
        if not got:          # 채울 게 없던 행사도 다시 시도하지 않도록 표시
            e.ai_note = ((e.ai_note or "") + " · AI로 채움: 없음").strip(" ·")[:1000]
        else:
            filled.append({"id": e.id, "title": e.title, "fields": [FIELDS[k] for k in got]})
        done += 1
        db.commit()
        if pause and i < len(rows) - 1:
            time.sleep(pause)
    return {"ok": True, "checked": done, "filled": filled}
