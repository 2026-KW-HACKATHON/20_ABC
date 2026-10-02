// 공통 UI 도구: 토스트, 아래 창, 날짜 표시, HTML 이스케이프
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------------- 아래에서 올라오는 창
const sheet = () => $("#sheet");
let onSheetClose = null;
export function openSheet(html, { onClose } = {}) {
  const s = sheet();
  $("#sheet-body").innerHTML = html;
  $("#sheet-body").scrollTop = 0;
  s.classList.add("open");
  s.setAttribute("aria-hidden", "false");
  onSheetClose = onClose || null;   // 내용만 바꿀 때는 이전 콜백을 부르지 않음
  return $("#sheet-body");
}
export function closeSheet() {
  const s = sheet();
  if (!s.classList.contains("open")) return;
  s.classList.remove("open");
  s.setAttribute("aria-hidden", "true");
  const f = onSheetClose; onSheetClose = null;
  if (f) f();
}
export function sheetIsOpen() { return sheet().classList.contains("open"); }

export function initSheet() {
  $("#sheet-x").addEventListener("click", closeSheet);
  let y0 = null;
  const s = sheet();
  s.addEventListener("touchstart", e => { if ($("#sheet-body").scrollTop <= 0) y0 = e.touches[0].clientY; }, { passive: true });
  s.addEventListener("touchend", e => { if (y0 !== null && e.changedTouches[0].clientY - y0 > 70) closeSheet(); y0 = null; }, { passive: true });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });
}

// ---------------- 날짜 (서버 시각은 한국시간)
export function kst(s) { return s ? new Date(s.length <= 16 ? s + ":00+09:00" : s + "+09:00") : null; }
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
export function fmtDate(s, withTime = true) {
  const d = kst(s);
  if (!d) return "";
  const k = new Date(d.getTime() + 9 * 3600e3); // 한국시간 필드로 읽기
  const base = `${k.getUTCMonth() + 1}월 ${k.getUTCDate()}일 (${DOW[k.getUTCDay()]})`;
  if (!withTime) return base;
  const h = k.getUTCHours(), m = k.getUTCMinutes();
  return h === 0 && m === 0 ? base : `${base} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
export function kstParts(s) {
  const d = kst(s);
  if (!d) return null;
  const k = new Date(d.getTime() + 9 * 3600e3);
  return { y: k.getUTCFullYear(), m: k.getUTCMonth() + 1, d: k.getUTCDate(), dow: DOW[k.getUTCDay()], h: k.getUTCHours(), min: k.getUTCMinutes() };
}
export function todayKst() {
  const k = new Date(Date.now() + 9 * 3600e3);
  return { y: k.getUTCFullYear(), m: k.getUTCMonth() + 1, d: k.getUTCDate() };
}
export function ago(s) {
  const d = kst(s);
  if (!d) return "";
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 60) return "방금";
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}일 전`;
  return fmtDate(s, false);
}
export function eventWhen(e) {
  if (!e.start_at) return e.time_text || "일정 미정";
  const a = kstParts(e.start_at), b = e.end_at ? kstParts(e.end_at) : null;
  if (b && (a.y !== b.y || a.m !== b.m || a.d !== b.d)) return `${fmtDate(e.start_at, false)} ~ ${b.m}월 ${b.d}일`;
  return fmtDate(e.start_at);
}

export const fmtDist = m => m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
export const fmtMin = (m, speed = 67) => `${Math.max(1, Math.round(m / speed))}분`;

export const ICON = {
  back: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>`,
  heart: on => `<svg viewBox="0 0 24 24" width="18" height="18" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9z"/></svg>`,
  route: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h7a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h7"/></svg>`,
  swap: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3"/></svg>`,
  camera: `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`,
  pin: `<svg viewBox="0 0 30 40" width="30" height="40"><path d="M15 1C7.3 1 1 7.3 1 15c0 10.5 14 24 14 24s14-13.5 14-24C29 7.3 22.7 1 15 1z" fill="#e8542f" stroke="#fff" stroke-width="2"/><circle cx="15" cy="15" r="5" fill="#fff"/></svg>`,
};

export function pageHead(title, { back = false, sub = "", right = "" } = {}) {
  return `<header class="page-head">
    ${back ? `<button class="back" type="button" data-back aria-label="뒤로">${ICON.back}</button>` : ""}
    <div class="grow"><h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ""}</div>${right}
  </header>`;
}

export function bindBack(root) {
  root.querySelectorAll("[data-back]").forEach(b => b.addEventListener("click", () => {
    if (history.length > 1) history.back(); else location.hash = "#/map";
  }));
}

export function loginCard(msg) {
  return `<div class="card stack" style="text-align:center">
    <h2>로그인이 필요해요</h2>
    <p class="muted small" style="margin:0">${esc(msg)}</p>
    <a class="btn primary block" href="#/login?next=${encodeURIComponent(location.hash)}">로그인 / 가입하기</a>
  </div>`;
}

// 사진을 1600px 이하 JPEG로 줄여서 올림 (데이터 절약)
export function shrinkImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => b ? resolve(b) : reject(new Error("사진 변환 실패")), "image/jpeg", 0.86);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("사진을 열 수 없습니다.")); };
    img.src = url;
  });
}
