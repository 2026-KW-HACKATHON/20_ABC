// 화면을 보고 있는 동안 새 알림을 바로 보여줌 (15초마다 확인)
//  · 관리자가 '직접 쓰기' 등으로 보낸 공지 → 로그인하지 않은 사람에게도 바로 위쪽 알림 카드로 표시
//  · 내 알림(즐겨찾기 행사 곧 시작 등) → 로그인한 사람에게
//  · 안드로이드 앱 안이면, 이미 보여준 알림을 앱에 알려 휴대폰 알림이 또 뜨지 않게 함
//  (화면을 닫았을 때는 앱의 FeedWorker 가 1분 간격으로 확인해 휴대폰 알림으로 띄움)
import { api, auth } from "./api.js";
import { bridge } from "./prefs.js";
import { esc } from "./ui.js";

const KEY = "wolgyeon.feed";
const EVERY_MS = 15000;
let st = (() => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (_) { return {}; } })();
let busy = false, onNew = null;

function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (_) {} }

function pop(items) {
  document.querySelector(".noti-pop")?.remove();
  const it = items[items.length - 1];
  const more = items.length > 1 ? ` <small>외 ${items.length - 1}건</small>` : "";
  const el = document.createElement("a");
  el.className = "noti-pop";
  el.href = it.link || "#/notifications";
  el.setAttribute("role", "status");
  el.innerHTML = `<span class="np-ic" aria-hidden="true">🔔</span><span class="np-txt"><b>${esc(it.title)}${more}</b>${it.body ? `<span>${esc(it.body)}</span>` : ""}</span>
    <button class="np-x" type="button" aria-label="닫기">×</button>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("on"));
  const close = () => { el.classList.remove("on"); setTimeout(() => el.remove(), 250); };
  el.querySelector(".np-x").addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); close(); });
  el.addEventListener("click", () => setTimeout(close, 50));
  setTimeout(close, 8000);
  if (navigator.vibrate) try { navigator.vibrate(60); } catch (_) {}
}

async function check() {
  if (busy || document.hidden) return;
  busy = true;
  try {
    const uid = auth.user?.id || 0;
    if (st.uid !== uid) { st.uid = uid; st.nt = -1; }          // 계정이 바뀌면 지난 알림은 다시 안 띄움
    const bc = st.bc ?? -1, nt = uid ? (st.nt ?? -1) : -1;
    const r = await api(`/api/app/feed?after_bc=${bc}&after_nt=${nt}`);
    const items = [...(r.broadcasts || []), ...(r.notifications || [])];
    st.bc = Math.max(bc, r.latest_bc || 0);
    if (uid) st.nt = Math.max(nt, r.latest_nt || 0);
    save();
    if (bridge) { try { bridge.markSeen(st.bc, uid ? st.nt : -1); } catch (_) { /* 옛 버전 앱 */ } }
    if (items.length) { pop(items); onNew?.(); }
  } catch (_) { /* 연결 끊김 — 다음에 다시 */ }
  busy = false;
}

export function initLivePush({ onNewItems } = {}) {
  onNew = onNewItems;
  setTimeout(check, 3000);
  setInterval(check, EVERY_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
  auth.onChange(() => setTimeout(check, 500));
}
