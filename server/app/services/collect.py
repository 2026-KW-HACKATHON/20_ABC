"""행사 자동 수집 → 승인 대기열(pending)

출처
 1) 서울시 문화행사 정보 Open API (서울 열린데이터광장, 좌표 포함) — 노원구 + 월계1동 반경 내
 2) 광운대학교 공지사항 — 행사성 공지만 골라 본문에서 일시·장소 추출 (AI 키가 있으면 AI, 없으면 규칙)
수집된 행사는 관리자가 승인해야 앱에 보입니다.
"""
from __future__ import annotations

import hashlib
import logging
import re
from datetime import datetime, timedelta
from urllib.parse import parse_qs, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import CENTER, NEARBY_KM, SEOUL_API_KEY
from ..models import CollectLog, Event, now
from . import ai
from .geo import dist_m

log = logging.getLogger("wolgyeon.collect")
UA = {"User-Agent": "Mozilla/5.0 (WolgyeON community app; +https://github.com/) Python-httpx"}

# 광운대 건물 좌표 (OSM 기준)
KW_BUILDINGS = {
    "80주년": (37.62008, 127.05879), "기념관": (37.62008, 127.05879), "비마관": (37.61961, 127.06007),
    "새빛관": (37.61979, 127.06085), "화도관": (37.62046, 127.05944), "복지관": (37.61936, 127.05841),
    "옥의관": (37.61878, 127.05897), "참빛관": (37.61917, 127.06094), "동해문화예술관": (37.61985, 127.05753),
    "연구관": (37.6196, 127.05754), "아이스링크": (37.62029, 127.05716), "한울관": (37.62069, 127.05713),
    "승리관": (37.61856, 127.05871), "누리관": (37.62035, 127.05501), "빛솔재": (37.62151, 127.05626),
    "한천재": (37.62024, 127.05759), "연촌재": (37.62192, 127.05671), "다산재": (37.6191, 127.05996),
    "운동장": (37.62105, 127.05815), "대운동장": (37.62105, 127.05815),
}
KW_CENTER = (37.6197, 127.0590)

KW_INCLUDE = ("행사", "축제", "공연", "전시", "특강", "강연", "설명회", "콘서트", "세미나", "경진", "대회", "페스티벌",
              "박람회", "개최", "초청", "워크숍", "체험", "경기 안내", "음악회", "영화", "상영", "포럼", "심포지엄", "캠프")
KW_EXCLUDE = ("채용", "장학", "등록금", "휴학", "복학", "병무", "수강", "성적", "졸업", "학위", "입찰", "계약",
              "외국인 학생 모집", "유학생", "시설 공사", "정전", "단수", "납부")

SEOUL_CAT = [
    (("교육", "체험"), "academic"),
    (("축제-시민화합", "시민화합", "축제-주민", "주민"), "community"),
]


# ============================================================== 서울시 문화행사
def _parse_dt(s: str | None) -> datetime | None:
    """'2026-10-01 00:00:00.0', '2026.10.01', '20261001', '2026-10-01 14:00' 등을 datetime으로."""
    if not s:
        return None
    m = re.match(r"\s*(\d{4})[-./]?(\d{1,2})[-./]?(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?", str(s))
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    h, mi = int(m.group(4) or 0), int(m.group(5) or 0)
    try:
        return datetime(y, mo, d, h, mi)
    except ValueError:
        return None


def _seoul_category(codename: str) -> str:
    for keys, cat in SEOUL_CAT:
        if any(k in codename for k in keys):
            return cat
    return "culture"


def parse_seoul_rows(rows: list[dict], today: datetime) -> list[dict]:
    out = []
    for r in rows:
        title = (r.get("TITLE") or "").strip()
        if not title:
            continue
        gu = (r.get("GUNAME") or "").strip()
        lat = lng = None
        try:
            a, b = float(r.get("LAT") or 0), float(r.get("LOT") or 0)
            # 데이터에 따라 LAT/LOT가 뒤바뀐 경우가 있어 값 범위로 판별
            lat, lng = (a, b) if 30 < a < 45 else (b, a)
            if not (30 < lat < 45 and 120 < lng < 135):
                lat = lng = None
        except (TypeError, ValueError):
            lat = lng = None
        near = lat is not None and dist_m(lat, lng, *CENTER) <= NEARBY_KM * 1000
        if gu != "노원구" and not near:
            continue
        start = _parse_dt(r.get("STRTDATE"))
        end = _parse_dt(r.get("END_DATE")) or start
        if end and end + timedelta(days=1) < today:
            continue
        sid = hashlib.sha1(f"{title}|{r.get('STRTDATE')}|{r.get('PLACE')}".encode()).hexdigest()[:20]
        desc_parts = [r.get("PROGRAM") or "", r.get("ETC_DESC") or ""]
        out.append({
            "source": "seoul", "source_id": sid, "title": title[:300],
            "category": _seoul_category(r.get("CODENAME") or ""),
            "start_at": start, "end_at": end,
            "time_text": (r.get("DATE") or "") + ((" " + r["PRO_TIME"]) if r.get("PRO_TIME") else ""),
            "place_name": (r.get("PLACE") or "")[:200], "lat": lat, "lng": lng,
            "description": "\n".join(x for x in desc_parts if x).strip()[:4000],
            "host": (r.get("ORG_NAME") or "")[:200],
            "fee": ((r.get("USE_FEE") or "") or ("무료" if r.get("IS_FREE") == "무료" else ""))[:200],
            "url": (r.get("ORG_LINK") or r.get("HMPG_ADDR") or "")[:500],
            "image_url": (r.get("MAIN_IMG") or "")[:500],
            "ai_note": f"대상: {r.get('USE_TRGT') or '-'} · 분류: {r.get('CODENAME') or '-'} · {gu}",
        })
    return out


def fetch_seoul(client: httpx.Client) -> list[dict]:
    page, size, rows = 1, 1000, []
    if SEOUL_API_KEY == "sample":
        size = 5  # 샘플 키 제한
    while True:
        s, e = (page - 1) * size + 1, page * size
        url = f"http://openapi.seoul.go.kr:8088/{SEOUL_API_KEY}/json/culturalEventInfo/{s}/{e}/"
        data = client.get(url).json()
        body = data.get("culturalEventInfo")
        if not body:
            code = (data.get("RESULT") or {}).get("MESSAGE") or str(data)[:200]
            raise RuntimeError(f"서울시 API 응답 오류: {code}")
        rows += body.get("row", [])
        total = int(body.get("list_total_count", 0))
        if e >= total or SEOUL_API_KEY == "sample" or page >= 10:
            break
        page += 1
    return parse_seoul_rows(rows, now())


# ============================================================== 광운대 공지사항
KW_LIST = "https://www.kw.ac.kr/ko/life/notice.jsp"


def parse_kw_list(html: str, base: str = KW_LIST) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    items, seen = [], set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if "BoardMode=view" not in href or "DUID=" not in href:
            continue
        full = urljoin(base, href)
        duid = parse_qs(urlparse(full).query).get("DUID", [""])[0]
        if not duid or duid in seen:
            continue
        seen.add(duid)
        title = re.sub(r"\s+", " ", a.get_text(" ", strip=True))
        title = re.sub(r"\s*(신규게시글|Attachment|첨부파일|NEW)\s*$", "", title).strip()
        row = a.find_parent(["li", "tr", "div"]) or a
        row_text = row.get_text(" ", strip=True)
        m = re.search(r"(20\d{2})-(\d{2})-(\d{2})", row_text)
        posted = m.group(0) if m else ""
        cat_m = re.match(r"\[([^\]]+)\]", title)
        items.append({"duid": duid, "title": title, "url": full, "posted": posted,
                      "board_cat": cat_m.group(1) if cat_m else ""})
    return items


def kw_is_candidate(title: str) -> bool:
    return any(k in title for k in KW_INCLUDE) and not any(k in title for k in KW_EXCLUDE)


def parse_kw_body(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer"]):
        tag.decompose()
    best = ""
    for sel in (".board-view-contents", ".board-view", ".view-contents", ".board_view", ".contents", "#contents", "article"):
        for el in soup.select(sel):
            txt = el.get_text("\n", strip=True)
            if len(txt) > len(best):
                best = txt
    if len(best) < 50:
        best = soup.get_text("\n", strip=True)
    return re.sub(r"\n{3,}", "\n\n", best)[:8000]


_DATE_PATTERNS = [
    re.compile(r"(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})"),
    re.compile(r"(?<![\d.])(\d{1,2})\s*월\s*(\d{1,2})\s*일"),
    re.compile(r"(?<![\d.])(\d{1,2})\.\s*(\d{1,2})\.\s*\(?[월화수목금토일]"),
]
_TIME_PATTERN = re.compile(r"(\d{1,2}):(\d{2})")


def heuristic_event(title: str, body: str, posted: str) -> dict:
    """AI 키가 없을 때: 본문에서 '일시/장소' 줄을 찾아 날짜·장소를 추출."""
    year = int(posted[:4]) if posted[:4].isdigit() else now().year
    focus = "\n".join(l for l in body.splitlines() if re.search(r"일\s*시|일\s*정|기\s*간|날\s*짜|장\s*소|시\s*간", l)) or body
    start = None
    for pat in _DATE_PATTERNS:
        m = pat.search(focus) or pat.search(title)
        if m:
            g = [int(x) for x in m.groups()]
            y, mo, d = (g if len(g) == 3 else [year, *g])
            try:
                start = datetime(y, mo, d)
            except ValueError:
                start = None
            break
    if start:
        tm = _TIME_PATTERN.search(focus)
        if tm and int(tm.group(1)) < 24:
            start = start.replace(hour=int(tm.group(1)), minute=int(tm.group(2)))
    place = ""
    m = re.search(r"장\s*소\s*[:：]?\s*(.+)", body)
    if m:
        place = m.group(1).strip()[:120]
    clean_title = re.sub(r"^\[[^\]]+\]\s*", "", title)
    clean_title = re.sub(r"^\[[^\]]+\]\s*", "", clean_title)
    time_line = ""
    m = re.search(r"(일\s*시|일\s*정|기\s*간)\s*[:：]?\s*(.+)", body)
    if m:
        time_line = m.group(2).strip()[:120]
    return {"is_public_event": True, "title": clean_title, "category": _guess_cat(title + body[:500]),
            "start": start.strftime("%Y-%m-%d %H:%M") if start else "", "end": "",
            "time_text": time_line, "place": place, "summary": body[:300], "target": ""}


def fill_missing_dates(info: dict, title: str, body: str, posted: str) -> dict:
    """AI 결과에 시작일이 비어 있으면 ① 일시 설명(time_text) ② 공지 본문 규칙 추출 순서로 채운다."""
    if _parse_dt(info.get("start")):
        return info
    year = int(posted[:4]) if posted[:4].isdigit() else now().year
    tt = info.get("time_text") or ""
    for pat in _DATE_PATTERNS:
        m = pat.search(tt)
        if m:
            g = [int(x) for x in m.groups()]
            y, mo, d = (g if len(g) == 3 else [year, *g])
            try:
                start = datetime(y, mo, d)
                tm = _TIME_PATTERN.search(tt)
                if tm and int(tm.group(1)) < 24:
                    start = start.replace(hour=int(tm.group(1)), minute=int(tm.group(2)))
                info["start"] = start.strftime("%Y-%m-%d %H:%M")
                return info
            except ValueError:
                pass
    h = heuristic_event(title, body, posted)
    if h.get("start"):
        info["start"] = h["start"]
        if not info.get("time_text"):
            info["time_text"] = h.get("time_text", "")
    return info


_END_PATTERN = re.compile(r"~\s*(?:(20\d{2})\s*[.\-/년]\s*)?(\d{1,2})\s*[.\-/월]\s*(\d{1,2})")


def fill_end_date(info: dict) -> dict:
    """'10. 13.(화) ~ 10. 15.(목)' 처럼 기간이면 종료일도 채운다."""
    start = _parse_dt(info.get("start"))
    if not start or _parse_dt(info.get("end")):
        return info
    m = _END_PATTERN.search(info.get("time_text") or "")
    if m:
        y = int(m.group(1) or start.year)
        try:
            end = datetime(y, int(m.group(2)), int(m.group(3)), 23, 59)
            if end > start:
                info["end"] = end.strftime("%Y-%m-%d %H:%M")
        except ValueError:
            pass
    return info


def _guess_cat(text: str) -> str:
    if any(k in text for k in ("특강", "강연", "세미나", "설명회", "포럼", "심포지엄", "교육", "워크숍", "경진", "대회")):
        return "academic"
    if any(k in text for k in ("공연", "전시", "콘서트", "음악회", "영화", "축제", "페스티벌")):
        return "culture"
    return "community"


def kw_location(place: str) -> tuple[float, float]:
    for key, ll in KW_BUILDINGS.items():
        if key in place:
            return ll
    return KW_CENTER


def fetch_kw(client: httpx.Client, pages: int = 3, existing: set[str] | None = None) -> list[dict]:
    existing = existing or set()
    items, seen = [], set()
    for page in range(1, pages + 1):
        r = client.get(KW_LIST, params={"BoardMode": "list", "tpage": page, "searchKey": 1, "searchVal": "", "srCategoryId": ""})
        for it in parse_kw_list(r.text):          # 상단 고정 공지가 페이지마다 반복됨
            if it["duid"] not in seen:
                seen.add(it["duid"])
                items.append(it)
    out = []
    for it in items:
        if it["duid"] in existing or not kw_is_candidate(it["title"]):
            continue
        try:
            body = parse_kw_body(client.get(it["url"]).text)
        except Exception as e:  # 개별 글 실패는 건너뜀
            log.warning("광운대 공지 본문 실패 %s: %s", it["url"], e)
            continue
        info = None
        if ai.enabled():
            try:
                info = ai.extract_event(it["title"], body, it["posted"])
            except Exception as e:
                log.warning("AI 추출 실패, 규칙 기반으로 대체: %s", e)
        if info is None:
            info = heuristic_event(it["title"], body, it["posted"])
        if not info.get("is_public_event", True):
            continue
        fill_end_date(fill_missing_dates(info, it["title"], body, it["posted"]))
        lat, lng = kw_location(info.get("place", ""))
        out.append({
            "source": "kw", "source_id": it["duid"], "title": (info.get("title") or it["title"])[:300],
            "category": info.get("category") if info.get("category") in ("culture", "academic", "community") else "academic",
            "start_at": _parse_dt(info.get("start")), "end_at": _parse_dt(info.get("end")),
            "time_text": (info.get("time_text") or "")[:200],
            "place_name": ("광운대학교 " + info["place"]) if info.get("place") and "광운" not in info["place"] else (info.get("place") or "광운대학교"),
            "lat": lat, "lng": lng, "description": (info.get("summary") or "")[:4000],
            "host": "광운대학교", "url": it["url"],
            "ai_note": f"공지 분류: {it['board_cat'] or '-'} · 게시일 {it['posted'] or '-'} · 대상: {info.get('target') or '-'}"
                       + (" · AI 추출" if ai.enabled() else " · 규칙 추출(날짜·장소 확인 필요)"),
        })
    return out


def reextract_kw(ev) -> dict:
    """이미 수집한 광운대 공지를 다시 읽어 비어 있는 일시·장소를 채운다. 바뀐 항목을 돌려줌."""
    with httpx.Client(headers=UA, timeout=20, follow_redirects=True) as client:
        html = client.get(ev.url).text
    body = parse_kw_body(html)
    posted = (re.search(r"게시일 (\d{4}-\d{2}-\d{2})", ev.ai_note or "") or [None, ""])[1] or now().strftime("%Y-%m-%d")
    info = None
    if ai.enabled():
        try:
            info = ai.extract_event(ev.title, body, posted)
        except Exception as e:
            log.warning("AI 다시 읽기 실패: %s", e)
    info = fill_end_date(fill_missing_dates(info or heuristic_event(ev.title, body, posted), ev.title, body, posted))
    changed = {}
    if ev.start_at is None and _parse_dt(info.get("start")):
        ev.start_at = changed["start_at"] = _parse_dt(info["start"])
    if ev.end_at is None and _parse_dt(info.get("end")):
        ev.end_at = changed["end_at"] = _parse_dt(info["end"])
    if not ev.time_text and info.get("time_text"):
        ev.time_text = changed["time_text"] = info["time_text"][:200]
    if not ev.description and info.get("summary"):
        ev.description = changed["description"] = info["summary"][:4000]
    return {k: (v.isoformat(timespec="minutes") if isinstance(v, datetime) else v) for k, v in changed.items()}


# ============================================================== 실행
def _store(db: Session, cands: list[dict]) -> int:
    added = 0
    seen: set[tuple[str, str]] = set()
    for c in cands:
        key = (c["source"], c["source_id"])
        if key in seen:
            continue
        seen.add(key)
        exists = db.scalar(select(Event.id).where(Event.source == c["source"], Event.source_id == c["source_id"]))
        if exists:
            continue
        db.add(Event(status="pending", **c))
        added += 1
    db.commit()
    return added


def collect_all(db: Session) -> list[dict]:
    results = []
    with httpx.Client(headers=UA, timeout=20, follow_redirects=True) as client:
        for name, fn in (("seoul", lambda: fetch_seoul(client)),
                         ("kw", lambda: fetch_kw(client, existing=set(db.scalars(
                             select(Event.source_id).where(Event.source == "kw")))))):
            logrow = CollectLog(source=name)
            try:
                cands = fn()
                logrow.found = len(cands)
                logrow.added = _store(db, cands)
            except Exception as e:
                db.rollback()
                logrow.error = f"{type(e).__name__}: {e}"[:1000]
                log.exception("수집 실패: %s", name)
            db.add(logrow)
            db.commit()
            results.append({"source": name, "found": logrow.found, "added": logrow.added, "error": logrow.error})
    return results
