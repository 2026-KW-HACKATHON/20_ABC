"""월계1동 실시간 소식 — 지금 기준 가장 최근의 뉴스 또는 앱 소식 하나

후보
 - 뉴스: Google 뉴스 RSS ("월계1동", 없으면 "월계동 노원") — 제목에 '월계'가 들어간 기사만
 - 앱 소식: 새로 공개된 행사 · 처리 완료된 신고 · 새 공사 구간
가장 최근 것 하나를 돌려줌. 뉴스는 10분 동안 캐시.
"""
import email.utils
import logging
import threading
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import EVENT_CATEGORIES, KST, REPORT_CATEGORIES, Construction, Event, Report, now
from .events import iso

router = APIRouter(prefix="/api", tags=["live"])
log = logging.getLogger("wolgyeon.live")

NEWS_QUERIES = ["월계1동", "월계동 노원"]
NEWS_MAX_AGE = timedelta(days=30)
APP_MAX_AGE = timedelta(days=14)

_http: httpx.Client | None = None   # 테스트에서 바꿔 끼울 수 있음
_news_cache: dict = {"at": 0.0, "items": []}
_lock = threading.Lock()


def _client() -> httpx.Client:
    global _http
    if _http is None:
        _http = httpx.Client(timeout=10, follow_redirects=True,
                             headers={"User-Agent": "Mozilla/5.0 (WolgyeON community app)"})
    return _http


def parse_rss(xml_text: str) -> list[dict]:
    root = ET.fromstring(xml_text)
    out = []
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        pub = it.findtext("pubDate")
        src = (it.findtext("source") or "").strip()
        if not title or not link or not pub:
            continue
        try:
            dt = email.utils.parsedate_to_datetime(pub).astimezone(KST).replace(tzinfo=None)
        except (TypeError, ValueError):
            continue
        # Google 뉴스 제목은 "기사 제목 - 언론사" 형태
        if src and title.endswith(" - " + src):
            title = title[: -len(src) - 3]
        out.append({"title": title, "link": link, "time": dt, "source": src or "뉴스"})
    return out


def latest_news() -> list[dict]:
    with _lock:
        if time.time() - _news_cache["at"] < 600:
            return _news_cache["items"]
    items: list[dict] = []
    for q in NEWS_QUERIES:
        try:
            r = _client().get("https://news.google.com/rss/search",
                              params={"q": q, "hl": "ko", "gl": "KR", "ceid": "KR:ko"})
            r.raise_for_status()
            found = [n for n in parse_rss(r.text) if "월계" in n["title"]]
        except Exception as e:
            log.warning("뉴스 RSS 실패 (%s): %s", q, e)
            found = []
        fresh = [n for n in found if n["time"] >= now() - NEWS_MAX_AGE]
        if fresh:
            items = fresh
            break
    items.sort(key=lambda n: n["time"], reverse=True)
    with _lock:
        _news_cache.update(at=time.time(), items=items[:10])
    return items[:10]


def app_items(db: Session) -> list[dict]:
    since = now() - APP_MAX_AGE
    out = []
    for e in db.scalars(select(Event).where(Event.status == "approved", Event.updated_at >= since,
                                            Event.source != "nowon")   # 구청 월간 자료 일괄 등록분은 '새 소식'에서 제외
                        .order_by(Event.updated_at.desc()).limit(40)):
        if e.title.startswith("(예시)"):
            continue
        last = e.end_at or e.start_at
        if last and last < now().replace(hour=0, minute=0, second=0, microsecond=0):
            continue            # 이미 끝난 행사는 '새 소식'이 아님
        label = EVENT_CATEGORIES.get(e.category, "행사")
        out.append({"kind": "event", "title": f"새 {label} 행사: {e.title}", "time": e.updated_at,
                    "source": "월계온 소식", "link": f"#/event/{e.id}"})
    for r in db.scalars(select(Report).where(Report.status == "resolved", Report.updated_at >= since)
                        .order_by(Report.updated_at.desc()).limit(5)):
        out.append({"kind": "report", "title": f"주민 신고 처리 완료: {REPORT_CATEGORIES.get(r.category, '생활 불편')}",
                    "time": r.updated_at, "source": "월계온 신문고", "link": "#/map"})
    for c in db.scalars(select(Construction).where(Construction.active.is_(True), Construction.created_at >= since)
                        .order_by(Construction.created_at.desc()).limit(3)):
        out.append({"kind": "construction", "title": f"공사 알림: {c.title}" + (" (먼지 주의)" if c.dust else ""),
                    "time": c.created_at, "source": "월계온 공사 정보", "link": "#/map"})
    return out


@router.get("/live")
def live(db: Session = Depends(get_db)):
    """지금 기준 가장 최근의 월계1동 소식 하나 (없으면 item=null)."""
    cands = [{"kind": "news", **n} for n in latest_news()] + app_items(db)
    cands = [c for c in cands if c["time"] <= now() + timedelta(minutes=5)]
    if not cands:
        return {"item": None}
    best = max(cands, key=lambda c: c["time"])
    return {"item": {**best, "time": iso(best["time"])}}


def _reset_cache_for_tests():
    _news_cache.update(at=0.0, items=[])

