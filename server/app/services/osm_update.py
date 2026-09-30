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

BBOX = "37.6080,127.0470,37.6350,127.0760"
QUERY = f"""[out:json][timeout:180][bbox:{BBOX}];
(
  relation["boundary"="administrative"]["name"="월계1동"];
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
            r = httpx.post(url, data={"data": QUERY}, timeout=200,
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
            return {"ok": True, "server": url, "features": len(gj["features"]), "graph": g["stats"],
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
    return {"ok": True, "features": len(gj["features"]), "graph": geo.base_graph()["stats"], "pois": len(geo.pois())}


def fetch_elevation() -> dict:
    """Open-Meteo 고도 API(Copernicus 90m DEM)로 보행 그래프 노드의 고도를 받아 경사도 계산에 사용."""
    nodes = geo.base_graph()["n"]
    out: dict[str, float] = {}
    f = DATA_DIR / "elevation.json"
    if f.exists():
        out = json.loads(f.read_text())
    todo = [n for n in nodes if geo._nkey(n) not in out]
    with httpx.Client(timeout=30) as client:
        for i in range(0, len(todo), 100):
            chunk = todo[i:i + 100]
            params = {"latitude": ",".join(f"{n[0]:.6f}" for n in chunk),
                      "longitude": ",".join(f"{n[1]:.6f}" for n in chunk)}
            for attempt in range(3):
                try:
                    r = client.get("https://api.open-meteo.com/v1/elevation", params=params)
                    r.raise_for_status()
                    for n, e in zip(chunk, r.json()["elevation"]):
                        out[geo._nkey(n)] = float(e)
                    break
                except Exception as e:
                    log.warning("고도 받기 재시도 %s: %s", attempt, e)
                    time.sleep(2 + attempt * 3)
            time.sleep(0.3)
    f.write_text(json.dumps(out))
    geo.reset_cache()
    g = geo.base_graph()
    return {"ok": True, "nodes": len(out), "graph": g["stats"]}
