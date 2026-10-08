// 길 정보 제보
//  - 새 길·쪽문·막힌 길: 지도에 점을 찍음
//  - 계단·가파른 길: 손가락으로 지도를 문질러 범위를 칠함 → 길찾기 경로가 칠한 범위를 지나가면 배리어프리에서 피함
import { api, auth } from "../api.js";
import { ICON, closeSheet, esc, loginCard, openSheet, toast } from "../ui.js";

const KINDS = {
  add: { label: "새 길", help: "지도에 없는 길을 따라 점을 차례로 찍어주세요. (예: 아파트 사이 샛길, 주차장 옆 통로)", min: 2, color: "#2563eb" },
  gate: { label: "쪽문·후문", help: "문 안쪽 한 점, 바깥쪽 한 점을 찍어주세요. 열리는 시간을 알면 적어주세요.", min: 2, color: "#7c3aed" },
  block: { label: "막힌 길", help: "지도에는 있지만 실제로 못 지나가는 길 위에 점을 찍어주세요.", min: 1, color: "#dc2626" },
  stairs: { label: "계단 있음", help: "계단이 있는 곳을 손가락으로 문질러 칠해주세요. 칠한 범위를 지나는 길은 배리어프리 경로에서 피해요.", paint: true, color: "#7c2d12" },
  steep: { label: "가파른 길", help: "휠체어·유아차로 오르기 힘든 구간을 손가락으로 문질러 칠해주세요.", paint: true, color: "#c2410c" },
};
const BRUSH = [["좁게", 5], ["보통", 8], ["넓게", 12]];

// 붓 반지름(m) → 현재 확대 수준의 선 두께(px)
function brushPx(map, lat, r) {
  const mpp = 40075016.686 * Math.cos(lat * Math.PI / 180) / Math.pow(2, map.getZoom() + 8);
  return Math.max(4, (2 * r) / mpp);
}
function dist(a, b) { return Math.hypot((a[0] - b[0]) * 110540, (a[1] - b[1]) * 88000); }

// 칠한 범위를 지도에 그림 (확대·축소하면 두께도 맞춰 바뀜)
function paintLayer(map, strokes, r, color, opacity = .45) {
  const g = L.layerGroup();
  const lines = strokes.map(s => L.polyline(s.length > 1 ? s : [s[0], s[0]], { color, opacity, lineCap: "round", lineJoin: "round", interactive: false, weight: 8 }));
  const restyle = () => lines.forEach(l => { const c = l.getLatLngs()[0]; if (c) l.setStyle({ weight: brushPx(map, c.lat, r) }); });
  lines.forEach(l => g.addLayer(l));
  restyle();
  g.restyle = restyle;
  return g;
}

export async function render({ view, ctx }) {
  document.body.classList.add("route-open");
  const map = ctx.map;
  const layers = L.layerGroup().addTo(map);
  const draft = L.layerGroup().addTo(map);
  const st = { kind: "add", pts: [], strokes: [], brush: 8, painting: true };
  const paints = [];

  view.innerHTML = `<section class="rpanel"><div class="row">
    <button class="back" type="button" id="pe-back" aria-label="길찾기로">${ICON.back}</button>
    <div class="grow"><b>길 정보 제보</b><div class="small muted">검토 후 길찾기에 반영돼요</div></div>
  </div></section>`;
  view.querySelector("#pe-back").addEventListener("click", () => { location.hash = "#/route"; });
  ctx.focusDong(true, { message: "길 정보 제보는 월계1동에서만 받아요." });

  // 이미 반영된 제보 보여주기
  api("/api/map/paths/approved").then(rows => rows.forEach(p => {
    const k = KINDS[p.kind] || KINDS.add;
    if (p.strokes && p.strokes.length) {
      const pl = paintLayer(map, p.strokes, p.brush_m || 8, k.color, .28);
      pl.addTo(layers); paints.push(pl);
      return;
    }
    const shape = p.coords.length > 1 ? L.polyline(p.coords, { color: k.color, weight: 4, opacity: .7, dashArray: "6 6" }) : L.circleMarker(p.coords[0], { radius: 7, color: k.color });
    shape.bindPopup(`<b>${esc(p.kind_label)}</b>${p.open_hours ? `<br>통행 ${esc(p.open_hours)}` : ""}${p.note ? `<br>${esc(p.note)}` : ""}`).addTo(layers);
  })).catch(() => {});
  const onZoom = () => { paints.forEach(p => p.restyle()); redraw(); };
  map.on("zoomend", onZoom);

  if (!auth.loggedIn) {
    openSheet(loginCard("길 제보는 로그인한 뒤 할 수 있어요. 반영되면 알림으로 알려드려요."));
    return () => { map.off("zoomend", onZoom); map.removeLayer(layers); map.removeLayer(draft); closeSheet(); };
  }

  const isPaint = () => !!KINDS[st.kind].paint;
  function count() { return isPaint() ? st.strokes.length : st.pts.length; }
  function redraw() {
    draft.clearLayers();
    const k = KINDS[st.kind];
    if (isPaint()) {
      if (st.strokes.length) { const pl = paintLayer(map, st.strokes, st.brush, k.color, .5); pl.eachLayer(l => draft.addLayer(l)); }
    } else {
      if (st.pts.length > 1) draft.addLayer(L.polyline(st.pts, { color: k.color, weight: 5, dashArray: "8 6" }));
      st.pts.forEach(p => draft.addLayer(L.marker(p, { icon: L.divIcon({ className: "draw-pt", html: `<i style="border-color:${k.color}"></i>`, iconSize: [14, 14], iconAnchor: [7, 7] }), interactive: false })));
    }
    const cnt = document.getElementById("pe-count");
    if (cnt) cnt.textContent = isPaint() ? `${st.strokes.length}번 칠함` : `${st.pts.length}개 찍음`;
    const save = document.getElementById("pe-save");
    if (save) save.disabled = isPaint() ? !st.strokes.length : st.pts.length < k.min;
  }

  // ---- 칠하기: 칠하기 모드일 때는 지도 끌기를 끄고 손가락 움직임을 획으로 기록
  const box = map.getContainer();
  let cur = null;
  const fingers = new Set();     // 두 손가락(확대·축소)일 때는 칠하지 않음
  const llOf = e => map.mouseEventToLatLng(e);
  function setPainting(on) {
    st.painting = on;
    box.classList.toggle("painting", isPaint() && on);
    if (isPaint() && on) map.dragging.disable(); else map.dragging.enable();
    const b = document.getElementById("pe-mode");
    if (b) b.innerHTML = on ? "지도 움직이기" : "다시 칠하기";
  }
  const down = e => {
    fingers.add(e.pointerId);
    if (fingers.size > 1) {                         // 두 번째 손가락: 방금 시작한 획은 취소
      if (cur) { if (cur.length < 4) st.strokes.pop(); cur = null; redraw(); }
      map.touchZoom.enable();
      return;
    }
    if (!isPaint() || !st.painting || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (e.target.closest && e.target.closest(".leaflet-control")) return;
    const ll = llOf(e);
    if (!ctx.inArea(ll.lat, ll.lng)) { toast("월계1동 안(흐리지 않은 영역)을 칠해주세요."); return; }
    e.preventDefault();
    cur = [[ll.lat, ll.lng]];
    st.strokes.push(cur);
    box.setPointerCapture?.(e.pointerId);
    redraw();
  };
  const move = e => {
    if (!cur) return;
    e.preventDefault();
    const ll = llOf(e), p = [ll.lat, ll.lng];
    if (!ctx.inArea(p[0], p[1])) return;
    if (dist(p, cur[cur.length - 1]) >= 2) { cur.push(p); redraw(); }
  };
  const up = e => {
    if (e) fingers.delete(e.pointerId);
    if (!cur) return;
    cur = null;
    const total = st.strokes.reduce((n, s) => n + s.length, 0);
    if (total > 1400) { st.strokes.pop(); toast("칠한 범위가 너무 넓어요. 나눠서 제보해주세요."); }
    redraw();
  };
  box.addEventListener("pointerdown", down);
  box.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);

  function panel() {
    const k = KINDS[st.kind];
    const body = openSheet(`
      <h2 style="font-size:17px">무엇을 알려주실 건가요?</h2>
      <div class="pick" style="margin-top:6px">${Object.entries(KINDS).map(([key, v]) => `<button type="button" data-k="${key}" aria-pressed="${st.kind === key}">${v.label}</button>`).join("")}</div>
      <p class="small" style="margin:10px 0">${k.help}</p>
      ${k.paint ? `<div class="row wrap" style="gap:6px;margin-bottom:8px"><span class="small muted">붓 굵기</span>
        <div class="seg compact" style="flex:1">${BRUSH.map(([l, r]) => `<button type="button" data-brush="${r}" aria-pressed="${st.brush === r}">${l}</button>`).join("")}</div></div>` : ""}
      <div class="row wrap"><span class="chip" id="pe-count"></span>
        ${k.paint ? `<button class="btn sm" id="pe-mode" type="button">지도 움직이기</button>` : ""}
        <button class="btn sm" id="pe-undo" type="button">${k.paint ? "마지막 획 지우기" : "마지막 점 지우기"}</button><button class="btn sm ghost" id="pe-clear" type="button">모두 지우기</button></div>
      <div class="stack" style="margin-top:10px">
        ${st.kind === "gate" ? `<label class="field">통행 가능 시간 (모르면 비워두세요)<input class="input" id="pe-hours" placeholder="06:00-23:00" inputmode="numeric"></label>` : ""}
        <label class="field">메모<input class="input" id="pe-note" maxlength="200" placeholder="${k.paint ? "예: 계단 12칸, 난간 없음" : "예: 아파트 후문, 밤에는 잠김"}"></label>
        <button class="btn primary block" id="pe-save" type="button" disabled>제보 보내기</button>
      </div>`, { peek: true });
    body.querySelectorAll("[data-k]").forEach(b => b.addEventListener("click", () => {
      st.kind = b.dataset.k; st.pts = []; st.strokes = []; panel(); setPainting(true); redraw();
    }));
    body.querySelectorAll("[data-brush]").forEach(b => b.addEventListener("click", () => {
      st.brush = +b.dataset.brush; body.querySelectorAll("[data-brush]").forEach(x => x.setAttribute("aria-pressed", x === b)); redraw();
    }));
    body.querySelector("#pe-mode")?.addEventListener("click", () => setPainting(!st.painting));
    body.querySelector("#pe-undo").addEventListener("click", () => { isPaint() ? st.strokes.pop() : st.pts.pop(); redraw(); });
    body.querySelector("#pe-clear").addEventListener("click", () => { st.pts = []; st.strokes = []; redraw(); });
    body.querySelector("#pe-save").addEventListener("click", submit);
    setPainting(st.painting);
    redraw();
  }

  async function submit() {
    const hours = document.getElementById("pe-hours")?.value.trim() || "";
    if (hours && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(hours)) { toast("시간은 06:00-23:00 형식으로 적어주세요."); return; }
    const round = p => [+p[0].toFixed(6), +p[1].toFixed(6)];
    const body = isPaint()
      ? { kind: st.kind, strokes: st.strokes.map(s => s.map(round)), brush_m: st.brush, note: document.getElementById("pe-note").value.trim() }
      : { kind: st.kind, coords: st.pts.map(round), note: document.getElementById("pe-note").value.trim(), open_hours: hours };
    try {
      const r = await api("/api/map/paths", { method: "POST", body });
      toast(r.status === "approved" ? "바로 반영했어요 (관리자)." : "제보를 보냈어요. 검토 후 반영되면 알려드릴게요.", 3500);
      if (r.status === "approved") ctx.getGraph(true).catch(() => {});
      st.pts = []; st.strokes = []; panel();
    } catch (e) { toast(e.message); }
  }

  const onClick = e => {
    if (isPaint()) return;
    if (st.pts.length >= 60) return;
    if (!ctx.inArea(e.latlng.lat, e.latlng.lng)) { toast("월계1동 안(흐리지 않은 영역)에 점을 찍어주세요."); return; }
    st.pts.push([e.latlng.lat, e.latlng.lng]); redraw();
  };
  map.on("click", onClick);
  panel();

  return () => {
    map.off("click", onClick); map.off("zoomend", onZoom);
    box.removeEventListener("pointerdown", down); box.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
    box.classList.remove("painting"); map.dragging.enable();
    map.removeLayer(layers); map.removeLayer(draft); closeSheet();
  };
}
