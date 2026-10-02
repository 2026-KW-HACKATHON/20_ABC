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
  ["dash", "대시보드"], ["events", "행사 승인"], ["reports", "신문고"], ["paths", "길 제보"],
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
  const counts = { events: summary.pending_events, reports: summary.open_reports, paths: summary.pending_paths };
  nav.querySelectorAll("[data-tab]").forEach(b => {
    const c = counts[b.dataset.tab];
    b.querySelector(".cnt")?.remove();
    if (c) b.insertAdjacentHTML("beforeend", `<span class="cnt">${c}</span>`);
  });
}

function shell() {
  root.innerHTML = `<div class="adm">
    <nav class="adm-nav" aria-label="관리 메뉴">
      <div class="logo"><span class="brand-mark"></span><div><b>월계온</b><small>관리자</small></div></div>
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
    await ({ dash, events, reports, paths, cons, data, users }[tab] || dash)(main);
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
      <div class="stat"><div class="k">처리할 신고</div><div class="v">${s.open_reports}</div></div>
      <div class="stat"><div class="k">검토할 길 제보</div><div class="v">${s.pending_paths}</div></div>
      <div class="stat"><div class="k">공개 중인 행사</div><div class="v">${s.approved_events}</div></div>
      <div class="stat"><div class="k">가입자</div><div class="v">${s.users}</div></div>
    </div>
    <div class="stack">
      ${s.ai_enabled ? `<div class="okbox">AI 사진 분류가 켜져 있습니다: ${esc(s.ai_label)}</div>` : `<div class="warn">AI 사진 분류가 꺼져 있습니다. 서버 환경변수 <b>GEMINI_API_KEY</b>(무료) 또는 <b>ANTHROPIC_API_KEY</b>를 설정하면 켜집니다. 지금은 신고자가 유형을 직접 고릅니다.</div>`}
      ${s.seoul_sample_key ? `<div class="warn">서울시 문화행사 API가 샘플 키로 동작 중이라 5건만 받아옵니다. 서울 열린데이터광장에서 인증키를 받아 <b>SEOUL_API_KEY</b>에 넣어주세요.</div>` : ""}
      <div class="panel"><div class="panel-h"><h2>행사 자동 수집</h2><button class="btn sm primary" id="collect" type="button">지금 수집</button></div>
        <div class="panel-b"><p class="note" style="margin:0">서울시 문화행사(노원구·월계1동 반경)와 광운대 공지사항에서 행사를 모아 승인 대기열에 넣습니다. 서버가 켜져 있으면 몇 시간마다 자동으로 실행됩니다.</p>
        <div id="job"></div>
        <table class="tbl"><thead><tr><th>출처</th><th>실행 시각</th><th>찾음</th><th>새로 추가</th><th>오류</th></tr></thead><tbody>
        ${s.collect_logs.length ? s.collect_logs.map(l => `<tr><td>${{ seoul: "서울시", kw: "광운대" }[l.source] || l.source}</td><td>${fmtDate(l.at)}</td><td>${l.found}</td><td>${l.added}</td><td class="small" style="color:#dc2626">${esc(l.error || "")}</td></tr>`).join("") : `<tr><td colspan="5" class="muted">아직 수집 기록이 없습니다.</td></tr>`}
        </tbody></table></div></div>
      <div class="panel"><div class="panel-h"><h2>구청 행사 자료 올리기</h2></div>
        <div class="panel-b"><p class="note" style="margin:0">노원구청 '주요행사계획' PDF를 올리면 AI가 주민 대상 행사를 뽑아 <b>승인 대기</b>로 넣습니다 (1~3분). 정리된 JSON 파일은 바로 <b>승인</b>됩니다. 이미 등록된 행사는 다시 넣지 않습니다.</p>
        <div class="row" style="margin-top:8px"><input type="file" id="off-file" accept=".pdf,.json,application/pdf,application/json"><button class="btn sm primary" id="off-up" type="button">올리기</button></div><div id="off-res"></div></div></div>
    </div>`;
  main.querySelector("#collect").addEventListener("click", () => runJob("/api/admin/collect", "collect", main.querySelector("#job"), () => show()));
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
let evFilter = "pending";
async function events(main) {
  const cats = summary.meta.event_categories;
  const rows = await api(`/api/admin/events?status=${evFilter}`);
  main.innerHTML = `<h1>행사 승인</h1><p class="lead">자동 수집된 행사를 확인해 승인하거나, 직접 등록합니다. 승인된 행사만 앱에 보이고, 해당 분류 알림을 켠 주민에게 알림이 갑니다.</p>
    <div class="split">
      <div class="panel"><div class="panel-h">
        <select class="input" id="ev-f" style="width:auto">${[["pending", "승인 대기"], ["approved", "승인됨"], ["rejected", "반려"], ["all", "전체"]].map(([k, l]) => `<option value="${k}" ${evFilter === k ? "selected" : ""}>${l}</option>`).join("")}</select>
        <span class="grow"></span><button class="btn sm primary" id="ev-new" type="button">새 행사 등록</button></div>
        <div class="rows">${rows.length ? rows.map(e => `<button class="rowi" type="button" data-id="${e.id}"><div class="grow">
          <div class="row wrap" style="gap:6px"><span class="chip ${e.category}">${esc(e.category_label)}</span><span class="chip ${e.status === "approved" ? "resolved" : e.status}">${{ pending: "대기", approved: "승인", rejected: "반려" }[e.status]}</span><span class="small muted">${{ seoul: "서울시", kw: "광운대", manual: "직접", nowon: "노원구청" }[e.source] || e.source}</span></div>
          <div class="t">${esc(e.title)}</div><div class="m">${e.start_at ? fmtDate(e.start_at) : "날짜 확인 필요"} · ${esc(e.place_name || "장소 확인 필요")}</div></div></button>`).join("") : `<div class="empty">해당하는 행사가 없습니다.</div>`}</div>
      </div>
      <div class="panel" id="ev-edit"><div class="empty">왼쪽에서 행사를 고르거나 새로 등록하세요.</div></div>
    </div>`;
  main.querySelector("#ev-f").addEventListener("change", e => { evFilter = e.target.value; show(); });
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
      <div class="field">지도 위치 <span class="note">(지도를 눌러 정확한 위치를 찍어주세요)</span><div class="pickmap" id="f-map"></div><span class="note" id="f-ll">${v.lat != null ? `${v.lat}, ${v.lng}` : "위치 없음 — 승인하려면 필요합니다"}</span></div>
      <label class="field">소개<textarea class="input" id="f-desc" rows="5">${esc(v.description)}</textarea></label>
      <div class="grid2">
        <label class="field">요금<input class="input" id="f-fee" value="${esc(v.fee)}"></label>
        <label class="field">문의<input class="input" id="f-contact" value="${esc(v.contact)}"></label>
        <label class="field">원문 링크<input class="input" id="f-url" value="${esc(v.url)}"></label>
        <label class="field">이미지 주소<input class="input" id="f-img" value="${esc(v.image_url)}"></label>
      </div>
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

// ------------------------------------------------------------------ 신문고
let rpFilter = "open";
async function reports(main) {
  const rows = await api(`/api/admin/reports?status=${rpFilter}`);
  const st = summary.meta.report_status, cats = summary.meta.report_categories;
  main.innerHTML = `<h1>신문고</h1><p class="lead">상태를 바꾸면 신고한 주민에게 앱 알림이 갑니다. 공사 신고는 공사 구간으로 등록해 길찾기에 반영할 수 있습니다.</p>
    <div class="split">
      <div class="panel"><div class="panel-h"><select class="input" id="rp-f" style="width:auto">${[["open", "처리할 신고"], ["resolved", "처리 완료"], ["rejected", "반려"], ["all", "전체"]].map(([k, l]) => `<option value="${k}" ${rpFilter === k ? "selected" : ""}>${l}</option>`).join("")}</select>
        <span class="grow"></span><a class="btn sm" href="#" id="rp-hot">문제 반복 구간 보기</a></div>
        <div class="rows">${rows.length ? rows.map(r => `<button class="rowi" type="button" data-id="${r.id}"><img src="${r.thumb_url}" alt="" loading="lazy"><div class="grow">
          <div class="row wrap" style="gap:6px"><span class="chip ${r.status}">${esc(r.status_label)}</span>${r.ai_severity === 3 ? `<span class="chip" style="color:#dc2626">긴급</span>` : ""}<span class="small muted">${ago(r.created_at)}</span></div>
          <div class="t">${esc(r.category_label)}</div><div class="m">${esc(r.summary || r.description || "")}</div></div></button>`).join("") : `<div class="empty">해당하는 신고가 없습니다.</div>`}</div>
      </div>
      <div class="panel" id="rp-edit"><div class="empty">왼쪽에서 신고를 고르세요.</div></div>
    </div>`;
  main.querySelector("#rp-f").addEventListener("change", e => { rpFilter = e.target.value; show(); });
  main.querySelector("#rp-hot").addEventListener("click", async ev => {
    ev.preventDefault();
    const hs = await api("/api/reports/hotspots");
    const box = main.querySelector("#rp-edit");
    cleanupMaps();
    box.innerHTML = `<div class="panel-h"><h2>문제 반복 구간 (반경 40m 안 신고 3건 이상)</h2></div><div class="panel-b"><div class="pickmap" id="hs-map" style="height:420px"></div>
      <table class="tbl"><thead><tr><th>신고 수</th><th>미처리</th><th>주요 유형</th><th>최근</th></tr></thead><tbody>${hs.length ? hs.map(h => `<tr><td>${h.count}</td><td>${h.open}</td><td>${esc(h.top_label)}</td><td>${ago(h.last)}</td></tr>`).join("") : `<tr><td colspan="4" class="muted">아직 반복 구간이 없습니다.</td></tr>`}</tbody></table></div>`;
    const m = createMap(box.querySelector("#hs-map"), base, { attribution: false });
    maps.push(m);
    hs.forEach(h => L.circle([h.lat, h.lng], { radius: h.radius_m, color: "#dc2626", fillOpacity: .15 }).bindPopup(`${h.count}건 · ${esc(h.top_label)}`).addTo(m));
  });
  main.querySelectorAll(".rowi").forEach(b => b.addEventListener("click", () => {
    main.querySelectorAll(".rowi").forEach(x => x.classList.toggle("sel", x === b));
    const r = rows.find(x => x.id == b.dataset.id);
    cleanupMaps();
    const box = main.querySelector("#rp-edit");
    box.innerHTML = `<div class="panel-h"><h2>신고 #${r.id} · ${esc(r.reporter)}</h2><span class="small muted">${fmtDate(r.created_at)}</span></div>
      <div class="panel-b">
        <img src="${r.image_url}" alt="신고 사진" style="width:100%;max-height:420px;object-fit:contain;background:#111;border-radius:12px">
        ${r.ai_category ? `<div class="note">AI 판단: ${esc(cats[r.ai_category] || r.ai_category)} (확신도 ${Math.round(r.ai_confidence * 100)}%, 심각도 ${r.ai_severity}) — ${esc(r.summary)}</div>` : `<div class="note">AI 분류 없이 접수됨</div>`}
        ${r.description ? `<p style="margin:0">${esc(r.description)}</p>` : ""}
        <div class="pickmap" id="rp-map" style="height:220px"></div>
        <div class="grid2">
          <label class="field">유형<select class="input" id="r-cat">${Object.entries(cats).map(([k, l]) => `<option value="${k}" ${r.category === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <label class="field">상태<select class="input" id="r-st">${Object.entries(st).map(([k, l]) => `<option value="${k}" ${r.status === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        </div>
        <label class="field">주민에게 보일 메모<textarea class="input" id="r-note" rows="3" placeholder="예: 노원구청 도로과에 전달했습니다.">${esc(r.admin_note || "")}</textarea></label>
        <div class="row wrap"><button class="btn primary" id="r-save" type="button">저장하고 알림 보내기</button><button class="btn" id="r-cons" type="button">공사 구간으로 등록</button></div>
      </div>`;
    const m = createMap(box.querySelector("#rp-map"), base, { attribution: false });
    maps.push(m);
    m.setView([r.lat, r.lng], 18, { animate: false });
    L.marker([r.lat, r.lng], { icon: L.divIcon({ className: `rp-dot ${r.status}`, html: "<i></i>", iconSize: [14, 14], iconAnchor: [7, 7] }) }).addTo(m);
    box.querySelector("#r-save").addEventListener("click", async () => {
      try {
        await api(`/api/admin/reports/${r.id}`, { method: "PATCH", body: { status: box.querySelector("#r-st").value, category: box.querySelector("#r-cat").value, admin_note: box.querySelector("#r-note").value } });
        toast("저장했습니다."); show();
      } catch (ex) { toast(ex.message); }
    });
    box.querySelector("#r-cons").addEventListener("click", async () => {
      try { await api(`/api/admin/reports/${r.id}/to-construction`, { method: "POST" }); toast("공사 구간으로 등록했습니다. 공사 구간 메뉴에서 기간을 정해주세요."); show(); } catch (ex) { toast(ex.message); }
    });
  }));
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
          <div class="m">${esc(p.note || "메모 없음")}${p.open_hours ? ` · 통행 ${esc(p.open_hours)}` : ""}</div></div></button>`).join("") : `<div class="empty">해당하는 제보가 없습니다.</div>`}</div></div>
      <div class="panel" id="p-edit"><div class="panel-b"><div class="pickmap" id="p-map" style="height:520px"></div></div></div>
    </div>`;
  main.querySelector("#p-f").addEventListener("change", e => { pFilter = e.target.value; show(); });
  const m = createMap(main.querySelector("#p-map"), base, { attribution: false });
  maps.push(m);
  const shapes = {};
  rows.forEach(p => {
    const shape = p.coords.length > 1 ? L.polyline(p.coords, { color: PCOLOR[p.kind], weight: 5, dashArray: "8 6" }) : L.circleMarker(p.coords[0], { radius: 8, color: PCOLOR[p.kind] });
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
        <div class="panel-b"><p class="note" style="margin:0">Open-Meteo 고도 API(90m 격자)로 보행로 노드의 고도를 받아 경사도를 계산합니다. 배리어프리 경로가 급경사를 피하게 됩니다. 지형 수준의 경사라 짧은 경사로·턱은 주민 제보로 보완하세요.</p><div id="elev-job"></div></div></div>
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
