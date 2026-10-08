// 행사 상세 (전체 화면) — 위쪽 큰 제목 영역 + 기간·시간·위치 + #행사 소개 + #참여방법 + 후기·사진·동영상
import { api, auth } from "../api.js";
import { catColor, catInk, kindIcon, kindTag } from "../icons.js";
import { ago, esc, eventState, eventWhen, kstParts, shrinkImage, toast, todayKst } from "../ui.js";

const MAX_MEDIA = 4, MAX_VIDEO_MB = 30;
const I = {
  back: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>`,
  mark: on => `<svg viewBox="0 0 24 24" width="19" height="19" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3h12v18l-6-4.5L6 21z"/>${on ? "" : `<path d="M12 8.5c-1-1.6-3.6-1-3.4 1 .2 1.6 3.4 3.5 3.4 3.5s3.2-1.9 3.4-3.5c.2-2-2.4-2.6-3.4-1z"/>`}</svg>`,
  share: `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.3 10.8l7.4-4.4M8.3 13.2l7.4 4.4"/></svg>`,
  pin: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`,
  cal: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/><path d="M8.5 14h2M13.5 14h2M8.5 17h2"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>`,
  host: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-3.6 3.7-5.5 7-5.5s6 1.9 7 5.5"/></svg>`,
  won: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7l3.5 11L12 8l4.5 10L20 7M3 11h18M3 14h18"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  play: `<svg viewBox="0 0 24 24" width="26" height="26"><circle cx="12" cy="12" r="11" fill="rgba(0,0,0,.55)"/><path d="M10 8l6 4-6 4z" fill="#fff"/></svg>`,
};

export async function render({ view, ctx, args }) {
  const id = +args[0];
  document.body.classList.add("page-open");
  view.innerHTML = `<div class="page ev-page"><div class="empty" style="padding-top:40vh"><span class="spinner"></span></div></div>`;
  let ev;
  try { ev = await api(`/api/events/${id}`); }
  catch (e) { toast(e.message); location.hash = "#/map"; return; }
  ctx.setActiveEvent(id);
  ev.inArea = ev.lat != null && ctx.inService(ev.lat, ev.lng);
  if (ev.inArea) ctx.map.setView([ev.lat, ev.lng], Math.max(ctx.map.getZoom(), 16.5), { animate: false });   // 뒤로 가면 지도가 이 행사에 맞춰져 있게
  draw(view, ev, ctx);
  return () => { ctx.setActiveEvent(null); closeLightbox(); };
}

// "대상: …" 줄은 소개에서 떼어 #참여방법으로
function splitTarget(desc) {
  const m = /(?:^|\n)\s*대상\s*[:：]\s*(.+)\s*$/m.exec(desc || "");
  return m ? { intro: desc.replace(m[0], "").trim(), target: m[1].trim() } : { intro: (desc || "").trim(), target: "" };
}
const two = n => String(n).padStart(2, "0");
function dateText(ev) {
  if (!ev.start_at) return ev.time_text || "일정 미정";
  const a = kstParts(ev.start_at), b = ev.end_at ? kstParts(ev.end_at) : null;
  const d = x => `${x.m}월 ${x.d}일`;
  return b && (b.m !== a.m || b.d !== a.d) ? `${d(a)} ~ ${a.m === b.m ? `${b.d}일` : d(b)}` : `${d(a)} (${a.dow})`;
}
function timeText(ev) {
  const hm = s => (s && !/T00:00$/.test(s)) ? s.slice(11, 16) : "";
  const a = hm(ev.start_at), b = hm(ev.end_at);
  if (a) return b ? `${a} ~ ${b}` : `${a}부터`;
  return ev.time_text || "시간 미정";
}
// 캘린더 버튼 → 월계온 자체 달력의 그 날짜 (진행 중인 긴 행사는 오늘 날짜)
function calHref(ev) {
  if (!ev.start_at) return "";
  const p = kstParts(ev.start_at), e = ev.end_at ? kstParts(ev.end_at) : p, t = todayKst();
  const n = x => x.y * 10000 + x.m * 100 + x.d;
  const d = n(p) < n(t) && n(t) <= n(e) ? t : p;
  const date = `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  return `#/news?mode=cal&date=${date}&ev=${ev.id}`;
}

function draw(view, ev, ctx) {
  const { intro, target } = splitTarget(ev.description);
  const color = catColor(ev.category), ink = catInk(ev.category);
  const state = eventState(ev);
  const hasUrl = /^https?:\/\//i.test(ev.url || "");
  const routeHref = ev.inArea ? `#/route?to=${ev.lat},${ev.lng}&name=${encodeURIComponent(ev.title)}`
    : ev.lat != null ? `https://map.kakao.com/link/to/${encodeURIComponent(ev.place_name || ev.title)},${ev.lat},${ev.lng}`
      : `https://map.kakao.com/?q=${encodeURIComponent(ev.place_name || ev.title)}`;
  const ext = ev.inArea ? "" : ` target="_blank" rel="noopener"`;
  const cal = calHref(ev);
  const media = ev.reviews.flatMap(r => r.media.map(m => ({ ...m, by: r.nickname })));
  const source = { kw: "광운대 공지", seoul: "서울시 문화행사", nowon: "노원구청 주요행사", tip: "주민 제보", manual: "월계온" }[ev.source] || "";
  const heroBg = ev.image_url
    ? `background-image:linear-gradient(180deg,rgba(0,0,0,.35),rgba(0,0,0,.2) 40%,rgba(0,0,0,.82)),url('${esc(ev.image_url)}')`
    : `background:linear-gradient(160deg,${color},#111 92%)`;

  view.innerHTML = `<div class="page ev-page">
    <header class="ev-hero" style="${heroBg}">
      ${ev.image_url ? "" : `<span class="ev-hero-mark" style="color:${ink}">${kindIcon(ev.kind, 150, "currentColor", 1.2)}</span>`}
      <div class="ev-hero-top">
        <button class="circ" type="button" id="ev-back" aria-label="뒤로">${I.back}</button>
        <span class="grow"></span>
        <button class="circ${ev.is_favorite ? " on" : ""}" type="button" id="ev-fav" aria-label="${ev.is_favorite ? "즐겨찾기 해제" : "즐겨찾기"}">${I.mark(ev.is_favorite)}</button>
        <button class="circ" type="button" id="ev-share" aria-label="공유">${I.share}</button>
      </div>
      <div class="ev-hero-bottom">
        <div class="row wrap" style="gap:6px">${kindTag(ev)}<span class="st-chip ${state.cls}">${state.label}</span>${ev.inArea ? "" : `<span class="ktag">월계동 밖</span>`}</div>
        <h1>${esc(ev.title)}</h1>
        <div class="ev-btns">
          <a class="hbtn" href="${routeHref}"${ext}>${I.pin}길찾기</a>
          ${cal ? `<a class="hbtn" href="${cal}">${I.cal}캘린더</a>` : `<span class="hbtn off" title="일정이 아직 정해지지 않았어요">${I.cal}캘린더</span>`}
          ${hasUrl ? `<a class="hbtn dark" href="${esc(ev.url)}" target="_blank" rel="noopener">자세히 알아보기</a>` : `<a class="hbtn dark" href="#about" id="ev-join">자세히 알아보기</a>`}
        </div>
      </div>
    </header>
    <div class="page-body ev-body">
      <section class="ev-card info">
        <div class="irow"><span class="ibox">${I.cal}</span><div><small>기간</small><b>${esc(dateText(ev))}</b></div></div>
        <div class="irow"><span class="ibox">${I.clock}</span><div><small>시간</small><b>${esc(timeText(ev))}</b></div></div>
        <div class="irow"><span class="ibox">${I.pin}</span><div class="grow"><small>위치</small><b>${esc(ev.place_name || "장소 미정")}</b></div>
          ${ev.inArea ? `<button class="btn sm" type="button" id="ev-onmap">지도</button>` : ""}</div>
        ${ev.host ? `<div class="irow"><span class="ibox">${I.host}</span><div><small>주최</small><b>${esc(ev.host)}</b></div></div>` : ""}
      </section>

      <section class="ev-card" id="about">
        <h3>#행사 소개</h3>
        ${intro ? `<p class="desc">${esc(intro)}</p>` : `<p class="muted small" style="margin:0">아직 소개가 없어요.</p>`}
        <div class="row wrap small muted" style="gap:8px;margin-top:10px">${source ? `<span>출처: ${source}</span>` : ""}${hasUrl ? `<a href="${esc(ev.url)}" target="_blank" rel="noopener">원문 보기</a>` : ""}</div>
      </section>

      <section class="ev-card" id="how">
        <h3>#참여방법</h3>
        ${target || ev.fee || hasUrl ? `<div class="how">
          ${target ? `<div><small>대상</small><span>${esc(target)}</span></div>` : ""}
          ${ev.fee ? `<div><small>참가비</small><span>${esc(ev.fee)}</span></div>` : ""}
          ${hasUrl ? `<div><small>신청·안내</small><span><a href="${esc(ev.url)}" target="_blank" rel="noopener">안내 페이지에서 확인하기</a></span></div>` : ""}
          ${ev.contact ? `<div><small>문의</small><span>${esc(ev.contact)}</span></div>` : ""}
        </div>` : `<p class="small" style="margin:0">따로 안내된 신청 방법이 없어요. 시간에 맞춰 현장에 방문하거나 주최 측에 문의해주세요.</p>`}
      </section>

      <section class="ev-card">
        <div class="row"><h3 class="grow" style="margin:0">후기&사진 및 동영상</h3>${ev.review_count ? `<span class="small"><span class="stars">★</span> ${ev.avg_rating} · ${ev.review_count}개</span>` : ""}</div>
        ${media.length ? `<div class="gallery">${media.map((m, i) => thumb(m, i)).join("")}</div>` : ""}
        <div id="rv-form"></div>
        <div id="rv-list">${ev.reviews.length ? ev.reviews.map(r => `
          <div class="review"><div class="head"><b>${esc(r.nickname)}</b><span class="stars">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</span><span class="muted small grow">${ago(r.created_at)}</span>
            ${r.mine ? `<button class="btn sm ghost danger" type="button" data-del="${r.id}">삭제</button>` : ""}</div>
            <p>${esc(r.body)}</p>
            ${r.media.length ? `<div class="gallery sm">${r.media.map(m => thumb(m, media.findIndex(x => x.id === m.id))).join("")}</div>` : ""}</div>`).join("") : `<p class="muted small" style="margin:10px 0 0">아직 후기가 없어요.</p>`}</div>
      </section>

      <section class="ev-card" id="ev-same" hidden></section>
    </div>
  </div>`;

  const $ = s => view.querySelector(s);
  $("#ev-back").addEventListener("click", () => goBack(ev, ctx));
  $("#ev-onmap")?.addEventListener("click", () => { ctx.lastList = null; location.hash = "#/map"; setTimeout(() => ctx.map.flyTo([ev.lat, ev.lng], 18, { duration: .5 }), 60); });
  $("#ev-join")?.addEventListener("click", e => { e.preventDefault(); $("#about").scrollIntoView({ behavior: "smooth", block: "start" }); });
  $("#ev-share").addEventListener("click", async () => {
    const url = `${location.origin}/#/event/${ev.id}`;
    try {
      if (navigator.share) await navigator.share({ title: ev.title, text: `${ev.title} · ${dateText(ev)}`, url });
      else { await navigator.clipboard.writeText(url); toast("링크를 복사했어요."); }
    } catch (_) { /* 공유 취소 */ }
  });
  $("#ev-fav").addEventListener("click", async () => {
    if (!auth.loggedIn) { location.hash = `#/login?next=${encodeURIComponent(location.hash)}`; return; }
    try {
      const r = await api(`/api/events/${ev.id}/favorite`, { method: "POST" });
      ev.is_favorite = r.is_favorite;
      ctx.setFavorite?.(ev.id, r.is_favorite);
      toast(r.is_favorite ? "즐겨찾기에 넣었어요. 시작하기 전에 알려드릴게요." : "즐겨찾기에서 뺐어요.");
      const b = $("#ev-fav"); b.classList.toggle("on", r.is_favorite); b.innerHTML = I.mark(r.is_favorite);
    } catch (e) { toast(e.message); }
  });
  view.querySelectorAll("[data-media]").forEach(t => t.addEventListener("click", () => openLightbox(media, +t.dataset.media)));
  view.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("후기를 삭제할까요? 붙인 사진·영상도 함께 지워져요.")) return;
    try { await api(`/api/events/reviews/${b.dataset.del}`, { method: "DELETE" }); reload(view, ev.id, ctx); } catch (e) { toast(e.message); }
  }));
  reviewForm(view, ev, ctx);

  // 같은 장소의 다른 행사
  if (ev.lat != null) api(`/api/events/${ev.id}/same-place`).then(({ current, past }) => {
    const box = $("#ev-same");
    if (!box || (!current.length && !past.length)) return;
    const item = (e, isPast) => `<a class="item${isPast ? " past" : ""}" href="#/event/${e.id}"><div class="grow">
      <div class="t">${esc(e.title)}</div><div class="m"><span class="st-chip ${eventState(e).cls}">${eventState(e).label}</span> ${esc(eventWhen(e))}</div></div></a>`;
    box.hidden = false;
    box.innerHTML = `<h3>이 장소의 다른 행사</h3>
      ${current.length ? `<div class="list">${current.map(e => item(e, false)).join("")}</div>` : `<p class="small muted" style="margin:0">지금 진행 중이거나 예정된 다른 행사는 없어요.</p>`}
      ${past.length ? `<details style="margin-top:8px"><summary class="small muted">지난 행사 ${past.length}개</summary><div class="list" style="margin-top:6px">${past.map(e => item(e, true)).join("")}</div></details>` : ""}`;
  }).catch(() => {});
}

function thumb(m, i) {
  return m.kind === "video"
    ? `<button class="mthumb" type="button" data-media="${i}" aria-label="동영상 보기"><video src="${esc(m.url)}#t=0.5" preload="metadata" muted playsinline></video><span class="play">${I.play}</span></button>`
    : `<button class="mthumb" type="button" data-media="${i}" aria-label="사진 크게 보기"><img src="${esc(m.url)}" alt="" loading="lazy"></button>`;
}

function goBack(ev, ctx) {
  const list = ctx.lastList && ctx.lastList.ids.includes(ev.id) && ctx.lastList.ids.length > 1 ? ctx.lastList : null;
  if (list) { location.hash = "#/map"; setTimeout(() => ctx.openEventList(list.ids, list.title), 40); return; }
  const prev = ctx.prevHash || "";
  location.hash = prev && !prev.startsWith("#/event/") ? prev : "#/map";
}

// ---- 후기 쓰기 (별점 + 글 + 사진·영상 최대 4개)
function reviewForm(view, ev, ctx) {
  const form = view.querySelector("#rv-form");
  if (!auth.loggedIn) {
    form.innerHTML = `<a class="btn block" style="margin-top:10px" href="#/login?next=${encodeURIComponent(location.hash)}">${I.plus} 로그인하고 후기·사진 남기기</a>`;
    return;
  }
  if (!ev.can_review) { form.innerHTML = `<p class="small muted" style="margin:10px 0 0">행사가 시작되면 후기와 사진·영상을 남길 수 있어요.</p>`; return; }
  let rating = 5;
  const files = [];     // {blob, name, kind, url}
  form.innerHTML = `<div class="stack rv-write">
    <div class="star-pick" role="radiogroup" aria-label="별점">${[1, 2, 3, 4, 5].map(i => `<button type="button" data-star="${i}" class="on" aria-label="${i}점">★</button>`).join("")}</div>
    <textarea class="input" id="rv-body" maxlength="1000" placeholder="행사는 어땠나요? 다른 주민에게 도움이 되는 이야기를 남겨주세요."></textarea>
    <div class="gallery sm" id="rv-files"></div>
    <div class="row"><label class="btn sm" for="rv-file">${I.plus} 사진·영상</label><input id="rv-file" type="file" accept="image/*,video/*" multiple hidden>
      <span class="small muted grow">최대 ${MAX_MEDIA}개 · 영상 ${MAX_VIDEO_MB}MB 이하</span>
      <button class="btn primary" type="button" id="rv-send">후기 올리기</button></div></div>`;
  const stars = form.querySelectorAll("[data-star]");
  stars.forEach(s => s.addEventListener("click", () => { rating = +s.dataset.star; stars.forEach(x => x.classList.toggle("on", +x.dataset.star <= rating)); }));
  const drawFiles = () => {
    form.querySelector("#rv-files").innerHTML = files.map((f, i) => `<div class="mthumb">${f.kind === "video" ? `<video src="${f.url}" muted playsinline></video><span class="play">${I.play}</span>` : `<img src="${f.url}" alt="">`}
      <button class="mx" type="button" data-rm="${i}" aria-label="빼기">×</button></div>`).join("");
    form.querySelectorAll("[data-rm]").forEach(b => b.addEventListener("click", () => { URL.revokeObjectURL(files[+b.dataset.rm].url); files.splice(+b.dataset.rm, 1); drawFiles(); }));
  };
  form.querySelector("#rv-file").addEventListener("change", async e => {
    for (const f of [...e.target.files]) {
      if (files.length >= MAX_MEDIA) { toast(`사진·영상은 ${MAX_MEDIA}개까지 올릴 수 있어요.`); break; }
      if (f.type.startsWith("video/")) {
        if (f.size > MAX_VIDEO_MB * 1024 * 1024) { toast(`영상은 ${MAX_VIDEO_MB}MB 이하만 올릴 수 있어요.`); continue; }
        files.push({ blob: f, name: f.name, kind: "video", url: URL.createObjectURL(f) });
      } else {
        try { const b = await shrinkImage(f); files.push({ blob: b, name: "photo.jpg", kind: "image", url: URL.createObjectURL(b) }); }
        catch (err) { toast(err.message); }
      }
    }
    e.target.value = "";
    drawFiles();
  });
  form.querySelector("#rv-send").addEventListener("click", async ev2 => {
    const text = form.querySelector("#rv-body").value.trim();
    if (text.length < 2) { toast("후기를 두 글자 이상 적어주세요."); return; }
    const btn = ev2.currentTarget; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const r = await api(`/api/events/${ev.id}/reviews`, { method: "POST", body: { rating, body: text } });
      if (files.length) {
        const fd = new FormData();
        files.forEach(f => fd.append("files", f.blob, f.name));
        try { await api(`/api/reviews/${r.id}/media`, { method: "POST", form: fd }); }
        catch (e) { toast(`후기는 올렸지만 사진·영상은 올리지 못했어요: ${e.message}`, 4000); }
      }
      toast("후기를 올렸어요.");
      reload(view, ev.id, ctx);
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = "후기 올리기"; }
  });
}

async function reload(view, id, ctx) {
  try {
    const ev = await api(`/api/events/${id}`);
    ev.inArea = ev.lat != null && ctx.inService(ev.lat, ev.lng);
    const y = view.querySelector(".page")?.scrollTop || 0;
    draw(view, ev, ctx);
    view.querySelector(".page").scrollTop = y;
  } catch (e) { toast(e.message); }
}

// ---- 사진·영상 크게 보기
let lb = null;
function openLightbox(items, i) {
  closeLightbox();
  lb = document.createElement("div");
  lb.className = "lightbox";
  const show = () => {
    const m = items[i];
    lb.innerHTML = `<button class="lb-x" type="button" aria-label="닫기">×</button>
      <div class="lb-stage">${m.kind === "video" ? `<video src="${esc(m.url)}" controls autoplay playsinline></video>` : `<img src="${esc(m.url)}" alt="">`}</div>
      <div class="lb-cap">${esc(m.by || "")} · ${i + 1} / ${items.length}</div>
      ${items.length > 1 ? `<button class="lb-nav prev" type="button" aria-label="이전">‹</button><button class="lb-nav next" type="button" aria-label="다음">›</button>` : ""}`;
    lb.querySelector(".lb-x").addEventListener("click", closeLightbox);
    lb.querySelector(".prev")?.addEventListener("click", () => { i = (i + items.length - 1) % items.length; show(); });
    lb.querySelector(".next")?.addEventListener("click", () => { i = (i + 1) % items.length; show(); });
  };
  show();
  lb.addEventListener("click", e => { if (e.target === lb || e.target.classList.contains("lb-stage")) closeLightbox(); });
  document.body.appendChild(lb);
}
function closeLightbox() { if (lb) { lb.remove(); lb = null; } }
