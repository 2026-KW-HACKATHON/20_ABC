// 길찾기 (자체 보행 그래프)
//  - 일반 도보: 월계동(월계1·2·3동) 안
//  - 지름길 · 배리어프리(경사·계단 회피): 월계1동 안에서만
import { api } from "../api.js";
import { MODES } from "../graph.js";
import { ICON, closeSheet, esc, fmtDist, fmtMin, openSheet, peekSheet, toast } from "../ui.js";

// 월계1동 전용 기능 이름 (조사 붙이기용: 은/는)
const DONG_ONLY = { shortcut: "지름길은", accessible: "배리어프리 길찾기는" };

const PLACES = [
  ["광운대역", 37.62370, 127.06182], ["석계역", 37.61481, 127.06584], ["광운대 정문", 37.61905, 127.06090],
  ["월계1동 주민센터", 37.61993, 127.06292], ["월계역", 37.63306, 127.05887], ["이마트 월계점", 37.62668, 127.06203],
];
const st = { start: null, end: null, armed: "start", mode: "normal", avoid: false };

export async function render({ view, ctx, params }) {
  document.body.classList.add("route-open");
  const map = ctx.map;
  const layers = L.layerGroup().addTo(map);
  const markers = {};
  st.avoid = false;

  // 위 패널: 출발·도착을 고르는 동안만 보임. 경로가 나오면 접히고, 같은 기능이 아래 창으로 옮겨감
  view.innerHTML = `<section class="rpanel" aria-label="길찾기">
    <div class="rp-fields">
      <span class="dot"></span>
      <div class="rp-fwrap"><button class="rp-field" id="f-start" type="button"></button>
        <button class="rp-me" id="rp-me" type="button" aria-label="내 위치에서 출발">${ICON.locate || ""}내 위치</button></div>
      <button class="rp-swap" id="rp-swap" type="button" aria-label="출발·도착 바꾸기">${ICON.swap}</button>
      <span class="dot end"></span>
      <button class="rp-field" id="f-end" type="button"></button>
    </div>
    <div class="seg compact" role="group" aria-label="경로 종류" style="margin-top:8px">${modeButtons()}</div>
    <form class="row" id="rp-search" style="margin-top:8px;gap:6px" role="search">
      <input class="input grow" id="rp-q" type="search" placeholder="월계동 장소 검색 (예: 월계역, 광운대)" autocomplete="off" style="padding:7px 11px;font-size:14px">
      <button class="btn sm" type="submit">검색</button>
    </form>
    <div class="quick" id="quick"></div>
    <div class="rp-foot"><span class="rp-hint" id="rp-hint"></span>
      <a href="#/plan">메모 경로</a><a href="#/path-edit">길 제보</a></div>
  </section>`;

  const $ = s => view.querySelector(s);
  function modeButtons() {
    return Object.entries(MODES).map(([k, m]) =>
      `<button type="button" data-mode="${k}" aria-pressed="${st.mode === k}">${m.label}${DONG_ONLY[k] ? `<small class="dong-tag">월계1동</small>` : ""}</button>`).join("");
  }
  function bindModes(root) {
    root.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => {
      setMode(b.dataset.mode);
      if (st.start && st.end) compute();
    }));
  }
  // 경로가 나오면 위 패널을 접음 (아래 창에 출발·도착·경로 종류가 들어감)
  function compactTop(on) { document.body.classList.toggle("route-compact", on); }
  async function useMyLocation(which = "start") {
    const pos = ctx.myPos || await ctx.locate();
    if (!pos) return;
    if (!ctx.inService(pos[0], pos[1])) { toast("지금 위치가 월계동 밖이라 출발지로 쓸 수 없어요."); return; }
    setPoint(which, pos[0], pos[1], "내 위치");
  }
  const pointName = p => p ? esc(p.name) : "";
  function renderFields() {
    $("#f-start").innerHTML = st.start ? pointName(st.start) : `<span class="ph">출발지 — 지도를 누르거나 아래에서 선택</span>`;
    $("#f-end").innerHTML = st.end ? pointName(st.end) : `<span class="ph">도착지 — 지도를 누르거나 아래에서 선택</span>`;
    $("#f-start").classList.toggle("armed", st.armed === "start");
    $("#f-end").classList.toggle("armed", st.armed === "end");
    $("#rp-hint").textContent = st.armed === "start" ? "지도를 누르면 출발지로 정해집니다." : "지도를 누르면 도착지로 정해집니다.";
  }
  function setMarker(which) {
    if (markers[which]) { map.removeLayer(markers[which]); markers[which] = null; }
    const p = st[which];
    if (!p) return;
    markers[which] = L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: "rt-pin", html: `<div class="${which === "start" ? "s" : "e"}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }),
      zIndexOffset: 700, interactive: false,
    }).addTo(map);
  }
  function setPoint(which, lat, lng, name, { pan = false } = {}) {
    st[which] = { lat, lng, name: name || (which === "start" ? "지도에서 고른 출발지" : "지도에서 고른 도착지") };
    if (pan && !(st.start && st.end)) map.flyTo([lat, lng], Math.max(map.getZoom(), 16), { duration: 0.5 });
    setMarker(which);
    if (st.start && st.end) compute();
    else st.armed = which === "start" ? "end" : "start";
    renderFields();
  }

  async function quickList() {
    const items = [["내 위치", null, null, "me"], ...PLACES.filter(p => ctx.inService(p[1], p[2])).map(p => [...p, "place"])];
    ctx.events.filter(e => e.lat != null && ctx.inService(e.lat, e.lng)).slice(0, 6).forEach(e => items.push([e.title, e.lat, e.lng, "event"]));
    $("#quick").innerHTML = items.map(([n, la, ln, k], i) => `<button type="button" data-q="${i}">${k === "event" ? "행사 · " : ""}${esc(n.length > 14 ? n.slice(0, 14) + "…" : n)}</button>`).join("");
    $("#quick").querySelectorAll("[data-q]").forEach(b => b.addEventListener("click", async () => {
      const [n, la, ln, k] = items[+b.dataset.q];
      if (k === "me") {
        const pos = ctx.myPos || await ctx.locate();
        if (!pos) return;
        setPoint(st.armed, pos[0], pos[1], "내 위치");
      } else setPoint(st.armed, la, ln, n);
    }));
  }

  // 장소 검색: 앱의 가게·시설 목록 먼저, 그다음 서버 검색(카카오/OSM) — 월계동 안만
  async function search(q) {
    openSheet(`<div class="empty"><span class="spinner"></span><br>"${esc(q)}" 찾는 중…</div>`);
    const norm = x => (x || "").replace(/\s+/g, "").toLowerCase(), nq = norm(q);
    let rows = [];
    try {
      const pois = await ctx.getPois();
      rows = pois.filter(p => p.name && norm(p.name).includes(nq)).slice(0, 8)
        .map(p => ({ name: p.name, address: "월계온 장소 목록", lat: p.lat, lng: p.lng }));
    } catch (_) { /* 목록이 없어도 서버 검색은 계속 */ }
    try {
      const more = await api(`/api/geo/search?q=${encodeURIComponent(q)}`);
      more.forEach(r => { if (!rows.some(x => Math.abs(x.lat - r.lat) < 2e-4 && Math.abs(x.lng - r.lng) < 2e-4)) rows.push(r); });
    } catch (e) { if (!rows.length) { openSheet(`<p class="muted">${esc(e.message)}</p>`); return; } }
    rows = rows.filter(r => ctx.inService(r.lat, r.lng));
    if (!rows.length) { openSheet(`<p class="muted">월계동 안에서 "${esc(q)}"에 맞는 장소를 찾지 못했어요. 다른 이름으로 검색하거나 지도를 눌러 골라주세요.</p>`); return; }
    const body = openSheet(`<h2 style="font-size:16px">${st.armed === "start" ? "출발지" : "도착지"}로 쓸 장소를 고르세요</h2>
      <div class="list">${rows.map((r, i) => `<button class="item" type="button" data-i="${i}"><div class="grow"><div class="t">${esc(r.name)}</div><div class="m">${esc(r.address || "")}${ctx.inArea(r.lat, r.lng) ? ` · <span class="dong-tag">월계1동</span>` : ""}</div></div></button>`).join("")}</div>`);
    body.querySelectorAll("[data-i]").forEach(b => b.addEventListener("click", () => {
      const r = rows[+b.dataset.i];
      closeSheet();
      $("#rp-q").value = "";
      setPoint(st.armed, r.lat, r.lng, r.name, { pan: true });
    }));
  }

  const bothInService = () => st.start && st.end && ctx.inService(st.start.lat, st.start.lng) && ctx.inService(st.end.lat, st.end.lng);
  const bothInDong = () => st.start && st.end && ctx.inArea(st.start.lat, st.start.lng) && ctx.inArea(st.end.lat, st.end.lng);

  let graph;
  async function compute() {
    document.body.classList.add("has-route");
    layers.clearLayers();
    if (!bothInService()) { compactTop(false); return outsideNotice(); }
    if (DONG_ONLY[st.mode] && !bothInDong()) { compactTop(false); return dongOnlyNotice(); }
    openSheet(`<div class="empty"><span class="spinner"></span><br>경로 계산 중…</div>`);
    try { graph = await ctx.getGraph(); } catch (e) { toast(e.message); return; }
    const from = [st.start.lat, st.start.lng], to = [st.end.lat, st.end.lng];
    const main = graph.route(from, to, st.mode, { avoidConstruction: st.avoid });
    const cmpMode = st.mode === "normal" ? "shortcut" : "normal";
    const inDong = bothInDong();      // 지름길 비교는 월계1동 안에서만
    const cmp = inDong ? graph.route(from, to, cmpMode, { avoidConstruction: st.avoid }) : null;
    if (cmp) {
      layers.addLayer(L.polyline(cmp.latlngs, { color: "#fff", weight: 9, opacity: .9, lineCap: "round", lineJoin: "round", interactive: false }));
      layers.addLayer(L.polyline(cmp.latlngs, { color: "#98a2b3", weight: 5, lineCap: "round", lineJoin: "round", interactive: false }));
    }
    if (main) {
      const color = st.mode === "accessible" ? "#047857" : "#2563eb";
      layers.addLayer(L.polyline(main.latlngs, { color: "#fff", weight: 10, opacity: .95, lineCap: "round", lineJoin: "round", interactive: false }));
      layers.addLayer(L.polyline(main.latlngs, { color, weight: 6, lineCap: "round", lineJoin: "round", interactive: false }));
      if (st.mode !== "normal") {
        const sp = graph.specialSegments(main);
        if (sp.length) layers.addLayer(L.polyline(sp, { color: "#f59e0b", weight: 6, dashArray: "2 10", lineCap: "round", interactive: false }));
      }
    }
    const all = [main, cmp].filter(Boolean).flatMap(r => r.latlngs);
    compactTop(!!main);
    if (all.length) map.fitBounds(L.latLngBounds(all), { paddingTopLeft: [24, 40], paddingBottomRight: [24, Math.min(380, window.innerHeight * 0.5)] });
    showResult(main, cmp, cmpMode, graph, inDong);
  }

  // 지름길·배리어프리를 골랐는데 출발·도착이 월계1동 밖일 때
  function dongOnlyNotice() {
    ctx.focusDong(true, { fly: true });
    const body = openSheet(`
      <h2 style="font-size:17px">${DONG_ONLY[st.mode]} 월계1동에서만 지원돼요</h2>
      <p class="small muted" style="margin:4px 0 0">월계1동은 주민이 직접 확인한 샛길·쪽문·계단·경사 정보를 담은 정밀 지도로 길을 찾아요. 흐리지 않은 영역 안에서 출발지와 도착지를 골라주세요.</p>
      <div class="actions"><button class="btn" id="to-normal" type="button">일반 도보로 보기</button><button class="btn primary" id="reset-pts" type="button">동 안에서 다시 고르기</button></div>`);
    body.querySelector("#to-normal").addEventListener("click", () => { setMode("normal"); compute(); });
    body.querySelector("#reset-pts").addEventListener("click", () => {
      ["start", "end"].forEach(w => { if (st[w] && !ctx.inArea(st[w].lat, st[w].lng)) { st[w] = null; setMarker(w); } });
      st.armed = st.start ? "end" : "start";
      document.body.classList.remove("has-route");
      closeSheet(); renderFields();
    });
  }

  // 출발지나 도착지가 월계동 밖일 때
  function outsideNotice() {
    const far = [st.start, st.end].find(p => !ctx.inService(p.lat, p.lng));
    const kakao = `https://map.kakao.com/link/from/${encodeURIComponent(st.start.name)},${st.start.lat},${st.start.lng}/to/${encodeURIComponent(st.end.name)},${st.end.lat},${st.end.lng}`;
    const body = openSheet(`
      <h2 style="font-size:17px">월계동 안에서만 길을 찾아요</h2>
      <p class="small muted" style="margin:4px 0 0">${esc(far.name)}이(가) 월계동(월계1·2·3동) 밖이에요. 흐리지 않은 영역 안에서 골라주세요. 지름길·배리어프리는 점선으로 표시된 월계1동 안에서 쓸 수 있어요.</p>
      <div class="actions"><a class="btn" href="${kakao}" target="_blank" rel="noopener">카카오맵으로 보기</a><button class="btn primary" id="reset-out" type="button">다시 고르기</button></div>`);
    body.querySelector("#reset-out").addEventListener("click", () => {
      ["start", "end"].forEach(w => { if (st[w] && !ctx.inService(st[w].lat, st[w].lng)) { st[w] = null; setMarker(w); } });
      st.armed = st.start ? "end" : "start";
      document.body.classList.remove("has-route");
      closeSheet(); renderFields();
    });
  }

  function showResult(main, cmp, cmpMode, graph, inDong = true) {
    const m = MODES[st.mode];
    if (!main) {
      openSheet(`<h2 style="font-size:17px">경로를 찾지 못했어요</h2>
        <p class="muted small">${st.mode === "accessible" ? "계단과 급경사를 피해서 갈 수 있는 길이 지도에 없어요. 지름길 모드로 보거나, 아는 길이 있다면 제보해주세요." : "두 지점을 잇는 길이 지도에 없어요. 지점을 조금 옮겨보세요."}</p>
        <a class="btn block" href="#/path-edit">이 근처 길 제보하기</a>`);
      return;
    }
    const s = main.stats;
    const tags = [];
    if (s.inside > 0) tags.push(`<span class="chip special">캠퍼스·학교 관통 ${fmtDist(s.inside)}</span>`);
    if (s.cross > 0) tags.push(`<span class="chip special">광장·공원·주차장 가로지름 ${fmtDist(s.cross)}</span>`);
    if (s.bridge > 0) tags.push(`<span class="chip special">끊긴 길 연결 ${s.bridge}곳</span>`);
    if (s.custom > 0) tags.push(`<span class="chip special">주민이 알려준 길 ${fmtDist(s.custom)}</span>`);
    if (s.gates > 0) tags.push(`<span class="chip special">쪽문·출입구 ${s.gates}곳</span>`);
    if (s.stepsCount > 0) tags.push(`<span class="chip">계단 ${s.stepsCount}곳</span>`);
    if (s.steep > 0) tags.push(`<span class="chip">가파른 구간 ${fmtDist(s.steep)}</span>`);
    if (s.restrict > 0) tags.push(`<span class="chip">출입 제한 가능 구간 ${fmtDist(s.restrict)}</span>`);
    if (!tags.length) tags.push(`<span class="chip">공식 보행로만 사용</span>`);

    let saving = "";
    if (cmp) {
      const diff = st.mode === "normal" ? main.total - cmp.total : cmp.total - main.total;
      if (st.mode === "shortcut") saving = diff > 5 ? `<div class="saving">지름길이 ${fmtDist(diff)} 짧아요 (${Math.round(diff / cmp.total * 100)}% 단축)</div>` : `<div class="saving none">이 구간은 공식 보행로가 이미 가장 빨라요.</div>`;
      else if (st.mode === "normal") saving = diff > 5 ? `<div class="saving none">지름길로 가면 ${fmtDist(diff)} 줄일 수 있어요.</div>` : "";
      else if (st.mode === "accessible") saving = main.total - cmp.total > 5 ? `<div class="saving none">계단·급경사를 피하느라 ${fmtDist(main.total - cmp.total)} 더 걸어요.</div>` : `<div class="saving">계단 없이 일반 경로와 거의 같은 거리예요.</div>`;
    } else if (st.mode === "shortcut") saving = `<div class="saving">일반 보행로로는 이어지지 않는 구간이에요. 지름길로만 갈 수 있어요.</div>`;

    const zones = main.zones || [];
    const banner = zones.length && !st.avoid
      ? `<div class="banner"><span>⚠ 공사 구간 <b>${esc(zones.map(z => z.title).join(", "))}</b>을 지나요.${zones.some(z => z.dust) ? " 먼지가 날 수 있어요." : ""}</span><button class="btn sm" id="btn-avoid" type="button">피해서 가기</button></div>`
      : st.avoid ? `<div class="banner info"><span>공사 구간을 피한 경로예요.</span><button class="btn sm" id="btn-avoid" type="button">원래 경로</button></div>` : "";
    const noGrade = st.mode === "accessible" && !graph.e.some(e => e[5] > 0);
    const hoursNote = Object.keys(graph.hours).length ? `<p class="small muted" style="margin:8px 0 0">지금 닫혀 있는 쪽문은 경로에서 뺐어요.</p>` : "";

    openSheet(`
      <div class="rs-head">
        <div class="grow"><div class="rs-pts"><b>${esc(st.start.name)}</b> → <b>${esc(st.end.name)}</b></div>
          <div class="rs-sum">${m.label} · ${fmtDist(main.total)} · 도보 약 ${fmtMin(main.total, m.speed)}</div></div>
        <button class="btn sm" type="button" id="rs-swap" aria-label="출발·도착 바꾸기">${ICON.swap}</button>
        <button class="btn sm" type="button" id="rs-edit">바꾸기</button>
      </div>
      <div class="seg compact" role="group" aria-label="경로 종류" id="rs-modes" style="margin-top:10px">${modeButtons()}</div>
      <div class="res-cmp"${inDong ? "" : ` style="grid-template-columns:1fr"`}>
        <div class="res-card main ${st.mode === "accessible" ? "bf" : ""}"><div class="k">${m.label}</div><div class="v">${fmtDist(main.total)}</div><div class="tt">도보 약 ${fmtMin(main.total, m.speed)}</div></div>
        ${inDong ? `<div class="res-card"><div class="k">${MODES[cmpMode].label}</div><div class="v">${cmp ? fmtDist(cmp.total) : "없음"}</div><div class="tt">${cmp ? "도보 약 " + fmtMin(cmp.total, MODES[cmpMode].speed) : "이어지는 길 없음"}</div></div>` : ""}
      </div>
      ${inDong ? "" : `<p class="small muted" style="margin:8px 0 0">월계1동 밖이 포함된 경로라 일반 도보로 안내해요. 지름길·배리어프리는 두 지점이 모두 월계1동(점선) 안일 때 쓸 수 있어요.</p>`}
      ${saving}
      <div class="tags">${tags.join("")}</div>
      ${banner}
      ${noGrade ? `<p class="small muted" style="margin:8px 0 0">경사 정보는 계단·주민 제보 기준이에요. 관리자가 고도 데이터를 받으면 경사도까지 반영됩니다.</p>` : ""}
      ${hoursNote}
      ${st.mode !== "normal" ? `<p class="small muted" style="margin:8px 0 0">주황 점선은 공식 지도에 없는 지름길 구간이에요. 실제로 막혀 있으면 알려주세요.</p>` : ""}
      <div class="actions"><a class="btn" href="#/path-edit">막힌 길·새 길 제보</a><button class="btn primary" id="btn-follow" type="button">내 위치 따라가기</button></div>
      <p class="small muted" style="margin:10px 0 0;text-align:center">창을 아래로 내리면 지도를 넓게 볼 수 있어요</p>
    `, { peek: true, onClose: () => compactTop(false) });
    const sb = document.getElementById("sheet-body");
    bindModes(sb.querySelector("#rs-modes"));
    sb.querySelector("#rs-edit").addEventListener("click", () => { compactTop(false); closeSheet(); st.armed = "end"; renderFields(); });
    sb.querySelector("#rs-swap").addEventListener("click", () => { [st.start, st.end] = [st.end, st.start]; setMarker("start"); setMarker("end"); renderFields(); compute(); });
    document.getElementById("btn-avoid")?.addEventListener("click", () => { st.avoid = !st.avoid; compute(); });
    document.getElementById("btn-follow")?.addEventListener("click", () => follow());
  }

  let watchId = null;
  function follow() {
    if (!navigator.geolocation) { toast("위치를 확인할 수 없는 기기예요."); return; }
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; toast("따라가기를 멈췄어요."); return; }
    toast("내 위치를 따라갑니다.");
    peekSheet(true);
    watchId = navigator.geolocation.watchPosition(p => {
      const pos = [p.coords.latitude, p.coords.longitude];
      ctx.setMyPos(pos);
      map.panTo(pos, { animate: true });
      if (st.end && Math.hypot((pos[0] - st.end.lat) * 110540, (pos[1] - st.end.lng) * 88000) < 30) {
        toast("도착했어요!", 4000);
        if (navigator.vibrate) navigator.vibrate(200);
        navigator.geolocation.clearWatch(watchId); watchId = null;
      }
    }, () => toast("위치를 받지 못했어요."), { enableHighAccuracy: true, maximumAge: 5000 });
  }

  // 이벤트 연결
  $("#f-start").addEventListener("click", () => { st.armed = "start"; renderFields(); });
  $("#f-end").addEventListener("click", () => { st.armed = "end"; renderFields(); });
  $("#rp-swap").addEventListener("click", () => {
    [st.start, st.end] = [st.end, st.start];
    setMarker("start"); setMarker("end"); renderFields();
    if (st.start && st.end) compute();
  });
  function setMode(mode) {
    st.mode = mode;
    document.querySelectorAll("#view [data-mode], #sheet-body [data-mode]").forEach(x => x.setAttribute("aria-pressed", x.dataset.mode === mode));
    if (DONG_ONLY[mode]) {
      const ok = !st.start && !st.end || bothInDong() || (st.start && !st.end && ctx.inArea(st.start.lat, st.start.lng));
      // 두 지점이 다 정해져 있으면 compute()가 안내 창을 띄우므로 토스트는 생략
      ctx.focusDong(true, { fly: !ok || !(st.start && st.end), message: st.start && st.end ? "" : `${DONG_ONLY[mode]} 월계1동에서만 지원돼요.` });
    } else ctx.focusDong(false);
  }
  bindModes(view);
  $("#rp-me").addEventListener("click", () => useMyLocation("start"));
  $("#rp-search").addEventListener("submit", e => {
    e.preventDefault();
    const q = $("#rp-q").value.trim();
    if (q.length < 2) { toast("두 글자 이상 입력해주세요."); return; }
    $("#rp-q").blur();
    search(q);
  });
  const onMapClick = e => {
    if (!ctx.inService(e.latlng.lat, e.latlng.lng)) { toast("월계동 안(흐리지 않은 영역)을 눌러주세요."); return; }
    setPoint(st.armed, +e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6));
  };
  map.on("click", onMapClick);

  // 파라미터: ?to=lat,lng&name=...
  const to = params.get("to");
  if (to) {
    const [la, ln] = to.split(",").map(Number);
    st.end = { lat: la, lng: ln, name: params.get("name") || "도착지" };
    st.armed = "start";
    if (!st.start) {
      const pos = ctx.myPos || await ctx.locate({ silent: true });
      if (!location.hash.startsWith("#/route")) {   // 위치를 기다리는 사이 다른 화면으로 이동함
        map.off("click", onMapClick); map.removeLayer(layers);
        Object.values(markers).forEach(m => m && map.removeLayer(m));
        return null;
      }
      if (pos) st.start = { lat: pos[0], lng: pos[1], name: "내 위치" };
    }
  }
  if (!st.start && ctx.myPos && ctx.inService(ctx.myPos[0], ctx.myPos[1])) {   // 내 위치를 알고 있으면 출발지로
    st.start = { lat: ctx.myPos[0], lng: ctx.myPos[1], name: "내 위치" };
    if (!st.end) st.armed = "end";
  }
  setMarker("start"); setMarker("end");
  renderFields();
  quickList();
  if (DONG_ONLY[st.mode]) ctx.focusDong(true, { fly: !(st.start && st.end) });
  ctx.getGraph().catch(() => {});
  if (st.start && st.end) compute();

  return () => {
    map.off("click", onMapClick);
    map.removeLayer(layers);
    Object.values(markers).forEach(m => m && map.removeLayer(m));
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    compactTop(false);
    closeSheet();
  };
}

