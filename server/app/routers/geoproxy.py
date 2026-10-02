"""장소 검색(월계동 범위) · 외부 도보 경로 (외부 무료 서비스를 서버가 대신 호출)

- 도보 경로: OpenStreetMap 기반 OSRM 도보 서버 (기본 routing.openstreetmap.de)
- 장소 검색: 카카오 로컬 API 키가 있으면 카카오, 없으면 OpenStreetMap Nominatim
월계1동 안의 지름길·배리어프리·메모 경로는 앱이 자체 보행 그래프로 계산합니다.
"""
import logging
import math
import threading
import time
from collections import OrderedDict

import httpx
from fastapi import APIRouter, HTTPException, Query

from ..config import KAKAO_REST_KEY, NOMINATIM_URL, ROUTING_URL
from ..services import geo

router = APIRouter(prefix="/api", tags=["geo"])
log = logging.getLogger("wolgyeon.geo")
UA = {"User-Agent": "WolgyeON/1.0 (Kwangwoon Univ. hackathon community map)"}

_http: httpx.Client | None = None     # 테스트에서 바꿔 끼울 수 있음
_cache: "OrderedDict[str, dict | list]" = OrderedDict()
_lock = threading.Lock()
_last_nominatim = 0.0


def _client() -> httpx.Client:
    global _http
    if _http is None:
        _http = httpx.Client(timeout=12, headers=UA, follow_redirects=True)
    return _http


def _cached(key: str, fn):
    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    val = fn()
    with _lock:
        _cache[key] = val
        while len(_cache) > 300:
            _cache.popitem(last=False)
    return val


def _pt(s: str) -> tuple[float, float]:
    try:
        lat, lng = (float(x) for x in s.split(","))
    except ValueError:
        raise HTTPException(400, "좌표 형식이 올바르지 않습니다.")
    if not (33 < lat < 39 and 124 < lng < 132):
        raise HTTPException(400, "국내 위치만 길찾기를 할 수 있습니다.")
    return lat, lng


def _dist(a, b) -> float:
    kx = 111320 * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot((b[1] - a[1]) * kx, (b[0] - a[0]) * 110540)


@router.get("/route/walk")
def walk_route(from_: str = Query(..., alias="from"), to: str = Query(...)):
    a, b = _pt(from_), _pt(to)
    if _dist(a, b) > 30000:
        raise HTTPException(400, "도보 길찾기는 30km 이내만 지원합니다.")
    key = f"walk:{a[0]:.5f},{a[1]:.5f}:{b[0]:.5f},{b[1]:.5f}"

    def fetch():
        # FOSSGIS OSRM 서버는 프로필 이름 자리에 'driving'을 쓰고, 경로 자체는 도보(routed-foot)로 계산함
        url = f"{ROUTING_URL.rstrip('/')}/route/v1/driving/{a[1]:.6f},{a[0]:.6f};{b[1]:.6f},{b[0]:.6f}"
        r = _client().get(url, params={"overview": "full", "geometries": "geojson", "steps": "false"})
        r.raise_for_status()
        data = r.json()
        if data.get("code") != "Ok" or not data.get("routes"):
            raise HTTPException(404, "두 지점을 잇는 도보 경로를 찾지 못했습니다.")
        rt = data["routes"][0]
        return {"distance": round(rt["distance"], 1), "duration": round(rt["duration"]),
                "coords": [[round(c[1], 6), round(c[0], 6)] for c in rt["geometry"]["coordinates"]],
                "source": "OpenStreetMap 도보 경로 (OSRM)"}
    try:
        return _cached(key, fetch)
    except HTTPException:
        raise
    except Exception as e:
        log.warning("도보 경로 서버 오류: %s", e)
        raise HTTPException(502, "도보 경로 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.")


@router.get("/geo/search")
def search(q: str = Query(..., min_length=2, max_length=60)):
    q = q.strip()
    s_, w_, n_, e_ = geo.area_bbox()
    pad = 0.004
    s_, w_, n_, e_ = s_ - pad, w_ - pad, n_ + pad, e_ + pad
    key = f"search:{q}:{s_:.3f},{w_:.3f}"

    def kakao():
        r = _client().get("https://dapi.kakao.com/v2/local/search/keyword.json",
                          params={"query": q, "rect": f"{w_},{s_},{e_},{n_}", "sort": "accuracy", "size": 10},
                          headers={"Authorization": f"KakaoAK {KAKAO_REST_KEY}"})
        r.raise_for_status()
        return [{"name": d["place_name"], "address": d.get("road_address_name") or d.get("address_name", ""),
                 "lat": float(d["y"]), "lng": float(d["x"])} for d in r.json().get("documents", [])]

    def nominatim():
        global _last_nominatim
        with _lock:                       # Nominatim 이용 규칙: 초당 1회 이하
            wait = 1.05 - (time.time() - _last_nominatim)
            if wait > 0:
                time.sleep(wait)
            _last_nominatim = time.time()
        r = _client().get(f"{NOMINATIM_URL.rstrip('/')}/search", params={
            "q": q, "format": "jsonv2", "countrycodes": "kr", "accept-language": "ko", "limit": 8,
            "viewbox": f"{w_},{n_},{e_},{s_}", "bounded": 1})
        r.raise_for_status()
        out = []
        for d in r.json():
            parts = [p.strip() for p in d.get("display_name", "").split(",")]
            out.append({"name": d.get("name") or parts[0], "address": ", ".join(parts[1:4]),
                        "lat": float(d["lat"]), "lng": float(d["lon"])})
        return out

    try:   # 서비스 범위(월계동 + 약간) 밖 결과는 뺌
        rows = _cached(key, kakao if KAKAO_REST_KEY else nominatim)
        return [r for r in rows if s_ <= r["lat"] <= n_ and w_ <= r["lng"] <= e_]
    except Exception as e:
        log.warning("장소 검색 오류: %s", e)
        raise HTTPException(502, "장소 검색 서버에 연결하지 못했습니다. 지도를 눌러 위치를 골라주세요.")
