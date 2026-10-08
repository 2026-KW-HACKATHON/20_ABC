// 기기 설정 (이 휴대폰·브라우저에만 저장) + 안드로이드 앱 연결
//  · 화면 테마: system(기기 설정 따름) / light / dark  — index.html 머리의 짧은 스크립트가 처음 그릴 때 바로 적용
//  · 휴대폰 알림(앱 전용): push 켜기/끄기, promo(근처 행사 추천) 켜기/끄기
//  · 로그인 토큰을 앱에 넘겨, 화면을 닫아도 앱이 15분마다 내 알림을 가져올 수 있게 함
import { auth } from "./api.js";

const KEY = "wolgyeon.prefs";
const DEF = { theme: "system", push: true, promo: true };
export const bridge = window.WolgyeonAndroid || null;        // 안드로이드 앱 안에서만 있음

let cur = (() => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch (_) { return { ...DEF }; } })();

export function getPref(k) { return cur[k]; }
export function setPref(k, v) {
  cur[k] = v;
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch (_) {}
  if (k === "theme") applyTheme();
  if (k === "push" || k === "promo") syncApp();
}

const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
export function applyTheme() {
  const dark = cur.theme === "dark" || (cur.theme === "system" && mq?.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#111113" : "#171717");
}

export function syncApp() {
  if (!bridge) return;
  try {
    bridge.setPrefs(JSON.stringify({ push: !!cur.push, promo: !!cur.promo }));
    bridge.setAuth(auth.token || "");
  } catch (_) { /* 옛 버전 앱 */ }
}

// 알림 권한 (앱): "granted" | "denied" | null(앱이 아님)
export function notifPermission() {
  try { return bridge ? bridge.notifPermission() : null; } catch (_) { return null; }
}
export function askNotifPermission() {
  return new Promise(res => {
    if (!bridge) return res(null);
    window.__wgNotifPerm = st => { window.__wgNotifPerm = null; res(st); };
    try { bridge.requestNotifPermission(); } catch (_) { res(null); }
    setTimeout(() => { if (window.__wgNotifPerm) { window.__wgNotifPerm = null; res(notifPermission()); } }, 20000);
  });
}
export function testNotification() { try { bridge?.testNotification(); } catch (_) {} }

export function initPrefs() {
  applyTheme();
  mq?.addEventListener?.("change", applyTheme);
  syncApp();
  auth.onChange(syncApp);            // 로그인·로그아웃하면 앱에도 알려줌
}
