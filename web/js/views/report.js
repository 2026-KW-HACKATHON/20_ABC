// 사진 신문고: 촬영 → AI 분류 → 위치 확인 → 접수 / 내 신고 목록·상세
import { api, auth } from "../api.js";
import { createMap } from "../basemap.js";
import { ICON, ago, bindBack, esc, loginCard, pageHead, shrinkImage, toast } from "../ui.js";

let meta = null;
async function getMeta() { if (!meta) meta = await api("/api/reports/meta"); return meta; }

export async function render({ view, ctx, args }) {
  document.body.classList.add("page-open");
  if (args[0]) return detail(view, +args[0]);
  view.innerHTML = `<div class="page">${pageHead("사진 신문고", { sub: "사진 한 장이면 위치와 유형은 자동으로" })}<div class="page-body" id="rp-body"></div></div>`;
  const body = view.querySelector("#rp-body");
  if (!auth.loggedIn) { body.innerHTML = loginCard("신고 내용과 처리 결과를 알려드리려면 로그인이 필요해요."); return; }
  const m = await getMeta();
  let mini = null;
  const st = { blob: null, url: null, ai: null, category: "", pos: null };

  function step1() {
    body.innerHTML = `
      <label class="shot" for="rp-photo">${ICON.camera}<span>불편한 곳을 찍어주세요</span><span class="small muted" style="font-weight:400">보도 파손, 불법 주정차, 쓰레기, 고장 난 시설, 휠체어가 못 지나가는 곳</span>
        <input id="rp-photo" type="file" accept="image/*" capture="environment"></label>
      <div class="card small muted">사진에서 위치 정보는 지워지고, 사진은 신고한 본인과 관리자만 볼 수 있어요. 지도에는 유형과 처리 상태만 공개됩니다.${m.ai_enabled ? ` 유형을 자동으로 고르기 위해 사진이 AI 서비스(${esc(m.ai_label)})로 전송돼요. 사람 얼굴이나 차량 번호판이 크게 찍히지 않게 해주세요.` : ""}</div>
      <div id="mine"></div>`;
    body.querySelector("#rp-photo").addEventListener("change", onPhoto);
    myList(body.querySelector("#mine"));
  }

  async function onPhoto(e) {
    const f = e.target.files[0];
    if (!f) return;
    try { st.blob = await shrinkImage(f); } catch (err) { toast(err.message); return; }
    if (st.url) URL.revokeObjectURL(st.url);
    st.url = URL.createObjectURL(st.blob);
    st.pos = ctx.myPos;
    if (mini) { mini.remove(); mini = null; }
    body.innerHTML = "";
    step2(true);
    ctx.locate({ silent: true }).then(p => { if (p && mini && ctx.inArea(...p)) { st.pos = p; mini.setView(p, 18, { animate: false }); } });
    const fd = new FormData();
    fd.append("photo", st.blob, "photo.jpg");
    try {
      st.ai = await api("/api/reports/analyze", { method: "POST", form: fd });
      if (st.ai.ai && st.ai.category !== "not_issue") st.category = st.ai.category;
    } catch (err) { st.ai = { ai: false, message: err.message }; }
    step2(false);
  }

  function aiHtml(loading) {
    const ai = st.ai;
    if (loading) return `<div class="ai-box row"><span class="spinner"></span><span>AI가 사진을 살펴보는 중…</span></div>`;
    if (ai && ai.ai) {
      return ai.category === "not_issue"
        ? `<div class="ai-box"><div class="cat">신고할 문제가 안 보여요</div><p class="small" style="margin:4px 0 0">${esc(ai.summary)} — 맞지 않다면 아래에서 유형을 직접 골라주세요.</p></div>`
        : `<div class="ai-box"><div class="small muted">AI 분석 결과</div><div class="cat">${esc(ai.category_label)}</div>
            <p class="small" style="margin:4px 0 0">${esc(ai.summary)}</p>
            <div class="conf" aria-label="확신도 ${Math.round(ai.confidence * 100)}%"><i style="width:${Math.round(ai.confidence * 100)}%"></i></div>
            <div class="small muted" style="margin-top:4px">확신도 ${Math.round(ai.confidence * 100)}%${ai.severity === 3 ? " · 빠른 조치가 필요해 보여요" : ""}</div>
            ${ai.privacy ? `<p class="small" style="margin:6px 0 0;color:#9a5a00">사람 얼굴이나 번호판이 보여요. 사진은 관리자만 봅니다.</p>` : ""}</div>`;
    }
    return `<div class="ai-box small">${esc(ai?.message || "유형을 직접 골라주세요.")}</div>`;
  }

  // AI 결과가 오면 이 부분만 바꿈 (지도는 다시 만들지 않음)
  function step2(loading) {
    if (!body.querySelector("#ai-slot")) layout();
    body.querySelector("#ai-slot").innerHTML = aiHtml(loading);
    body.querySelectorAll("[data-cat]").forEach(x => x.setAttribute("aria-pressed", x.dataset.cat === st.category));
    body.querySelector("#rp-send").disabled = loading;
  }

  function layout() {
    body.innerHTML = `
      <img class="preview" src="${st.url}" alt="찍은 사진">
      <div id="ai-slot"></div>
      <div class="card stack">
        <h2>유형</h2>
        <div class="pick" id="cat-pick">${Object.entries(m.categories).map(([k, l]) => `<button type="button" data-cat="${k}" aria-pressed="false">${esc(l)}</button>`).join("")}</div>
      </div>
      <div class="card stack">
        <h2>위치</h2>
        <p class="small muted" style="margin:-4px 0 0">지도를 움직여 핀을 문제 위치에 맞춰주세요.</p>
        <div class="minimap"><div id="mini" style="height:100%"></div><div class="center-pin">${ICON.pin}</div></div>
      </div>
      <div class="card stack">
        <h2>설명 <span class="muted small">(선택)</span></h2>
        <textarea class="input" id="rp-desc" maxlength="1000" placeholder="예: 보도블록이 들떠서 유모차 바퀴가 걸려요"></textarea>
      </div>
      <div class="row"><button class="btn grow" id="rp-cancel" type="button">다시 찍기</button><button class="btn accent grow" id="rp-send" type="button">신고 접수</button></div>`;
    body.querySelectorAll("[data-cat]").forEach(b => b.addEventListener("click", () => {
      st.category = b.dataset.cat;
      body.querySelectorAll("[data-cat]").forEach(x => x.setAttribute("aria-pressed", x === b));
    }));
    if (mini) { mini.remove(); mini = null; }
    mini = createMap(body.querySelector("#mini"), ctx.base, { zoomControl: false, attribution: false, labels: true, padding: [10, 10] });
    const start = st.pos && ctx.inArea(...st.pos) ? st.pos : ctx.map.getCenter();
    mini.setView(start, 18, { animate: false });
    body.querySelector("#rp-cancel").addEventListener("click", () => { st.ai = null; st.category = ""; if (mini) { mini.remove(); mini = null; } step1(); });
    body.querySelector("#rp-send").addEventListener("click", send);
  }

  async function send() {
    if (!st.category) { toast("유형을 골라주세요."); return; }
    const c = mini.getCenter();
    if (!ctx.inArea(c.lat, c.lng)) { toast("월계1동 안의 위치만 신고할 수 있어요."); return; }
    const fd = new FormData();
    fd.append("photo", st.blob, "photo.jpg");
    fd.append("lat", c.lat.toFixed(6));
    fd.append("lng", c.lng.toFixed(6));
    fd.append("category", st.category);
    fd.append("description", body.querySelector("#rp-desc").value.trim());
    if (st.ai?.ai) {
      fd.append("ai_category", st.ai.category); fd.append("ai_confidence", st.ai.confidence);
      fd.append("ai_summary", st.ai.summary); fd.append("ai_severity", st.ai.severity);
    }
    const btn = body.querySelector("#rp-send");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const r = await api("/api/reports", { method: "POST", form: fd });
      toast("신고가 접수됐어요. 처리 상황을 알림으로 알려드릴게요.", 3500);
      ctx.reloadReports();
      location.hash = `#/report/${r.id}`;
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = "신고 접수"; }
  }

  step1();
  return () => { if (mini) mini.remove(); if (st.url) URL.revokeObjectURL(st.url); };
}

async function myList(el) {
  try {
    const rows = await api("/api/reports/mine");
    el.innerHTML = `<h2 style="font-size:16px;margin:6px 0 8px">내 신고 ${rows.length ? `<span class="muted small">${rows.length}건</span>` : ""}</h2>` + (rows.length
      ? `<div class="list">${rows.map(r => `<a class="item" href="#/report/${r.id}">
          <img class="thumb" src="${r.thumb_url}" alt="" loading="lazy">
          <div class="grow"><div class="row wrap" style="gap:6px"><span class="chip ${r.status}">${esc(r.status_label)}</span><span class="small muted">${ago(r.created_at)}</span></div>
          <div class="t" style="margin-top:3px">${esc(r.category_label)}</div><div class="m">${esc(r.summary || r.description || "")}</div></div></a>`).join("")}</div>`
      : `<div class="empty">아직 신고한 내역이 없어요.</div>`);
  } catch (e) { el.innerHTML = ""; }
}

async function detail(view, id) {
  view.innerHTML = `<div class="page">${pageHead("신고 상세", { back: true })}<div class="page-body" id="rd"><div class="empty"><span class="spinner"></span></div></div></div>`;
  bindBack(view);
  const el = view.querySelector("#rd");
  if (!auth.loggedIn) { el.innerHTML = loginCard("신고 내용은 신고한 본인만 볼 수 있어요."); return; }
  let r;
  try { r = await api(`/api/reports/${id}`); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const steps = ["received", "checking", "resolved"];
  const idx = r.status === "rejected" ? -1 : steps.indexOf(r.status);
  el.innerHTML = `
    <img class="photo-full" src="${r.image_url}" alt="신고 사진">
    <div class="card stack">
      <div class="row wrap"><span class="chip ${r.status}">${esc(r.status_label)}</span><span class="small muted">${ago(r.created_at)} 접수</span></div>
      <h2 style="margin:0">${esc(r.category_label)}</h2>
      ${r.summary ? `<p style="margin:0">${esc(r.summary)}</p>` : ""}
      ${r.description ? `<p class="small muted" style="margin:0">${esc(r.description)}</p>` : ""}
      ${r.status === "rejected" ? `<div class="banner">반려된 신고예요.</div>` : `<div class="timeline">${["접수", "확인 중", "처리 완료"].map((l, i) => `<div class="${i <= idx ? "on" : ""}">${l}</div>`).join("")}</div>`}
      ${r.admin_note ? `<div class="banner info"><span><b>담당자 메모</b><br>${esc(r.admin_note)}</span></div>` : ""}
    </div>
    <div class="row">
      <a class="btn grow" href="#/map">지도에서 보기</a>
      ${r.status === "received" ? `<button class="btn danger grow" id="rd-del" type="button">신고 취소</button>` : ""}
    </div>`;
  el.querySelector("#rd-del")?.addEventListener("click", async () => {
    if (!confirm("신고를 취소할까요?")) return;
    try { await api(`/api/reports/${id}`, { method: "DELETE" }); toast("신고를 취소했어요."); location.hash = "#/report"; } catch (e) { toast(e.message); }
  });
  el.querySelector('a[href="#/map"]').addEventListener("click", e => {
    e.preventDefault();
    location.hash = "#/map";
    setTimeout(() => {
      const c = window.__wolgyeon;
      c.map.flyTo([r.lat, r.lng], 18, { duration: 0.5 });
      L.popup().setLatLng([r.lat, r.lng]).setContent(`<b>${esc(r.category_label)}</b><br>${esc(r.status_label)}`).openOn(c.map);
    }, 50);
  });
}
