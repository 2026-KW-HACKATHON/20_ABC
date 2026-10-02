// 길 정보 제보: 지도에 점을 찍어 새 길·막힌 길·쪽문·계단·가파른 길을 알림
import { api, auth } from "../api.js";
import { ICON, closeSheet, esc, loginCard, openSheet, toast } from "../ui.js";

const KINDS = {
  add: { label: "새 길", help: "지도에 없는 길을 따라 점을 차례로 찍어주세요. (예: 아파트 사이 샛길, 주차장 옆 통로)", min: 2, color: "#2563eb" },
  gate: { label: "쪽문·후문", help: "문 안쪽 한 점, 바깥쪽 한 점을 찍어주세요. 열리는 시간을 알면 적어주세요.", min: 2, color: "#7c3aed" },
  block: { label: "막힌 길", help: "지도에는 있지만 실제로 못 지나가는 길 위에 점을 찍어주세요.", min: 1, color: "#dc2626" },
  stairs: { label: "계단 있음", help: "계단이 있는 구간 위에 점을 찍어주세요.", min: 1, color: "#92400e" },
  steep: { label: "가파른 길", help: "휠체어·유아차로 오르기 힘든 구간 위에 점을 찍어주세요.", min: 1, color: "#b45309" },
};

export async function render({ view, ctx }) {
  document.body.classList.add("route-open");
  const map = ctx.map;
  const layers = L.layerGroup().addTo(map);
  const draft = L.layerGroup().addTo(map);
  const st = { kind: "add", pts: [] };

  view.innerHTML = `<section class="rpanel"><div class="row">
    <button class="back" type="button" id="pe-back" aria-label="길찾기로">${ICON.back}</button>
    <div class="grow"><b>길 정보 제보</b><div class="small muted">검토 후 길찾기에 반영돼요</div></div>
  </div></section>`;
  view.querySelector("#pe-back").addEventListener("click", () => { location.hash = "#/route"; });
  ctx.focusDong(true, { message: "길 정보 제보는 월계1동에서만 받아요." });

  // 이미 반영된 제보 보여주기
  api("/api/map/paths/approved").then(rows => rows.forEach(p => {
    const k = KINDS[p.kind] || KINDS.add;
    const shape = p.coords.length > 1 ? L.polyline(p.coords, { color: k.color, weight: 4, opacity: .7, dashArray: "6 6" }) : L.circleMarker(p.coords[0], { radius: 7, color: k.color });
    shape.bindPopup(`<b>${esc(p.kind_label)}</b>${p.open_hours ? `<br>통행 ${esc(p.open_hours)}` : ""}${p.note ? `<br>${esc(p.note)}` : ""}`).addTo(layers);
  })).catch(() => {});

  if (!auth.loggedIn) {
    openSheet(loginCard("길 제보는 로그인한 뒤 할 수 있어요. 반영되면 알림으로 알려드려요."));
    return () => { map.removeLayer(layers); map.removeLayer(draft); closeSheet(); };
  }

  function redraw() {
    draft.clearLayers();
    const k = KINDS[st.kind];
    if (st.pts.length > 1) draft.addLayer(L.polyline(st.pts, { color: k.color, weight: 5, dashArray: "8 6" }));
    st.pts.forEach(p => draft.addLayer(L.marker(p, { icon: L.divIcon({ className: "draw-pt", html: `<i style="border-color:${k.color}"></i>`, iconSize: [14, 14], iconAnchor: [7, 7] }), interactive: false })));
    const cnt = document.getElementById("pe-count");
    if (cnt) cnt.textContent = `${st.pts.length}개 찍음`;
    const save = document.getElementById("pe-save");
    if (save) save.disabled = st.pts.length < k.min;
  }

  function panel() {
    const k = KINDS[st.kind];
    const body = openSheet(`
      <h2 style="font-size:17px">무엇을 알려주실 건가요?</h2>
      <div class="pick" style="margin-top:6px">${Object.entries(KINDS).map(([key, v]) => `<button type="button" data-k="${key}" aria-pressed="${st.kind === key}">${v.label}</button>`).join("")}</div>
      <p class="small" style="margin:10px 0">${k.help}</p>
      <div class="row"><span class="chip" id="pe-count">${st.pts.length}개 찍음</span><button class="btn sm" id="pe-undo" type="button">마지막 점 지우기</button><button class="btn sm ghost" id="pe-clear" type="button">모두 지우기</button></div>
      <div class="stack" style="margin-top:10px">
        ${st.kind === "gate" ? `<label class="field">통행 가능 시간 (모르면 비워두세요)<input class="input" id="pe-hours" placeholder="06:00-23:00" inputmode="numeric"></label>` : ""}
        <label class="field">메모<input class="input" id="pe-note" maxlength="200" placeholder="예: 아파트 후문, 밤에는 잠김"></label>
        <button class="btn primary block" id="pe-save" type="button" disabled>제보 보내기</button>
      </div>`);
    body.querySelectorAll("[data-k]").forEach(b => b.addEventListener("click", () => { st.kind = b.dataset.k; st.pts = []; panel(); redraw(); }));
    body.querySelector("#pe-undo").addEventListener("click", () => { st.pts.pop(); redraw(); });
    body.querySelector("#pe-clear").addEventListener("click", () => { st.pts = []; redraw(); });
    body.querySelector("#pe-save").addEventListener("click", submit);
    redraw();
  }

  async function submit() {
    const hours = document.getElementById("pe-hours")?.value.trim() || "";
    if (hours && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(hours)) { toast("시간은 06:00-23:00 형식으로 적어주세요."); return; }
    try {
      const r = await api("/api/map/paths", { method: "POST", body: { kind: st.kind, coords: st.pts.map(p => [+p[0].toFixed(6), +p[1].toFixed(6)]), note: document.getElementById("pe-note").value.trim(), open_hours: hours } });
      toast(r.status === "approved" ? "바로 반영했어요 (관리자)." : "제보를 보냈어요. 검토 후 반영되면 알려드릴게요.", 3500);
      if (r.status === "approved") ctx.getGraph(true).catch(() => {});
      st.pts = []; panel();
    } catch (e) { toast(e.message); }
  }

  const onClick = e => {
    if (st.pts.length >= 60) return;
    if (!ctx.inArea(e.latlng.lat, e.latlng.lng)) { toast("월계1동 안(흐리지 않은 영역)에 점을 찍어주세요."); return; }
    st.pts.push([e.latlng.lat, e.latlng.lng]); redraw();
  };
  map.on("click", onClick);
  panel();

  return () => { map.off("click", onClick); map.removeLayer(layers); map.removeLayer(draft); closeSheet(); };
}
