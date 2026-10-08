"""장소 이름 → 좌표 (좌표 없이 들어온 행사를 지도에 올리기 위해)

구청 PDF 같은 자료는 '월계도서관 4층 달빛소리홀'처럼 장소 이름만 있고 좌표가 없다.
1) 별칭 사전으로 흔한 줄임말을 OSM 이름으로 바꾸고 (월계도서관 → 월계문화정보도서관)
2) OSM 지도에 이름이 있는 건물·공원·학교 중 장소 글자 안에 들어 있는 가장 긴 이름을 고른다.
3) KAKAO_REST_KEY 가 있으면 월계동 근처로 범위를 좁혀 카카오 장소 검색도 써 본다.
찾지 못한 행사는 좌표 없이 남고, 월계동 밖 행사처럼 '검색'에서만 보인다 (관리자가 직접 지도에서 찍을 수 있음).
"""
from __future__ import annotations

import logging
import re
import threading

import httpx
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..config import KAKAO_REST_KEY
from ..models import Event
from . import geo

log = logging.getLogger("wolgyeon.places")

# 자료에 자주 나오는 줄임말·옛 이름 → OSM 이름 (띄어쓰기 무시)
ALIASES = {
    "월계도서관": "월계문화정보도서관",
    "월계정보도서관": "월계문화정보도서관",
    "광운대": "광운대학교",
    "광운대학교링크": "광운대학교",
    "광운대링크": "광운대학교",
}
# 이름만으로는 어디인지 알 수 없는 말 (건물 안 방 이름 등)
GENERIC = {"도서관", "공원", "주차장", "강당", "체육관", "운동장", "놀이터", "화장실", "관리사무소", "경로당", "어린이집",
           "정문", "후문", "광장", "다목적실", "쉼터", "공원화장실", "도서관별관"}
# 다른 시·구를 적어 둔 장소는 이름이 같아도 동네 안 장소가 아님
ELSEWHERE = re.compile(r"(송파구|도봉구|성북구|강북구|중랑구|동대문구|경기도|충북|충남|전북|전남|경북|경남|강원|제주|양평|제천|익산)")

_lock = threading.Lock()
_index: list[tuple[str, float, float, str]] | None = None
_index_mtime = 0.0
_kakao_cache: dict[str, tuple[float, float, str] | None] = {}


def norm(s: str) -> str:
    return re.sub(r"[\s·・.,\-_/()\[\]{}'\"“”‘’]", "", (s or "")).lower()


def _build() -> list[tuple[str, float, float, str]]:
    groups: dict[str, list[tuple[float, float, str]]] = {}
    for ft in geo.load_features():
        name = (ft["properties"].get("name") or "").strip()
        n = norm(name)
        if len(n) < 4 or n in GENERIC:
            continue
        g = ft["geometry"]
        if g["type"] == "Point":
            lng, lat = g["coordinates"]
        elif g["type"] == "Polygon":
            ring = g["coordinates"][0]
            lat = sum(c[1] for c in ring) / len(ring)
            lng = sum(c[0] for c in ring) / len(ring)
        else:
            continue
        groups.setdefault(n, []).append((lat, lng, name))
    out = []
    for n, pts in groups.items():
        # 같은 이름이 서로 멀리 떨어져 있으면(체인점 등) 어느 것인지 알 수 없으니 뺀다
        lat0, lng0, name = pts[0]
        if any(geo.dist_m(lat0, lng0, la, ln) > 600 for la, ln, _ in pts[1:]):
            continue
        lat = sum(p[0] for p in pts) / len(pts)
        lng = sum(p[1] for p in pts) / len(pts)
        out.append((n, round(lat, 6), round(lng, 6), name))
    out.sort(key=lambda r: -len(r[0]))          # 긴 이름 먼저 (월계문화정보도서관 > 문화정보도서관)
    return out


def index() -> list[tuple[str, float, float, str]]:
    global _index, _index_mtime
    with _lock:
        try:
            mt = geo.osm_path().stat().st_mtime        # 관리자가 지도 데이터를 새로 받으면 다시 만듦
        except OSError:
            mt = 0.0
        if _index is None or mt != _index_mtime:
            _index_mtime = mt
            try:
                _index = _build()
            except Exception as e:
                log.warning("장소 이름 목록을 만들지 못했습니다: %s", e)
                _index = []
        return _index


def reset():
    global _index
    with _lock:
        _index = None


def _kakao(place: str) -> tuple[float, float, str] | None:
    if not KAKAO_REST_KEY:
        return None
    q = re.sub(r"\(.*?\)", "", place).strip()
    q = re.split(r"\s+\d+층|\s+지하|\s+[A-Z]?\d+호", q)[0].strip()[:40]
    if len(q) < 2:
        return None
    if q in _kakao_cache:
        return _kakao_cache[q]
    s, w, n, e = geo.area_bbox()
    res = None
    try:
        r = httpx.get("https://dapi.kakao.com/v2/local/search/keyword.json",
                      params={"query": q, "rect": f"{w},{s},{e},{n}", "size": 1},
                      headers={"Authorization": f"KakaoAK {KAKAO_REST_KEY}"}, timeout=8)
        r.raise_for_status()
        docs = r.json().get("documents") or []
        if docs:
            res = (float(docs[0]["y"]), float(docs[0]["x"]), docs[0]["place_name"])
    except Exception as ex:
        log.info("카카오 장소 검색 실패(%s): %s", q, ex)
        return None
    _kakao_cache[q] = res
    return res


def locate(place: str) -> tuple[float, float, str] | None:
    """장소 글자 → (lat, lng, 찾은 이름). 못 찾으면 None."""
    if not place or ELSEWHERE.search(place):
        return None
    p = norm(place)
    for a, full in ALIASES.items():
        if a in p and norm(full) not in p:
            p = p.replace(a, norm(full))
    for n, lat, lng, name in index():
        i = p.find(n)
        # 장소 글자의 맨 앞에서 시작하는 이름이거나, 충분히 긴 고유한 이름일 때만 인정
        #  ('마들스포츠타운 테니스장'의 '테니스장', '305동 앞마당'의 '305동' 같은 오인 방지)
        if i == 0 or (i > 0 and len(n) >= 6):
            return lat, lng, name
    k = _kakao(place)
    if k and geo.area_contains(k[0], k[1]):
        return k
    return None


def fill_missing(db: Session, statuses=("pending", "approved")) -> dict:
    """좌표가 없는 행사에 장소 이름으로 좌표를 채움. 수정 시각은 건드리지 않음."""
    rows = list(db.scalars(select(Event).where(Event.lat.is_(None), Event.status.in_(statuses), Event.place_name != "")))
    found = inside = 0
    for e in rows:
        hit = locate(e.place_name)
        if not hit:
            continue
        lat, lng, name = hit
        note = (e.ai_note or "")
        add = f"위치 자동: '{name}'"
        db.execute(update(Event).where(Event.id == e.id).values(
            lat=lat, lng=lng, ai_note=(note + ("\n" if note else "") + add)[:500] if add not in note else note,
            updated_at=Event.updated_at))
        found += 1
        inside += geo.area_contains(lat, lng)
    db.commit()
    if found:
        log.info("장소 이름으로 위치 찾음: %d건 (월계동 안 %d건)", found, inside)
    return {"checked": len(rows), "found": found, "inside": inside}
