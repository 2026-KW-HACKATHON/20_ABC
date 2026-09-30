// 서버 API 호출 + 로그인 상태
const TOKEN_KEY = "wolgyeon.token";
const USER_KEY = "wolgyeon.user";

function store(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) {} }
function load(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }

export const auth = {
  token: load(TOKEN_KEY),
  user: (() => { try { return JSON.parse(load(USER_KEY) || "null"); } catch (_) { return null; } })(),
  listeners: new Set(),
  set(token, user) {
    this.token = token; this.user = user;
    store(TOKEN_KEY, token); store(USER_KEY, user ? JSON.stringify(user) : null);
    this.listeners.forEach(fn => fn(user));
  },
  logout() { this.set(null, null); },
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  get loggedIn() { return !!this.token; },
};

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function api(path, { method = "GET", body, form, signal } = {}) {
  const headers = {};
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload, signal });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ApiError(0, "인터넷 연결을 확인해주세요.");
  }
  if (res.status === 401 && auth.token) {
    auth.logout();
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) {
    let msg = "요청을 처리하지 못했습니다.";
    if (data && typeof data.detail === "string") msg = data.detail;
    else if (data && Array.isArray(data.detail)) msg = "입력한 내용을 다시 확인해주세요.";
    throw new ApiError(res.status, msg);
  }
  return data;
}

export async function refreshMe() {
  if (!auth.token) return null;
  try {
    const u = await api("/api/auth/me");
    auth.set(auth.token, u);
    return u;
  } catch (e) {
    return null;
  }
}
