// MY: 로그인·가입, 대시보드(프로필·즐겨찾기·알림·행사 제보·설정), 설정, 알림 목록
import { api, auth } from "../api.js";
import { ago, bindBack, esc, pageHead, toast } from "../ui.js";

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
        <p class="small muted" style="text-align:center">지도·행사·길찾기는 로그인 없이 쓸 수 있어요.<br>행사 제보, 후기, 메모 경로, 길 제보는 로그인이 필요해요.</p>
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

// ---- MY 대시보드: 프로필 · 즐겨찾기 · 알림 · 행사 제보 · 설정 (+ 메모 경로 · 길 제보)
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
      ${tile(login("#/settings"), "profile", "프로필")}
      ${tile(login("#/news?mode=fav"), "fav", "즐겨찾기")}
      ${tile(login("#/notifications"), "bell", "알림", `<span class="dbadge" id="me-unread" hidden></span>`)}
      ${tile(login("#/tip"), "tip", "행사 제보")}
      ${tile(login("#/settings"), "gear", "설정")}
      ${tile(login("#/plan"), "memo", "메모 경로")}
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
    if (el) el.innerHTML = rows.length ? rows.slice(0, 5).map(p => `<div class="row" style="padding:4px 0"><span class="chip ${p.status === "approved" ? "resolved" : p.status === "rejected" ? "rejected" : "received"}">${p.status === "approved" ? "반영됨" : p.status === "rejected" ? "반려" : "검토 중"}</span><span class="grow" style="color:#161616">${esc(p.kind_label)}${p.strokes ? " (칠한 범위)" : ""}${p.note ? " · " + esc(p.note) : ""}</span></div>`).join("")
      : `아직 제보한 길이 없어요. <a href="#/path-edit">길 정보 제보하기</a>`;
  } catch (_) { /* 무시 */ }
}

// ---- 설정: 프로필(닉네임·비밀번호) · 알림 받을 행사 · 로그아웃 · 탈퇴
async function settings(view, ctx) {
  if (!auth.loggedIn) { location.hash = "#/login?next=%23%2Fsettings"; return; }
  const u = auth.user || {};
  view.innerHTML = `<div class="page">${pageHead("설정", { back: true })}<div class="page-body">
    <div class="card stack" id="profile">
      <h2>프로필</h2>
      <label class="field">닉네임<div class="row"><input class="input grow" id="nick" maxlength="20" value="${esc(u.nickname || "")}"><button class="btn sm" id="save-nick" type="button">저장</button></div></label>
      <label class="field">새 비밀번호<div class="row"><input class="input grow" id="pw" type="password" minlength="6" autocomplete="new-password" placeholder="6자 이상"><button class="btn sm" id="save-pw" type="button">변경</button></div></label>
    </div>
    <div class="card stack">
      <h2>알림 받을 행사</h2>
      <p class="small muted" style="margin:-4px 0 0">새 행사가 올라오면 앱 안에서 알려드려요. 즐겨찾기한 행사는 시작 하루 전에 알려드려요.</p>
      <div class="pick" id="noti-cats">${Object.entries(CATS).map(([k, l]) => `<button type="button" data-c="${k}" aria-pressed="${(u.notify_categories || []).includes(k)}">${l}</button>`).join("")}</div>
    </div>
    <div class="card stack">
      <h2>계정</h2>
      <div class="row"><button class="btn grow" id="logout" type="button">로그아웃</button><button class="btn ghost danger" id="leave" type="button">탈퇴</button></div>
    </div>
  </div></div>`;
  bindBack(view);
  view.querySelectorAll("#noti-cats [data-c]").forEach(b => b.addEventListener("click", async () => {
    b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true");
    const cats = [...view.querySelectorAll('#noti-cats [aria-pressed="true"]')].map(x => x.dataset.c);
    try { auth.set(auth.token, await api("/api/auth/me", { method: "PATCH", body: { notify_categories: cats } })); toast("알림 설정을 저장했어요."); } catch (e) { toast(e.message); }
  }));
  view.querySelector("#save-nick").addEventListener("click", async () => {
    const v = view.querySelector("#nick").value.trim();
    if (!v) return toast("닉네임을 입력해주세요.");
    try { auth.set(auth.token, await api("/api/auth/me", { method: "PATCH", body: { nickname: v } })); toast("닉네임을 바꿨어요."); } catch (e) { toast(e.message); }
  });
  view.querySelector("#save-pw").addEventListener("click", async () => {
    const v = view.querySelector("#pw").value;
    if (v.length < 6) return toast("비밀번호는 6자 이상이어야 해요.");
    try {
      const r = await api("/api/auth/me", { method: "PATCH", body: { password: v } });
      auth.set(r.token || auth.token, r);
      view.querySelector("#pw").value = ""; toast("비밀번호를 바꿨어요. 다른 기기는 다시 로그인해야 해요.");
    } catch (e) { toast(e.message); }
  });
  view.querySelector("#logout").addEventListener("click", () => { auth.logout(); toast("로그아웃했어요."); location.hash = "#/me"; });
  view.querySelector("#leave").addEventListener("click", async () => {
    if (!confirm("탈퇴하면 후기(사진·영상 포함)·메모가 모두 지워집니다. 제보한 행사는 제보자 정보 없이 남아요. 탈퇴할까요?")) return;
    try { await api("/api/auth/me", { method: "DELETE" }); auth.logout(); toast("탈퇴했어요."); location.hash = "#/me"; } catch (e) { toast(e.message); }
  });
}

function about() {
  return `<div class="card small muted stack" style="gap:4px">
    <b style="color:#161616">월계온 (Wolgye-ON)</b>
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
