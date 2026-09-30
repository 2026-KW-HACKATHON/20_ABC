// OSM 데이터로 그리는 월계1동 배경지도 (외부 지도 타일 없이 동작)
const POLY = {
  residential: { fillColor: "#efece5", fillOpacity: 1, stroke: false },
  parking:  { fillColor: "#e9e7e2", fillOpacity: 1, color: "#dcd9d2", weight: 0.5 },
  construction: { fillColor: "#efe3c8", fillOpacity: 1, color: "#e0cf9f", weight: 0.8, dashArray: "4 3" },
  park:     { fillColor: "#c6e6bd", fillOpacity: 1, color: "#b3d8a8", weight: 0.6 },
  pitch:    { fillColor: "#b3dcae", fillOpacity: 1, color: "#9fcc9a", weight: 0.6 },
  campus:   { fillColor: "#ede7d6", fillOpacity: 1, color: "#ddd4bd", weight: 0.8 },
  school:   { fillColor: "#ede7d6", fillOpacity: 1, color: "#ddd4bd", weight: 0.6 },
  plaza:    { fillColor: "#ebe8e1", fillOpacity: 1, stroke: false },
  platform: { fillColor: "#dcdad4", fillOpacity: 1, stroke: false },
  water:    { fillColor: "#a8cff2", fillOpacity: 1, color: "#8fbde8", weight: 0.6 },
  building: { fillColor: "#e3dfd6", fillOpacity: 1, color: "#d1ccc1", weight: 0.6 },
};
// [폭(z16 기준), 채움, 테두리, 점선]
const ROAD = {
  service: [2.0, "#ffffff", "#dcd8cf"], residential: [3.2, "#ffffff", "#d3cfc5"], tertiary: [4.4, "#ffffff", "#cfcabf"],
  secondary: [5.4, "#fdf0c6", "#dcc88e"], primary: [6.4, "#f8dd8e", "#d9b25c"], trunk: [7.4, "#f5cf70", "#cfa43e"],
  footway: [1.3, "#b9b5ad", null, true], cycleway: [1.4, "#7fa8d8", null, true], steps: [2.4, "#8f8a80", null, true],
};
const ROAD_ORDER = ["footway", "cycleway", "steps", "service", "residential", "tertiary", "secondary", "primary", "trunk"];

export function renderBasemap(map, data, { dimOutside = true, labels = true, cover = false } = {}) {
  // 배경지도(건물·길)는 따로 층을 둬서 위성 지도로 바꿀 때 통째로 숨김. 동 경계·흐림은 그 위 층
  if (!map.getPane("wgBase")) { map.createPane("wgBase").style.zIndex = 350; map.createPane("wgDim").style.zIndex = 390; }
  const canvas = L.canvas({ padding: 0.4, pane: "wgBase" });
  const dimCanvas = L.canvas({ padding: 0.4, pane: "wgDim" });
  const baseGroup = L.layerGroup();
  const addB = l => l.addTo(baseGroup);
  if (cover) {
    // 전국 배경지도 위에 월계1동 정밀 지도를 얹을 때: 데이터 범위만큼 바탕을 덮어 두 지도가 겹쳐 보이지 않게
    let s = 90, w = 180, n = -90, e = -180;
    data.l.forEach(([, cs]) => cs.forEach(([la, ln]) => { if (la < s) s = la; if (la > n) n = la; if (ln < w) w = ln; if (ln > e) e = ln; }));
    addB(L.rectangle([[s, w], [n, e]], { stroke: false, fillColor: "#f3f1ec", fillOpacity: 1, interactive: false, renderer: canvas }));
  }
  const groups = { residential: [], land: [], water: [], building: [] };
  data.p.forEach(([cls, ring]) => {
    const st = POLY[cls]; if (!st) return;
    const layer = L.polygon(ring, { ...st, renderer: canvas, interactive: false });
    const g = cls === "building" ? "building" : cls === "water" ? "water" : (cls === "residential" || cls === "parking") ? "residential" : "land";
    groups[g].push(layer);
  });
  ["residential", "land", "water", "building"].forEach(g => groups[g].forEach(addB));

  const byCls = {};
  data.l.forEach(([cls, cs]) => (byCls[cls] = byCls[cls] || []).push(cs));
  const waterLines = [], railBase = [], railDash = [], casing = [], fill = [], fences = [];
  (byCls.waterline || []).forEach(cs => waterLines.push(addB(L.polyline(cs, { color: "#a8cff2", weight: 4, lineCap: "round", renderer: canvas, interactive: false }))));
  (byCls.fence || []).forEach(cs => fences.push(addB(L.polyline(cs, { color: "#b8b1a4", weight: 1, dashArray: "2 3", renderer: canvas, interactive: false }))));
  (byCls.rail || []).forEach(cs => {
    railBase.push(addB(L.polyline(cs, { color: "#8f8f8f", weight: 3, renderer: canvas, interactive: false })));
    railDash.push(addB(L.polyline(cs, { color: "#ffffff", weight: 1.6, dashArray: "7 7", renderer: canvas, interactive: false })));
  });
  ROAD_ORDER.forEach(cls => {
    const [w, , cas] = ROAD[cls];
    if (!cas) return;
    (byCls[cls] || []).forEach(cs => casing.push({ cls, layer: addB(L.polyline(cs, { color: cas, weight: w + 2, lineCap: "round", lineJoin: "round", renderer: canvas, interactive: false })) }));
  });
  ROAD_ORDER.forEach(cls => {
    const [w, f, , dashed] = ROAD[cls];
    (byCls[cls] || []).forEach(cs => fill.push({ cls, layer: addB(L.polyline(cs, { color: f, weight: w, lineCap: dashed ? "butt" : "round", lineJoin: "round", dashArray: dashed ? "4 4" : null, renderer: canvas, interactive: false })) }));
  });

  baseGroup.addTo(map);

  if (dimOutside) {
    // 서비스 범위(월계동) 바깥을 흐리게. 점선은 월계1동만
    const WORLD = [[-90, -180], [-90, 180], [90, 180], [90, -180]];
    L.polygon([WORLD, ...serviceArea(data)], { stroke: false, fillColor: "#f3f1ec", fillOpacity: 0.78, interactive: false, renderer: dimCanvas }).addTo(map);
  }
  const dongLine = L.polygon(data.b, { color: "#171717", weight: 2.2, dashArray: "8 6", fill: false, interactive: false, renderer: dimCanvas }).addTo(map);

  if (labels) {
    data.t.forEach(([cls, lat, lng, name]) => {
      L.marker([lat, lng], {
        icon: L.divIcon({ className: "lbl lbl-" + cls, html: `<span>${name.replace(/[<>&]/g, "")}</span>`, iconSize: [0, 0] }),
        interactive: false, keyboard: false,
      }).addTo(map);
    });
  }

  function restyle() {
    const z = map.getZoom();
    const k = Math.max(0.35, Math.pow(2, z - 16));
    casing.forEach(({ cls, layer }) => layer.setStyle({ weight: ROAD[cls][0] * k + 2 * Math.min(1, k) }));
    fill.forEach(({ cls, layer }) => layer.setStyle({ weight: ROAD[cls][0] * k, dashArray: ROAD[cls][3] ? `${4 * k} ${4 * k}` : null }));
    waterLines.forEach(l => l.setStyle({ weight: 4 * k }));
    railBase.forEach(l => l.setStyle({ weight: 3 * k }));
    railDash.forEach(l => l.setStyle({ weight: 1.6 * k, dashArray: `${7 * k} ${7 * k}` }));
    groups.building.forEach(l => l.setStyle({ stroke: z >= 16.5 }));
    const el = map.getContainer();
    el.classList.toggle("z-lt16", z < 16);
    el.classList.toggle("z-lt17", z < 17);
  }
  map.on("zoomend", restyle);
  restyle();

  // 위성 지도 켜고 끄기 (sat = {url, labels, maxNativeZoom, attribution})
  let satLayers = [];
  function setSatellite(on, sat) {
    satLayers.forEach(l => map.removeLayer(l)); satLayers = [];
    map.getContainer().classList.toggle("map-sat", !!on);
    if (on && sat) {
      if (map.hasLayer(baseGroup)) map.removeLayer(baseGroup);
      satLayers.push(L.tileLayer(sat.url, { maxZoom: 20, maxNativeZoom: sat.maxNativeZoom || 19, attribution: sat.attribution || "" }).addTo(map));
      if (sat.labels) satLayers.push(L.tileLayer(sat.labels, { maxZoom: 20, maxNativeZoom: sat.maxNativeZoom || 19 }).addTo(map));
      dongLine.setStyle({ color: "#ffffff" });
    } else {
      if (!map.hasLayer(baseGroup)) baseGroup.addTo(map);
      dongLine.setStyle({ color: "#171717" });
    }
  }
  return { bounds: L.latLngBounds(data.b), restyle, baseGroup, setSatellite };
}

// 서비스 범위: 월계동(월계1·2·3동) 경계들. 예전 데이터처럼 월계1동만 있으면 월계1동
export function serviceArea(data) { return data.a && data.a.length ? data.a : [data.b]; }

export function inService(data, lat, lng) {
  return serviceArea(data).some(rg => pointInBoundary(lat, lng, rg));
}

// 지도 이동은 월계동 범위 안으로 제한, 처음 화면은 월계1동
export function createMap(el, data, opts = {}) {
  const area = L.latLngBounds(serviceArea(data).flat());
  const map = L.map(el, {
    preferCanvas: true, zoomControl: false, attributionControl: opts.attribution !== false,
    maxBounds: area.pad(0.35), maxBoundsViscosity: 1.0, minZoom: 13.5, maxZoom: 19.5,
    zoomSnap: 0.25, zoomDelta: 0.5,
    ...(opts.leaflet || {}),
  });
  if (opts.zoomControl !== false) L.control.zoom({ position: "bottomright" }).addTo(map);
  if (opts.attribution !== false) map.attributionControl.setPrefix(false).addAttribution('© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 기여자');
  map.wg = renderBasemap(map, data, opts);
  map.fitBounds(L.latLngBounds(data.b), { padding: opts.padding || [20, 20] });
  // 월계동 전체가 한 화면에 들어오는 정도까지만 축소
  map.setMinZoom(Math.max(13, Math.min(map.getBoundsZoom(area, false, [16, 16]) - 0.25, map.getZoom())));
  return map;
}

// 월계1동 전용 기능을 쓸 때: 동 바깥을 흐리게 덮는 레이어 (켜고 끌 수 있음)
export function dongMask(data) {
  const WORLD = [[-90, -180], [-90, 180], [90, 180], [90, -180]];
  return L.polygon([WORLD, data.b], { stroke: false, fillColor: "#14233d", fillOpacity: 0.28, interactive: false });
}

export function pointInBoundary(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < xi + (lat - yi) * (xj - xi) / (yj - yi)) inside = !inside;
  }
  return inside;
}
