// 소식: 다가오는 행사 목록 + 이달의 달력(날짜별 메모) + 연관어 검색
//  - 목록·달력·지도에는 월계동 안 행사만 보임 (area=1)
//  - 월계동 밖 행사는 검색했을 때만 '월계동 밖' 표시와 함께 나옴
//  - 달력: 1주일 미만 짧은 행사만 날짜마다 점으로, 1주일 이상 이어지는 긴 행사는 따로 모아 보여줌
import { api, auth } from "../api.js";
import { evBadge, kindTag } from "../icons.js";
import { esc, eventState, eventWhen, kstParts, pageHead, toast, todayKst } from "../ui.js";

const CATS = [["", "전체"], ["culture", "문화·예술"], ["academic", "학술·교육"], ["community", "지역·참여"]];
const LONG_DAYS = 7;          // 이 날수 이상 이어지는 행사는 '긴 행사'
const DOW = "일월화수목금토";
const state = { mode: "list", cat: "", q: "", past: false, ym: null, day: null, hl: null };

export async function render({ view, params, path }) {
  document.body.classList.add("page-open");
  const pm = params?.get("mode");
  if (pm === "cal" || pm === "list" || (pm === "fav" && auth.loggedIn)) state.mode = pm;
  const date = params?.get("date");
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {        // 행사 상세의 '캘린더' 버튼 → 그 날짜를 연 달력
    const [y, m, d] = date.split("-").map(Number);
    state.mode = "cal"; state.ym = { y, m }; state.day = d; state.q = "";
  }
  state.hl = params?.get("ev") ? +params.get("ev") : null;
  const isSearch = path === "/search";
  const focus = params?.get("focus") === "1" || isSearch;
  if (focus) state.mode = state.mode === "fav" ? "list" : state.mode;
  if (pm || date || params?.get("focus")) history.replaceState(null, "", "#/news");
  const t = todayKst();
  if (!state.ym) state.ym = { y: t.y, m: t.m };
  view.innerHTML = `<div class="page">
    ${pageHead(isSearch ? "행사 검색" : state.mode === "fav" ? "즐겨찾기" : "동네 소식", { sub: isSearch ? "이름·내용에 없어도 관련된 행사까지 찾아줘요 · 다른 동네 행사도 나와요" : state.mode === "fav" ? "북마크한 행사를 모아봐요" : "월계동 행사를 한곳에서 · 다른 동네 행사는 검색으로" })}
    <div class="page-body">
      <div class="seg" role="group" aria-label="보기 방식">
        <button type="button" data-mode="list" aria-pressed="${state.mode === "list"}">다가오는 행사</button>
        <button type="button" data-mode="cal" aria-pressed="${state.mode === "cal"}">이달의 달력</button>
        ${auth.loggedIn ? `<button type="button" data-mode="fav" aria-pressed="${state.mode === "fav"}">즐겨찾기</button>` : ""}
      </div>
      <div class="srch">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input class="grow" id="news-q" type="search" placeholder="행사 검색 · 예: 아이, 음악, 무료, 월계도서관" value="${esc(state.q)}" autocomplete="off" enterkeyhint="search" aria-label="행사 검색">
      </div>
      ${isSearch && !state.q ? `<div class="srch-rel" id="sugg">이렇게 찾아보세요 ${["아이", "음악", "무료", "전시", "운동", "어르신", "책", "축제"].map(w => `<button type="button" data-sg="${w}">${w}</button>`).join("")}</div>` : ""}
      <div class="pick" role="group" aria-label="분류">${CATS.map(([k, l]) => `<button type="button" data-cat="${k}" aria-pressed="${state.cat === k}">${l}</button>`).join("")}</div>
      <div id="news-body"><div class="empty"><span class="spinner"></span></div></div>
    </div></div>`;

  view.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => { state.mode = b.dataset.mode; state.q = ""; render({ view }); }));
  view.querySelectorAll("[data-cat]").forEach(b => b.addEventListener("click", () => {
    state.cat = b.dataset.cat;
    view.querySelectorAll("[data-cat]").forEach(x => x.setAttribute("aria-pressed", x === b));
    load(view);
  }));
  let timer;
  const qEl = view.querySelector("#news-q");
  qEl.addEventListener("input", e => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = e.target.value.trim(); load(view); }, 350);
  });
  view.querySelectorAll("[data-sg]").forEach(b => b.addEventListener("click", () => {
    state.q = qEl.value = b.dataset.sg; view.querySelector("#sugg")?.remove(); load(view);
  }));
  qEl.addEventListener("keydown", e => { if (e.key === "Enter") { clearTimeout(timer); state.q = qEl.value.trim(); qEl.blur(); load(view); } });
  load(view);
  if (focus) setTimeout(() => qEl.focus(), 50);
}

async function load(view) {
  const body = view.querySelector("#news-body");
  if (!body) return;
  if (state.q && state.mode !== "fav") return searchView(view, body);
  const qs = new URLSearchParams({ area: "1" });
  if (state.cat) qs.set("category", state.cat);
  let rows;
  try {
    if (state.mode === "fav") rows = await api("/api/events/favorites");
    else if (state.mode === "cal") { qs.set("when", "month"); qs.set("year", state.ym.y); qs.set("month", state.ym.m); rows = await api("/api/events?" + qs); }
    else rows = await api("/api/events?" + qs);
  } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (!view.isConnected) return;
  if (state.mode === "fav" && (state.cat || state.q)) rows = rows.filter(r => (!state.cat || r.category === state.cat) && (!state.q || (r.title + r.place_name).includes(state.q)));
  if (state.mode === "cal" && state.hl && !rows.some(r => r.id === state.hl)) {
    // 검색으로 본 월계동 밖 행사에서 '캘린더'를 누른 경우: 그 행사만 달력에 함께 보여줌
    try { const x = await api(`/api/events/${state.hl}`); if (x.start_at) rows = [...rows, x]; } catch (_) {}
  }
  if (state.mode === "cal") return calView(view, body, rows);
  body.innerHTML = rows.length ? list(rows) + (state.mode === "list" ? `<p class="note center" style="margin-top:14px">월계동 밖에서 열리는 행사는 위 검색창으로 찾을 수 있어요.</p>` : "")
    : `<div class="empty">${state.mode === "fav" ? "북마크(즐겨찾기)한 행사가 여기 모여요." : "월계동에서 열리는 행사가 아직 없어요.<br>검색하면 다른 동네 행사도 볼 수 있어요."}</div>`;
}

function list(rows, { reasons = false } = {}) {
  return `<div class="list">${rows.map(e => {
    const st = eventState(e);
    return `<a class="item${state.hl === e.id ? " hl" : ""}" href="#/event/${e.id}" data-eid="${e.id}">
      ${evBadge(e, 44)}
      <div class="grow">
        <div class="row wrap" style="gap:6px;margin-bottom:3px">${kindTag(e)}<span class="st-chip ${st.cls}">${st.label}</span>${e.in_area === false ? `<span class="chip outside">월계동 밖</span>` : ""}${e.is_favorite ? `<span class="chip" style="color:#ee3f5b">♥ 즐겨찾기</span>` : ""}</div>
        <div class="t">${esc(e.title)}</div>
        <div class="m">${esc(eventWhen(e))}${e.place_name ? " · " + esc(e.place_name) : ""}</div>
        ${reasons && e.reasons?.length ? `<div class="why">${e.reasons.map(esc).join(" · ")}</div>` : ""}
        ${e.review_count ? `<div class="m"><span class="stars">★</span> ${e.avg_rating} · 후기 ${e.review_count}</div>` : ""}
      </div></a>`;
  }).join("")}</div>`;
}

// ------------------------------------------------------------------ 검색
async function searchView(view, body) {
  const q = state.q;
  body.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
  const qs = new URLSearchParams({ q });
  if (state.cat) qs.set("category", state.cat);
  if (state.past) qs.set("past", "true");
  let r;
  try { r = await api("/api/events/search?" + qs); }
  catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (!view.isConnected || state.q !== q) return;
  const inside = r.items.filter(e => e.in_area), outside = r.items.filter(e => !e.in_area);
  body.innerHTML = `
    <div class="srch-head"><strong>'${esc(q)}' 검색 결과 ${r.items.length}개</strong>
      <label class="srch-past"><input type="checkbox" id="s-past" ${state.past ? "checked" : ""}> 지난 행사 포함</label></div>
    ${r.related.length ? `<div class="srch-rel">함께 찾은 말 ${r.related.map(w => `<button type="button" data-rel="${esc(w)}">${esc(w)}</button>`).join("")}</div>` : ""}
    ${r.items.length ? "" : `<div class="empty">'${esc(q)}'와 관련된 행사를 찾지 못했어요.<br>다른 낱말로 찾아보세요.</div>`}
    ${inside.length ? `<h3 class="srch-sec">월계동 행사 <span>${inside.length}</span></h3>` + list(inside, { reasons: true }) : ""}
    ${outside.length ? `<h3 class="srch-sec">월계동 밖 행사 <span>${outside.length}</span></h3><p class="note" style="margin:-4px 0 8px">지도·달력에는 나오지 않는 다른 동네 행사예요.</p>` + list(outside, { reasons: true }) : ""}`;
  body.querySelector("#s-past").addEventListener("change", e => { state.past = e.target.checked; load(view); });
  body.querySelectorAll("[data-rel]").forEach(b => b.addEventListener("click", () => {
    state.q = b.dataset.rel; view.querySelector("#news-q").value = state.q; load(view);
  }));
}

// ------------------------------------------------------------------ 달력
const dkey = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const num = p => p.y * 10000 + p.m * 100 + p.d;
function spanDays(e) {
  const a = kstParts(e.start_at), b = e.end_at ? kstParts(e.end_at) : a;
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 864e5) + 1;
}
const isLong = e => e.start_at && spanDays(e) >= LONG_DAYS;
function onDay(e, y, m, d) {
  if (!e.start_at) return false;
  const a = kstParts(e.start_at), b = e.end_at ? kstParts(e.end_at) : a, cur = y * 10000 + m * 100 + d;
  return num(a) <= cur && cur <= num(b);
}

async function calView(view, body, rows) {
  const { y, m } = state.ym;
  const notes = await loadNotes(y, m);
  if (!view.isConnected) return;
  const short = rows.filter(e => e.start_at && !isLong(e)), long = rows.filter(isLong);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const startDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const t = todayKst();
  if (!state.day) state.day = (t.y === y && t.m === m) ? t.d : 1;
  if (state.day > days) state.day = days;
  let cells = "";
  for (let i = 0; i < startDow; i++) cells += `<span class="out"></span>`;
  for (let d = 1; d <= days; d++) {
    const evs = short.filter(e => onDay(e, y, m, d));
    const cats = [...new Set(evs.map(e => e.category))].slice(0, 3);
    const memo = notes[dkey(y, m, d)];
    const isToday = t.y === y && t.m === m && t.d === d;
    cells += `<button type="button" data-day="${d}" class="${isToday ? "today" : ""}${memo ? " has-memo" : ""}" aria-pressed="${state.day === d}"
      aria-label="${m}월 ${d}일, 행사 ${evs.length}개${memo ? ", 메모 있음" : ""}">
      <span>${d}</span><span class="dots">${cats.map(c => `<i class="${c}"></i>`).join("")}</span>${memo ? `<b class="mm" aria-hidden="true"></b>` : ""}</button>`;
  }
  body.innerHTML = `<div class="cal">
      <div class="cal-head">
        <button class="btn sm ghost" type="button" data-nav="-1" aria-label="이전 달">‹</button>
        <strong>${y}년 ${m}월</strong>
        <button class="btn sm ghost" type="button" data-nav="1" aria-label="다음 달">›</button>
      </div>
      <div class="cal-grid">${DOW.split("").map(d => `<div class="dow">${d}</div>`).join("")}${cells}</div>
      <div class="cal-legend"><span><i class="dot-ev"></i>짧은 행사</span><span><b class="mm"></b>내 메모</span></div>
    </div>
    <div id="cal-day" style="margin-top:14px"></div>
    ${long.length ? `<details class="long-sec" id="long-sec">
      <summary><span><strong>이번 달 계속 이어지는 행사 ${long.length}개</strong><span class="note">전시·강좌·모집처럼 1주일 넘게 하는 행사는 날짜마다 점을 찍지 않고 여기 모았어요.</span></span></summary>
      ${list(long)}</details>` : ""}`;

  body.querySelectorAll("[data-nav]").forEach(b => b.addEventListener("click", () => {
    let { y: yy, m: mm } = state.ym;
    mm += +b.dataset.nav;
    if (mm < 1) { mm = 12; yy--; } if (mm > 12) { mm = 1; yy++; }
    state.ym = { y: yy, m: mm }; state.day = null; state.hl = null;
    load(view);
  }));
  const showDay = d => {
    const dayShort = short.filter(e => onDay(e, y, m, d)), dayLong = long.filter(e => onDay(e, y, m, d));
    const dow = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    const key = dkey(y, m, d), memo = notes[key] || "";
    const hlLong = dayLong.some(e => e.id === state.hl);
    body.querySelector("#cal-day").innerHTML = `
      <h3 class="day-h">${m}월 ${d}일 (${dow})</h3>
      <div class="memo">
        <label for="memo-t">내 메모</label>
        <textarea id="memo-t" rows="2" maxlength="500" placeholder="이 날 기억할 일을 적어두세요 (나만 보여요)">${esc(memo)}</textarea>
        <div class="row"><span class="note grow" id="memo-st">${auth.loggedIn ? "로그인한 계정에 저장돼요" : "이 기기에만 저장돼요 · 로그인하면 계정에 옮겨져요"}</span>
          <button class="btn sm" type="button" id="memo-save">저장</button></div>
      </div>
      ${dayShort.length ? list(dayShort) : `<div class="empty" style="padding:18px 0">${m}월 ${d}일에 시작·진행하는 짧은 행사는 없어요.</div>`}
      ${dayLong.length ? `<details class="long-day"${hlLong ? " open" : ""}><summary>이 날도 진행 중인 긴 행사 ${dayLong.length}개</summary>${list(dayLong)}</details>` : ""}`;
    const ta = body.querySelector("#memo-t"), stEl = body.querySelector("#memo-st");
    let saved = memo, tm;
    const save = async () => {
      const text = ta.value.trim();
      if (text === saved) return;
      try {
        await saveNote(key, text);
        saved = text;
        if (text) notes[key] = text; else delete notes[key];
        stEl.textContent = text ? "저장했어요" : "메모를 지웠어요";
        const cell = body.querySelector(`[data-day="${d}"]`);
        cell.classList.toggle("has-memo", !!text);
        cell.querySelector(".mm")?.remove();
        if (text) cell.insertAdjacentHTML("beforeend", `<b class="mm" aria-hidden="true"></b>`);
      } catch (e) { toast(e.message); }
    };
    ta.addEventListener("input", () => { clearTimeout(tm); stEl.textContent = "입력 중…"; tm = setTimeout(save, 900); });
    ta.addEventListener("blur", () => { clearTimeout(tm); save(); });
    body.querySelector("#memo-save").addEventListener("click", () => { clearTimeout(tm); save(); });
    const hl = body.querySelector("#cal-day .item.hl");
    if (hl) setTimeout(() => hl.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
  };
  body.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", () => {
    state.day = +b.dataset.day; state.hl = null;
    body.querySelectorAll("[data-day]").forEach(x => x.setAttribute("aria-pressed", x === b));
    showDay(state.day);
  }));
  showDay(state.day);
}

// ------------------------------------------------------------------ 날짜별 메모 (로그인: 서버 / 손님: 이 기기)
const LS = "wolgyeon.notes";
function localNotes() { try { return JSON.parse(localStorage.getItem(LS) || "{}"); } catch (_) { return {}; } }
function setLocal(all) { try { Object.keys(all).length ? localStorage.setItem(LS, JSON.stringify(all)) : localStorage.removeItem(LS); } catch (_) {} }

async function moveLocalToAccount() {
  const all = localNotes();
  for (const [day, text] of Object.entries(all)) {
    try { await api(`/api/me/notes/${day}`, { method: "PUT", body: { text } }); delete all[day]; } catch (_) { break; }
  }
  setLocal(all);
}

async function loadNotes(y, m) {
  const pre = `${y}-${String(m).padStart(2, "0")}-`;
  if (auth.loggedIn) {
    try {
      if (Object.keys(localNotes()).length) await moveLocalToAccount();
      return await api(`/api/me/notes?year=${y}&month=${m}`);
    } catch (_) { return {}; }
  }
  const all = localNotes();
  return Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith(pre)));
}

async function saveNote(day, text) {
  if (auth.loggedIn) return api(`/api/me/notes/${day}`, { method: "PUT", body: { text } });
  const all = localNotes();
  if (text) all[day] = text; else delete all[day];
  setLocal(all);
}
