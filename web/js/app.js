// 월계온 앱 진입점: 지도, 레이어, 화면 전환(해시 라우터), 알림 배지
import { api, auth, refreshMe } from "./api.js";
import { createMap, dongMask, inService, pointInBoundary } from "./basemap.js";
import { Graph } from "./graph.js";
import { $, $$, closeSheet, esc, eventState, eventWhen, initSheet, openSheet, toast } from "./ui.js";

import * as newsView from "./views/news.js";
import * as eventView from "./views/event.js";
import * as routeView from "./views/route.js";
import * as planView from "./views/plan.js";
import * as tipView from "./views/tip.js";
import * as meView from "./views/me.js";
import * as pathView from "./views/pathedit.js";
import { initLiveBoard } from "./live.js";
import { CATS, KINDS, KIND_GROUPS, clusterSvg, evBadge, kindIcon, kindTag, pinSvg } from "./icons.js";

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
  activeEventId: null,
  setActiveEvent(id) {
    this.activeEventId = id;
    const active = id != null ? this.eventMarkers.get(id) : null;
    new Set(this.eventMarkers.values()).forEach(m => m.getElement()?.classList.toggle("is-active", m === active));
  },
};
window.__wolgyeon = ctx; // 디버깅용

// ------------------------------------------------------------------ 지도 레이어 · 행사 필터
function loadLayerPrefs() {
  const def = { events: true, constructions: true, satellite: false };
  try { return { ...def, ...JSON.parse(localStorage.getItem(LAYER_KEY) || "{}") }; } catch (_) { return def; }
}
const layerOn = loadLayerPrefs();
const layerGroups = {};
const saveLayers = () => { try { localStorage.setItem(LAYER_KEY, JSON.stringify(layerOn)); } catch (_) {} };

// 행사 필터: only = 전체 / 큰 분류 하나 / 세부 종류 하나만 보기, hidden = 숨길 분류·종류
const FILTER_KEY = "wolgyeon.filter";
const filter = (() => {
  const def = { only: "all", hiddenKinds: [], hiddenCats: [] };
  try { return { ...def, ...JSON.parse(localStorage.getItem(FILTER_KEY) || "{}") }; } catch (_) { return def; }
})();
const saveFilter = () => { try { localStorage.setItem(FILTER_KEY, JSON.stringify(filter)); } catch (_) {} };
ctx.eventVisible = e => {
  if (filter.hiddenCats.includes(e.category) || filter.hiddenKinds.includes(e.kind)) return false;
  if (filter.only === "all") return true;
  const [t, k] = filter.only.split(":");
  return t === "cat" ? e.category === k : e.kind === k;
};
const filterActive = () => filter.only !== "all" || filter.hiddenKinds.length || filter.hiddenCats.length;

function renderChips() {
  const cnt = {};
  ctx.events.filter(e => e.lat != null && ctx.inService(e.lat, e.lng)).forEach(e => { cnt[e.kind] = (cnt[e.kind] || 0) + 1; });
  const topKinds = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).slice(0, 7);
  const chip = (key, label, icon = "") => `<button class="fchip" type="button" data-only="${key}" aria-pressed="${filter.only === key}">${icon}${label}</button>`;
  $("#fchips").innerHTML = chip("all", "전체")
    + Object.entries(CATS).map(([k, c]) => chip(`cat:${k}`, c.label, `<i style="width:8px;height:8px;border-radius:50%;background:${c.color};display:inline-block"></i>`)).join("")
    + topKinds.map(k => chip(`kind:${k}`, KINDS[k], kindIcon(k, 14))).join("")
    + `<button class="fchip more${filter.hiddenKinds.length || filter.hiddenCats.length ? " on" : ""}" type="button" id="fchip-more">${filter.hiddenKinds.length + filter.hiddenCats.length ? `숨김 ${filter.hiddenKinds.length + filter.hiddenCats.length}개` : "세부 필터"}</button>`;
  $$("#fchips [data-only]").forEach(b => b.addEventListener("click", () => {
    filter.only = filter.only === b.dataset.only ? "all" : b.dataset.only;
    saveFilter(); renderChips(); renderEventPins(); ctx.refreshLive?.();
  }));
  $("#fchip-more").addEventListener("click", openMapMenu);
  $("#legend").innerHTML = ["academic", "community", "culture"].map(k => `<span><i style="background:${CATS[k].color}"></i>${CATS[k].short}</span>`).join("");
}

// ☰ 지도 설정: 지도 종류(일반/위성), 표시할 것, 행사 종류 숨기기
function openMapMenu() {
  const on = (k, v) => `aria-pressed="${v}" data-${k}`;
  const body = openSheet(`
    <h2 style="font-size:18px">지도 설정</h2>
    <div class="stack" style="gap:14px;margin-top:8px">
      <div><div class="small muted" style="margin-bottom:6px">지도 종류</div>
        <div class="seg"><button type="button" data-sat="0" aria-pressed="${!layerOn.satellite}">일반 지도</button><button type="button" data-sat="1" aria-pressed="${layerOn.satellite}">위성 지도</button></div></div>
      <div><div class="small muted" style="margin-bottom:6px">지도에 표시</div>
        <div class="pick"><button type="button" ${on("layer", layerOn.events)}="events">행사</button><button type="button" ${on("layer", layerOn.constructions)}="constructions">공사 구간</button></div></div>
      <div><div class="row" style="margin-bottom:6px"><span class="small muted grow">행사 종류 — 끄면 지도에서 숨겨요</span><button class="btn sm ghost" type="button" id="mm-reset">모두 보기</button></div>
        ${Object.entries(KIND_GROUPS).map(([cat, kinds]) => `
          <div class="kgroup">
            <button type="button" class="kcat" data-hcat="${cat}" aria-pressed="${!filter.hiddenCats.includes(cat)}"><i style="background:${CATS[cat].color}"></i>${CATS[cat].label}</button>
            <div class="pick">${kinds.map(k => `<button type="button" data-hkind="${k}" aria-pressed="${!filter.hiddenKinds.includes(k)}">${kindIcon(k, 14)} ${KINDS[k]}</button>`).join("")}</div>
          </div>`).join("")}
      </div>
    </div>`);
  body.querySelectorAll("[data-sat]").forEach(b => b.addEventListener("click", () => {
    setSatellite(b.dataset.sat === "1");
    body.querySelectorAll("[data-sat]").forEach(x => x.setAttribute("aria-pressed", x === b));
  }));
  body.querySelectorAll("[data-layer]").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.layer; layerOn[k] = !layerOn[k]; b.setAttribute("aria-pressed", layerOn[k]); saveLayers(); applyLayers();
  }));
  const toggle = (arr, v) => { const i = arr.indexOf(v); i >= 0 ? arr.splice(i, 1) : arr.push(v); };
  body.querySelectorAll("[data-hcat]").forEach(b => b.addEventListener("click", () => {
    toggle(filter.hiddenCats, b.dataset.hcat); b.setAttribute("aria-pressed", !filter.hiddenCats.includes(b.dataset.hcat));
    saveFilter(); renderChips(); renderEventPins(); ctx.refreshLive?.();
  }));
  body.querySelectorAll("[data-hkind]").forEach(b => b.addEventListener("click", () => {
    toggle(filter.hiddenKinds, b.dataset.hkind); b.setAttribute("aria-pressed", !filter.hiddenKinds.includes(b.dataset.hkind));
    saveFilter(); renderChips(); renderEventPins(); ctx.refreshLive?.();
  }));
  body.querySelector("#mm-reset").addEventListener("click", () => {
    filter.only = "all"; filter.hiddenKinds = []; filter.hiddenCats = []; saveFilter(); renderChips(); renderEventPins(); ctx.refreshLive?.(); openMapMenu();
  });
}

let satCfg = null;
async function setSatellite(on) {
  if (on && !satCfg) {
    try { satCfg = (await api("/api/config")).satellite; } catch (_) { toast("위성 지도를 불러오지 못했어요."); return; }
  }
  layerOn.satellite = !!on; saveLayers();
  ctx.map.wg.setSatellite(!!on, satCfg);
  $("#btn-sat").setAttribute("aria-pressed", !!on);
  $("#sat-label").textContent = on ? "지도" : "위성";
}

function applyLayers() {
  for (const [k, g] of Object.entries(layerGroups)) {
    if (layerOn[k] && !ctx.map.hasLayer(g)) g.addTo(ctx.map);
    if (!layerOn[k] && ctx.map.hasLayer(g)) ctx.map.removeLayer(g);
  }
}

const CLUSTER_PX = 38;   // 화면에서 이 거리(px) 안에 있는 핀은 하나로 묶음

function pinIcon(ev, showLabel) {
  return L.divIcon({
    className: `ev-pin ${ev.category}${showLabel ? "" : " no-label"}`,
    html: `${pinSvg(ev.category, ev.kind, 32)}<span class="label">${esc(ev.title)}</span>`,
    iconSize: [32, 41], iconAnchor: [16, 40],
  });
}

function clusterIcon(evs, label, showLabel) {
  return L.divIcon({
    className: `ev-pin cluster${showLabel ? "" : " no-label"}`,
    html: `${clusterSvg(evs.length, 36)}<span class="label">${esc(label)}</span>`,
    iconSize: [36, 47], iconAnchor: [18, 46],
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
  const evs = ctx.events.filter(e => e.lat != null && ctx.inService(e.lat, e.lng) && ctx.eventVisible(e));   // 지도에는 월계동 안, 필터에 맞는 행사만
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
  // 진행 중인 행사 먼저, 그다음 가까운 날짜 순
  const evs = ids.map(id => ctx.events.find(e => e.id === id)).filter(Boolean)
    .map(e => ({ e, s: eventState(e) }))
    .sort((a, b) => a.s.rank - b.s.rank || (a.e.start_at || "9999").localeCompare(b.e.start_at || "9999"));
  const nowCnt = evs.filter(x => x.s.rank === 0).length;
  const body = openSheet(`
    <h2 style="font-size:18px">${esc(title)}</h2>
    <p class="small muted" style="margin:0 0 10px">이 자리의 행사 ${evs.length}개${nowCnt ? ` · 지금 진행 중 ${nowCnt}개` : ""}. 보고 싶은 행사를 고르세요.</p>
    <div class="list">${evs.map(({ e, s }) => `
      <a class="item" href="#/event/${e.id}">${evBadge(e)}
        <div class="grow">
          <div class="row wrap" style="gap:6px;margin-bottom:3px"><span class="st-chip ${s.cls}">${s.label}</span>${kindTag(e)}${e.source === "tip" ? `<span class="chip">주민 제보</span>` : ""}${e.is_favorite ? `<span class="chip" style="color:#e8542f">♥ 내 일정</span>` : ""}</div>
          <div class="t">${esc(e.title)}</div>
          <div class="m">${esc(eventWhen(e))}${e.place_name ? " · " + esc(e.place_name) : ""}</div>
        </div></a>`).join("")}</div>`);
};

async function loadEvents() {
  try {
    ctx.events = await api("/api/events?when=upcoming");
  } catch (e) { toast(e.message); return; }
  renderChips();
  renderEventPins();
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
  [/^\/tip$/, tipView, "me"],
  [/^\/settings$/, meView, "me"],
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
  ctx.prevHash = ctx.curHash || "";       // 이전 화면 (상세 화면의 뒤로 버튼용)
  ctx.curHash = location.hash || "#/map";
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
  closeSheet();
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
  ctx.map = createMap("map", base, { padding: [170, 16] });
  ["events", "constructions"].forEach(k => { layerGroups[k] = L.layerGroup(); });
  ctx.map.on("zoomend", renderEventPins);
  renderChips();
  applyLayers();
  $("#btn-menu").addEventListener("click", openMapMenu);
  $("#btn-sat").addEventListener("click", () => setSatellite(!layerOn.satellite));
  if (layerOn.satellite) setSatellite(true);

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
  api("/api/map/constructions").then(drawConstructions).catch(() => {});
  refreshMe().then(pollBadge);
  initLiveBoard(ctx);
  setInterval(pollBadge, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollBadge(); });
}

boot();
