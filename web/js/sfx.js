// 버튼 효과음 — Kenney Interface Sounds (CC0, web/sfx/CREDITS.txt)
//  · 일반 버튼·링크: tap / 켜고 끄는 버튼(aria-pressed·체크박스·즐겨찾기): toggle / 뒤로: back
//  · Web Audio 로 미리 디코딩해 두고 짧게 재생 (지연이 적고, 여러 번 눌러도 겹쳐 재생됨)
//  · 끄기: 지도 설정(☰) 또는 MY → 설정 → '버튼 효과음' (localStorage wolgyeon.sfx = "0")
const FILES = { tap: "/sfx/tap.wav", toggle: "/sfx/toggle.wav", back: "/sfx/back.wav" };
const VOLUME = { tap: 0.28, toggle: 0.3, back: 0.3 };
const KEY = "wolgyeon.sfx";

let actx = null, loading = null;
const bufs = {};
let enabled = (() => { try { return localStorage.getItem(KEY) !== "0"; } catch (_) { return true; } })();
let volume = (() => { try { const v = parseFloat(localStorage.getItem(KEY + "Vol")); return v >= 0 && v <= 1 ? v : 0.8; } catch (_) { return 0.8; } })();

export function sfxVolume() { return volume; }
export function setSfxVolume(v) {
  volume = Math.max(0, Math.min(1, +v || 0));
  try { localStorage.setItem(KEY + "Vol", String(volume)); } catch (_) {}
}

export function sfxOn() { return enabled; }
export function setSfx(on) {
  enabled = !!on;
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (_) {}
  if (on) { prepare(); play("toggle"); }
}

function prepare() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!actx) actx = new AC();
  if (actx.state === "suspended") actx.resume().catch(() => {});
  if (!loading) {
    loading = Promise.all(Object.entries(FILES).map(async ([k, url]) => {
      try {
        const data = await (await fetch(url)).arrayBuffer();
        bufs[k] = await new Promise((res, rej) => actx.decodeAudioData(data, res, rej));
      } catch (_) { /* 소리 파일이 없어도 앱은 그대로 */ }
    }));
  }
  return loading;
}

export function play(name = "tap") {
  if (!enabled) return;
  prepare();
  const b = bufs[name];
  if (!actx || !b) return;           // 첫 터치에서 아직 불러오는 중이면 그 한 번은 조용히
  const src = actx.createBufferSource(), g = actx.createGain();
  g.gain.value = (VOLUME[name] ?? 0.3) * volume * 1.25;
  src.buffer = b;
  src.connect(g).connect(actx.destination);
  src.start();
}

const CLICKABLE = "button, a[href], [role=button], summary, input[type=checkbox], input[type=radio], .leaflet-marker-icon";
const TEXTY = "input[type=text], input[type=search], input[type=password], input:not([type]), textarea, select";

function kindOf(el) {
  if (el.matches("[data-back], #ev-back, .back, [aria-label='뒤로']")) return "back";
  if (el.matches("input[type=checkbox], input[type=radio], [aria-pressed], #ev-fav, .kcat")) return "toggle";
  return "tap";
}

export function initSfx() {
  // 첫 터치 때 소리를 준비 (브라우저는 사용자 동작 전에는 소리를 막음)
  if (enabled) prepare();            // 소리 파일은 미리 불러 둠 (재생은 첫 터치 뒤부터)
  const warm = () => { if (enabled) prepare(); };
  document.addEventListener("pointerdown", warm, { capture: true, passive: true });
  document.addEventListener("click", e => {
    const el = e.target.closest?.(CLICKABLE);
    if (!el || el.matches(TEXTY) || el.disabled || el.getAttribute("aria-disabled") === "true" || "nosfx" in el.dataset) return;
    play(kindOf(el));
  }, true);
}
