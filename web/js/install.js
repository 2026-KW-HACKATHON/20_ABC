// 웹으로 들어온 사람에게 앱 설치 안내
//  · 안드로이드·PC: 서버에 APK가 올라와 있으면(관리자 대시보드에서 올리거나 server/data/download/wolgyeon.apk) 내려받기 안내
//    APK가 아직 없으면 '홈 화면에 설치'(크롬 PWA 설치) 안내
//  · 아이폰: APK를 설치할 수 없으니 '홈 화면에 추가' 안내
//  · 앱(WebView, UA에 WolgyeonApp) 안이거나 홈 화면 앱으로 연 경우에는 띄우지 않음
//  · '나중에'를 누르면 3일 동안 다시 안 띄움
import { api } from "./api.js";
import { esc } from "./ui.js";

const KEY = "wolgyeon.installSnooze";
const SNOOZE_MS = 3 * 864e5;
const UA = navigator.userAgent || "";
export const IS_APP = /WolgyeonApp/i.test(UA);
export const IS_IOS = /iPhone|iPad|iPod/i.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/i.test(UA);
const STANDALONE = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;

// 크롬(안드로이드·PC)의 '앱 설치' 기회를 잡아 둠 — 페이지가 열리자마자 와서 모듈이 읽힐 때 등록
let deferred = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e; });

function snoozed() {
  try { return Date.now() - (+localStorage.getItem(KEY) || 0) < SNOOZE_MS; } catch (_) { return false; }
}
function snooze() { try { localStorage.setItem(KEY, String(Date.now())); } catch (_) {} }

function show(html) {
  const el = document.createElement("div");
  el.className = "inst-wrap";
  el.innerHTML = `<div class="inst-card" role="dialog" aria-modal="true" aria-labelledby="inst-t">${html}</div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("on"));
  const close = () => { snooze(); el.classList.remove("on"); setTimeout(() => el.remove(), 250); };
  el.addEventListener("click", e => { if (e.target === el) close(); });
  el.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", close));
  el.querySelector("[data-dl]")?.addEventListener("click", () => setTimeout(close, 300));
  return el;
}

const LOGO = `<span class="inst-logo" aria-hidden="true"><img src="/icons/icon-192.png" alt=""></span>`;

export async function initInstallPrompt() {
  if (IS_APP || STANDALONE || snoozed() || new URLSearchParams(location.search).has("noinstall")) return;
  await new Promise(r => setTimeout(r, 1500));          // 지도가 먼저 뜬 뒤에
  if (IS_IOS) {
    show(`${LOGO}
      <h2 id="inst-t">홈 화면에 월계온을 추가해 보세요</h2>
      <p>아이폰은 앱 파일(APK)을 설치할 수 없어요. 대신 아래 방법으로 홈 화면에 두면 앱처럼 바로 열 수 있어요.</p>
      <ol class="inst-steps"><li>아래쪽 <b>공유</b> 버튼(네모에 위쪽 화살표)을 눌러요</li><li><b>홈 화면에 추가</b>를 눌러요</li></ol>
      <button class="btn block" type="button" data-close>확인</button>`);
    return;
  }
  let info = null;
  try { info = await api("/api/app/apk"); } catch (_) { /* 서버 연결 실패 → 아래 PWA 안내 */ }
  if (!info?.available) {
    // APK가 아직 없을 때: 홈 화면에 설치(PWA) 안내. 크롬이 설치를 허락하지 않는 환경이면 방법만 알려줌
    const el = show(`${LOGO}
      <h2 id="inst-t">월계온을 앱처럼 설치해 보세요</h2>
      <p>홈 화면에 두면 바로 열리고, 동네 행사 소식과 내 위치·길찾기를 더 편하게 쓸 수 있어요.</p>
      ${deferred ? `<button class="btn primary block" type="button" id="inst-pwa">홈 화면에 설치하기</button>`
        : `<ol class="inst-steps"><li>브라우저 메뉴(⋮)를 눌러요</li><li><b>홈 화면에 추가</b> 또는 <b>앱 설치</b>를 눌러요</li></ol>`}
      <button class="btn ghost block" type="button" data-close>나중에 할게요</button>`);
    el.querySelector("#inst-pwa")?.addEventListener("click", async () => {
      try { deferred.prompt(); await deferred.userChoice; } catch (_) {}
      deferred = null; el.querySelector("[data-close]").click();
    });
    return;
  }
  show(`${LOGO}
    <h2 id="inst-t">월계온 앱으로 더 편하게 소식을 받아보세요</h2>
    <p>앱을 설치하면 홈 화면에서 바로 열리고, 동네 행사 소식과 내 위치·길찾기를 더 편하게 쓸 수 있어요.</p>
    <a class="btn primary block" href="${esc(info.url)}" download="wolgyeon.apk" data-dl>안드로이드 앱 내려받기${info.size_mb ? ` <small>(${info.size_mb}MB)</small>` : ""}</a>
    <p class="inst-note">${IS_ANDROID
      ? "내려받은 파일을 열고, '출처를 알 수 없는 앱' 설치를 물으면 <b>허용</b>해 주세요."
      : "안드로이드 휴대폰에서 이 주소를 열면 바로 설치할 수 있어요."}</p>
    <button class="btn ghost block" type="button" data-close>나중에 할게요</button>`);
}
