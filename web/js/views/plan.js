// 메모·일정 기반 경로: 할 일 메모 → 들를 가게 자동 선택 → 최단 순서 → 근처 알림
import { api, auth } from "../api.js";
import { MODES, distM } from "../graph.js";
import { ICON, closeSheet, esc, fmtDist, fmtMin, kst, loginCard, openSheet, toast } from "../ui.js";

export async function render({ view, ctx }) {
  document.body.classList.add("route-open");
  const map = ctx.map;
  const layers = L.layerGroup().addTo(map);
  let watchId = null;
  let plan = null;
  const st = { mode: "shortcut", endKey: "back", todos: [], favs: [] };

  view.innerHTML = `<section class="rpanel"><div class="row">
    <button class="back" type="button" id="plan-back" aria-label="길찾기로">${ICON.back}</button>
    <div class="grow"><b>메모로 경로 짜기</b><div class="small muted">살 것·할 일을 적으면 들를 곳과 순서를 정해드려요</div></div>
  </div></section>`;
  view.querySelector("#plan-back").addEventListener("click", () => { location.hash = "#/route"; });
  ctx.focusDong(true, { message: auth.loggedIn ? "메모 경로는 월계1동에서만 지원돼요." : "" });

  if (!auth.loggedIn) {
    openSheet(loginCard("메모 기반 경로는 로그인한 뒤 쓸 수 있어요. 메모가 계정에 저장됩니다."));
    return () => { map.removeLayer(layers); closeSheet(); };
  }

  async function loadData() {
    try {
      [st.todos, st.favs] = await Promise.all([api("/api/todos"), api("/api/events/favorites")]);
    } catch (e) { toast(e.message); }
  }

  function editor() {
    const upcomingFavs = st.favs.filter(f => f.lat != null && (!f.start_at || kst(f.start_at) > new Date()));
    const body = openSheet(`
      <h2 style="font-size:17px">할 일 메모</h2>
      <form class="row" id="todo-form" style="margin:8px 0">
        <input class="input grow" id="todo-in" maxlength="100" placeholder="예: 휴지 사기, 과일, 택배 보내기" autocomplete="off">
        <button class="btn primary" type="submit">추가</button>
      </form>
      <div class="list" id="todo-list">${st.todos.length ? st.todos.map(t => `
        <div class="todo ${t.done ? "done" : ""}">
          <input type="checkbox" data-done="${t.id}" ${t.done ? "checked" : ""} aria-label="완료">
          <div class="txt"><div>${esc(t.text)}</div><div class="cats">${t.cats.length ? t.cats.map(c => esc(label(c))).join(" · ") : "들를 곳을 AI가 찾아볼게요"}</div></div>
          <button class="x" type="button" data-del="${t.id}" aria-label="삭제">×</button>
        </div>`).join("") : `<div class="empty" style="padding:16px">메모를 추가해보세요.</div>`}</div>
      <div class="stack" style="margin-top:14px">
        <label class="field">끝나고 갈 곳
          <select class="input" id="end-sel">
            <option value="back" ${st.endKey === "back" ? "selected" : ""}>출발한 곳으로 돌아오기</option>
            ${upcomingFavs.map(f => `<option value="ev${f.id}" ${st.endKey === "ev" + f.id ? "selected" : ""}>내 일정: ${esc(f.title)}</option>`).join("")}
          </select>
        </label>
        <div class="seg" role="group" aria-label="경로 종류">${Object.entries(MODES).map(([k, m]) => `<button type="button" data-mode="${k}" aria-pressed="${st.mode === k}">${m.label}</button>`).join("")}</div>
        <button class="btn blue block" id="btn-plan" type="button">경로 만들기</button>
        <p class="small muted" style="margin:0">메모 경로는 <b>월계1동 안</b>에서만 지원돼요. 출발지는 현재 위치이고, 월계1동 밖이면 동 안의 지도 가운데에서 출발합니다.</p>
      </div>`);
    body.querySelector("#todo-form").addEventListener("submit", async e => {
      e.preventDefault();
      const v = body.querySelector("#todo-in").value.trim();
      if (!v) return;
      try { st.todos.push(await api("/api/todos", { method: "POST", body: { text: v } })); editor(); document.getElementById("todo-in")?.focus(); }
      catch (err) { toast(err.message); }
    });
    body.querySelectorAll("[data-done]").forEach(c => c.addEventListener("change", async () => {
      try { await api(`/api/todos/${c.dataset.done}`, { method: "PATCH", body: { done: c.checked } }); const t = st.todos.find(x => x.id == c.dataset.done); t.done = c.checked; editor(); }
      catch (err) { toast(err.message); }
    }));
    body.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      try { await api(`/api/todos/${b.dataset.del}`, { method: "DELETE" }); st.todos = st.todos.filter(x => x.id != b.dataset.del); editor(); }
      catch (err) { toast(err.message); }
    }));
    body.querySelector("#end-sel").addEventListener("change", e => { st.endKey = e.target.value; });
    body.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => {
      st.mode = b.dataset.mode;
      body.querySelectorAll("[data-mode]").forEach(x => x.setAttribute("aria-pressed", x === b));
    }));
    body.querySelector("#btn-plan").addEventListener("click", makePlan);
  }

  let labels = {};
  const label = c => labels[c] || c;

  async function makePlan() {
    const open = st.todos.filter(t => !t.done);
    if (!open.length) { toast("완료하지 않은 메모가 없어요."); return; }
    openSheet(`<div class="empty"><span class="spinner"></span><br>들를 곳을 고르는 중…</div>`);
    try {
      const [graph, poiData, cat] = await Promise.all([
        ctx.getGraph(), ctx.getPois(),
        api("/api/todos/categorize", { method: "POST", body: { items: open.map(t => t.text) } }),
      ]);
      labels = cat.labels;
      let start = ctx.myPos || await ctx.locate({ silent: true });
      let startName = "내 위치";
      if (!start || !ctx.inArea(...start)) {
        const c = map.getCenter();
        if (ctx.inArea(c.lat, c.lng)) { start = [c.lat, c.lng]; startName = "지도 가운데"; }
        else { start = ctx.dongCenter(); startName = "월계1동 가운데"; }
        toast("지금 위치가 월계1동 밖이라 월계1동 안에서 출발하는 경로로 짰어요.", 3500);
      }
      let end = null, endEv = null;
      if (st.endKey.startsWith("ev")) { endEv = st.favs.find(f => "ev" + f.id === st.endKey); if (endEv) end = [endEv.lat, endEv.lng]; }
      plan = graph.planStops(start, end, cat.items, poiData.items, st.mode);
      plan.start = start; plan.startName = startName; plan.endEv = endEv;
      drawPlan();
    } catch (e) { toast(e.message); editor(); }
  }

  function drawPlan() {
    layers.clearLayers();
    if (!plan.ok) {
      openSheet(`<h2 style="font-size:17px">경로를 만들지 못했어요</h2>
        <p class="muted small">${esc(plan.error || "메모에 맞는 가게를 근처에서 찾지 못했어요.")}</p>
        ${missingHtml()}
        <button class="btn block" id="back-edit" type="button">메모 고치기</button>`);
      document.getElementById("back-edit").addEventListener("click", editor);
      return;
    }
    layers.addLayer(L.polyline(plan.latlngs, { color: "#fff", weight: 10, opacity: .95, lineCap: "round", lineJoin: "round", interactive: false }));
    layers.addLayer(L.polyline(plan.latlngs, { color: "#2563eb", weight: 6, lineCap: "round", lineJoin: "round", interactive: false }));
    plan.stops.forEach((s, i) => {
      s._m = L.marker([s.lat, s.lng], { icon: L.divIcon({ className: "stop-pin", html: `<div>${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: 600 })
        .bindPopup(`<b>${esc(s.name)}</b><br>${esc(s.covers.join(", "))}`).addTo(layers);
    });
    layers.addLayer(L.marker(plan.start, { icon: L.divIcon({ className: "rt-pin", html: `<div class="s"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false }));
    map.fitBounds(L.latLngBounds(plan.latlngs), { paddingTopLeft: [24, 110], paddingBottomRight: [24, Math.min(380, innerHeight * 0.5)] });

    const mins = plan.minutes + plan.stops.length * 5; // 가게마다 5분 머무른다고 가정
    let timing = "";
    if (plan.endEv?.start_at) {
      const leave = new Date(kst(plan.endEv.start_at).getTime() - (mins + 5) * 60000);
      const k = new Date(leave.getTime() + 9 * 3600e3);
      timing = `<div class="banner info"><span><b>${esc(plan.endEv.title)}</b>에 늦지 않으려면 <b>${String(k.getUTCHours()).padStart(2, "0")}:${String(k.getUTCMinutes()).padStart(2, "0")}</b>까지 출발하세요.</span></div>`;
    }
    openSheet(`
      <h2 style="font-size:17px">들를 곳 ${plan.stops.length}곳 · ${fmtDist(plan.length)}</h2>
      <p class="small muted" style="margin:0">걷는 시간 약 ${fmtMin(plan.length, MODES[st.mode].speed)} (가게에서 머무는 시간 제외) · ${MODES[st.mode].label}</p>
      ${timing}
      <ol class="stops">
        <li><b class="n" style="background:#14233d">출</b><div>${esc(plan.startName)}에서 출발</div></li>
        ${plan.stops.map((s, i) => `<li data-stop="${i}"><b class="n">${i + 1}</b><div><b>${esc(s.name)}</b> <span class="muted small">${esc(label(s.cat))}</span><br><span class="small">${esc(s.covers.join(", "))}</span></div></li>`).join("")}
        <li><b class="n" style="background:#14233d">도</b><div>${plan.endEv ? esc(plan.endEv.title) : "출발한 곳으로 돌아오기"}</div></li>
      </ol>
      ${missingHtml()}
      <div class="actions"><button class="btn" id="back-edit" type="button">메모 고치기</button><button class="btn primary" id="btn-go" type="button">안내 시작</button></div>
      <p class="small muted" style="margin:10px 0 0">안내를 시작하면 가게 근처(40m)에 갔을 때 알려드려요. 앱이 켜져 있을 때만 알림이 울립니다.</p>`);
    document.getElementById("back-edit").addEventListener("click", () => { stopWatch(); editor(); });
    document.getElementById("btn-go").addEventListener("click", startGuide);
  }

  function missingHtml() {
    const parts = [];
    if (plan.missing?.length) parts.push(`근처에서 파는 곳을 찾지 못함: ${plan.missing.map(m => esc(m.text)).join(", ")}`);
    if (plan.noCats?.length) parts.push(`들를 곳이 필요 없는 메모로 봤어요: ${plan.noCats.map(m => esc(m.text)).join(", ")}`);
    return parts.length ? `<div class="banner" style="margin-top:10px"><span>${parts.join("<br>")}</span></div>` : "";
  }

  function stopWatch() { if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; } }

  function startGuide() {
    if (!navigator.geolocation) { toast("이 기기에서는 위치 안내를 쓸 수 없어요."); return; }
    if (watchId != null) { stopWatch(); toast("안내를 멈췄어요."); return; }
    toast("안내를 시작합니다. 가게 근처에 가면 알려드릴게요.");
    const btn = document.getElementById("btn-go");
    if (btn) btn.textContent = "안내 멈추기";
    watchId = navigator.geolocation.watchPosition(p => {
      const pos = [p.coords.latitude, p.coords.longitude];
      ctx.setMyPos(pos);
      plan.stops.forEach((s, i) => {
        if (s.done) return;
        if (distM(pos, [s.lat, s.lng]) <= 40) {
          s.done = true;
          s._m?.setIcon(L.divIcon({ className: "stop-pin done", html: `<div>${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }));
          document.querySelector(`[data-stop="${i}"]`)?.classList.add("done");
          toast(`${s.name} 근처예요 — ${s.covers.join(", ")}`, 6000);
          if (navigator.vibrate) navigator.vibrate([150, 80, 150]);
        }
      });
      if (plan.stops.every(s => s.done)) { toast("모든 곳을 들렀어요!", 4000); stopWatch(); }
    }, () => toast("위치를 받지 못했어요."), { enableHighAccuracy: true, maximumAge: 5000 });
  }

  await loadData();
  try { labels = (await ctx.getPois()).labels || {}; } catch (_) {}
  editor();

  return () => { stopWatch(); map.removeLayer(layers); closeSheet(); };
}
