"""OpenStreetMap 데이터 새로 받기 + 고도(경사도) 데이터 받기.

서버(클라우드·기숙사 PC)는 인터넷에 연결돼 있으므로 관리자 화면 버튼이나
`python -m tools.update_osm` 으로 직접 최신 데이터를 받을 수 있습니다.
"""
from __future__ import annotations

import json
import logging
import time

import httpx

from ..config import DATA_DIR
from . import geo

log = logging.getLogger("wolgyeon.osm")

# 월계동(월계1·2·3동) 전체 + 약간의 여유. 경계선이 잘리지 않도록 넉넉하게 잡음
BBOX = "37.6030,127.0330,37.6560,127.0800"
QUERY = f"""[out:json][timeout:240][bbox:{BBOX}];
(
  relation["boundary"="administrative"]["name"~"^월계[0-9]동$"];
  way["highway"]; way["building"];
  way["waterway"]; way["natural"="water"]; relation["natural"="water"];
  way["leisure"]; way["landuse"];
  way["railway"]; node["railway"="station"];
  way["amenity"]; node["amenity"];
  node["shop"]; way["shop"];
  node["barrier"]; way["barrier"];
  node["entrance"];
);
out body;
>;
out skel qt;"""
SERVERS = ["https://overpass-api.de/api/interpreter",
           "https://overpass.kumi.systems/api/interpreter",
           "https://overpass.private.coffee/api/interpreter"]


def update_osm() -> dict:
    last = None
    for url in SERVERS:
        try:
            r = httpx.post(url, data={"data": QUERY}, timeout=260,
                           headers={"User-Agent": "WolgyeON/1.0 (community map)"})
            r.raise_for_status()
            raw = r.json()
            gj = geo.osm_json_to_geojson(raw)
            if not any(f["properties"].get("name") == "월계1동" for f in gj["features"]):
                raise RuntimeError("월계1동 경계가 응답에 없습니다.")
            tmp = DATA_DIR / "osm.geojson.tmp"
            tmp.write_text(json.dumps(gj, ensure_ascii=False), encoding="utf-8")
            tmp.replace(DATA_DIR / "osm.geojson")
            geo.reset_cache()
            g = geo.base_graph()
            return {"ok": True, "server": url, "features": len(gj["features"]), "area": geo.basemap().get("an"),
                    "graph": g["stats"],
                    "pois": len(geo.pois())}
        except Exception as e:
            last = f"{url}: {type(e).__name__}: {e}"
            log.warning("OSM 받기 실패 %s", last)
    return {"ok": False, "error": last}


def import_geojson(raw_bytes: bytes) -> dict:
    """overpass-turbo에서 내보낸 GeoJSON(또는 원본 JSON) 파일을 올려서 교체."""
    raw = json.loads(raw_bytes.decode("utf-8"))
    gj = geo.osm_json_to_geojson(raw) if "elements" in raw else raw
    if not any(f.get("properties", {}).get("name") == "월계1동" and f["geometry"]["type"] == "Polygon"
               for f in gj.get("features", [])):
        raise ValueError("파일에 월계1동 행정경계가 없습니다. 쿼리에 경계(relation)가 포함됐는지 확인해주세요.")
    (DATA_DIR / "osm.geojson").write_text(json.dumps(gj, ensure_ascii=False), encoding="utf-8")
    geo.reset_cache()
    return {"ok": True, "features": len(gj["features"]), "area": geo.basemap().get("an"),
            "graph": geo.base_graph()["stats"], "pois": len(geo.pois())}


def _bilinear(z, s, w, dlat, dlng, lat, lng):
    ny, nx = len(z), len(z[0])
    fy, fx = (lat - s) / dlat, (lng - w) / dlng
    if not (0 <= fy <= ny - 1 and 0 <= fx <= nx - 1):
        return None
    y0, x0 = min(int(fy), ny - 2), min(int(fx), nx - 2)
    ty, tx = fy - y0, fx - x0
    v = [z[y0][x0], z[y0][x0 + 1], z[y0 + 1][x0], z[y0 + 1][x0 + 1]]
    if any(a is None for a in v):
        return None
    return (v[0] * (1 - tx) + v[1] * tx) * (1 - ty) + (v[2] * (1 - tx) + v[3] * tx) * ty


def fetch_elevation(pause: float = 11.0) -> dict:
    """Open-Meteo 고도 API(Copernicus 90m DEM)로 월계동 위에 약 90m 간격 격자의 고도를 받아,
    보행 그래프의 각 점 고도를 보간해 경사도를 계산한다.

    무료 이용 한도(분당 600곳, 하루 1만 곳)를 넘지 않도록 격자로 받고(약 1,200곳), 요청 사이에 쉰다.
    한 번 받은 격자는 elevation_grid.json 에 저장해 다시 받지 않음. 키 필요 없음.
    """
    s, w, n, e = geo.area_bbox()
    pad = 0.0025                                   # 경계 밖 약 250m 여유
    s, w, n, e = round(s - pad, 4), round(w - pad, 4), round(n + pad, 4), round(e + pad, 4)
    dlat, dlng = 0.0008, 0.001                     # 약 89m × 88m
    ny, nx = int((n - s) / dlat) + 2, int((e - w) / dlng) + 2
    key = f"{s},{w},{dlat},{dlng},{ny},{nx}"
    gfile = DATA_DIR / "elevation_grid.json"
    grid = None
    if gfile.exists():
        try:
            g = json.loads(gfile.read_text())
            if g.get("key") == key:
                grid = g
        except Exception:
            grid = None
    if grid is None:
        grid = {"key": key, "z": [[None] * nx for _ in range(ny)]}
    z = grid["z"]
    todo = [(y, x) for y in range(ny) for x in range(nx) if z[y][x] is None]
    got = failed = 0
    with httpx.Client(timeout=30) as client:
        for i in range(0, len(todo), 100):
            chunk = todo[i:i + 100]
            params = {"latitude": ",".join(f"{s + y * dlat:.5f}" for y, _ in chunk),
                      "longitude": ",".join(f"{w + x * dlng:.5f}" for _, x in chunk)}
            ok = False
            for attempt in range(5):
                try:
                    r = client.get("https://api.open-meteo.com/v1/elevation", params=params)
                    if r.status_code == 429:           # 분당 한도 → 1분 쉬고 다시
                        time.sleep(65)
                        continue
                    r.raise_for_status()
                    for (y, x), v in zip(chunk, r.json()["elevation"]):
                        z[y][x] = float(v)
                    got += len(chunk)
                    ok = True
                    break
                except Exception as ex:
                    log.warning("고도 받기 재시도 %s: %s", attempt, ex)
                    time.sleep(3 + attempt * 5)
            if not ok:
                failed += len(chunk)
            gfile.write_text(json.dumps(grid))       # 중간에 끊겨도 받은 만큼은 남김
            if pause and i + 100 < len(todo):
                time.sleep(pause)
    # 그래프 점마다 격자에서 보간
    out: dict[str, float] = {}
    for nd in geo.base_graph()["n"]:
        v = _bilinear(z, s, w, dlat, dlng, nd[0], nd[1])
        if v is not None:
            out[geo._nkey(nd)] = round(v, 2)
    (DATA_DIR / "elevation.json").write_text(json.dumps(out))
    geo.reset_cache()
    gr = geo.base_graph()
    missing = sum(v is None for row in z for v in row)
    return {"ok": missing == 0, "grid_points": ny * nx, "fetched_now": got, "missing": missing,
            "nodes_with_elevation": len(out), "graph": gr["stats"],
            **({"note": "일부를 받지 못했습니다. 잠시 뒤 '고도 받기'를 다시 누르면 남은 부분만 받습니다."} if missing else {})}
