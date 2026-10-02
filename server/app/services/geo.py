"""지도 데이터 서비스

- OSM(GeoJSON 또는 Overpass 원본 JSON) → 배경지도 데이터(basemap), 보행 그래프(graph), 가게 목록(POI)
- 승인된 길 제보·공사 구간을 그래프에 덧입힘(overlay)

그래프 간선 형식: [a, b, 길이m, 종류, 플래그, 경사%]
  종류  0 이면도로 · 1 보행로 · 2 계단 · 3 단지·건물 내 도로 · 4 끊긴 길 연결 · 5 열린 공간 가로지름 · 6 큰길
  플래그 1 캠퍼스·학교 내부 · 2 쪽문·출입구 통과 · 4 출입 제한 가능 · 8 계단 제보
         16 가파름 제보 · 32 막힘 제보 · 64 공사 구간 · 128 주민이 추가한 길
"""
from __future__ import annotations

import json
import math
import re
import threading
from collections import defaultdict
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

from ..config import DATA_DIR, SEED_DIR

# ---------------------------------------------------------------- 상수
ROAD_STYLE = {
    "trunk": "trunk", "trunk_link": "trunk", "motorway": "trunk",
    "primary": "primary", "primary_link": "primary",
    "secondary": "secondary", "secondary_link": "secondary",
    "tertiary": "tertiary", "tertiary_link": "tertiary",
    "residential": "residential", "unclassified": "residential", "road": "residential",
    "living_street": "residential", "bus_guideway": "residential",
    "service": "service",
    "footway": "footway", "path": "footway", "pedestrian": "footway", "track": "footway",
    "steps": "steps", "cycleway": "cycleway",
}
WALK_TYPE = {
    "residential": 0, "unclassified": 0, "road": 0, "living_street": 0,
    "tertiary": 0, "tertiary_link": 0,
    "secondary": 6, "secondary_link": 6, "primary": 6, "primary_link": 6, "trunk": 6, "trunk_link": 6,
    "footway": 1, "path": 1, "pedestrian": 1, "cycleway": 1, "track": 1,
    "steps": 2,
    "service": 3,
}
T_ROAD, T_FOOT, T_STEPS, T_SERVICE, T_BRIDGE, T_CROSS, T_MAJOR = range(7)
F_INSIDE, F_GATE, F_RESTRICT, F_STAIRS, F_STEEP, F_BLOCK, F_CONSTR, F_CUSTOM = 1, 2, 4, 8, 16, 32, 64, 128
BRIDGE_M = 8
CROSS_M = 110
MAX_CROSS_NODES = 260

# 편의 기능(메모 기반 경로)용 가게 분류
POI_TAGS = {
    ("shop", "convenience"): "convenience", ("shop", "supermarket"): "supermarket",
    ("shop", "department_store"): "supermarket", ("shop", "mall"): "supermarket",
    ("shop", "variety_store"): "variety", ("shop", "cosmetics"): "cosmetics", ("shop", "chemist"): "cosmetics",
    ("shop", "greengrocer"): "greengrocer", ("shop", "bakery"): "bakery", ("shop", "butcher"): "butcher",
    ("shop", "stationery"): "stationery", ("shop", "hardware"): "hardware", ("shop", "doityourself"): "hardware",
    ("shop", "clothes"): "clothes", ("shop", "laundry"): "laundry", ("shop", "dry_cleaning"): "laundry",
    ("shop", "mobile_phone"): "electronics", ("shop", "electronics"): "electronics",
    ("shop", "books"): "books", ("shop", "florist"): "florist", ("shop", "beverages"): "convenience",
    ("amenity", "pharmacy"): "pharmacy", ("amenity", "cafe"): "cafe", ("amenity", "bank"): "bank",
    ("amenity", "atm"): "bank", ("amenity", "post_office"): "post_office", ("amenity", "clinic"): "clinic",
    ("amenity", "doctors"): "clinic", ("amenity", "hospital"): "clinic", ("amenity", "dentist"): "clinic",
    ("amenity", "restaurant"): "restaurant", ("amenity", "fast_food"): "restaurant",
    ("amenity", "library"): "library", ("amenity", "townhall"): "public", ("amenity", "community_centre"): "public",
}
BRAND_POI = [  # 이름으로 분류 (태그가 빠진 경우)
    (("CU", "GS25", "세븐일레븐", "7-Eleven", "이마트24", "미니스톱", "emart24"), "convenience"),
    (("이마트", "E-Mart", "홈플러스", "롯데마트", "하나로마트", "마트"), "supermarket"),
    (("다이소",), "variety"), (("올리브영", "롭스", "랄라블라"), "cosmetics"),
    (("약국",), "pharmacy"), (("파리바게뜨", "뚜레쥬르", "베이커리"), "bakery"),
    (("스타벅스", "이디야", "투썸", "메가커피", "빽다방", "카페"), "cafe"),
    (("우체국",), "post_office"), (("은행",), "bank"), (("의원", "병원"), "clinic"),
    (("도서관",), "library"), (("주민센터", "행정복지센터"), "public"),
]

_lock = threading.Lock()
_cache: dict = {}
generation = 0   # 지도·고도 데이터가 바뀔 때마다 증가 (덧입힌 그래프 캐시 무효화용)


# ---------------------------------------------------------------- OSM 로딩
def osm_path() -> Path:
    p = DATA_DIR / "osm.geojson"
    return p if p.exists() else SEED_DIR / "osm.geojson"


def osm_json_to_geojson(raw: dict) -> dict:
    """Overpass 원본 JSON(elements) → GeoJSON FeatureCollection."""
    nodes, ways, rels = {}, {}, []
    for el in raw.get("elements", []):
        t = el.get("type")
        if t == "node":
            nodes[el["id"]] = el
        elif t == "way":
            ways[el["id"]] = el
        elif t == "relation":
            rels.append(el)
    feats = []
    for n in nodes.values():
        if n.get("tags"):
            feats.append({"type": "Feature", "properties": n["tags"],
                          "geometry": {"type": "Point", "coordinates": [n["lon"], n["lat"]]}})
    area_keys = ("building", "landuse", "leisure", "amenity", "natural", "shop", "area", "place")
    for w in ways.values():
        tags = w.get("tags") or {}
        if not tags:
            continue
        cs = [[nodes[i]["lon"], nodes[i]["lat"]] for i in w.get("nodes", []) if i in nodes]
        if len(cs) < 2:
            continue
        closed = len(cs) >= 4 and cs[0] == cs[-1]
        is_area = closed and (tags.get("area") == "yes" or
                              (any(k in tags for k in area_keys) and "highway" not in tags and "barrier" not in tags) or
                              tags.get("highway") == "pedestrian" and tags.get("area") == "yes")
        geom = {"type": "Polygon", "coordinates": [cs]} if is_area else {"type": "LineString", "coordinates": cs}
        feats.append({"type": "Feature", "properties": tags, "geometry": geom})
    for r in rels:
        tags = r.get("tags") or {}
        if tags.get("type") not in ("multipolygon", "boundary"):
            continue
        segs = []
        for m in r.get("members", []):
            if m.get("type") == "way" and m.get("role", "outer") in ("outer", "") and m["ref"] in ways:
                cs = [[nodes[i]["lon"], nodes[i]["lat"]] for i in ways[m["ref"]].get("nodes", []) if i in nodes]
                if len(cs) >= 2:
                    segs.append(cs)
        for ring in _stitch(segs):
            if len(ring) >= 4:
                feats.append({"type": "Feature", "properties": tags,
                              "geometry": {"type": "Polygon", "coordinates": [ring]}})
    return {"type": "FeatureCollection", "features": feats}


def _stitch(segs: list[list]) -> list[list]:
    """선 조각들을 이어 닫힌 고리로 만든다 (행정경계 relation용)."""
    segs = [list(s) for s in segs]
    rings = []
    while segs:
        ring = segs.pop(0)
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += s[::-1][1:]
                elif s[-1] == ring[0]:
                    ring = s[:-1] + ring
                elif s[0] == ring[0]:
                    ring = s[::-1][:-1] + ring
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        rings.append(ring)
    return rings


def load_features() -> list[dict]:
    raw = json.loads(osm_path().read_text(encoding="utf-8"))
    if "elements" in raw:
        raw = osm_json_to_geojson(raw)
    return raw["features"]


# ---------------------------------------------------------------- 좌표 유틸
def _r(c):
    return [round(c[1], 5), round(c[0], 5)]


def _ring(cs):
    out = [_r(c) for c in cs]
    return out[:-1] if len(out) > 1 and out[0] == out[-1] else out


def _pip(pt, poly):
    x, y = pt[1], pt[0]
    inside = False
    n = len(poly)
    for i in range(n):
        y1, x1 = poly[i]
        y2, x2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def _centroid(poly):
    return [round(sum(p[0] for p in poly) / len(poly), 5), round(sum(p[1] for p in poly) / len(poly), 5)]


class Proj:
    """위경도 ↔ 미터 평면 근사 (월계1동 규모에서 오차 무시 가능)."""
    def __init__(self, lat0=37.62):
        self.kx = 111320 * math.cos(math.radians(lat0))
        self.ky = 110540

    def xy(self, lng, lat):
        return (lng * self.kx, lat * self.ky)

    def ll(self, x, y):
        return (y / self.ky, x / self.kx)


P = Proj()


def dist_m(lat1, lng1, lat2, lng2):
    return math.hypot((lng2 - lng1) * P.kx, (lat2 - lat1) * P.ky)


# ---------------------------------------------------------------- 배경지도
AREA_NAME = re.compile(r"^월계[0-9]동$")      # 서비스 범위: 월계동(월계1·2·3동). 정밀 기능(점선)은 월계1동


def build_basemap(feats: list[dict]) -> dict:
    boundary, polys, lines, pts = None, [], [], []
    area: dict[str, list] = {}
    for ft in feats:
        p, geo = ft["properties"], ft["geometry"]
        t = geo["type"]
        name = p.get("name")
        if p.get("boundary") == "administrative" and t in ("Polygon", "MultiPolygon"):
            rings = [geo["coordinates"][0]] if t == "Polygon" else [pg[0] for pg in geo["coordinates"]]
            if name == "월계1동":
                boundary = _ring(max(rings, key=len))
            if name and AREA_NAME.match(name):
                area[name] = [_ring(rg) for rg in rings]
            continue
        if t == "Point":
            if p.get("railway") == "station" and name:
                pts.append(["station", *_r(geo["coordinates"]), name])
            continue
        if t in ("Polygon", "MultiPolygon"):
            rings = [geo["coordinates"][0]] if t == "Polygon" else [pg[0] for pg in geo["coordinates"]]
            if "building" in p:
                cls = "building"
            elif p.get("natural") == "water":
                cls = "water"
            elif p.get("leisure") in ("park", "garden", "dog_park", "nature_reserve") or p.get("landuse") in ("grass", "forest", "recreation_ground", "village_green"):
                cls = "park"
            elif p.get("leisure") in ("pitch", "playground", "sports_centre", "track"):
                cls = "pitch"
            elif p.get("amenity") in ("university", "college"):
                cls = "campus"
            elif p.get("amenity") in ("school", "kindergarten"):
                cls = "school"
            elif p.get("railway") == "platform":
                cls = "platform"
            elif p.get("highway") == "pedestrian":
                cls = "plaza"
            elif p.get("landuse") == "residential":
                cls = "residential"
            elif p.get("landuse") == "construction":
                cls = "construction"
            elif p.get("amenity") == "parking" and p.get("parking") not in ("underground",):
                cls = "parking"
            else:
                continue
            for rg in rings:
                polys.append([cls, _ring(rg)])
            continue
        if t == "LineString":
            cs = [_r(c) for c in geo["coordinates"]]
            if "highway" in p:
                cls = ROAD_STYLE.get(p["highway"])
                if not cls:
                    continue
            elif p.get("waterway") in ("river", "stream", "canal"):
                cls = "waterline"
            elif p.get("railway") in ("rail", "subway"):
                cls = "rail"
            elif p.get("barrier") in ("fence", "wall", "retaining_wall"):
                cls = "fence"
            else:
                continue
            lines.append([cls, cs])
    if boundary is None:
        raise RuntimeError("OSM 데이터에 월계1동 행정경계가 없습니다.")
    area_rings = [rg for name in sorted(area) for rg in area[name]] or [boundary]
    in_area = lambda c: any(_pip(c, rg) for rg in area_rings)  # noqa: E731

    labels = [["station", la, ln, n] for _, la, ln, n in pts]
    seen = set()
    biggest: dict[str, list] = {}
    for ft in feats:
        p, geo = ft["properties"], ft["geometry"]
        if geo["type"] == "Polygon" and p.get("name") and p.get("amenity") == "university":
            rg = geo["coordinates"][0]
            if len(rg) > len(biggest.get(p["name"], [])):
                biggest[p["name"]] = rg
    for name, rg in biggest.items():
        c = _centroid(_ring(rg))
        if in_area(c):
            labels.append(["campus", *c, name])
            seen.add(name)
    for ft in feats:
        p, geo = ft["properties"], ft["geometry"]
        if geo["type"] != "Polygon" or not p.get("name") or p["name"] in seen:
            continue
        c = _centroid(_ring(geo["coordinates"][0]))
        if not in_area(c):
            continue
        if p.get("leisure") == "park":
            labels.append(["park", *c, p["name"]])
        elif p.get("amenity") == "school":
            labels.append(["school", *c, p["name"]])
        elif p.get("building") and p.get("amenity") in (None,) and any(k in p["name"] for k in ("관", "재", "센터", "경로당", "도서관")):
            labels.append(["building", *c, p["name"]])
        else:
            continue
        seen.add(p["name"])
    lats = [pt[0] for rg in area_rings for pt in rg]
    lngs = [pt[1] for rg in area_rings for pt in rg]
    return {"b": boundary, "a": area_rings, "an": sorted(area) or ["월계1동"],
            "ab": [[min(lats), min(lngs)], [max(lats), max(lngs)]], "p": polys, "l": lines, "t": labels}


# ---------------------------------------------------------------- POI
def build_pois(feats: list[dict]) -> list[dict]:
    out, seen = [], set()
    for ft in feats:
        p, geo = ft["properties"], ft["geometry"]
        name = p.get("name") or ""
        cat = None
        if name and "장례식장" not in name:
            for keys, c in BRAND_POI:        # 상호명이 확실하면 태그보다 우선
                if any(key.lower() in name.lower() for key in keys):
                    cat = c
                    break
        if not cat:
            for (k, v), c in POI_TAGS.items():
                if p.get(k) == v:
                    cat = c
                    break
        if not cat or "장례식장" in name:
            continue
        if geo["type"] == "Point":
            lng, lat = geo["coordinates"]
        elif geo["type"] == "Polygon":
            ring = geo["coordinates"][0]
            lat = sum(c[1] for c in ring) / len(ring)
            lng = sum(c[0] for c in ring) / len(ring)
        else:
            continue
        key = (name, round(lat, 4), round(lng, 4))
        if key in seen:
            continue
        seen.add(key)
        out.append({"name": name or cat, "cat": cat, "lat": round(lat, 6), "lng": round(lng, 6),
                    "hours": p.get("opening_hours", "")})
    return out


# ---------------------------------------------------------------- 보행 그래프
def build_graph(feats: list[dict]) -> dict:
    private_polys, open_polys, buildings, barriers = [], [], [], []
    gate_nodes: dict[tuple, dict] = {}
    for f in feats:
        p, geo = f["properties"], f["geometry"]
        if geo["type"] == "Point":
            # 건물 출입구(entrance)는 쪽문이 아니므로 제외, 담장·단지 출입문(barrier)만
            if p.get("barrier") in ("gate", "lift_gate", "swing_gate", "kissing_gate", "turnstile", "entrance"):
                c = geo["coordinates"]
                gate_nodes[(round(c[0], 7), round(c[1], 7))] = p
            continue
        if geo["type"] == "LineString" and p.get("barrier") in ("fence", "wall", "retaining_wall", "hedge"):
            barriers.append(LineString([P.xy(*c) for c in geo["coordinates"]]))
            continue
        if geo["type"] != "Polygon":
            continue
        try:
            poly = Polygon([P.xy(*c) for c in geo["coordinates"][0]])
        except Exception:
            continue
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty:
            continue
        if p.get("amenity") in ("university", "college"):
            private_polys.append(poly)
            open_polys.append(poly)
        elif p.get("amenity") in ("school", "kindergarten"):
            private_polys.append(poly)          # 학교는 외부인 통행 제한 → 가로지르기 제외
        elif p.get("leisure") in ("park", "garden") or p.get("landuse") in ("grass", "village_green") or p.get("highway") == "pedestrian":
            open_polys.append(poly)
        elif p.get("amenity") == "parking" and p.get("parking") not in ("underground", "multi-storey", "rooftop") \
                and p.get("access") not in ("private", "no"):
            open_polys.append(poly)             # 평면 주차장은 가로질러 갈 수 있음
        elif "building" in p:
            buildings.append(poly)
    private_u = unary_union(private_polys) if private_polys else None
    btree = STRtree(buildings) if buildings else None
    fence_tree = STRtree(barriers) if barriers else None

    nid: dict[tuple, int] = {}
    nodes: list[list[float]] = []
    nxy: list[tuple] = []

    def node(c):
        k = (round(c[0], 7), round(c[1], 7))
        if k not in nid:
            nid[k] = len(nodes)
            nodes.append([round(c[1], 6), round(c[0], 6)])
            nxy.append(P.xy(*c))
        return nid[k]

    edges: dict[tuple, list] = {}
    deg = defaultdict(int)

    def add(a, b, t, flags=0):
        if a == b:
            return
        key = (a, b) if a < b else (b, a)
        if key in edges:
            return
        L = math.dist(nxy[a], nxy[b])
        mid = Point((nxy[a][0] + nxy[b][0]) / 2, (nxy[a][1] + nxy[b][1]) / 2)
        if private_u is not None and private_u.contains(mid):
            flags |= F_INSIDE
        edges[key] = [round(L, 1), t, flags]
        deg[a] += 1
        deg[b] += 1

    gate_node_ids: dict[int, dict] = {}
    for f in feats:
        p, geo = f["properties"], f["geometry"]
        if geo["type"] != "LineString" or p.get("highway") not in WALK_TYPE:
            continue
        if p.get("foot") == "no":
            continue
        flags = 0
        if p.get("access") in ("private", "no") and p.get("foot") not in ("yes", "designated", "permissive"):
            flags |= F_RESTRICT
        t = WALK_TYPE[p["highway"]]
        ids = [node(c) for c in geo["coordinates"]]
        for c, i in zip(geo["coordinates"], ids):
            gp = gate_nodes.get((round(c[0], 7), round(c[1], 7)))
            if gp is not None:
                gate_node_ids[i] = gp
        for a, b in zip(ids, ids[1:]):
            add(a, b, t, flags)
    n_base = len(edges)

    def _blocked(seg: LineString, touch_buildings=True) -> bool:
        if touch_buildings and btree is not None:
            if any(seg.intersects(buildings[int(k)]) for k in btree.query(seg)):
                return True
        if fence_tree is not None:
            if any(seg.crosses(barriers[int(k)]) for k in fence_tree.query(seg)):
                return True
        return False

    # 지름길 1: 끊긴 길 잇기
    cell = 20
    grid = defaultdict(list)
    for i, (x, y) in enumerate(nxy):
        grid[(int(x // cell), int(y // cell))].append(i)

    def near(i, r):
        x, y = nxy[i]
        cx, cy = int(x // cell), int(y // cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid[(cx + dx, cy + dy)]:
                    if j != i and math.dist(nxy[i], nxy[j]) <= r:
                        yield j

    for i in [i for i in range(len(nodes)) if deg[i] == 1]:
        best = None
        for j in near(i, BRIDGE_M):
            key = (i, j) if i < j else (j, i)
            if key in edges:
                continue
            d = math.dist(nxy[i], nxy[j])
            if best is None or d < best[0]:
                best = (d, j)
        if best:
            seg = LineString([nxy[i], nxy[best[1]]])
            if not _blocked(seg):
                add(i, best[1], T_BRIDGE)
    n_bridge = len(edges) - n_base

    # 지름길 2: 캠퍼스·공원·광장 가로지르기
    pts = [Point(q) for q in nxy]
    ptree = STRtree(pts)
    for area in open_polys:
        if area.area < 400:
            continue
        inner = area.buffer(1.5)
        cand = [int(k) for k in ptree.query(inner) if inner.contains(pts[int(k)])]
        if len(cand) < 2:
            continue
        if len(cand) > MAX_CROSS_NODES:
            step = len(cand) / MAX_CROSS_NODES
            cand = [cand[int(i * step)] for i in range(MAX_CROSS_NODES)]
        for ii in range(len(cand)):
            a = cand[ii]
            for jj in range(ii + 1, len(cand)):
                b = cand[jj]
                d = math.dist(nxy[a], nxy[b])
                if d < 15 or d > CROSS_M:
                    continue
                key = (a, b) if a < b else (b, a)
                if key in edges:
                    continue
                seg = LineString([nxy[a], nxy[b]])
                if not inner.contains(seg) or _blocked(seg):
                    continue
                add(a, b, T_CROSS)
    n_cross = len(edges) - n_base - n_bridge

    # 쪽문·출입구 표시 (게이트 노드에 닿는 간선)
    hours: dict[int, str] = {}
    E = []
    for (a, b), (L, t, fl) in edges.items():
        for g in (a, b):
            gp = gate_node_ids.get(g)
            if gp is not None:
                fl |= F_GATE
                if gp.get("access") in ("private", "no") and gp.get("foot") not in ("yes", "permissive", "designated"):
                    fl |= F_RESTRICT
                if gp.get("opening_hours"):
                    hours[len(E)] = gp["opening_hours"]
        E.append([a, b, L, t, fl, 0.0])

    # 경사도 (tools/fetch_elevation.py 로 받은 고도 파일이 있으면)
    elev = _load_elevation()
    n_grade = 0
    if elev:
        for e in E:
            a, b, L = e[0], e[1], e[2]
            ea, eb = elev.get(_nkey(nodes[a])), elev.get(_nkey(nodes[b]))
            if ea is not None and eb is not None and L >= 8:
                e[5] = round(abs(eb - ea) / L * 100, 1)
                n_grade += 1

    stats = {"nodes": len(nodes), "edges": len(E), "base": n_base, "bridge": n_bridge, "cross": n_cross,
             "gates": len(gate_node_ids), "fences": len(barriers), "graded": n_grade}
    return {"n": nodes, "e": E, "h": {str(k): v for k, v in hours.items()}, "stats": stats}


def _nkey(n):
    return f"{n[0]:.6f},{n[1]:.6f}"


def _load_elevation() -> dict:
    f = DATA_DIR / "elevation.json"
    if not f.exists():
        return {}
    try:
        return json.loads(f.read_text())
    except Exception:
        return {}


# ---------------------------------------------------------------- 덧입히기 (길 제보, 공사)
def apply_overlays(base: dict, path_edits: list[dict], constructions: list[dict]) -> dict:
    nodes = [list(n) for n in base["n"]]
    E = [list(e) for e in base["e"]]
    hours = dict(base.get("h", {}))
    npts = [Point(P.xy(n[1], n[0])) for n in nodes]
    ntree = STRtree(npts)

    def nearest_node(lat, lng, maxd=30):
        pt = Point(P.xy(lng, lat))
        best, bd = None, maxd
        for k in ntree.query(pt.buffer(maxd)):
            d = npts[int(k)].distance(pt)
            if d < bd:
                best, bd = int(k), d
        return best

    def add_node(lat, lng):
        nodes.append([round(lat, 6), round(lng, 6)])
        return len(nodes) - 1

    def add_edge(a, b, t, fl, hrs=""):
        L = dist_m(nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1])
        if L < 0.5:
            return
        E.append([a, b, round(L, 1), t, fl, 0.0])
        if hrs:
            hours[str(len(E) - 1)] = hrs

    applied = 0
    # 1) 새 길·쪽문 먼저 추가
    for pe in path_edits:
        coords = pe["coords"]
        if pe["kind"] in ("add", "gate") and len(coords) >= 2:
            fl = F_CUSTOM | (F_GATE if pe["kind"] == "gate" else 0)
            ids = []
            for i, (lat, lng) in enumerate(coords):
                snap = nearest_node(lat, lng, 12 if 0 < i < len(coords) - 1 else 30)
                ids.append(snap if snap is not None else add_node(lat, lng))
            for a, b in zip(ids, ids[1:]):
                add_edge(a, b, T_FOOT, fl, pe.get("open_hours", ""))
            applied += 1

    # 2) 추가된 길까지 포함해 인덱스를 만든 뒤 막힘·계단·가파름·공사 표시
    segs = [LineString([P.xy(nodes[e[0]][1], nodes[e[0]][0]), P.xy(nodes[e[1]][1], nodes[e[1]][0])]) for e in E]
    tree = STRtree(segs)
    for pe in path_edits:
        coords = pe["coords"]
        if pe["kind"] not in ("block", "stairs", "steep") or not coords:
            continue
        flag = {"block": F_BLOCK, "stairs": F_STAIRS, "steep": F_STEEP}[pe["kind"]]
        geom = LineString([P.xy(c[1], c[0]) for c in coords]) if len(coords) >= 2 else Point(P.xy(coords[0][1], coords[0][0]))
        zone = geom.buffer(7)
        for k in tree.query(zone):
            k = int(k)
            if zone.contains(segs[k].centroid) or (segs[k].length < 20 and zone.intersects(segs[k])):
                E[k][4] |= flag
        applied += 1

    for c in constructions:
        zone = Point(P.xy(c["lng"], c["lat"])).buffer(max(5.0, c["radius_m"]))
        for k in tree.query(zone):
            if zone.intersects(segs[int(k)]):
                E[int(k)][4] |= F_CONSTR
    return {"n": nodes, "e": E, "h": hours, "applied": applied}


# ---------------------------------------------------------------- 캐시
BUILD_VERSION = "3"      # 캐시 형식이 바뀌면 올림 (월계동 범위 'a' 추가)


def _cached(name: str, builder):
    with _lock:
        if name in _cache:
            return _cache[name]
        src = osm_path()
        cache_file = DATA_DIR / f"cache_{name}.json"
        stamp = f"{BUILD_VERSION}:{src}:{src.stat().st_mtime_ns}:{(DATA_DIR / 'elevation.json').exists()}"
        if cache_file.exists():
            try:
                obj = json.loads(cache_file.read_text(encoding="utf-8"))
                if obj.get("_stamp") == stamp:
                    _cache[name] = obj["data"]
                    return obj["data"]
            except Exception:
                pass
        feats = _cache.get("_feats") or load_features()
        _cache["_feats"] = feats
        data = builder(feats)
        cache_file.write_text(json.dumps({"_stamp": stamp, "data": data}, ensure_ascii=False, separators=(",", ":")),
                              encoding="utf-8")
        _cache[name] = data
        return data


def basemap() -> dict:
    return _cached("basemap", build_basemap)


def base_graph() -> dict:
    return _cached("graph", build_graph)


def pois() -> list[dict]:
    return _cached("pois", build_pois)


def reset_cache():
    global generation
    with _lock:
        _cache.clear()
        generation += 1
    for f in DATA_DIR.glob("cache_*.json"):
        f.unlink(missing_ok=True)


def boundary_contains(lat, lng) -> bool:
    return _pip([lat, lng], basemap()["b"])


def area_contains(lat, lng) -> bool:
    """월계동(서비스 범위) 안인지."""
    return any(_pip([lat, lng], rg) for rg in basemap().get("a") or [basemap()["b"]])


def area_bbox() -> tuple[float, float, float, float]:
    (s, w), (n, e) = basemap().get("ab") or [[37.60, 127.04], [37.65, 127.08]]
    return s, w, n, e
