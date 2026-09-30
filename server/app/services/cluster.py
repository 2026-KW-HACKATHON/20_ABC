"""신문고 제보 위치 클러스터링 (DBSCAN) → 문제 반복 구간(핫스팟)."""
from __future__ import annotations

import math
from collections import Counter

from .geo import P


def dbscan(points: list[tuple[float, float]], eps_m: float = 40, min_pts: int = 3) -> list[int]:
    """points: [(lat,lng)] → 라벨 목록 (-1 = 잡음). 제보 수가 수천 건 이하라 격자 인덱스로 충분."""
    xy = [P.xy(lng, lat) for lat, lng in points]
    cell = eps_m
    grid: dict[tuple, list[int]] = {}
    for i, (x, y) in enumerate(xy):
        grid.setdefault((int(x // cell), int(y // cell)), []).append(i)

    def neighbors(i):
        x, y = xy[i]
        cx, cy = int(x // cell), int(y // cell)
        out = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid.get((cx + dx, cy + dy), []):
                    if math.dist(xy[i], xy[j]) <= eps_m:
                        out.append(j)
        return out

    labels = [None] * len(points)
    cid = -1
    for i in range(len(points)):
        if labels[i] is not None:
            continue
        nb = neighbors(i)
        if len(nb) < min_pts:
            labels[i] = -1
            continue
        cid += 1
        labels[i] = cid
        queue = [j for j in nb if j != i]
        while queue:
            j = queue.pop()
            if labels[j] == -1:
                labels[j] = cid
            if labels[j] is not None:
                continue
            labels[j] = cid
            nb2 = neighbors(j)
            if len(nb2) >= min_pts:
                queue.extend(nb2)
    return [(-1 if l is None else l) for l in labels]


def hotspots(reports: list[dict], eps_m: float = 40, min_pts: int = 3) -> list[dict]:
    """reports: [{lat,lng,category,status,created_at}] → 핫스팟 목록 (제보 많은 순)."""
    if not reports:
        return []
    labels = dbscan([(r["lat"], r["lng"]) for r in reports], eps_m, min_pts)
    groups: dict[int, list[dict]] = {}
    for r, l in zip(reports, labels):
        if l >= 0:
            groups.setdefault(l, []).append(r)
    out = []
    for members in groups.values():
        lat = sum(m["lat"] for m in members) / len(members)
        lng = sum(m["lng"] for m in members) / len(members)
        radius = max(dist for dist in [math.dist(P.xy(m["lng"], m["lat"]), P.xy(lng, lat)) for m in members]) + 10
        cats = Counter(m["category"] for m in members)
        open_cnt = sum(1 for m in members if m["status"] in ("received", "checking"))
        out.append({"lat": round(lat, 6), "lng": round(lng, 6), "radius_m": round(radius), "count": len(members),
                    "open": open_cnt, "top_category": cats.most_common(1)[0][0],
                    "categories": dict(cats), "last": max(m["created_at"] for m in members)})
    out.sort(key=lambda h: (-h["open"], -h["count"]))
    return out
