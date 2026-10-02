// 월계1동 실시간 소식 보드 — 내 위치가 월계1동 안일 때만, 지금 기준 가장 최근 소식 하나를 지도 위에 띄움
import { api } from "./api.js";
import { esc } from "./ui.js";

const KIND = { news: "뉴스", event: "행사", report: "신문고", construction: "공사" };
const DEMO = new URLSearchParams(location.search).get("demo") === "live";   // 전시 부스용: ?demo=live 면 위치와 상관없이 표시
let el, ctx, item = null, dismissed = "";

function ago(iso) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso + "+09:00").getTime()) / 60000));
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}시간 전`;
  return `${Math.floor(m / 1440)}일 전`;
}

function inDong() {
  return DEMO || (ctx.myPos && ctx.inArea(ctx.myPos[0], ctx.myPos[1]));
}

function key(it) { return it ? `${it.kind}:${it.link}:${it.time}` : ""; }

function paint() {
  const show = item && inDong() && key(item) !== dismissed;
  el.hidden = !show;
  if (!show) return;
  const ext = /^https?:/.test(item.link);
  el.innerHTML = `
    <a class="live-body" href="${esc(item.link)}"${ext ? ' target="_blank" rel="noopener"' : ""}>
      <span class="live-head"><span class="live-dot" aria-hidden="true"></span>LIVE 월계1동 · ${KIND[item.kind] || "소식"}<span class="live-time">${ago(item.time)}</span></span>
      <span class="live-title">${esc(item.title)}</span>
      <span class="live-src">${esc(item.source)}</span>
    </a>
    <button class="live-x" type="button" aria-label="소식 닫기">×</button>`;
  el.querySelector(".live-x").addEventListener("click", () => {
    dismissed = key(item);
    try { sessionStorage.setItem("wolgyeon.liveDismissed", dismissed); } catch (_) {}
    paint();
  });
}

async function refresh() {
  if (!inDong()) { paint(); return; }
  try { item = (await api("/api/live")).item; } catch (_) { /* 서버가 잠깐 안 되면 이전 소식 유지 */ }
  paint();
}

async function geoGranted() {
  try { return (await navigator.permissions.query({ name: "geolocation" })).state === "granted"; }
  catch (_) { return true; }   // 앱(WebView)처럼 권한 조회가 안 되는 곳은 그냥 시도
}

export async function initLiveBoard(context) {
  ctx = context;
  el = document.getElementById("live-board");
  try { dismissed = sessionStorage.getItem("wolgyeon.liveDismissed") || ""; } catch (_) {}
  // 내 위치가 바뀌면(내 위치 버튼 등) 다시 판단
  const orig = ctx.setMyPos.bind(ctx);
  let wasIn = inDong();
  ctx.setMyPos = pos => {
    orig(pos);
    const now = inDong();
    if (now !== wasIn || (now && !item)) refresh(); else paint();
    wasIn = now;
  };
  if (await geoGranted()) await ctx.locate({ silent: true });
  refresh();
  setInterval(async () => {
    if (document.hidden) return;
    if (!DEMO && await geoGranted()) await ctx.locate({ silent: true });
    refresh();
  }, 120000);
  setInterval(() => { if (!el.hidden) el.querySelector(".live-time").textContent = ago(item.time); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
}
