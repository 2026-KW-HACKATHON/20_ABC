// 주민 행사 제보: 구청·서울시 사이트에 없는 작은 동네 행사를 알려주면 관리자가 확인 후 지도에 올림
//  - 포스터·전단 사진(선택) → AI가 이름·일시·장소를 미리 채움
//  - 위치는 작은 지도의 가운데 핀으로 지정 (월계동 안)
import { api, auth } from "../api.js";
import { createMap } from "../basemap.js";
import { ICON, ago, bindBack, esc, eventWhen, loginCard, pageHead, shrinkImage, toast } from "../ui.js";

let meta = null;
const STATUS_CHIP = { pending: "received", approved: "resolved", rejected: "rejected" };

const INTRO = `<div class="tip-intro">
  <h2>내 행사를 월계온 지도에 올려보세요</h2>
  <p>동아리 공연, 아파트 장터, 경로당 잔치, 교회·성당 바자회처럼 구청이나 서울시 사이트에 올라오지 않는 행사를 알려주세요. 관리자가 확인한 뒤 지도에 올리고, 결과를 알림으로 알려드려요.</p>
</div>`;

export async function render({ view, ctx }) {
  document.body.classList.add("page-open");
  view.innerHTML = `<div class="page">${pageHead("행사 제보", { back: true, sub: "내 행사를 이웃에게 알려보세요" })}<div class="page-body stack" id="tp-body"></div></div>`;
  bindBack(view);
  const body = view.querySelector("#tp-body");
  if (!auth.loggedIn) {
    body.innerHTML = INTRO + loginCard("제보 결과를 알림으로 알려드리려면 로그인이 필요해요.");
    return;
  }
  try { meta = meta || await api("/api/tips/meta"); } catch (e) { body.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }

  const st = { blob: null, url: null, category: "community", busy: false };
  let mini = null;
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

  body.innerHTML = `${INTRO}
    <form class="stack" id="tp-form" novalidate>
      <div class="card stack">
        <h2>포스터·전단 사진 <span class="muted small">(선택)</span></h2>
        <div id="tp-photo-slot">
          <label class="shot" for="tp-photo" style="min-height:120px">${ICON.camera}<span>사진 올리기</span>
            <span class="small muted" style="font-weight:400">${meta.ai_enabled ? "AI가 포스터를 읽고 아래 칸을 채워드려요" : "관리자가 행사를 확인하는 데 도움이 돼요"}</span>
            <input id="tp-photo" type="file" accept="image/*"></label>
        </div>
        <div id="tp-ai"></div>
        ${meta.ai_enabled ? `<p class="small muted" style="margin:0">사진은 포스터를 읽기 위해 AI 서비스(${esc(meta.ai_label)})로 전송돼요. 사람 얼굴이 크게 찍힌 사진은 피해주세요. 촬영 위치 정보는 지워서 저장해요.</p>` : ""}
      </div>

      <div class="card stack">
        <h2>행사 정보</h2>
        <label class="field">행사 이름 *<input class="input" id="f-title" maxlength="100" required placeholder="예: 월계 한일아파트 가을 알뜰장터"></label>
        <div class="field">분류
          <div class="pick" id="f-cat">${Object.entries(meta.categories).map(([k, l]) => `<button type="button" data-cat="${k}" aria-pressed="${k === st.category}">${esc(l)}</button>`).join("")}</div>
        </div>
        <div class="row2">
          <label class="field">시작 날짜 *<input class="input" id="f-sd" type="date" min="${today}" required></label>
          <label class="field">시작 시간<input class="input" id="f-st" type="time"></label>
        </div>
        <div class="row2">
          <label class="field">끝나는 날짜<input class="input" id="f-ed" type="date" min="${today}"></label>
          <label class="field">끝나는 시간<input class="input" id="f-et" type="time"></label>
        </div>
        <label class="field">장소 이름 *<input class="input" id="f-place" maxlength="120" required placeholder="예: 한일아파트 3동 앞 주차장"></label>
      </div>

      <div class="card stack">
        <h2>위치 *</h2>
        <p class="small muted" style="margin:-4px 0 0">지도를 움직여 핀을 행사 장소에 맞춰주세요. 월계동 안의 행사만 받아요.</p>
        <div class="minimap"><div id="tp-mini" style="height:100%"></div><div class="center-pin">${ICON.pin}</div></div>
        <button class="btn sm" type="button" id="tp-me">내 위치로 옮기기</button>
      </div>

      <div class="card stack">
        <h2>더 알려주세요 <span class="muted small">(선택)</span></h2>
        <label class="field">소개<textarea class="input" id="f-desc" maxlength="2000" placeholder="어떤 행사인지, 누가 참여할 수 있는지"></textarea></label>
        <label class="field">주최<input class="input" id="f-host" maxlength="100" placeholder="예: 한일아파트 입주자대표회의"></label>
        <label class="field">참가비<input class="input" id="f-fee" maxlength="100" placeholder="예: 무료"></label>
        <label class="field">관련 링크<input class="input" id="f-url" maxlength="400" inputmode="url" placeholder="안내 글이나 SNS 주소"></label>
        <label class="field">연락처 (관리자만 봐요)<input class="input" id="f-contact" maxlength="80" placeholder="확인이 필요할 때 연락드릴 곳"></label>
      </div>
      <button class="btn accent block" type="submit" id="tp-send">제보 보내기</button>
    </form>
    <section class="stack" id="tp-mine"></section>`;

  const $ = s => body.querySelector(s);
  function setCat(k) {
    st.category = k;
    body.querySelectorAll("[data-cat]").forEach(b => b.setAttribute("aria-pressed", b.dataset.cat === k));
  }
  body.querySelectorAll("[data-cat]").forEach(b => b.addEventListener("click", () => setCat(b.dataset.cat)));

  // 작은 지도 (한 번만 만듦)
  mini = createMap($("#tp-mini"), ctx.base, { zoomControl: false, attribution: false, labels: true, padding: [10, 10] });
  const startPos = ctx.myPos && ctx.inService(...ctx.myPos) ? ctx.myPos : ctx.dongCenter();
  mini.setView(startPos, 17, { animate: false });
  $("#tp-me").addEventListener("click", async () => {
    const p = ctx.myPos || await ctx.locate();
    if (!p) return;
    if (!ctx.inService(...p)) { toast("지금 위치가 월계동 밖이에요. 지도를 직접 움직여주세요."); return; }
    mini.setView(p, 18);
  });

  // 포스터 사진
  function photoSlot() {
    $("#tp-photo-slot").innerHTML = st.url
      ? `<img class="poster" src="${st.url}" alt="올린 포스터"><button class="btn sm ghost" type="button" id="tp-photo-x" style="margin-top:6px">사진 빼기</button>`
      : `<label class="shot" for="tp-photo" style="min-height:120px">${ICON.camera}<span>사진 올리기</span>
          <span class="small muted" style="font-weight:400">${meta.ai_enabled ? "AI가 포스터를 읽고 아래 칸을 채워드려요" : "관리자가 행사를 확인하는 데 도움이 돼요"}</span>
          <input id="tp-photo" type="file" accept="image/*"></label>`;
    $("#tp-photo")?.addEventListener("change", onPhoto);
    $("#tp-photo-x")?.addEventListener("click", () => { URL.revokeObjectURL(st.url); st.url = null; st.blob = null; $("#tp-ai").innerHTML = ""; photoSlot(); });
  }
  async function onPhoto(e) {
    const f = e.target.files[0];
    if (!f) return;
    try { st.blob = await shrinkImage(f); } catch (err) { toast(err.message); return; }
    if (st.url) URL.revokeObjectURL(st.url);
    st.url = URL.createObjectURL(st.blob);
    photoSlot();
    if (!meta.ai_enabled) return;
    $("#tp-ai").innerHTML = `<div class="ai-box row"><span class="spinner"></span><span>AI가 포스터를 읽는 중…</span></div>`;
    const fd = new FormData();
    fd.append("photo", st.blob, "poster.jpg");
    try {
      const r = await api("/api/tips/analyze", { method: "POST", form: fd });
      if (!r.ai) { $("#tp-ai").innerHTML = `<div class="ai-box small">${esc(r.message)}</div>`; return; }
      fillFromAi(r);
    } catch (err) { $("#tp-ai").innerHTML = `<div class="ai-box small">${esc(err.message)}</div>`; }
  }
  async function fillFromAi(r) {
    const put = (sel, v) => { if (v && !$(sel).value) $(sel).value = v; };
    const [sd, stt] = (r.start || "").split(" "), [ed, ett] = (r.end || "").split(" ");
    put("#f-title", r.title); put("#f-place", r.place); put("#f-host", r.host); put("#f-fee", r.fee); put("#f-desc", r.summary);
    if (/^\d{4}-\d{2}-\d{2}$/.test(sd || "")) put("#f-sd", sd);
    if (/^\d{2}:\d{2}$/.test(stt || "")) put("#f-st", stt);
    if (/^\d{4}-\d{2}-\d{2}$/.test(ed || "") && ed !== sd) put("#f-ed", ed);
    if (/^\d{2}:\d{2}$/.test(ett || "")) put("#f-et", ett);
    if (r.category) setCat(r.category);
    let moved = false;
    if (r.place) {   // 앱의 장소 목록에서 같은 이름을 찾으면 지도를 그곳으로
      try {
        const norm = x => (x || "").replace(/\s+/g, "");
        const hit = (await ctx.getPois()).find(p => p.name && norm(r.place).includes(norm(p.name)) && norm(p.name).length >= 3);
        if (hit && ctx.inService(hit.lat, hit.lng)) { mini.setView([hit.lat, hit.lng], 18); moved = true; }
      } catch (_) { /* 무시 */ }
    }
    $("#tp-ai").innerHTML = `<div class="ai-box small"><b>포스터 내용을 채웠어요.</b> 틀린 곳은 고쳐주세요.${r.time_text ? `<br>포스터 일시: ${esc(r.time_text)}` : ""}${r.place && !moved ? "<br>위치는 지도에서 직접 맞춰주세요." : ""}</div>`;
  }
  photoSlot();

  // 보내기
  $("#tp-form").addEventListener("submit", async e => {
    e.preventDefault();
    if (st.busy) return;
    const v = s => $(s).value.trim();
    if (v("#f-title").length < 2) return toast("행사 이름을 적어주세요.");
    if (!v("#f-sd")) return toast("시작 날짜를 골라주세요.");
    if (!v("#f-place")) return toast("장소 이름을 적어주세요.");
    const c = mini.getCenter();
    if (!ctx.inService(c.lat, c.lng)) return toast("핀이 월계동 밖에 있어요. 지도를 행사 장소로 옮겨주세요.");
    const fd = new FormData();
    [["title", "#f-title"], ["start_date", "#f-sd"], ["start_time", "#f-st"], ["end_date", "#f-ed"], ["end_time", "#f-et"],
     ["place_name", "#f-place"], ["description", "#f-desc"], ["host", "#f-host"], ["fee", "#f-fee"], ["url", "#f-url"], ["contact", "#f-contact"]]
      .forEach(([k, s]) => fd.append(k, v(s)));
    fd.append("category", st.category);
    fd.append("lat", c.lat.toFixed(6));
    fd.append("lng", c.lng.toFixed(6));
    if (st.blob) fd.append("photo", st.blob, "poster.jpg");
    const btn = $("#tp-send");
    st.busy = true; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await api("/api/tips", { method: "POST", form: fd });
      toast("제보를 보냈어요. 확인되면 알림으로 알려드릴게요.", 3500);
      $("#tp-form").reset();
      if (st.url) URL.revokeObjectURL(st.url);
      st.url = null; st.blob = null; $("#tp-ai").innerHTML = ""; photoSlot(); setCat("community");
      loadMine();
      $("#tp-mine").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) { toast(err.message); }
    st.busy = false; btn.disabled = false; btn.textContent = "제보 보내기";
  });

  async function loadMine() {
    const el = $("#tp-mine");
    let rows = [];
    try { rows = await api("/api/tips/mine"); } catch (_) { return; }
    el.innerHTML = `<h2 style="font-size:17px;margin:8px 0 0">내 제보</h2>` + (rows.length ? `<div class="list">${rows.map(t => `
      <div class="item"><div class="grow">
        <div class="row wrap" style="gap:6px;margin-bottom:3px"><span class="chip ${STATUS_CHIP[t.status] || ""}">${esc(t.status_label)}</span><span class="small muted">${ago(t.created_at)}</span></div>
        <div class="t">${esc(t.title)}</div>
        <div class="m">${esc(eventWhen(t))} · ${esc(t.place_name)}</div>
        ${t.status === "approved" ? `<a class="btn sm" href="#/event/${t.id}" style="margin-top:6px">지도에서 보기</a>` : ""}
        ${t.status === "pending" ? `<button class="btn sm ghost danger" type="button" data-cancel="${t.id}" style="margin-top:6px">제보 취소</button>` : ""}
      </div></div>`).join("")}</div>` : `<p class="small muted">아직 제보한 행사가 없어요.</p>`);
    el.querySelectorAll("[data-cancel]").forEach(b => b.addEventListener("click", async () => {
      try { await api(`/api/tips/${b.dataset.cancel}`, { method: "DELETE" }); toast("제보를 취소했어요."); loadMine(); } catch (err) { toast(err.message); }
    }));
  }
  loadMine();

  return () => { if (mini) mini.remove(); if (st.url) URL.revokeObjectURL(st.url); };
}
