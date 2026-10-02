// 행사 상세 (아래에서 올라오는 창) + 즐겨찾기 + 후기
import { api, auth } from "../api.js";
import { ICON, ago, closeSheet, esc, eventWhen, openSheet, toast } from "../ui.js";

export async function render({ ctx, args }) {
  const id = +args[0];
  let ev;
  try { ev = await api(`/api/events/${id}`); }
  catch (e) { toast(e.message); location.hash = "#/map"; return; }
  ctx.setActiveEvent(id);
  ev.inArea = ev.lat != null && ctx.inService(ev.lat, ev.lng);
  if (ev.inArea) {
    const map = ctx.map;
    const z = Math.max(map.getZoom(), 16.5);
    const pt = map.project([ev.lat, ev.lng], z).add([0, Math.min(window.innerHeight * 0.25, 220)]);
    map.flyTo(map.unproject(pt, z), z, { duration: 0.5 });
  }
  draw(ev, ctx);
  return () => { ctx.setActiveEvent(null); closeSheet(); };
}

function draw(ev, ctx) {
  const here = `#/event/${ev.id}`;
  const onClose = () => { if (location.hash === here) location.hash = "#/map"; };
  const list = ctx.lastList && ctx.lastList.ids.includes(ev.id) && ctx.lastList.ids.length > 1 ? ctx.lastList : null;
  const body = openSheet(`
    ${list ? `<button class="btn sm ghost" id="ev-back-list" type="button" style="margin:0 0 6px -10px">‹ ${esc(list.title)} 목록</button>` : ""}
    <div class="row wrap" style="gap:6px"><span class="chip ${ev.category}">${esc(ev.category_label)}</span>
      ${{ kw: `<span class="chip">광운대 공지</span>`, seoul: `<span class="chip">서울시 문화행사</span>`, nowon: `<span class="chip">노원구청 주요행사</span>` }[ev.source] || ""}
      ${ev.inArea ? "" : `<span class="chip">월계동 밖</span>`}</div>
    <h2>${esc(ev.title)}</h2>
    <dl class="meta">
      <dt>일시</dt><dd>${esc(eventWhen(ev))}${ev.time_text && ev.start_at ? `<br><span class="muted small">${esc(ev.time_text)}</span>` : ""}</dd>
      <dt>장소</dt><dd>${esc(ev.place_name || "-")}</dd>
      ${ev.host ? `<dt>주최</dt><dd>${esc(ev.host)}</dd>` : ""}
      ${ev.fee ? `<dt>요금</dt><dd>${esc(ev.fee)}</dd>` : ""}
      ${ev.contact ? `<dt>문의</dt><dd>${esc(ev.contact)}</dd>` : ""}
    </dl>
    ${ev.description ? `<p class="desc">${esc(ev.description)}</p>` : ""}
    ${/^https?:\/\//i.test(ev.url || "") ? `<a class="btn sm" href="${esc(ev.url)}" target="_blank" rel="noopener">원문 보기</a>` : ""}
    <div class="actions">
      <button class="btn" id="ev-fav" type="button" style="color:${ev.is_favorite ? "#e8542f" : ""}">${ICON.heart(ev.is_favorite)} ${ev.is_favorite ? "내 일정에 있음" : "내 일정에 추가"}</button>
      ${ev.inArea
        ? `<a class="btn primary" href="#/route?to=${ev.lat},${ev.lng}&name=${encodeURIComponent(ev.title)}">${ICON.route} 여기로 가기</a>`
        : `<a class="btn primary" href="${ev.lat != null ? `https://map.kakao.com/link/to/${encodeURIComponent(ev.place_name || ev.title)},${ev.lat},${ev.lng}` : `https://map.kakao.com/?q=${encodeURIComponent(ev.place_name || ev.title)}`}" target="_blank" rel="noopener">${ICON.route} 카카오맵</a>`}
    </div>
    ${ev.inArea ? "" : `<p class="small muted" style="margin:8px 0 0">월계동 밖에서 열리는 행사라 지도에는 표시되지 않아요. 길찾기는 카카오맵으로 안내해요.</p>`}
    <section style="margin-top:20px">
      <div class="row"><h3 style="margin:0" class="grow">후기 ${ev.review_count ? `<span class="muted small">★ ${ev.avg_rating} · ${ev.review_count}개</span>` : ""}</h3></div>
      <div id="rv-form"></div>
      <div id="rv-list">${ev.reviews.length ? ev.reviews.map(r => `
        <div class="review"><div class="head"><b>${esc(r.nickname)}</b><span class="stars">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</span><span class="muted small grow">${ago(r.created_at)}</span>
          ${r.mine ? `<button class="btn sm ghost danger" type="button" data-del="${r.id}">삭제</button>` : ""}</div>
        <p>${esc(r.body)}</p></div>`).join("") : `<p class="muted small">아직 후기가 없어요.</p>`}</div>
    </section>`, { onClose });

  body.querySelector("#ev-back-list")?.addEventListener("click", () => {
    location.hash = "#/map";
    setTimeout(() => ctx.openEventList(list.ids, list.title), 30);
  });
  body.querySelector("#ev-fav").addEventListener("click", async () => {
    if (!auth.loggedIn) { location.hash = `#/login?next=${encodeURIComponent(location.hash)}`; return; }
    try {
      const r = await api(`/api/events/${ev.id}/favorite`, { method: "POST" });
      ev.is_favorite = r.is_favorite;
      toast(r.is_favorite ? "내 일정에 추가했어요. 시작 하루 전에 알려드릴게요." : "내 일정에서 뺐어요.");
      draw(ev, ctx);
    } catch (e) { toast(e.message); }
  });
  body.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("후기를 삭제할까요?")) return;
    try { await api(`/api/events/reviews/${b.dataset.del}`, { method: "DELETE" }); reload(ev.id, ctx); } catch (e) { toast(e.message); }
  }));

  const form = body.querySelector("#rv-form");
  if (!auth.loggedIn) {
    form.innerHTML = `<p class="small muted">후기는 <a href="#/login?next=${encodeURIComponent(location.hash)}">로그인</a> 후 남길 수 있어요.</p>`;
  } else if (!ev.can_review) {
    form.innerHTML = `<p class="small muted">행사가 시작되면 후기를 남길 수 있어요.</p>`;
  } else {
    let rating = 5;
    form.innerHTML = `<div class="stack" style="margin:10px 0">
      <div class="star-pick" role="radiogroup" aria-label="별점">${[1, 2, 3, 4, 5].map(i => `<button type="button" data-star="${i}" class="on" aria-label="${i}점">★</button>`).join("")}</div>
      <textarea class="input" id="rv-body" maxlength="1000" placeholder="행사는 어땠나요? 다른 주민에게 도움이 되는 이야기를 남겨주세요."></textarea>
      <button class="btn primary" type="button" id="rv-send">후기 올리기</button></div>`;
    const stars = form.querySelectorAll("[data-star]");
    stars.forEach(s => s.addEventListener("click", () => { rating = +s.dataset.star; stars.forEach(x => x.classList.toggle("on", +x.dataset.star <= rating)); }));
    form.querySelector("#rv-send").addEventListener("click", async () => {
      const text = form.querySelector("#rv-body").value.trim();
      if (text.length < 2) { toast("후기를 두 글자 이상 적어주세요."); return; }
      try { await api(`/api/events/${ev.id}/reviews`, { method: "POST", body: { rating, body: text } }); toast("후기를 올렸어요."); reload(ev.id, ctx); }
      catch (e) { toast(e.message); }
    });
  }
}

async function reload(id, ctx) {
  try { draw(await api(`/api/events/${id}`), ctx); } catch (e) { toast(e.message); }
}
