// 월계온 관리자 화면
import { api, auth } from "/js/api.js";
import { createMap } from "/js/basemap.js";
import { ago, esc, fmtDate, toast } from "/js/ui.js";

const root = document.getElementById("admin-root");
let base = null;       // 배경지도 데이터
let summary = null;
let tab = "dash";
const maps = [];       // 화면 전환 시 정리할 지도

const TABS = [
  ["dash", "대시보드"], ["events", "행사 승인"], ["paths", "길 제보"],
  ["cons", "공사 구간"], ["data", "지도 데이터"], ["users", "사용자"],
];

function cleanupMaps() { while (maps.length) { try { maps.pop().remove(); } catch (_) {} } }

// 지도를 눌러 위치를 고르는 작은 지도. radius 가 함수면 반경 원도 함께 그림
function pickMap(el, { lat, lng, onPick, radius }) {
  const m = createMap(el, base, { attribution: false, padding: [10, 10] });
  maps.push(m);
  let marker = null, circle = null, cur = null;
  const draw = () => {
    if (marker) m.removeLayer(marker);
    if (circle) m.removeLayer(circle);
    if (!cur) return;
    marker = L.marker(cur, { icon: L.divIcon({ className: "rt-pin", html: `<div class="e"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(m);
    if (radius) circle = L.circle(cur, { radius: radius(), color: "#d97706", dashArray: "5 5", fillOpacity: .12 }).addTo(m);
  };
  if (lat != null && lng != null) { cur = [lat, lng]; draw(); m.setView(cur, 17.5, { animate: false }); }
  m.on("click", e => { cur = [+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)]; draw(); onPick(cur[0], cur[1]); });
  m.redraw = draw;
  return m;
}

// ------------------------------------------------------------------ 로그인
function loginView(msg = "") {
  root.innerHTML = `<div class="login-box card stack">
    <h2 style="font-size:20px">월계온 관리자</h2>
    ${msg ? `<div class="warn">${esc(msg)}</div>` : ""}
    <form class="stack" id="lf">
      <label class="field">아이디<input class="input" id="u" autocomplete="username" required></label>
      <label class="field">비밀번호<input class="input" id="p" type="password" autocomplete="current-password" required></label>
      <button class="btn primary block" type="submit">로그인</button>
    </form>
    <a class="small muted" href="/">앱으로 돌아가기</a></div>`;
  root.querySelector("#lf").addEventListener("submit", async e => {
    e.preventDefault();
    try {
      const r = await api("/api/auth/login", { method: "POST", body: { username: root.querySelector("#u").value.trim(), password: root.querySelector("#p").value } });
      auth.set(r.token, r.user);
      if (!r.user.is_admin) return loginView("관리자 권한이 없는 계정입니다.");
      start();
    } catch (ex) { loginView(ex.message); }
  });
}

// ------------------------------------------------------------------ 뼈대
async function refreshSummary() {
  summary = await api("/api/admin/summary");
  const nav = root.querySelector(".adm-nav");
  if (!nav) return;
  const counts = { events: summary.pending_events, paths: summary.pending_paths };
  nav.querySelectorAll("[data-tab]").forEach(b => {
    const c = counts[b.dataset.tab];
    b.querySelector(".cnt")?.remove();
    if (c) b.insertAdjacentHTML("beforeend", `<span class="cnt">${c}</span>`);
  });
}

function shell() {
  root.innerHTML = `<div class="adm">
    <nav class="adm-nav" aria-label="관리 메뉴">
      <div class="logo"><img class="brand-mark" src="/icons/icon-192.png" alt=""><div><b>월계온</b><small>관리자</small></div></div>
      ${TABS.map(([k, l]) => `<button type="button" data-tab="${k}" ${tab === k ? 'aria-current="page"' : ""}><span>${l}</span></button>`).join("")}
      <div class="foot"><span>${esc(auth.user?.nickname || "")} (@${esc(auth.user?.username || "")})</span><a href="/">앱 열기</a><button type="button" class="btn ghost" id="lo" style="justify-content:flex-start;min-height:0">로그아웃</button></div>
    </nav>
    <main class="adm-main" id="main"></main></div>`;
  root.querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => { tab = b.dataset.tab; location.hash = tab; }));
  root.querySelector("#lo").addEventListener("click", () => { auth.logout(); loginView(); });
}

async function show() {
  cleanupMaps();
  root.querySelectorAll("[data-tab]").forEach(b => b.toggleAttribute("aria-current", b.dataset.tab === tab));
  root.querySelectorAll("[data-tab][aria-current]").forEach(b => b.setAttribute("aria-current", "page"));
  const main = root.querySelector("#main");
  main.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
  try {
    await refreshSummary();
    await ({ dash, events, paths, cons, data, users }[tab] || dash)(main);
  } catch (e) {
    if (e.status === 401 || e.status === 403) return loginView(e.message);
    main.innerHTML = `<div class="warn">${esc(e.message)}</div>`;
  }
}

// ------------------------------------------------------------------ 대시보드
async function dash(main) {
  const s = summary;
  main.innerHTML = `<h1>대시보드</h1><p class="lead">확인할 일을 한눈에 봅니다.</p>
    <div class="stats">
      <div class="stat"><div class="k">승인 대기 행사</div><div class="v">${s.pending_events}</div></div>
      <div class="stat"><div class="k">주민 행사 제보 대기</div><div class="v">${s.pending_tips}</div></div>
      <div class="stat"><div class="k">검토할 길 제보</div><div class="v">${s.pending_paths}</div></div>
      <div class="stat"><div class="k">공개 중인 행사</div><div class="v">${s.approved_events}</div></div>
      <div class="stat"><div class="k">가입자</div><div class="v">${s.users}</div></div>
    </div>
    <div class="stack">
      ${s.pending_events ? `<div class="panel"><div class="panel-h"><h2>승인 대기 행사 한 번에 공개</h2></div>
        <div class="panel-b"><p class="note" style="margin:0">대기 중인 행사 <b>${s.pending_events}</b>건을 한꺼번에 승인합니다. 장소 이름으로 위치를 먼저 찾아 넣고, 월계동 안 행사는 지도·달력에, 나머지는 앱 검색에 나옵니다. 하나씩 확인하려면 '행사 승인' 메뉴를 쓰세요.</p>
        <div class="row wrap" style="margin-top:10px;gap:8px"><select class="input" id="ap-area" style="width:auto"><option value="all">대기 행사 전체</option><option value="in">월계동 안 행사만</option></select>
          <button class="btn sm blue" id="ap-go" type="button">한 번에 승인</button></div><div id="ap-res"></div></div></div>` : ""}
      <div class="panel"><div class="panel-h"><h2>모두에게 알림 보내기</h2></div>
        <div class="panel-b" id="bc-box"><span class="spinner"></span></div></div>
      <div class="panel"><div class="panel-h"><h2>안드로이드 앱 파일 (APK)</h2></div>
        <div class="panel-b"><p class="note" style="margin:0">여기에 APK를 올리면, 웹으로 들어온 안드로이드·PC 사용자에게 <b>앱 내려받기 안내</b>가 뜹니다. 없으면 '홈 화면에 설치' 안내가 대신 뜹니다.</p>
        <div id="apk-st" class="note" style="margin-top:8px"></div>
        <div class="row" style="margin-top:8px;gap:8px"><input type="file" id="apk-file" accept=".apk"><button class="btn sm primary" id="apk-up" type="button">올리기</button><button class="btn sm ghost danger" id="apk-del" type="button">내리기</button></div></div></div>
      ${s.ai_enabled ? `<div class="okbox">AI가 켜져 있습니다 (${esc(s.ai_label)}): 주민 제보 포스터 읽기, 광운대 공지·구청 PDF 행사 추출에 쓰입니다.</div>` : `<div class="warn">AI가 꺼져 있습니다. 서버 환경변수 <b>GEMINI_API_KEY</b>(무료)를 설정하면 포스터 자동 읽기와 구청 PDF 행사 추출이 켜집니다.</div>`}
      ${s.seoul_sample_key ? `<div class="warn">서울시 문화행사 API가 샘플 키로 동작 중이라 5건만 받아옵니다. 서울 열린데이터광장에서 인증키를 받아 <b>SEOUL_API_KEY</b>에 넣어주세요.</div>` : ""}
      <div class="panel"><div class="panel-h"><h2>행사 자동 수집</h2><button class="btn sm primary" id="collect" type="button">지금 수집</button></div>
        <div class="panel-b"><p class="note" style="margin:0">서울시 문화행사(노원구·월계1동 반경)와 광운대 공지사항에서 행사를 모아 승인 대기열에 넣습니다. 서버가 켜져 있으면 몇 시간마다 자동으로 실행됩니다.</p>
        <div id="job"></div>
        <table class="tbl"><thead><tr><th>출처</th><th>실행 시각</th><th>찾음</th><th>새로 추가</th><th>오류</th></tr></thead><tbody>
        ${s.collect_logs.length ? s.collect_logs.map(l => `<tr><td>${{ seoul: "서울시", kw: "광운대" }[l.source] || l.source}</td><td>${fmtDate(l.at)}</td><td>${l.found}</td><td>${l.added}</td><td class="small" style="color:#dc2626">${esc(l.error || "")}</td></tr>`).join("") : `<tr><td colspan="5" class="muted">아직 수집 기록이 없습니다.</td></tr>`}
        </tbody></table></div></div>
      ${s.ai_enabled ? `<div class="panel"><div class="panel-h"><h2>AI로 행사 빈칸 채우기</h2><select class="input" id="aifill-st" style="width:auto"><option value="pending">승인 대기</option><option value="approved">공개 중</option><option value="all">전체</option></select><button class="btn sm primary" id="aifill" type="button">실행</button></div>
        <div class="panel-b"><p class="note" style="margin:0">소개·끝나는 날·장소·주최·요금이 비어 있는 행사를 골라, 원문 링크를 읽고 빈칸만 채웁니다(한 번에 20개). 원문에 없는 날짜·장소는 채우지 않고, 원문이 없으면 소개만 정리합니다. 새로 수집된 행사는 자동으로 채워집니다.</p><div id="aifill-job"></div></div></div>` : ""}
      <div class="panel"><div class="panel-h"><h2>행사 위치 찾기 · 검색 키워드</h2></div>
        <div class="panel-b"><p class="note" style="margin:0">지도·달력에는 <b>월계동 안</b> 행사만 나오고, 밖이거나 위치가 없는 행사는 앱의 <b>검색</b>에서만 보입니다. 위치 없는 행사 <b>${s.no_location}</b>건 · 검색 키워드가 붙은 행사 <b>${s.tagged_events}</b>건</p>
        <div class="row wrap" style="margin-top:10px;gap:8px"><button class="btn sm primary" id="loc-go" type="button">장소 이름으로 위치 찾기</button><span class="note">'월계도서관 4층' → 월계문화정보도서관처럼 지도에 이름이 있는 곳을 찾아 위치를 넣습니다.</span></div>
        <div id="loc-res"></div>
        ${s.ai_enabled ? `<div class="row wrap" style="margin-top:10px;gap:8px"><button class="btn sm" id="tag-go" type="button">AI 검색 키워드 만들기</button><span class="note">행사마다 '가족, 야외, 그림책'처럼 이름에 없는 연관 키워드를 붙여 검색이 더 잘 되게 합니다 (한 번에 120개).</span></div><div id="tag-job"></div>` : `<p class="note">AI 키가 없어도 연관어 사전으로 검색은 동작합니다.</p>`}</div></div>
      <div class="panel"><div class="panel-h"><h2>구청 행사 자료 올리기</h2></div>
        <div class="panel-b"><p class="note" style="margin:0">노원구청 '주요행사계획' PDF를 올리면 AI가 주민 대상 행사를 뽑아 <b>승인 대기</b>로 넣습니다 (1~3분). 정리된 JSON 파일은 바로 <b>승인</b>됩니다. 이미 등록된 행사는 다시 넣지 않습니다.</p>
        <div class="row" style="margin-top:8px"><input type="file" id="off-file" accept=".pdf,.json,application/pdf,application/json"><button class="btn sm primary" id="off-up" type="button">올리기</button></div><div id="off-res"></div>
        <div class="row" style="margin-top:10px;gap:8px"><button class="btn sm" id="off-re" type="button">노원구 9월 자료 다시 넣기</button><span class="note">초기화한 뒤 앱에 함께 들어 있는 구청 자료(80건)를 다시 등록합니다. 이미 있는 행사는 건너뜁니다.</span></div></div></div>
      <div class="panel danger-zone"><div class="panel-h"><h2>행사 초기화</h2></div>
        <div class="panel-b"><p class="note" style="margin:0">고른 범위의 행사를 한꺼번에 지웁니다. 그 행사의 즐겨찾기·후기(사진·영상 포함)·제보 포스터·알림도 함께 지워지며 <b>되돌릴 수 없습니다.</b> 사용자 계정, 길 제보, 공사 구간, 지도 데이터는 그대로입니다.</p>
        <div class="row wrap" style="margin-top:10px;gap:8px">
          <select class="input" id="rs-scope" style="width:auto"><option value="all">모든 행사</option><option value="collected">자동 수집·구청 자료만 (직접 등록·주민 제보는 남김)</option><option value="pending">승인 대기만</option></select>
          <input class="input" id="rs-confirm" placeholder="'초기화'라고 입력" style="width:170px">
          <button class="btn sm danger-btn" id="rs-go" type="button">초기화</button></div><div id="rs-res"></div></div></div>
    </div>`;
  main.querySelector("#collect").addEventListener("click", () => runJob("/api/admin/collect", "collect", main.querySelector("#job"), () => show()));
  main.querySelector("#aifill")?.addEventListener("click", () => runJob(`/api/admin/ai-fill?status=${main.querySelector("#aifill-st").value}`, "aifill", main.querySelector("#aifill-job")));
  broadcastPanel(main.querySelector("#bc-box"));
  const apkSt = async () => {
    try { const r = await api("/api/app/apk"); main.querySelector("#apk-st").innerHTML = r.available ? `올라와 있음: <b>${r.size_mb}MB</b> · ${new Date(r.updated * 1000).toLocaleString("ko-KR")} · <a href="${r.url}">내려받기 확인</a>` : "아직 올린 APK가 없습니다."; } catch (_) {}
  };
  apkSt();
  main.querySelector("#apk-up").addEventListener("click", async () => {
    const f = main.querySelector("#apk-file").files[0];
    if (!f) return toast("APK 파일을 골라주세요.");
    const fd = new FormData(); fd.append("file", f);
    main.querySelector("#apk-st").innerHTML = `<span class="spinner"></span> 올리는 중…`;
    try { const r = await api("/api/admin/app/apk", { method: "POST", form: fd }); toast(`APK를 올렸습니다 (${r.size_mb}MB).`); } catch (ex) { toast(ex.message); }
    apkSt();
  });
  main.querySelector("#apk-del").addEventListener("click", async () => {
    if (!confirm("올린 APK를 내릴까요? 웹 사용자에게 내려받기 안내가 더 이상 뜨지 않습니다.")) return;
    try { await api("/api/admin/app/apk", { method: "DELETE" }); toast("APK를 내렸습니다."); } catch (ex) { toast(ex.message); }
    apkSt();
  });
  main.querySelector("#ap-go")?.addEventListener("click", () => approveAll(main.querySelector("#ap-area").value));
  main.querySelector("#loc-go").addEventListener("click", async () => {
    try {
      const r = await api("/api/admin/events/locate", { method: "POST" });
      main.querySelector("#loc-res").innerHTML = `<div class="okbox">위치 없는 행사 ${r.checked}건 중 ${r.found}건의 위치를 찾았습니다 (월계동 안 ${r.inside}건).</div>`;
      summary = await api("/api/admin/summary");
    } catch (ex) { toast(ex.message); }
  });
  main.querySelector("#tag-go")?.addEventListener("click", () => runJob("/api/admin/search-tags", "tags", main.querySelector("#tag-job")));
  main.querySelector("#off-re").addEventListener("click", async () => {
    try { const r = await api("/api/admin/official/reimport", { method: "POST" }); toast(`구청 자료 ${r.added}건을 다시 넣었습니다.`); summary = await api("/api/admin/summary"); }
    catch (ex) { toast(ex.message); }
  });
  main.querySelector("#rs-go").addEventListener("click", async () => {
    const scope = main.querySelector("#rs-scope").value, confirmText = main.querySelector("#rs-confirm").value.trim();
    if (confirmText !== "초기화") return toast("확인 칸에 '초기화'라고 적어주세요.");
    if (!confirm("정말 지울까요? 되돌릴 수 없습니다.")) return;
    try {
      const r = await api("/api/admin/events/reset", { method: "POST", body: { scope, confirm: confirmText } });
      main.querySelector("#rs-res").innerHTML = `<div class="okbox">${esc(r.scope)} ${r.deleted}건을 지웠습니다 (후기 ${r.reviews}개 포함). 다시 채우려면 위의 "지금 수집"이나 구청 자료 올리기를 쓰세요.</div>`;
      main.querySelector("#rs-confirm").value = "";
    } catch (ex) { toast(ex.message); }
  });
  main.querySelector("#off-up").addEventListener("click", async () => {
    const f = main.querySelector("#off-file").files[0], out = main.querySelector("#off-res");
    if (!f) return toast("파일을 골라주세요.");
    const fd = new FormData(); fd.append("file", f);
    out.innerHTML = `<span class="spinner"></span>`;
    try {
      const r = await api("/api/admin/official/upload", { method: "POST", form: fd });
      if (r.running !== undefined) {   // PDF → 백그라운드 AI 작업
        const tick = async () => {
          const j = await api("/api/admin/jobs/official");
          if (j.running) { out.innerHTML = `<div class="row"><span class="spinner"></span><span>AI가 문서를 읽는 중… (1~3분)</span></div>`; return setTimeout(tick, 2500); }
          const x = j.result || {};
          out.innerHTML = x.ok ? `<div class="okbox">${esc(x.title || "")}: ${x.found}건 중 새 행사 ${x.added}건을 승인 대기로 넣었습니다.</div>` : `<div class="warn">${esc(x.error || "실패")}</div>`;
        };
        tick();
      } else {
        out.innerHTML = `<div class="okbox">${esc(r.title || "")}: 새 행사 ${r.added}건 등록 (이미 있던 ${r.skipped}건은 건너뜀)</div>`;
      }
    } catch (ex) { out.innerHTML = `<div class="warn">${esc(ex.message)}</div>`; }
  });
}

// ------------------------------------------------------------------ 모두에게 알림
let bcMode = "event";
async function broadcastPanel(box) {
  let meta;
  try { meta = await api("/api/admin/broadcast/meta"); } catch (ex) { box.innerHTML = `<div class="warn">${esc(ex.message)}</div>`; return; }
  const evOpt = meta.events.map(e => `<option value="${e.id}">${e.in_area ? "" : "[월계동 밖] "}${fmtDate(e.start_at)} · ${esc(e.title)}</option>`).join("");
  box.innerHTML = `<p class="note" style="margin:0 0 10px">가입자 <b>${meta.users}</b>명의 앱 알림함에 들어가고, 안드로이드 앱을 설치한 휴대폰에는 15분 안에 알림으로 뜹니다(로그인 안 한 앱 사용자 포함 — 즐겨찾기 알림 제외).</p>
    <div class="seg" id="bc-mode" style="max-width:520px">${[["favorites", "즐겨찾기 행사 알림"], ["event", "행사 추천"], ["custom", "직접 쓰기"]].map(([k, l]) => `<button type="button" data-m="${k}" aria-pressed="${bcMode === k}">${l}</button>`).join("")}</div>
    <div id="bc-form" class="stack" style="margin-top:10px"></div>
    <div class="row" style="margin-top:10px;gap:8px"><button class="btn sm blue" id="bc-send" type="button">보내기</button><span class="note" id="bc-res"></span></div>
    ${meta.recent.length ? `<h3 style="font-size:13px;margin:14px 0 6px">최근 보낸 알림</h3><table class="tbl"><tbody>${meta.recent.map(b => `<tr><td class="small" style="white-space:nowrap">${fmtDate(b.at)}</td><td>${{ event: "추천", custom: "직접" }[b.kind] || b.kind}</td><td><b>${esc(b.title)}</b>${b.body ? `<div class="small muted">${esc(b.body)}</div>` : ""}</td><td class="small">${b.sent}명</td></tr>`).join("")}</tbody></table>` : ""}`;
  const form = box.querySelector("#bc-form");
  const draw = () => {
    if (bcMode === "favorites") {
      form.innerHTML = `<div class="grid2"><label class="field">몇 시간 안에 시작하는 행사<input class="input" id="bc-h" type="number" min="1" max="72" value="3"></label><span></span></div>
        <label class="field">문구 ({title} = 행사 이름, {n} = 남은 시간)<input class="input" id="bc-tpl" value="즐겨찾기한 '{title}' 행사가 {n}시간 뒤에 시작합니다"></label>
        <p class="note" style="margin:0">그 시간 안에 시작하는 행사를 즐겨찾기한 사람에게만 보냅니다.</p>`;
    } else if (bcMode === "event") {
      form.innerHTML = meta.events.length ? `<label class="field">추천할 행사 (30일 안)<select class="input" id="bc-ev">${evOpt}</select></label>
        <label class="field">제목<input class="input" id="bc-t"></label><label class="field">내용<input class="input" id="bc-b"></label>
        <p class="note" style="margin:0">알림을 누르면 그 행사 화면이 열립니다. 문구는 고쳐서 보낼 수 있어요.</p>` : `<div class="warn">30일 안에 열리는 공개 행사가 없습니다.</div>`;
      const fill = () => { const e = meta.events.find(x => x.id == form.querySelector("#bc-ev").value); if (e) { form.querySelector("#bc-t").value = e.msg_title; form.querySelector("#bc-b").value = e.msg_body; } };
      form.querySelector("#bc-ev")?.addEventListener("change", fill); if (meta.events.length) fill();
    } else {
      form.innerHTML = `<label class="field">제목<input class="input" id="bc-t" maxlength="200" placeholder="예: 이번 주말 월계동 축제 안내"></label>
        <label class="field">내용<textarea class="input" id="bc-b" rows="3" maxlength="1000"></textarea></label>
        <label class="field">누르면 열 화면 (선택)<input class="input" id="bc-l" placeholder="#/news 또는 #/event/12"></label>`;
    }
  };
  draw();
  box.querySelectorAll("#bc-mode [data-m]").forEach(b => b.addEventListener("click", () => {
    bcMode = b.dataset.m; box.querySelectorAll("#bc-mode [data-m]").forEach(x => x.setAttribute("aria-pressed", x === b)); draw();
  }));
  box.querySelector("#bc-send").addEventListener("click", async () => {
    const v = id => form.querySelector(id)?.value?.trim() || "";
    const body = { mode: bcMode };
    if (bcMode === "favorites") Object.assign(body, { hours: +v("#bc-h") || 3, template: v("#bc-tpl") });
    else if (bcMode === "event") Object.assign(body, { event_id: +v("#bc-ev"), title: v("#bc-t"), body: v("#bc-b") });
    else Object.assign(body, { title: v("#bc-t"), body: v("#bc-b"), link: v("#bc-l") });
    if (bcMode !== "favorites" && !body.title) return toast("제목을 입력해주세요.");
    if (!confirm(bcMode === "favorites" ? "즐겨찾기한 사람들에게 알림을 보낼까요?" : `모든 사용자에게 '${body.title}' 알림을 보낼까요?`)) return;
    try { const r = await api("/api/admin/broadcast", { method: "POST", body }); toast(r.message, 4000); broadcastPanel(box); }
    catch (ex) { toast(ex.message); }
  });
}

async function approveAll(area) {
  const n = summary.pending_events;
  if (!confirm(area === "in" ? "월계동 안의 승인 대기 행사를 모두 공개할까요?" : `승인 대기 행사 ${n}건을 모두 공개할까요?`)) return;
  try {
    const r = await api("/api/admin/events/approve-pending", { method: "POST", body: { area } });
    toast(`${r.approved}건을 승인했습니다 (월계동 안 ${r.inside}건 · 나머지는 앱 검색에서만 보여요).`, 4500);
    await refreshSummary();
    show();
  } catch (ex) { toast(ex.message); }
}

async function runJob(url, name, el, done) {
  try { await api(url, { method: "POST" }); } catch (e) { toast(e.message); if (e.status !== 409) return; }
  el.innerHTML = `<div class="row"><span class="spinner"></span><span>실행 중… 창을 닫아도 서버에서 계속 진행됩니다.</span></div>`;
  const tick = async () => {
    const j = await api(`/api/admin/jobs/${name}`);
    if (j.running) return setTimeout(tick, 2000);
    el.innerHTML = `<pre class="log">${esc(JSON.stringify(j.result, null, 2))}</pre>`;
    toast("완료했습니다.");
    done && setTimeout(done, 1500);
  };
  setTimeout(tick, 1500);
}

// ------------------------------------------------------------------ 행사
let evFilter = "pending", evArea = "all";
const AREA_TXT = e => e.in_area ? `<span class="chip resolved">월계동 안</span>` : e.lat == null ? `<span class="chip pending">위치 없음 · 검색만</span>` : `<span class="chip pending">월계동 밖 · 검색만</span>`;
async function events(main) {
  const cats = summary.meta.event_categories;
  const rows = await api((evFilter === "tips" ? "/api/admin/events?status=pending&source=tip" : `/api/admin/events?status=${evFilter}`) + `&area=${evArea}`);
  main.innerHTML = `<h1>행사 승인</h1><p class="lead">자동 수집된 행사와 주민이 제보한 행사를 확인해 승인하거나, 직접 등록합니다. 승인된 행사만 앱에 보이고, 해당 분류 알림을 켠 주민에게 알림이 갑니다.</p>
    <div class="split">
      <div class="panel"><div class="panel-h">
        <select class="input" id="ev-f" style="width:auto">${[["pending", "승인 대기"], ["tips", "주민 제보 대기"], ["approved", "승인됨"], ["rejected", "반려"], ["all", "전체"]].map(([k, l]) => `<option value="${k}" ${evFilter === k ? "selected" : ""}>${l}</option>`).join("")}</select>
        <select class="input" id="ev-area" style="width:auto">${[["all", "모든 지역"], ["in", "월계동 안"], ["out", "월계동 밖·위치 없음"]].map(([k, l]) => `<option value="${k}" ${evArea === k ? "selected" : ""}>${l}</option>`).join("")}</select>
        <span class="grow"></span>${evFilter === "pending" && evArea !== "out" && rows.length ? `<button class="btn sm blue" id="ev-all" type="button">대기 ${evArea === "in" ? "(월계동 안) " : ""}전체 승인</button>` : ""}<button class="btn sm primary" id="ev-new" type="button">새 행사 등록</button></div>
        ${rows.length ? `<div class="bulkbar"><label><input type="checkbox" id="ck-all"> 전체 선택</label><span class="grow note" id="ck-n">0개 선택</span>
          <button class="btn sm blue" type="button" data-bulk="approved">선택 승인</button><button class="btn sm" type="button" data-bulk="rejected">선택 반려</button></div>` : ""}
        <div class="rows">${rows.length ? rows.map(e => `<div class="rowc"><input type="checkbox" class="ck" value="${e.id}" aria-label="선택"><button class="rowi" type="button" data-id="${e.id}"><div class="grow">
          <div class="row wrap" style="gap:6px"><span class="chip ${e.category}">${esc(e.category_label)}</span><span class="chip ${e.status === "approved" ? "resolved" : e.status}">${{ pending: "대기", approved: "승인", rejected: "반려" }[e.status]}</span>${AREA_TXT(e)}<span class="small muted">${{ seoul: "서울시", kw: "광운대", manual: "직접", nowon: "노원구청", tip: "주민 제보" }[e.source] || e.source}</span></div>
          <div class="t">${esc(e.title)}</div><div class="m">${e.start_at ? fmtDate(e.start_at) : "날짜 확인 필요"} · ${esc(e.place_name || "장소 확인 필요")}</div></div></button></div>`).join("") : `<div class="empty">해당하는 행사가 없습니다.</div>`}</div>
      </div>
      <div class="panel" id="ev-edit"><div class="empty">왼쪽에서 행사를 고르거나 새로 등록하세요.</div></div>
    </div>`;
  main.querySelector("#ev-f").addEventListener("change", e => { evFilter = e.target.value; show(); });
  main.querySelector("#ev-all")?.addEventListener("click", () => approveAll(evArea === "in" ? "in" : "all"));
  main.querySelector("#ev-area").addEventListener("change", e => { evArea = e.target.value; show(); });
  const cks = [...main.querySelectorAll(".ck")], nEl = main.querySelector("#ck-n");
  const upd = () => { if (nEl) nEl.textContent = `${cks.filter(c => c.checked).length}개 선택`; };
  cks.forEach(c => c.addEventListener("change", upd));
  main.querySelector("#ck-all")?.addEventListener("change", e => { cks.forEach(c => { c.checked = e.target.checked; }); upd(); });
  main.querySelectorAll("[data-bulk]").forEach(b => b.addEventListener("click", async () => {
    const ids = cks.filter(c => c.checked).map(c => +c.value);
    if (!ids.length) return toast("행사를 먼저 골라주세요.");
    const st = b.dataset.bulk;
    if (!confirm(`${ids.length}개 행사를 ${st === "approved" ? "승인(공개)" : "반려"}할까요?`)) return;
    try { const r = await api("/api/admin/events/bulk", { method: "POST", body: { ids, status: st } }); toast(`${r.changed}개를 ${st === "approved" ? "승인" : "반려"}했습니다.`); summary = await api("/api/admin/summary"); show(); }
    catch (ex) { toast(ex.message); }
  }));
  main.querySelector("#ev-new").addEventListener("click", () => evForm(main, null, cats));
  main.querySelectorAll(".rowi").forEach(b => b.addEventListener("click", () => {
    main.querySelectorAll(".rowi").forEach(x => x.classList.toggle("sel", x === b));
    evForm(main, rows.find(r => r.id == b.dataset.id), cats);
  }));
}

function evForm(main, e, cats) {
  cleanupMaps();
  const v = e || { title: "", category: "community", start_at: "", end_at: "", time_text: "", place_name: "", lat: null, lng: null, description: "", host: "", contact: "", fee: "", url: "", image_url: "", status: "new" };
  const box = main.querySelector("#ev-edit");
  box.innerHTML = `<div class="panel-h"><h2>${e ? "행사 편집" : "새 행사 등록"}</h2>${/^https?:\/\//i.test(e?.url || "") ? `<a class="btn sm" href="${esc(e.url)}" target="_blank" rel="noopener">원문</a>` : ""}</div>
    <div class="panel-b">
      ${e?.ai_note ? `<div class="note">${esc(e.ai_note)}</div>` : ""}
      ${e?.source === "tip" ? `<div class="okbox">주민이 제보한 행사입니다. 승인하거나 반려하면 제보자에게 앱 알림이 갑니다.</div>` : ""}
      ${e?.poster_admin_url ? `<img src="${esc(e.poster_admin_url)}" alt="제보 포스터" style="width:100%;max-height:420px;object-fit:contain;background:#f2f4f7;border-radius:12px">` : ""}
      <label class="field">행사 이름<input class="input" id="f-title" value="${esc(v.title)}"></label>
      <div class="grid2">
        <label class="field">분류<select class="input" id="f-cat">${Object.entries(cats).map(([k, l]) => `<option value="${k}" ${v.category === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="field">주최<input class="input" id="f-host" value="${esc(v.host)}"></label>
        <label class="field">시작<input class="input" id="f-start" type="datetime-local" value="${esc(v.start_at || "")}"></label>
        <label class="field">끝<input class="input" id="f-end" type="datetime-local" value="${esc(v.end_at || "")}"></label>
      </div>
      ${!v.start_at ? `<div class="warn">시작 날짜가 비어 있습니다. 원문을 확인해 채워주세요.${e?.source === "kw" ? ` <button class="btn sm" id="f-reread" type="button">공지에서 다시 읽기</button>` : ""}</div>` : ""}
      <label class="field">일시 설명 (선택)<input class="input" id="f-tt" value="${esc(v.time_text)}" placeholder="예: 매주 토요일 14:00~16:00"></label>
      <label class="field">장소 이름<input class="input" id="f-place" value="${esc(v.place_name)}"></label>
      <div class="field">지도 위치 <span class="note">(지도를 눌러 정확한 위치를 찍어주세요)</span><div class="pickmap" id="f-map"></div><span class="note" id="f-ll">${v.lat != null ? `${v.lat}, ${v.lng}${e && !e.in_area ? " (월계동 밖 — 앱에서는 검색으로만 보입니다)" : ""}` : "위치 없음 — 승인하면 지도·달력에는 안 나오고 검색에서만 보입니다"}</span></div>
      <label class="field">소개<textarea class="input" id="f-desc" rows="5">${esc(v.description)}</textarea></label>
      <div class="grid2">
        <label class="field">요금<input class="input" id="f-fee" value="${esc(v.fee)}"></label>
        <label class="field">문의<input class="input" id="f-contact" value="${esc(v.contact)}"></label>
        <label class="field">원문 링크<input class="input" id="f-url" value="${esc(v.url)}"></label>
        <label class="field">이미지 주소<input class="input" id="f-img" value="${esc(v.image_url)}"></label>
      </div>
      ${e && summary.ai_enabled ? `<div class="row" style="gap:8px"><button class="btn" id="f-ai" type="button">✦ AI로 빈칸 채우기</button><span class="note">원문 링크를 읽고 비어 있는 칸만 채웁니다. 확인 후 저장하세요.</span></div>` : ""}
      <div class="row wrap">
        ${e ? `<button class="btn" id="f-save" type="button">저장만</button>` : ""}
        <button class="btn blue" id="f-approve" type="button">${e ? (e.status === "approved" ? "저장 (공개 중)" : "승인하고 공개") : "등록하고 공개"}</button>
        ${e && e.status !== "rejected" ? `<button class="btn" id="f-reject" type="button">반려</button>` : ""}
        ${e ? `<button class="btn ghost danger" id="f-del" type="button">삭제</button>` : ""}
      </div>
    </div>`;
  const pos = { lat: v.lat, lng: v.lng };
  pickMap(box.querySelector("#f-map"), { lat: v.lat, lng: v.lng, onPick: (la, ln) => { pos.lat = la; pos.lng = ln; box.querySelector("#f-ll").textContent = `${la}, ${ln}`; } });
  const g = id => box.querySelector(id).value.trim();
  const payload = status => ({
    title: g("#f-title"), category: g("#f-cat"), host: g("#f-host"), start_at: g("#f-start") || null, end_at: g("#f-end") || null,
    time_text: g("#f-tt"), place_name: g("#f-place"), lat: pos.lat, lng: pos.lng, description: box.querySelector("#f-desc").value,
    fee: g("#f-fee"), contact: g("#f-contact"), url: g("#f-url"), image_url: g("#f-img"), ...(status ? { status } : {}),
  });
  box.querySelector("#f-reread")?.addEventListener("click", async ev2 => {
    const b = ev2.currentTarget; b.disabled = true; b.textContent = "읽는 중…";
    try {
      const r = await api(`/api/admin/events/${e.id}/reextract`, { method: "POST" });
      const n = Object.keys(r.changed).length;
      toast(n ? `${n}개 항목을 채웠습니다.` : "공지에서도 날짜를 찾지 못했습니다. 원문을 보고 직접 입력해주세요.");
      evForm(main, r.event, cats);
    } catch (ex) { toast(ex.message); b.disabled = false; b.textContent = "공지에서 다시 읽기"; }
  });
  box.querySelector("#f-ai")?.addEventListener("click", async ev2 => {
    const b = ev2.currentTarget; b.disabled = true; b.textContent = "AI가 읽는 중…";
    try {
      const r = await api(`/api/admin/events/${e.id}/ai-fill`, { method: "POST" });
      const sug = r.suggestions || {};
      const map = { description: "#f-desc", start_at: "#f-start", end_at: "#f-end", time_text: "#f-tt", place_name: "#f-place", host: "#f-host", fee: "#f-fee" };
      let n = 0;
      for (const [k, sel] of Object.entries(map)) {
        const el = box.querySelector(sel);
        if (sug[k] && el && !el.value.trim()) { el.value = sug[k]; el.classList.add("ai-filled"); n++; }
      }
      toast(n ? `${n}개 칸을 채웠습니다. 노란 칸을 확인하고 저장하세요.` : (r.message || "채울 수 있는 칸을 찾지 못했습니다."));
    } catch (ex) { toast(ex.message); }
    b.disabled = false; b.textContent = "✦ AI로 빈칸 채우기";
  });
  const save = async status => {
    if (!g("#f-title")) return toast("행사 이름을 입력해주세요.");
    if ((status === "approved" || !e) && !g("#f-start") &&
        !confirm("시작 날짜 없이 공개하면 앱에 '일정 미정'으로 표시되고, 등록 45일 뒤 목록에서 빠집니다. 그래도 공개할까요?")) return;
    try {
      if (e) await api(`/api/admin/events/${e.id}`, { method: "PATCH", body: payload(status) });
      else await api("/api/admin/events", { method: "POST", body: payload("approved") });
      toast(status === "approved" || !e ? "공개했습니다." : status === "rejected" ? "반려했습니다." : "저장했습니다.");
      show();
    } catch (ex) { toast(ex.message); }
  };
  box.querySelector("#f-save")?.addEventListener("click", () => save(null));
  box.querySelector("#f-approve").addEventListener("click", () => save("approved"));
  box.querySelector("#f-reject")?.addEventListener("click", () => save("rejected"));
  box.querySelector("#f-del")?.addEventListener("click", async () => {
    if (!confirm("행사를 완전히 삭제할까요? 후기와 즐겨찾기도 지워집니다.")) return;
    try { await api(`/api/admin/events/${e.id}`, { method: "DELETE" }); toast("삭제했습니다."); show(); } catch (ex) { toast(ex.message); }
  });
}

// ------------------------------------------------------------------ 길 제보
let pFilter = "pending";
const PCOLOR = { add: "#2563eb", gate: "#7c3aed", block: "#dc2626", stairs: "#92400e", steep: "#b45309" };
async function paths(main) {
  const rows = await api(`/api/admin/paths?status=${pFilter}`);
  main.innerHTML = `<h1>길 제보</h1><p class="lead">주민이 알려준 새 길·쪽문·막힌 길·계단·가파른 길입니다. 승인하면 바로 길찾기에 반영됩니다. 관리자가 앱의 "길 정보 제보"로 직접 그리면 곧바로 반영됩니다.</p>
    <div class="split">
      <div class="panel"><div class="panel-h"><select class="input" id="p-f" style="width:auto">${[["pending", "검토 대기"], ["approved", "반영됨"], ["rejected", "반려"], ["all", "전체"]].map(([k, l]) => `<option value="${k}" ${pFilter === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="rows">${rows.length ? rows.map(p => `<button class="rowi" type="button" data-id="${p.id}"><div class="grow">
          <div class="row" style="gap:6px"><span class="chip" style="color:${PCOLOR[p.kind]}">${esc(p.kind_label)}</span><span class="small muted">${ago(p.created_at)}</span></div>
          <div class="m">${p.strokes ? "칠한 범위 · " : ""}${esc(p.note || "메모 없음")}${p.open_hours ? ` · 통행 ${esc(p.open_hours)}` : ""}</div></div></button>`).join("") : `<div class="empty">해당하는 제보가 없습니다.</div>`}</div></div>
      <div class="panel" id="p-edit"><div class="panel-b"><div class="pickmap" id="p-map" style="height:520px"></div></div></div>
    </div>`;
  main.querySelector("#p-f").addEventListener("change", e => { pFilter = e.target.value; show(); });
  const m = createMap(main.querySelector("#p-map"), base, { attribution: false });
  maps.push(m);
  const shapes = {};
  rows.forEach(p => {
    // 칠하기 제보(계단·가파른 길)는 굵은 반투명 선으로
    const shape = p.strokes && p.strokes.length
      ? L.featureGroup(p.strokes.map(s => L.polyline(s.length > 1 ? s : [s[0], s[0]], { color: PCOLOR[p.kind], weight: 14, opacity: .45, lineCap: "round" })))
      : p.coords.length > 1 ? L.polyline(p.coords, { color: PCOLOR[p.kind], weight: 5, dashArray: "8 6" }) : L.circleMarker(p.coords[0], { radius: 8, color: PCOLOR[p.kind] });
    shape.addTo(m); shapes[p.id] = shape;
  });
  main.querySelectorAll(".rowi").forEach(b => b.addEventListener("click", () => {
    main.querySelectorAll(".rowi").forEach(x => x.classList.toggle("sel", x === b));
    const p = rows.find(x => x.id == b.dataset.id);
    const sh = shapes[p.id];
    m.fitBounds(sh.getBounds ? sh.getBounds().pad(2) : L.latLngBounds([sh.getLatLng()]).pad(0.002), { maxZoom: 18.5 });
    const html = `<b>${esc(p.kind_label)}</b><br>${esc(p.note || "")}${p.open_hours ? `<br>통행 ${esc(p.open_hours)}` : ""}<br>
      <div class="row" style="margin-top:8px;gap:6px">${p.status !== "approved" ? `<button class="btn sm blue" data-a="approved">반영</button>` : ""}${p.status !== "rejected" ? `<button class="btn sm" data-a="rejected">반려</button>` : ""}<button class="btn sm ghost danger" data-a="delete">삭제</button></div>`;
    const pop = L.popup({ minWidth: 220 }).setLatLng(sh.getBounds ? sh.getBounds().getCenter() : sh.getLatLng()).setContent(html).openOn(m);
    pop.getElement().querySelectorAll("[data-a]").forEach(x => x.addEventListener("click", async () => {
      try {
        if (x.dataset.a === "delete") { if (!confirm("제보를 삭제할까요?")) return; await api(`/api/admin/paths/${p.id}`, { method: "DELETE" }); }
        else await api(`/api/admin/paths/${p.id}`, { method: "PATCH", body: { status: x.dataset.a } });
        toast("처리했습니다."); show();
      } catch (ex) { toast(ex.message); }
    }));
  }));
}

// ------------------------------------------------------------------ 공사 구간
async function cons(main) {
  const rows = await api("/api/admin/constructions");
  main.innerHTML = `<h1>공사 구간</h1><p class="lead">등록한 구간은 지도에 표시되고, 길찾기에서 "공사 구간을 지나요 → 피해서 가기"로 안내됩니다. 기간이 끝나면 자동으로 사라집니다.</p>
    <div class="split">
      <div class="panel"><div class="panel-h"><h2>목록</h2><button class="btn sm primary" id="c-new" type="button">새 공사 구간</button></div>
        <div class="rows">${rows.length ? rows.map(c => `<button class="rowi" type="button" data-id="${c.id}"><div class="grow">
          <div class="row" style="gap:6px"><span class="chip ${c.active ? "received" : "rejected"}">${c.active ? "표시 중" : "숨김"}</span>${c.dust ? `<span class="chip">먼지</span>` : ""}</div>
          <div class="t">${esc(c.title)}</div><div class="m">${c.start_date ? fmtDate(c.start_date, false) : "시작일 없음"} ~ ${c.end_date ? fmtDate(c.end_date, false) : "종료일 없음"} · 반경 ${Math.round(c.radius_m)}m</div></div></button>`).join("") : `<div class="empty">등록된 공사 구간이 없습니다.</div>`}</div></div>
      <div class="panel" id="c-edit"><div class="empty">목록에서 고르거나 새로 등록하세요.</div></div>
    </div>`;
  main.querySelector("#c-new").addEventListener("click", () => consForm(main, null));
  main.querySelectorAll(".rowi").forEach(b => b.addEventListener("click", () => {
    main.querySelectorAll(".rowi").forEach(x => x.classList.toggle("sel", x === b));
    consForm(main, rows.find(x => x.id == b.dataset.id));
  }));
}

function consForm(main, c) {
  cleanupMaps();
  const v = c || { title: "", lat: null, lng: null, radius_m: 40, start_date: "", end_date: "", dust: true, note: "", active: true };
  const box = main.querySelector("#c-edit");
  const d = s => (s || "").slice(0, 10);
  box.innerHTML = `<div class="panel-h"><h2>${c ? "공사 구간 편집" : "새 공사 구간"}</h2></div><div class="panel-b">
    <label class="field">이름<input class="input" id="c-title" value="${esc(v.title)}" placeholder="예: 광운로 하수관 교체 공사"></label>
    <div class="field">위치 <span class="note">(지도를 눌러 가운데를 찍으세요)</span><div class="pickmap" id="c-map"></div></div>
    <div class="grid2">
      <label class="field">반경 (m)<input class="input" id="c-r" type="number" min="5" max="300" value="${Math.round(v.radius_m)}"></label>
      <label class="field">먼지·소음<select class="input" id="c-dust"><option value="1" ${v.dust ? "selected" : ""}>있음</option><option value="0" ${!v.dust ? "selected" : ""}>없음</option></select></label>
      <label class="field">시작일<input class="input" id="c-s" type="date" value="${d(v.start_date)}"></label>
      <label class="field">종료일<input class="input" id="c-e" type="date" value="${d(v.end_date)}"></label>
    </div>
    <label class="field">안내 문구<textarea class="input" id="c-note" rows="2">${esc(v.note)}</textarea></label>
    <label class="row small"><input type="checkbox" id="c-act" ${v.active ? "checked" : ""}> 지도에 표시</label>
    <div class="row"><button class="btn primary" id="c-save" type="button">저장</button>${c ? `<button class="btn ghost danger" id="c-del" type="button">삭제</button>` : ""}</div></div>`;
  const pos = { lat: v.lat, lng: v.lng };
  const rIn = box.querySelector("#c-r");
  const m = pickMap(box.querySelector("#c-map"), { lat: v.lat, lng: v.lng, radius: () => +rIn.value || 40, onPick: (la, ln) => { pos.lat = la; pos.lng = ln; } });
  rIn.addEventListener("input", () => m.redraw());
  box.querySelector("#c-save").addEventListener("click", async () => {
    const title = box.querySelector("#c-title").value.trim();
    if (!title || pos.lat == null) return toast("이름과 위치를 정해주세요.");
    const body = { title, lat: pos.lat, lng: pos.lng, radius_m: +rIn.value || 40, dust: box.querySelector("#c-dust").value === "1",
      start_date: box.querySelector("#c-s").value ? box.querySelector("#c-s").value + "T00:00" : null,
      end_date: box.querySelector("#c-e").value ? box.querySelector("#c-e").value + "T23:59" : null,
      note: box.querySelector("#c-note").value, active: box.querySelector("#c-act").checked };
    try { await api(c ? `/api/admin/constructions/${c.id}` : "/api/admin/constructions", { method: c ? "PATCH" : "POST", body }); toast("저장했습니다."); show(); } catch (ex) { toast(ex.message); }
  });
  box.querySelector("#c-del")?.addEventListener("click", async () => {
    if (!confirm("삭제할까요?")) return;
    try { await api(`/api/admin/constructions/${c.id}`, { method: "DELETE" }); show(); } catch (ex) { toast(ex.message); }
  });
}

// ------------------------------------------------------------------ 지도 데이터
async function data(main) {
  main.innerHTML = `<h1>지도 데이터</h1><p class="lead">OpenStreetMap에서 월계동(월계1·2·3동) 지도·가게·출입문 정보를 새로 받거나, 고도 데이터로 경사도를 계산합니다.</p>
    <div class="stack">
      <div class="panel"><div class="panel-h"><h2>OSM 지도 새로 받기</h2><button class="btn sm primary" id="osm" type="button">지금 받기</button></div>
        <div class="panel-b"><p class="note" style="margin:0">서버가 Overpass API에서 최신 데이터를 받아 지도·보행 그래프·가게 목록을 다시 만듭니다. 1~3분 걸립니다. OSM에 길을 직접 추가·수정했다면 여기서 반영하세요.</p><div id="osm-job"></div></div></div>
      <div class="panel"><div class="panel-h"><h2>GeoJSON 파일로 교체</h2></div>
        <div class="panel-b"><p class="note" style="margin:0">서버에서 Overpass에 접속이 안 될 때, overpass-turbo에서 내보낸 GeoJSON을 올립니다. 월계1동 행정경계가 꼭 있어야 하고, 월계2·3동 경계가 있으면 지도 범위가 월계동 전체로 잡힙니다.</p>
        <div class="row"><input type="file" id="osm-file" accept=".geojson,.json,application/json"><button class="btn sm" id="osm-up" type="button">올리기</button></div><div id="up-res"></div></div></div>
      <div class="panel"><div class="panel-h"><h2>경사도 (고도 데이터)</h2><button class="btn sm primary" id="elev" type="button">고도 받기</button></div>
        <div class="panel-b"><p class="note" style="margin:0">키 없이 쓰는 Open-Meteo 고도 API(Copernicus 90m 격자)로 월계동 위 약 1,200곳의 고도를 받아(2~3분) 보행로 경사도를 계산합니다. 지도 데이터를 새로 받은 뒤에는 한 번 더 누르세요. 배리어프리 경로가 급경사를 피하게 됩니다. 지형 수준의 경사라 짧은 경사로·턱은 주민 제보로 보완하세요.</p><div id="elev-job"></div></div></div>
    </div>`;
  main.querySelector("#osm").addEventListener("click", () => runJob("/api/admin/osm/refresh", "osm", main.querySelector("#osm-job")));
  main.querySelector("#elev").addEventListener("click", () => runJob("/api/admin/elevation/refresh", "elevation", main.querySelector("#elev-job")));
  main.querySelector("#osm-up").addEventListener("click", async () => {
    const f = main.querySelector("#osm-file").files[0];
    if (!f) return toast("파일을 골라주세요.");
    const fd = new FormData(); fd.append("file", f);
    main.querySelector("#up-res").innerHTML = `<span class="spinner"></span>`;
    try { const r = await api("/api/admin/osm/upload", { method: "POST", form: fd }); main.querySelector("#up-res").innerHTML = `<pre class="log">${esc(JSON.stringify(r, null, 2))}</pre>`; }
    catch (ex) { main.querySelector("#up-res").innerHTML = `<div class="warn">${esc(ex.message)}</div>`; }
  });
}

// ------------------------------------------------------------------ 사용자
async function users(main) {
  const rows = await api("/api/admin/users");
  main.innerHTML = `<h1>사용자</h1><p class="lead">관리자 권한을 줄 팀원을 지정합니다.</p>
    <div class="panel"><table class="tbl"><thead><tr><th>아이디</th><th>닉네임</th><th>가입일</th><th>관리자</th></tr></thead><tbody>
    ${rows.map(u => `<tr><td>@${esc(u.username)}</td><td>${esc(u.nickname)}</td><td>${fmtDate(u.created_at, false)}</td><td><input type="checkbox" data-u="${u.id}" ${u.is_admin ? "checked" : ""} ${u.id === auth.user?.id ? "disabled" : ""}></td></tr>`).join("")}
    </tbody></table></div>`;
  main.querySelectorAll("[data-u]").forEach(c => c.addEventListener("change", async () => {
    try { await api(`/api/admin/users/${c.dataset.u}/admin?value=${c.checked}`, { method: "POST" }); toast("변경했습니다."); } catch (ex) { toast(ex.message); c.checked = !c.checked; }
  }));
}

// ------------------------------------------------------------------ 시작
async function start() {
  if (!auth.loggedIn) return loginView();
  try {
    const me = await api("/api/auth/me");
    auth.set(auth.token, me);
    if (!me.is_admin) return loginView("관리자 권한이 없는 계정입니다.");
  } catch (e) { return loginView(); }
  if (!base) base = await api("/api/map/basemap");
  tab = (location.hash.slice(1) || "dash");
  if (!TABS.some(([k]) => k === tab)) tab = "dash";
  shell();
  show();
}
window.addEventListener("hashchange", () => {
  const t = location.hash.slice(1);
  if (TABS.some(([k]) => k === t) && root.querySelector(".adm")) { tab = t; show(); }
});
start();
