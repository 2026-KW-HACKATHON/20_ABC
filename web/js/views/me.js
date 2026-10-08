// MY: 로그인·가입, 대시보드(프로필·즐겨찾기·알림·행사 제보·설정), 설정, 알림 목록
import { api, auth } from "../api.js";
import { ago, bindBack, esc, pageHead, toast } from "../ui.js";
import { play as playSfx, setSfx, setSfxVolume, sfxOn, sfxVolume } from "../sfx.js";
import { askNotifPermission, bridge, getPref, notifPermission, setPref, testNotification } from "../prefs.js";

const CATS = { culture: "문화·예술", academic: "학술·교육", community: "지역·참여" };

export async function render({ view, ctx, path, params }) {
  document.body.classList.add("page-open");
  if (path === "/login") return login(view, params);
  if (path === "/notifications") return notifications(view, ctx);
  if (path === "/settings") return settings(view, ctx);
  return me(view, ctx);
}

function login(view, params) {
  const next = params.get("next") || "#/me";
  let mode = "login";
  const draw = () => {
    view.innerHTML = `<div class="page">${pageHead(mode === "login" ? "로그인" : "가입하기", { back: true })}
      <div class="page-body">
        <div class="seg"><button type="button" data-m="login" aria-pressed="${mode === "login"}">로그인</button><button type="button" data-m="register" aria-pressed="${mode === "register"}">가입하기</button></div>
        <form class="card stack" id="auth-form" novalidate>
          <label class="field">아이디<input class="input" id="a-user" autocomplete="username" autocapitalize="none" minlength="3" maxlength="20" required placeholder="영문·숫자 3~20자"></label>
          ${mode === "register" ? `<label class="field">닉네임<input class="input" id="a-nick" maxlength="20" required placeholder="후기와 알림에 쓰일 이름"></label>` : ""}
          <label class="field">비밀번호<input class="input" id="a-pw" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}" minlength="6" required placeholder="6자 이상"></label>
          <div class="form-error" id="a-err" hidden></div>
          <button class="btn primary block" type="submit">${mode === "login" ? "로그인" : "가입하고 시작하기"}</button>
          ${mode === "register" ? `<p class="small muted" style="margin:0">전화번호·이메일은 받지 않아요. 알림은 앱 안에서만 보여드립니다.</p>` : ""}
        </form>
        <p class="small muted" style="text-align:center">지도·행사·길찾기는 로그인 없이 쓸 수 있어요.<br>행사 제보, 후기, 길 제보는 로그인이 필요해요.</p>
      </div></div>`;
    bindBack(view);
    view.querySelectorAll("[data-m]").forEach(b => b.addEventListener("click", () => { mode = b.dataset.m; draw(); }));
    view.querySelector("#auth-form").addEventListener("submit", async e => {
      e.preventDefault();
      const err = view.querySelector("#a-err");
      const username = view.querySelector("#a-user").value.trim(), password = view.querySelector("#a-pw").value;
      const nickname = view.querySelector("#a-nick")?.value.trim();
      err.hidden = true;
      if (username.length < 3 || password.length < 6 || (mode === "register" && !nickname)) {
        err.textContent = mode === "register" ? "아이디 3자, 비밀번호 6자 이상, 닉네임을 입력해주세요." : "아이디와 비밀번호를 입력해주세요.";
        err.hidden = false; return;
      }
      try {
        const r = await api(`/api/auth/${mode}`, { method: "POST", body: mode === "login" ? { username, password } : { username, password, nickname } });
        auth.set(r.token, r.user);
        toast(mode === "login" ? `${r.user.nickname}님, 반가워요.` : "가입했어요. 환영합니다!");
        location.replace(next.startsWith("#") ? next : "#/me");
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
  };
  draw();
}

// ---- MY 대시보드: 프로필 · 즐겨찾기 · 알림 · 행사 제보 · 설정 (+ 길 제보)
const D = {
  profile: `<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>`,
  fav: `<path d="M6 3h12v18l-6-4.5L6 21z"/><path d="M12 8.5c-1-1.6-3.6-1-3.4 1 .2 1.6 3.4 3.5 3.4 3.5s3.2-1.9 3.4-3.5c.2-2-2.4-2.6-3.4-1z"/>`,
  bell: `<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>`,
  tip: `<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>`,
  gear: `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`,
  memo: `<path d="M8 4h11v16H5V7z"/><path d="M8 4v3H5M9 11h7M9 15h5"/>`,
  path: `<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h7a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h7"/>`,
  admin: `<path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>`,
};
const dicon = k => `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${D[k]}</svg>`;
const tile = (href, k, label, extra = "") => `<a class="dtile" href="${href}"${href.startsWith("/") ? ' target="_self"' : ""}><span class="dcirc">${dicon(k)}${extra}</span><span>${label}</span></a>`;
const STATUS_CHIP = { pending: "received", approved: "resolved", rejected: "rejected" };

async function me(view, ctx) {
  const u = auth.user || {};
  const login = href => auth.loggedIn ? href : `#/login?next=${encodeURIComponent(href)}`;
  view.innerHTML = `<div class="page">${pageHead("MY")}<div class="page-body">
    ${auth.loggedIn ? `<div class="profile-card"><span class="dcirc big">${dicon("profile")}</span>
        <div class="grow"><b>${esc(u.nickname || "")}</b><span>@${esc(u.username || "")}</span></div>
        <a class="btn sm" href="#/settings">프로필 수정</a></div>`
      : `<div class="card stack" style="text-align:center"><h2>월계온에 오신 걸 환영해요</h2>
        <p class="muted small" style="margin:0">지도·행사·길찾기는 로그인 없이 쓸 수 있어요. 로그인하면 즐겨찾기, 알림, 후기, 행사 제보를 쓸 수 있어요.</p>
        <a class="btn primary block" href="#/login">로그인 / 가입하기</a></div>`}
    <div class="dash">
      ${tile(login("#/news?mode=fav"), "fav", "즐겨찾기")}
      ${tile(login("#/notifications"), "bell", "알림", `<span class="dbadge" id="me-unread" hidden></span>`)}
      ${tile(login("#/tip"), "tip", "행사 제보")}
      ${tile("#/settings", "gear", "설정")}
      ${tile(login("#/path-edit"), "path", "길 제보")}
      ${u.is_admin ? tile("/admin", "admin", "관리자") : ""}
    </div>
    ${auth.loggedIn ? `
    <div class="card stack"><div class="row"><h2 class="grow" style="margin:0">내 행사 제보</h2><a class="btn sm" href="#/tip">제보하기</a></div>
      <p class="small muted" style="margin:0">내가 준비한 행사나 동네의 작은 행사를 알려서 이웃에게 홍보하세요. 확인 후 지도에 올라가요.</p>
      <div id="my-tips" class="small muted">불러오는 중…</div></div>
    <div class="card stack"><h2>내 길 제보</h2><div id="my-paths" class="small muted">불러오는 중…</div></div>` : ""}
    ${about()}
  </div></div>`;
  if (!auth.loggedIn) return;
  api("/api/notifications/unread").then(r => { const c = view.querySelector("#me-unread"); if (c && r.unread) { c.hidden = false; c.textContent = r.unread > 99 ? "99+" : r.unread; } }).catch(() => {});
  api("/api/tips/mine").then(rows => {
    const el = view.querySelector("#my-tips");
    if (!el) return;
    el.innerHTML = rows.length ? `<div class="list">${rows.slice(0, 3).map(t => `<a class="item" href="${t.status === "approved" ? `#/event/${t.id}` : "#/tip"}"><div class="grow">
        <div class="row" style="gap:6px"><span class="chip ${STATUS_CHIP[t.status] || ""}">${esc(t.status_label)}</span><span class="t" style="font-size:14px">${esc(t.title)}</span></div></div></a>`).join("")}</div>`
      : `아직 제보한 행사가 없어요.`;
  }).catch(() => {});
  try {
    const rows = await api("/api/map/paths/mine");
    const el = view.querySelector("#my-paths");
    if (el) el.innerHTML = rows.length ? rows.slice(0, 5).map(p => `<div class="row" style="padding:4px 0"><span class="chip ${p.status === "approved" ? "resolved" : p.status === "rejected" ? "rejected" : "received"}">${p.status === "approved" ? "반영됨" : p.status === "rejected" ? "반려" : "검토 중"}</span><span class="grow" style="color:var(--ink)">${esc(p.kind_label)}${p.strokes ? " (칠한 범위)" : ""}${p.note ? " · " + esc(p.note) : ""}</span></div>`).join("")
      : `아직 제보한 길이 없어요. <a href="#/path-edit">길 정보 제보하기</a>`;
  } catch (_) { /* 무시 */ }
}

// ---- 설정: 화면(테마) · 소리 · 알림 · 데이터 · (로그인 시) 프로필·계정
//  화면·소리·휴대폰 알림은 이 기기에 저장, 즐겨찾기 알림 시간·새 행사 분류는 계정에 저장
async function settings(view, ctx) {
  const u = auth.user || {};
  const inApp = !!bridge;
  let sp = { fav_hours: 24, promo: true, fav_hours_options: [0, 1, 2, 3, 6, 12, 24, 48] };
  if (auth.loggedIn) { try { sp = await api("/api/me/prefs"); } catch (_) {} }
  const hourLabel = h => h === 0 ? "받지 않기" : h >= 24 ? `${h / 24}일 전` : `${h}시간 전`;
  const seg = (id, opts, val) => `<div class="seg" id="${id}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join("")}</div>`;
  const perm = notifPermission();
  view.innerHTML = `<div class="page">${pageHead("설정", { back: true })}<div class="page-body">
    <div class="card stack">
      <h2>화면</h2>
      <div class="set-row"><div class="grow"><b>화면 모드</b><small>어두운 화면은 밤에 눈이 덜 피로해요</small></div></div>
      ${seg("s-theme", [["system", "기기 설정대로"], ["light", "밝게"], ["dark", "어둡게"]], getPref("theme"))}
    </div>
    <div class="card stack">
      <h2>소리</h2>
      <div class="set-row"><div class="grow"><b>버튼 효과음</b><small>버튼을 누를 때 짧은 소리</small></div>
        <label class="switch"><input type="checkbox" id="s-sfx" ${sfxOn() ? "checked" : ""}><span></span></label></div>
      <div class="set-row" id="s-vol-row" ${sfxOn() ? "" : "hidden"}><span class="small muted">작게</span>
        <input class="range grow" id="s-vol" type="range" min="5" max="100" step="5" value="${Math.round(sfxVolume() * 100)}" aria-label="효과음 크기">
        <span class="small muted">크게</span></div>
    </div>
    <div class="card stack">
      <h2>알림</h2>
      ${inApp ? `
        <div class="set-row"><div class="grow"><b>휴대폰 알림 받기</b><small id="s-perm">${perm === "granted" ? "앱을 닫아도 휴대폰 알림으로 알려드려요" : "켜려면 알림 권한이 필요해요"}</small></div>
          <label class="switch"><input type="checkbox" id="s-push" ${getPref("push") && perm === "granted" ? "checked" : ""}><span></span></label></div>
        <div class="set-row"><div class="grow"><b>근처 행사 추천</b><small>가까운 날 월계동에서 열리는 행사를 하루 한 번 소개해요</small></div>
          <label class="switch"><input type="checkbox" id="s-promo" ${getPref("promo") ? "checked" : ""}><span></span></label></div>
        <button class="btn sm" id="s-test" type="button" style="justify-self:start">알림 시험해 보기</button>`
      : `<p class="small muted" style="margin:0">휴대폰 알림은 안드로이드 <b>월계온 앱</b>에서 받을 수 있어요. 웹에서는 위 종 모양 알림함에서 확인하세요.</p>`}
      ${auth.loggedIn ? `
        <div class="set-row"><div class="grow"><b>즐겨찾기한 행사 알림</b><small>행사가 시작하기 얼마 전에 알려드릴까요?</small></div>
          <select class="input" id="s-fav" style="width:auto">${sp.fav_hours_options.map(h => `<option value="${h}" ${h === sp.fav_hours ? "selected" : ""}>${hourLabel(h)}</option>`).join("")}</select></div>
        <div><div class="set-row"><div class="grow"><b>새 행사 알림</b><small>고른 분류의 행사가 새로 올라오면 알려드려요</small></div></div>
          <div class="pick" id="noti-cats">${Object.entries(CATS).map(([k, l]) => `<button type="button" data-c="${k}" aria-pressed="${(u.notify_categories || []).includes(k)}">${l}</button>`).join("")}</div></div>`
      : `<p class="small muted" style="margin:0"><a href="#/login?next=%23%2Fsettings">로그인</a>하면 즐겨찾기한 행사가 시작하기 전에, 새 행사가 올라왔을 때 알려드려요.</p>`}
    </div>
    <div class="card stack">
      <h2>데이터</h2>
      <div class="set-row"><div class="grow"><b>앱 화면 새로 받기</b><small>화면이 이상하거나 최신 기능이 안 보일 때</small></div>
        <button class="btn sm" id="s-refresh" type="button">새로 받기</button></div>
    </div>
    ${auth.loggedIn ? `
    <div class="card stack" id="profile">
      <h2>프로필</h2>
      <label class="field">닉네임<div class="row"><input class="input grow" id="nick" maxlength="20" value="${esc(u.nickname || "")}"><button class="btn sm" id="save-nick" type="button">저장</button></div></label>
      <label class="field">새 비밀번호<div class="row"><input class="input grow" id="pw" type="password" minlength="6" autocomplete="new-password" placeholder="6자 이상"><button class="btn sm" id="save-pw" type="button">변경</button></div></label>
    </div>
    <div class="card stack">
      <h2>계정</h2>
      <div class="row"><button class="btn grow" id="logout" type="button">로그아웃</button><button class="btn ghost danger" id="leave" type="button">탈퇴</button></div>
    </div>` : ""}
    ${about()}
  </div></div>`;
  bindBack(view);
  const $ = s => view.querySelector(s);
  const bindSeg = (id, fn) => view.querySelectorAll(`#${id} [data-v]`).forEach(b => b.addEventListener("click", () => {
    view.querySelectorAll(`#${id} [data-v]`).forEach(x => x.setAttribute("aria-pressed", x === b));
    fn(b.dataset.v);
  }));
  bindSeg("s-theme", v => setPref("theme", v));
  $("#s-sfx").addEventListener("change", e => { setSfx(e.target.checked); $("#s-vol-row").hidden = !e.target.checked; });
  $("#s-vol").addEventListener("input", e => setSfxVolume(e.target.value / 100));
  $("#s-vol").addEventListener("change", () => playSfx("tap"));
  $("#s-push")?.addEventListener("change", async e => {
    if (e.target.checked && notifPermission() !== "granted") {
      const st = await askNotifPermission();
      if (st !== "granted") { e.target.checked = false; toast("휴대폰 설정에서 월계온 알림을 허용해주세요."); return; }
      $("#s-perm").textContent = "앱을 닫아도 휴대폰 알림으로 알려드려요";
    }
    setPref("push", e.target.checked);
    toast(e.target.checked ? "휴대폰 알림을 켰어요." : "휴대폰 알림을 껐어요.");
  });
  $("#s-promo")?.addEventListener("change", async e => {
    setPref("promo", e.target.checked);
    if (auth.loggedIn) { try { await api("/api/me/prefs", { method: "PUT", body: { promo: e.target.checked } }); } catch (_) {} }
  });
  $("#s-test")?.addEventListener("click", async () => {
    if (notifPermission() !== "granted" && (await askNotifPermission()) !== "granted") return toast("휴대폰 설정에서 월계온 알림을 허용해주세요.");
    testNotification();
  });
  $("#s-fav")?.addEventListener("change", async e => {
    try { await api("/api/me/prefs", { method: "PUT", body: { fav_hours: +e.target.value } }); toast(+e.target.value ? `행사 ${hourLabel(+e.target.value)}에 알려드릴게요.` : "즐겨찾기 알림을 껐어요."); }
    catch (ex) { toast(ex.message); }
  });
  $("#s-refresh").addEventListener("click", async () => {
    try {
      if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
      const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
      for (const r of regs) await r.unregister();
    } catch (_) {}
    location.reload();
  });
  view.querySelectorAll("#noti-cats [data-c]").forEach(b => b.addEventListener("click", async () => {
    b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true");
    const cats = [...view.querySelectorAll('#noti-cats [aria-pressed="true"]')].map(x => x.dataset.c);
    try { auth.set(auth.token, await api("/api/auth/me", { method: "PATCH", body: { notify_categories: cats } })); toast("알림 설정을 저장했어요."); } catch (e) { toast(e.message); }
  }));
  if (!auth.loggedIn) return;
  $("#save-nick").addEventListener("click", async () => {
    const v = $("#nick").value.trim();
    if (!v) return toast("닉네임을 입력해주세요.");
    try { auth.set(auth.token, await api("/api/auth/me", { method: "PATCH", body: { nickname: v } })); toast("닉네임을 바꿨어요."); } catch (e) { toast(e.message); }
  });
  $("#save-pw").addEventListener("click", async () => {
    const v = $("#pw").value;
    if (v.length < 6) return toast("비밀번호는 6자 이상이어야 해요.");
    try {
      const r = await api("/api/auth/me", { method: "PATCH", body: { password: v } });
      auth.set(r.token || auth.token, r);
      $("#pw").value = ""; toast("비밀번호를 바꿨어요. 다른 기기는 다시 로그인해야 해요.");
    } catch (e) { toast(e.message); }
  });
  $("#logout").addEventListener("click", () => { auth.logout(); toast("로그아웃했어요."); location.hash = "#/me"; });
  $("#leave").addEventListener("click", async () => {
    if (!confirm("탈퇴하면 후기(사진·영상 포함)·달력 메모가 모두 지워집니다. 제보한 행사는 제보자 정보 없이 남아요. 탈퇴할까요?")) return;
    try { await api("/api/auth/me", { method: "DELETE" }); auth.logout(); toast("탈퇴했어요."); location.hash = "#/me"; } catch (e) { toast(e.message); }
  });
}

function about() {
  return `<div class="card small muted stack" style="gap:4px">
    <b style="color:var(--ink);display:flex;align-items:center;gap:8px"><img src="/icons/icon-192.png" alt="" width="28" height="28" style="border-radius:7px">월계온 (Wolgye-ON)</b>
    <span>월계1동 지도 데이터 © OpenStreetMap 기여자 (ODbL)</span>
    <span>행사 정보: 서울 열린데이터광장 문화행사 정보, 노원구 주요행사계획, 광운대학교 공지사항, 주민 제보</span>
    <span>포스터 읽기·빈칸 채우기: 생성형 AI API (Google Gemini 또는 Anthropic Claude)</span>
  </div>`;
}

async function notifications(view, ctx) {
  view.innerHTML = `<div class="page">${pageHead("알림", { back: true, right: `<button class="btn sm" id="read-all" type="button">모두 읽음</button>` })}<div class="page-body" id="nb"><div class="empty"><span class="spinner"></span></div></div></div>`;
  bindBack(view);
  const el = view.querySelector("#nb");
  if (!auth.loggedIn) { location.hash = "#/login?next=%23%2Fnotifications"; return; }
  const draw = async () => {
    try {
      const r = await api("/api/notifications");
      el.innerHTML = r.items.length ? `<div class="list">${r.items.map(n => `
        <a class="noti ${n.read ? "" : "unread"}" href="${esc(n.link || "#/notifications")}" data-id="${n.id}">
          <span class="dot"></span><div class="grow"><div style="font-weight:700;font-size:14px">${esc(n.title)}</div>
          ${n.body ? `<div class="small muted">${esc(n.body)}</div>` : ""}<div class="small" style="color:#98a2b3">${ago(n.created_at)}</div></div></a>`).join("")}</div>`
        : `<div class="empty">새 알림이 없어요.</div>`;
      el.querySelectorAll("[data-id]").forEach(a => a.addEventListener("click", () => { api(`/api/notifications/${a.dataset.id}/read`, { method: "POST" }).then(() => ctx.pollBadge()).catch(() => {}); }));
    } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };
  view.querySelector("#read-all").addEventListener("click", async () => {
    try { await api("/api/notifications/read-all", { method: "POST" }); ctx.pollBadge(); draw(); } catch (e) { toast(e.message); }
  });
  draw();
}
