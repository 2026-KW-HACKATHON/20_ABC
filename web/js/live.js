// 월계1동 실시간 보드 — 내 위치가 월계1동 안일 때, 가까운 시일 안에 열리는 월계동 행사를 무작위로 돌아가며 보여줌
//  (뉴스·공사 소식은 넣지 않음)
import { api } from "./api.js";
import { catColor, catInk, kindIcon } from "./icons.js";
import { esc, eventWhen } from "./ui.js";

const DEMO = new URLSearchParams(location.search).get("demo") === "live";   // 전시 부스용: ?demo=live 면 위치와 상관없이 표시
const ROTATE_MS = 8000;
let el, ctx, items = [], idx = 0, closed = false, timer = null;

function inDong() {
  return DEMO || (ctx.myPos && ctx.inArea(ctx.myPos[0], ctx.myPos[1]));
}

function visibleItems() {
  return ctx.eventVisible ? items.filter(ctx.eventVisible) : items;
}

function paint(fade = false) {
  const list = visibleItems();
  const show = !closed && list.length && inDong();
  el.hidden = !show;
  if (!show) return;
  const e = list[idx % list.length];
  el.innerHTML = `
    <span class="live-ic" style="background:${catColor(e.category)};color:${catInk(e.category)}">${kindIcon(e.kind, 22, "currentColor", 2.2)}</span>
    <a class="live-body${fade ? " live-fade" : ""}" href="#/event/${e.id}">
      <span class="live-head"><span class="live-dot" aria-hidden="true"></span>LIVE 월계1동 · 곧 열리는 행사<span class="live-when">${esc(e.when_label)}</span></span>
      <span class="live-title">${esc(e.title)}</span>
      <span class="live-src">${esc(eventWhen(e))}${e.place_name ? " · " + esc(e.place_name) : ""}</span>
    </a>
    <button class="live-x" type="button" aria-label="보드 닫기">×</button>`;
  el.querySelector(".live-x").addEventListener("click", () => {
    closed = true;
    try { sessionStorage.setItem("wolgyeon.liveClosed", "1"); } catch (_) {}
    paint();
  });
}

async function refresh() {
  if (!inDong()) { paint(); return; }
  try { items = (await api("/api/live")).items || []; idx = 0; } catch (_) { /* 이전 목록 유지 */ }
  paint(true);
}

async function geoGranted() {
  // 아이폰 사파리는 한 번 허용해도 다음에 'prompt'로 알려주는 경우가 많아서, '거부'만 아니면 시도함
  try { return (await navigator.permissions.query({ name: "geolocation" })).state !== "denied"; }
  catch (_) { return true; }   // 앱(WebView)·옛 사파리처럼 권한 조회가 안 되는 곳은 그냥 시도
}

export async function initLiveBoard(context) {
  ctx = context;
  el = document.getElementById("live-board");
  try { closed = sessionStorage.getItem("wolgyeon.liveClosed") === "1"; } catch (_) {}
  const orig = ctx.setMyPos.bind(ctx);
  let wasIn = inDong(), lastTry = 0;
  ctx.setMyPos = (...args) => {        // 내 위치가 2초마다 바뀌어도, 월계1동 안/밖이 바뀔 때만 보드를 다시 그림
    orig(...args);
    const now = inDong();
    if (now !== wasIn) refresh();
    else if (now && !items.length && Date.now() - lastTry > 60000) { lastTry = Date.now(); refresh(); }
    wasIn = now;
  };
  ctx.refreshLive = () => paint();            // 필터를 바꾸면 다시 그림
  if (await geoGranted()) await ctx.locate({ silent: true });
  refresh();
  timer = setInterval(() => { if (!document.hidden && !el.hidden && visibleItems().length > 1) { idx++; paint(true); } }, ROTATE_MS);
  setInterval(async () => {                    // 10분마다 목록·위치 새로
    if (document.hidden) return;
    if (!DEMO && await geoGranted()) await ctx.locate({ silent: true });
    refresh();
  }, 600000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
}
