// MY: 로그인·가입, 내 정보, 알림 설정, 알림 목록, 내 길 제보
import { api, auth } from "../api.js";
import { ago, bindBack, esc, pageHead, toast } from "../ui.js";

const CATS = { culture: "문화·예술", academic: "학술·교육", community: "지역·참여" };

export async function render({ view, ctx, path, params }) {
  document.body.classList.add("page-open");
  if (path === "/login") return login(view, params);
  if (path === "/notifications") return notifications(view, ctx);
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
        <p class="small muted" style="text-align:center">지도·행사·길찾기는 로그인 없이 쓸 수 있어요.<br>신문고, 후기, 메모 경로, 길 제보는 로그인이 필요해요.</p>
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

async function me(view, ctx) {
  if (!auth.loggedIn) {
    view.innerHTML = `<div class="page">${pageHead("MY")}<div class="page-body">
      <div class="card stack" style="text-align:center">
        <h2>월계온에 오신 걸 환영해요</h2>
        <p class="muted small" style="margin:0">로그인하면 행사 알림, 사진 신문고, 후기, 메모로 경로 짜기, 길 제보를 쓸 수 있어요.</p>
        <a class="btn primary block" href="#/login">로그인 / 가입하기</a>
      </div>${about()}</div></div>`;
    return;
  }
  const u = auth.user || {};
  view.innerHTML = `<div class="page">${pageHead("MY", { sub: `${esc(u.nickname || "")} · @${esc(u.username || "")}` })}<div class="page-body">
    <div class="list">
      <a class="item" href="#/notifications"><div class="grow"><div class="t">알림</div><div class="m">행사 소식, 신고 처리 결과</div></div><span id="me-unread" class="chip" hidden></span></a>
      <a class="item" href="#/news?mode=fav"><div class="grow"><div class="t">내 일정</div><div class="m">하트를 누른 행사</div></div></a>
      <a class="item" href="#/report"><div class="grow"><div class="t">내 신고</div><div class="m">사진 신문고 처리 현황</div></div></a>
      <a class="item" href="#/plan"><div class="grow"><div class="t">메모로 경로 짜기</div><div class="m">살 것·할 일로 들를 곳 정하기</div></div></a>
      ${u.is_admin ? `<a class="item" href="/admin" target="_self"><div class="grow"><div class="t">관리자 화면</div><div class="m">행사 승인, 신고 처리, 길 제보 검토</div></div></a>` : ""}
    </div>
    <div class="card stack">
      <h2>알림 받을 행사</h2>
      <p class="small muted" style="margin:-4px 0 0">새 행사가 올라오면 앱 안에서 알려드려요.</p>
      <div class="pick" id="noti-cats">${Object.entries(CATS).map(([k, l]) => `<button type="button" data-c="${k}" aria-pressed="${(u.notify_categories || []).includes(k)}">${l}</button>`).join("")}</div>
    </div>
    <div class="card stack">
      <h2>내 길 제보</h2><div id="my-paths" class="small muted">불러오는 중…</div>
    </div>
    <div class="card stack">
      <h2>계정</h2>
      <label class="field">닉네임<div class="row"><input class="input grow" id="nick" maxlength="20" value="${esc(u.nickname || "")}"><button class="btn sm" id="save-nick" type="button">저장</button></div></label>
      <label class="field">새 비밀번호<div class="row"><input class="input grow" id="pw" type="password" minlength="6" autocomplete="new-password" placeholder="6자 이상"><button class="btn sm" id="save-pw" type="button">변경</button></div></label>
      <div class="row"><button class="btn grow" id="logout" type="button">로그아웃</button><button class="btn ghost danger" id="leave" type="button">탈퇴</button></div>
    </div>
    ${about()}
  </div></div>`;

  api("/api/notifications/unread").then(r => { const c = view.querySelector("#me-unread"); if (c && r.unread) { c.hidden = false; c.textContent = `${r.unread}개`; } }).catch(() => {});
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
  view.querySelector("#logout").addEventListener("click", () => { auth.logout(); toast("로그아웃했어요."); me(view, ctx); });
  view.querySelector("#leave").addEventListener("click", async () => {
    if (!confirm("탈퇴하면 신고·후기·메모가 모두 지워집니다. 탈퇴할까요?")) return;
    try { await api("/api/auth/me", { method: "DELETE" }); auth.logout(); toast("탈퇴했어요."); me(view, ctx); } catch (e) { toast(e.message); }
  });
  try {
    const rows = await api("/api/map/paths/mine");
    const el = view.querySelector("#my-paths");
    if (el) el.innerHTML = rows.length ? rows.map(p => `<div class="row" style="padding:4px 0"><span class="chip ${p.status === "approved" ? "resolved" : p.status === "rejected" ? "rejected" : "received"}">${p.status === "approved" ? "반영됨" : p.status === "rejected" ? "반려" : "검토 중"}</span><span class="grow" style="color:#1d2433">${esc(p.kind_label)}${p.note ? " · " + esc(p.note) : ""}</span></div>`).join("")
      : `아직 제보한 길이 없어요. <a href="#/path-edit">길 정보 제보하기</a>`;
  } catch (_) { /* 무시 */ }
}

function about() {
  return `<div class="card small muted stack" style="gap:4px">
    <b style="color:#1d2433">월계온 (Wolgye-ON)</b>
    <span>월계1동 지도 데이터 © OpenStreetMap 기여자 (ODbL)</span>
    <span>행사 정보: 서울 열린데이터광장 문화행사 정보, 광운대학교 공지사항</span>
    <span>사진 분류: 생성형 AI API (Google Gemini 또는 Anthropic Claude)</span>
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
