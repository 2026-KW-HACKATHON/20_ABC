// 소식: 다가오는 행사 목록 + 이달의 달력
import { api, auth } from "../api.js";
import { esc, eventWhen, kstParts, pageHead, todayKst } from "../ui.js";

const CATS = [["", "전체"], ["culture", "문화·예술"], ["academic", "학술·교육"], ["community", "지역·참여"]];
const state = { mode: "list", cat: "", q: "", ym: null, day: null };

export async function render({ view, params }) {
  document.body.classList.add("page-open");
  if (params?.get("mode") && auth.loggedIn) { state.mode = params.get("mode"); history.replaceState(null, "", "#/news"); }
  const t = todayKst();
  if (!state.ym) state.ym = { y: t.y, m: t.m };
  view.innerHTML = `<div class="page">
    ${pageHead("동네 소식", { sub: "광운대·노원구 행사를 한곳에서" })}
    <div class="page-body">
      <div class="seg" role="group" aria-label="보기 방식">
        <button type="button" data-mode="list" aria-pressed="${state.mode === "list"}">다가오는 행사</button>
        <button type="button" data-mode="cal" aria-pressed="${state.mode === "cal"}">이달의 달력</button>
        ${auth.loggedIn ? `<button type="button" data-mode="fav" aria-pressed="${state.mode === "fav"}">내 일정</button>` : ""}
      </div>
      <div class="row">
        <input class="input grow" id="news-q" type="search" placeholder="행사 이름·장소 검색" value="${esc(state.q)}" autocomplete="off">
      </div>
      <div class="pick" role="group" aria-label="분류">${CATS.map(([k, l]) => `<button type="button" data-cat="${k}" aria-pressed="${state.cat === k}">${l}</button>`).join("")}</div>
      <div id="news-body"><div class="empty"><span class="spinner"></span></div></div>
    </div></div>`;

  view.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => { state.mode = b.dataset.mode; render({ view }); }));
  view.querySelectorAll("[data-cat]").forEach(b => b.addEventListener("click", () => { state.cat = b.dataset.cat; render({ view }); }));
  let timer;
  view.querySelector("#news-q").addEventListener("input", e => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = e.target.value.trim(); load(view); }, 300);
  });
  load(view);
}

async function load(view) {
  const body = view.querySelector("#news-body");
  if (!body) return;
  const qs = new URLSearchParams();
  if (state.cat) qs.set("category", state.cat);
  if (state.q) qs.set("q", state.q);
  let rows;
  try {
    if (state.mode === "fav") rows = await api("/api/events/favorites");
    else if (state.mode === "cal") { qs.set("when", "month"); qs.set("year", state.ym.y); qs.set("month", state.ym.m); rows = await api("/api/events?" + qs); }
    else rows = await api("/api/events?" + qs);
  } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (state.mode === "fav" && (state.cat || state.q)) rows = rows.filter(r => (!state.cat || r.category === state.cat) && (!state.q || r.title.includes(state.q)));
  if (state.mode === "cal") { body.innerHTML = calendar(rows) + `<div id="cal-list" style="margin-top:14px"></div>`; bindCal(view, rows); return; }
  body.innerHTML = rows.length ? list(rows) : `<div class="empty">${state.mode === "fav" ? "하트를 누른 행사가 여기 모여요." : "조건에 맞는 행사가 없어요."}</div>`;
}

function list(rows) {
  return `<div class="list">${rows.map(e => {
    const p = e.start_at ? kstParts(e.start_at) : null;
    return `<a class="item" href="#/event/${e.id}">
      <div class="date-box">${p ? `<b>${p.d}</b><small>${p.m}월 ${p.dow}</small>` : `<b>–</b><small>미정</small>`}</div>
      <div class="grow">
        <div class="row wrap" style="gap:6px;margin-bottom:3px"><span class="chip ${e.category}">${esc(e.category_label)}</span>${e.is_favorite ? `<span class="chip" style="color:#e8542f">♥ 내 일정</span>` : ""}</div>
        <div class="t">${esc(e.title)}</div>
        <div class="m">${esc(eventWhen(e))}${e.place_name ? " · " + esc(e.place_name) : ""}</div>
        ${e.review_count ? `<div class="m"><span class="stars">★</span> ${e.avg_rating} · 후기 ${e.review_count}</div>` : ""}
      </div></a>`;
  }).join("")}</div>`;
}

function calendar(rows) {
  const { y, m } = state.ym;
  const first = new Date(Date.UTC(y, m - 1, 1));
  const startDow = first.getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const t = todayKst();
  const byDay = {};
  rows.forEach(e => {
    if (!e.start_at) return;
    const a = kstParts(e.start_at), b = e.end_at ? kstParts(e.end_at) : a;
    const s = (a.y === y && a.m === m) ? a.d : 1;
    const en = (b.y === y && b.m === m) ? b.d : days;
    for (let d = s; d <= Math.min(en, days); d++) (byDay[d] = byDay[d] || []).push(e);
  });
  let cells = "";
  for (let i = 0; i < startDow; i++) cells += `<button type="button" class="out" disabled></button>`;
  for (let d = 1; d <= days; d++) {
    const evs = byDay[d] || [];
    const cats = [...new Set(evs.map(e => e.category))].slice(0, 3);
    const isToday = t.y === y && t.m === m && t.d === d;
    cells += `<button type="button" data-day="${d}" class="${isToday ? "today" : ""}" aria-pressed="${state.day === d}" aria-label="${m}월 ${d}일 행사 ${evs.length}개">
      <span>${d}</span><span class="dots">${cats.map(c => `<i class="${c}"></i>`).join("")}</span></button>`;
  }
  return `<div class="cal">
    <div class="cal-head">
      <button class="btn sm ghost" type="button" data-nav="-1" aria-label="이전 달">‹</button>
      <strong>${y}년 ${m}월</strong>
      <button class="btn sm ghost" type="button" data-nav="1" aria-label="다음 달">›</button>
    </div>
    <div class="cal-grid">${"일월화수목금토".split("").map(d => `<div class="dow">${d}</div>`).join("")}${cells}</div>
  </div>`;
  // byDay 는 bindCal 에서 다시 계산
}

function bindCal(view, rows) {
  view.querySelectorAll("[data-nav]").forEach(b => b.addEventListener("click", () => {
    let { y, m } = state.ym;
    m += +b.dataset.nav;
    if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; }
    state.ym = { y, m }; state.day = null;
    load(view);
  }));
  const showDay = d => {
    const { y, m } = state.ym;
    const evs = rows.filter(e => {
      if (!e.start_at) return false;
      const a = kstParts(e.start_at), b = e.end_at ? kstParts(e.end_at) : a;
      const key = (p) => p.y * 10000 + p.m * 100 + p.d, cur = y * 10000 + m * 100 + d;
      return key(a) <= cur && cur <= key(b);
    });
    view.querySelector("#cal-list").innerHTML = evs.length ? `<h3 style="margin:0 0 8px">${m}월 ${d}일</h3>` + list(evs) : `<div class="empty">${m}월 ${d}일에는 행사가 없어요.</div>`;
  };
  view.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", () => {
    state.day = +b.dataset.day;
    view.querySelectorAll("[data-day]").forEach(x => x.setAttribute("aria-pressed", x === b));
    showDay(state.day);
  }));
  const t = todayKst();
  if (state.day) showDay(state.day);
  else if (t.y === state.ym.y && t.m === state.ym.m) showDay(t.d);
  else view.querySelector("#cal-list").innerHTML = rows.length ? list(rows) : `<div class="empty">이 달에는 행사가 없어요.</div>`;
}

