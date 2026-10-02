// 월계온 앱 진입점: 지도, 레이어, 화면 전환(해시 라우터), 알림 배지
import { api, auth, refreshMe } from "./api.js";
import { createMap, dongMask, inService, pointInBoundary } from "./basemap.js";
import { Graph } from "./graph.js";
import { $, $$, ago, closeSheet, esc, eventWhen, initSheet, openSheet, toast } from "./ui.js";

import * as newsView from "./views/news.js";
import * as eventView from "./views/event.js";
import * as routeView from "./views/route.js";
import * as planView from "./views/plan.js";
import * as reportView from "./views/report.js";
import * as meView from "./views/me.js";
import * as pathView from "./views/pathedit.js";
import { initLiveBoard } from "./live.js";

const LAYER_KEY = "wolgyeon.layers";

// 화면들이 함께 쓰는 상태
export const ctx = {
  map: null,
  base: null,
  graph: null,
  pois: null,
  myPos: null,
  layers: {},
  events: [],
  eventMarkers: new Map(),
  async getGraph(force = false) {
    if (this.graph && !force) return this.graph;
    const data = await api("/api/map/graph");
    this.graph = new Graph(data);
    drawConstructions(data.z || []);
    return this.graph;
  },
  async getPois() {
    if (!this.pois) this.pois = await api("/api/map/pois");
    return this.pois;
  },
  inArea(lat, lng) { return this.base && pointInBoundary(lat, lng, this.base.b); },      // 월계1동 (정밀 기능)
  inService(lat, lng) { return this.base && inService(this.base, lat, lng); },           // 월계동 (지도·길찾기 범위)
  async locate({ silent = false } = {}) {
    if (!navigator.geolocation) { if (!silent) toast("이 기기에서는 위치를 확인할 수 없습니다."); return null; }
    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(p => {
        this.setMyPos([p.coords.latitude, p.coords.longitude]);
        resolve(this.myPos);
      }, err => {
        if (!silent) toast(err.code === 1 ? "위치 권한을 허용하면 내 위치를 쓸 수 있어요." : "현재 위치를 확인하지 못했습니다.");
        resolve(null);
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
    });
  },
  setMyPos(pos) {
    this.myPos = pos;
    if (!this._me) {
      this._me = L.marker(pos, { icon: L.divIcon({ className: "me-dot", html: "<i></i>", iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 800 }).addTo(this.map);
    } else this._me.setLatLng(pos);
  },
  // 월계1동 전용 기능(지름길·배리어프리·메모 경로·길 제보)을 쓸 때 동 영역을 다시 강조
  focusDong(on, { fly = true, message = "" } = {}) {
    if (!this._mask) this._mask = dongMask(this.base);
    if (on) {
      if (!this.map.hasLayer(this._mask)) this._mask.addTo(this.map);
      document.body.classList.add("dong-focus");
      if (fly) this.map.flyToBounds(L.latLngBounds(this.base.b), { paddingTopLeft: [16, 200], paddingBottomRight: [16, 120], duration: 0.6 });
      if (message) toast(message, 3500);
    } else {
      if (this.map.hasLayer(this._mask)) this.map.removeLayer(this._mask);
      document.body.classList.remove("dong-focus");
    }
  },
  dongCenter() {
    const b = this.base.b;
    return [b.reduce((s, p) => s + p[0], 0) / b.length, b.reduce((s, p) => s + p[1], 0) / b.length];
  },
  reloadEvents: () => loadEvents(),
  reloadReports: () => loadReports(),
  activeEventId: null,
  setActiveEvent(id) {
    this.activeEventId = id;
    const active = id != null ? this.eventMarkers.get(id) : null;
    new Set(this.eventMarkers.values()).forEach(m => m.getElement()?.classList.toggle("is-active", m === active));
  },
};
window.__wolgyeon = ctx; // 디버깅용

// ------------------------------------------------------------------ 지도 레이어
function loadLayerPrefs() {
  const def = { events: true, reports: false, constructions: true, hotspots: false };
  try { return { ...def, ...JSON.parse(localStorage.getItem(LAYER_KEY) || "{}") }; } catch (_) { return def; }
}
const layerOn = loadLayerPrefs();
const layerGroups = {};

function setupLayerChips() {
  const defs = [["events", "행사", "ev"], ["constructions", "공사", "cz"], ["reports", "신고", "rp"], ["hotspots", "문제 구간", "hs"]];
  $("#layer-chips").innerHTML = defs.map(([k, label, cls]) =>
    `<button class="lchip ${cls}" type="button" data-layer="${k}" aria-pressed="${layerOn[k]}"><i></i>${label}</button>`).join("");
  $$("#layer-chips .lchip").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.layer;
    layerOn[k] = !layerOn[k];
    b.setAttribute("aria-pressed", layerOn[k]);
    try { localStorage.setItem(LAYER_KEY, JSON.stringify(layerOn)); } catch (_) {}
    applyLayers();
    if (k === "reports" && layerOn[k]) loadReports();
    if (k === "hotspots" && layerOn[k]) loadHotspots();
  }));
}

function applyLayers() {
  for (const [k, g] of Object.entries(layerGroups)) {
    if (layerOn[k] && !ctx.map.hasLayer(g)) g.addTo(ctx.map);
    if (!layerOn[k] && ctx.map.hasLayer(g)) ctx.map.removeLayer(g);
  }
}

const DROP = `<path class="drop" d="M17 1.5C8.4 1.5 1.5 8.4 1.5 17c0 11.3 15.5 25.5 15.5 25.5S32.5 28.3 32.5 17C32.5 8.4 25.6 1.5 17 1.5z"/>`;
const CLUSTER_PX = 38;   // 화면에서 이 거리(px) 안에 있는 핀은 하나로 묶음

function pinIcon(ev, showLabel) {
  return L.divIcon({
    className: `ev-pin ${ev.category}${showLabel ? "" : " no-label"}`,
    html: `<svg width="30" height="40" viewBox="0 0 34 44" aria-hidden="true">${DROP}<circle class="dot" cx="17" cy="17" r="5.5"/></svg><span class="label">${esc(ev.title)}</span>`,
    iconSize: [30, 40], iconAnchor: [15, 39],
  });
}

function clusterIcon(evs, label, showLabel) {
  const n = evs.length;
  return L.divIcon({
    className: `ev-pin cluster${showLabel ? "" : " no-label"}`,
    html: `<svg width="34" height="45" viewBox="0 0 34 44" aria-hidden="true">${DROP}<text class="cnt" x="17" y="21.5" text-anchor="middle">${n > 99 ? "99+" : n}</text></svg><span class="label">${esc(label)}</span>`,
    iconSize: [34, 45], iconAnchor: [17, 44],
  });
}

// 같은 장소에 모인 행사들의 공통 이름
//  "[서울생활사박물관] 한가위…" 여러 개 → "서울생활사박물관 · 행사 5개"
function clusterLabel(evs) {
  const n = evs.length;
  const tags = evs.map(e => (/^\[([^\]]+)\]/.exec(e.title) || [])[1]);
  if (tags.every(t => t && t === tags[0])) return `${tags[0]} · 행사 ${n}개`;
  const places = evs.map(e => (e.place_name || "").trim());
  let prefix = places[0] || "";
  for (const p of places) while (prefix && !p.startsWith(prefix)) prefix = prefix.slice(0, -1);
  prefix = prefix.replace(/[\s(,·-]+$/, "").trim();
  if (prefix.length >= 3) return `${prefix} · 행사 ${n}개`;
  return `행사 ${n}개`;
}

function renderEventPins() {
  const g = layerGroups.events, map = ctx.map;
  if (!g || !map) return;
  g.clearLayers();
  ctx.eventMarkers.clear();
  const z = map.getZoom();
  const evs = ctx.events.filter(e => e.lat != null && ctx.inService(e.lat, e.lng));   // 지도에는 월계동 안 행사만
  // 1) 화면 거리 기준으로 묶기 (가까운 일정부터)
  const groups = [];
  for (const ev of evs) {
    const pt = map.project([ev.lat, ev.lng], z);
    const hit = groups.find(gr => gr.pt.distanceTo(pt) <= CLUSTER_PX);
    if (hit) hit.evs.push(ev); else groups.push({ pt, evs: [ev] });
  }
  // 2) 이름표가 서로 겹치지 않게: 묶음 먼저, 그다음 일정 순으로 자리를 차지
  const placed = [];
  const labelFits = (pt, text) => {
    const w = Math.min(170, 14 + text.length * 11.5), h = 18;
    const box = { x1: pt.x - w / 2, x2: pt.x + w / 2, y1: pt.y - 64, y2: pt.y - 64 + h };
    if (placed.some(b => b.x1 < box.x2 && box.x1 < b.x2 && b.y1 < box.y2 && box.y1 < b.y2)) return false;
    placed.push(box);
    return true;
  };
  groups.sort((a, b) => b.evs.length - a.evs.length);
  for (const gr of groups) {
    // 묶음의 위치 = 구성 행사들의 평균
    const lat = gr.evs.reduce((s, e) => s + e.lat, 0) / gr.evs.length;
    const lng = gr.evs.reduce((s, e) => s + e.lng, 0) / gr.evs.length;
    let m;
    if (gr.evs.length === 1) {
      const ev = gr.evs[0];
      m = L.marker([lat, lng], { icon: pinIcon(ev, labelFits(gr.pt, ev.title)), title: ev.title, riseOnHover: true });
      m.on("click", () => { ctx.lastList = null; location.hash = `#/event/${ev.id}`; });
    } else {
      const label = clusterLabel(gr.evs);
      m = L.marker([lat, lng], { icon: clusterIcon(gr.evs, label, labelFits(gr.pt, label)), title: label, riseOnHover: true, zIndexOffset: 200 });
      const ids = gr.evs.map(e => e.id);
      m.on("click", () => ctx.openEventList(ids, label));
    }
    m.addTo(g);
    gr.evs.forEach(e => ctx.eventMarkers.set(e.id, m));
  }
  ctx.setActiveEvent(ctx.activeEventId);
}

// 겹친 행사 목록 (아래에서 올라오는 창) → 하나를 고르면 평소 상세 화면
ctx.openEventList = (ids, title) => {
  ctx.lastList = { ids, title };
  const evs = ids.map(id => ctx.events.find(e => e.id === id)).filter(Boolean)
    .sort((a, b) => (a.start_at || "9999").localeCompare(b.start_at || "9999"));
  const body = openSheet(`
    <h2 style="font-size:18px">${esc(title)}</h2>
    <p class="small muted" style="margin:0 0 10px">이 자리에 행사가 ${evs.length}개 있어요. 보고 싶은 행사를 고르세요.</p>
    <div class="list">${evs.map(e => `
      <a class="item" href="#/event/${e.id}">
        <div class="grow">
          <div class="row wrap" style="gap:6px;margin-bottom:3px"><span class="chip ${e.category}">${esc(e.category_label)}</span>${e.is_favorite ? `<span class="chip" style="color:#e8542f">♥ 내 일정</span>` : ""}</div>
          <div class="t">${esc(e.title)}</div>
          <div class="m">${esc(eventWhen(e))}${e.place_name ? " · " + esc(e.place_name) : ""}</div>
        </div></a>`).join("")}</div>`);
};

async function loadEvents() {
  try {
    ctx.events = await api("/api/events?when=upcoming");
  } catch (e) { toast(e.message); return; }
  renderEventPins();
}

async function loadReports() {
  const g = layerGroups.reports;
  try {
    const rows = await api("/api/reports");
    g.clearLayers();
    rows.forEach(r => {
      L.marker([r.lat, r.lng], { icon: L.divIcon({ className: `rp-dot ${r.status}`, html: "<i></i>", iconSize: [14, 14], iconAnchor: [7, 7] }) })
        .bindPopup(`<b>${esc(r.category_label)}</b><br>${esc(r.summary || "")}<br><span style="color:#667085">${esc(r.status_label)} · ${ago(r.created_at)}</span>`)
        .addTo(g);
    });
  } catch (e) { /* 공개 목록 실패는 조용히 */ }
}

async function loadHotspots() {
  const g = layerGroups.hotspots;
  try {
    const rows = await api("/api/reports/hotspots");
    g.clearLayers();
    rows.forEach(h => {
      L.circle([h.lat, h.lng], { radius: h.radius_m, color: "#dc2626", weight: 1.5, fillColor: "#dc2626", fillOpacity: 0.14 })
        .bindPopup(`<b>문제 반복 구간</b><br>신고 ${h.count}건 (미처리 ${h.open}건)<br>주요 유형: ${esc(h.top_label)}`).addTo(g);
      L.marker([h.lat, h.lng], { icon: L.divIcon({ className: "hs-label", html: `<span>${h.count}건</span>`, iconSize: [0, 0] }), interactive: false }).addTo(g);
    });
    if (layerOn.hotspots && !rows.length) toast("아직 신고가 반복되는 구간이 없어요.");
  } catch (e) { /* 무시 */ }
}

function drawConstructions(zones) {
  const g = layerGroups.constructions;
  g.clearLayers();
  zones.forEach(z => {
    const period = [z.start_date, z.end_date].filter(Boolean).map(s => s.slice(5, 10).replace("-", "/")).join(" ~ ");
    const html = `<b>${esc(z.title)}</b><br>${period ? `기간 ${period}<br>` : ""}${z.dust ? "먼지·소음이 있을 수 있어요<br>" : ""}${esc(z.note || "")}`;
    L.circle([z.lat, z.lng], { radius: z.radius_m, color: "#d97706", weight: 2, dashArray: "5 5", fillColor: "#f59e0b", fillOpacity: 0.12 }).bindPopup(html).addTo(g);
    L.marker([z.lat, z.lng], { icon: L.divIcon({ className: "cz-icon", html: "<div><span>!</span></div>", iconSize: [26, 26], iconAnchor: [13, 13] }) }).bindPopup(html).addTo(g);
  });
}

// ------------------------------------------------------------------ 알림 배지
async function pollBadge() {
  const b = $("#bell-badge");
  if (!auth.loggedIn) { b.hidden = true; return; }
  try {
    const { unread } = await api("/api/notifications/unread");
    b.hidden = !unread;
    b.textContent = unread > 99 ? "99+" : unread;
  } catch (_) { /* 무시 */ }
}
ctx.pollBadge = pollBadge;

// ------------------------------------------------------------------ 라우터
const routes = [
  [/^\/?$|^\/map$/, null, "map"],
  [/^\/news$/, newsView, "news"],
  [/^\/event\/(\d+)$/, eventView, "map"],
  [/^\/route$/, routeView, "route"],
  [/^\/plan$/, planView, "route"],
  [/^\/path-edit$/, pathView, "route"],
  [/^\/report$/, reportView, "report"],
  [/^\/report\/(\d+)$/, reportView, "report"],
  [/^\/me$/, meView, "me"],
  [/^\/login$/, meView, "me"],
  [/^\/notifications$/, meView, "me"],
];
let cleanup = null;
let current = "";
let navSeq = 0;   // 화면 전환 번호 — 늦게 끝난 이전 화면을 정리하는 데 씀

function parseHash() {
  const h = location.hash.replace(/^#/, "") || "/map";
  const [path, qs] = h.split("?");
  return { path, params: new URLSearchParams(qs || "") };
}

async function route() {
  const { path, params } = parseHash();
  if (path + params === current) return;
  current = path + params;
  navSeq++;
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  document.body.classList.remove("page-open", "route-open", "has-route");
  ctx.focusDong(false);
  const view = $("#view");
  view.innerHTML = "";
  let matched = routes.find(([re]) => re.test(path));
  if (!matched) { location.hash = "#/map"; return; }
  const [re, mod, tab] = matched;
  $$("#tabbar a").forEach(a => a.classList.toggle("on", a.dataset.tab === tab));
  if (!/^\/event\//.test(path)) closeSheet();
  if (!mod) { ctx.setActiveEvent(null); return; }
  const m = path.match(re);
  const seq = ++navSeq;
  try {
    const c = (await mod.render({ view, ctx, path, params, args: m.slice(1) })) || null;
    if (seq !== navSeq) { if (c) { try { c(); } catch (_) {} } return; }  // 그 사이 다른 화면으로 이동함
    cleanup = c;
  } catch (e) {
    if (seq !== navSeq) return;
    console.error(e);
    toast(e.message || "화면을 여는 중 문제가 생겼습니다.");
  }
}

// ------------------------------------------------------------------ 시작
async function boot() {
  initSheet();
  let base;
  try {
    base = await api("/api/map/basemap");
  } catch (e) {
    $("#view").innerHTML = `<div class="page"><div class="page-body"><div class="card stack" style="margin-top:40px;text-align:center">
      <h2>서버에 연결할 수 없어요</h2><p class="muted">${esc(e.message)}</p>
      <button class="btn primary" onclick="location.reload()">다시 시도</button></div></div></div>`;
    return;
  }
  ctx.base = base;
  ctx.map = createMap("map", base, { padding: [110, 16] });
  ["events", "reports", "constructions", "hotspots"].forEach(k => { layerGroups[k] = L.layerGroup(); });
  ctx.map.on("zoomend", renderEventPins);
  setupLayerChips();
  applyLayers();

  $("#btn-locate").addEventListener("click", async () => {
    const pos = await ctx.locate();
    if (!pos) return;
    ctx.map.flyTo(pos, Math.max(ctx.map.getZoom(), 16), { duration: 0.6 });
  });
  $("#btn-bell").addEventListener("click", () => { location.hash = auth.loggedIn ? "#/notifications" : "#/login?next=%23%2Fnotifications"; });

  window.addEventListener("hashchange", route);
  auth.onChange(() => { pollBadge(); });
  await route();
  loadEvents();
  if (layerOn.reports) loadReports();
  if (layerOn.hotspots) loadHotspots();
  api("/api/map/constructions").then(drawConstructions).catch(() => {});
  refreshMe().then(pollBadge);
  initLiveBoard(ctx);
  setInterval(pollBadge, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollBadge(); });
}

boot();
