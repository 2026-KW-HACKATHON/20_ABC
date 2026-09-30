// 행사 분류 색 + 세부 종류 아이콘 (지도 핀, 목록, 상세 화면 공용)
//  색 = 큰 분류(문화·예술 빨강 / 지역·참여 파랑 / 학술·교육 노랑), 아이콘 = 세부 종류(음악, 전시, 장터 …)

export const CATS = {
  culture:   { label: "문화·예술", short: "문화&예술", color: "#ee3f5b", ink: "#ffffff" },
  community: { label: "지역·참여", short: "지역참여",  color: "#2f7cf6", ink: "#ffffff" },
  academic:  { label: "학술·교육", short: "학술&교육", color: "#f5b700", ink: "#1a1a1a" },
};

// 24×24, 선 아이콘 (stroke=currentColor)
const P = {
  music: `<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.8"/><circle cx="17.5" cy="16" r="2.8"/>`,
  show: `<path d="M3.5 4.5h11v6.2a5.5 5.5 0 0 1-11 0z"/><path d="M7 8.5h.01M11 8.5h.01"/><path d="M7 12c1.1.9 2.9.9 4 0"/><path d="M14.5 9.5h6v5.2a5.2 5.2 0 0 1-7.4 4.7"/><path d="M16.5 13h.01M19 13h.01"/>`,
  exhibit: `<path d="M12 3a9 9 0 1 0 0 18c1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5C21 5.8 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.1"/><circle cx="10" cy="7" r="1.1"/><circle cx="14.5" cy="7" r="1.1"/>`,
  film: `<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M7.5 5v4M12 5v4M16.5 5v4"/><path d="M10.5 12.3v4.2l3.6-2.1z"/>`,
  festival: `<path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z"/><path d="M18.5 15v5M16 17.5h5"/>`,
  market: `<path d="M4 9l1.6-5h12.8L20 9"/><path d="M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0"/><path d="M5.5 11.5V20h13v-8.5"/><path d="M10 20v-4.5h4V20"/>`,
  sports: `<circle cx="14.5" cy="4.5" r="2"/><path d="M7 21l3.5-6.5 3 2.5v4"/><path d="M5 11.5l3.5-3.5h5l2.5 3 3.5 1"/><path d="M10.5 14.5l2.3-6.3"/>`,
  contest: `<path d="M8 4h8v5.5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3.2 4M16 6h3a3 3 0 0 1-3.2 4"/><path d="M12 13.5V17M8.5 20.5h7M10 17h4v3.5h-4z"/>`,
  lecture: `<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6"/>`,
  book: `<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 21H20"/><path d="M8.5 7.5h7"/>`,
  class: `<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>`,
  share: `<path d="M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9z"/>`,
  meet: `<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.4"/><path d="M3 20c.6-3.5 3-5.6 6-5.6s5.4 2.1 6 5.6"/><path d="M15.6 14.6c2.5-.4 4.7 1.2 5.3 4.4"/>`,
};

export const KINDS = {
  music: "음악", show: "공연·무대", exhibit: "전시·미술", film: "영화", festival: "축제",
  market: "장터·바자회", sports: "체육·걷기", contest: "대회·공모", lecture: "강연·포럼",
  book: "독서·도서관", class: "교육·체험", share: "나눔·봉사", meet: "주민 모임",
};
// 세부 종류를 큰 분류별로 묶어 필터 화면에 보여줄 때
export const KIND_GROUPS = {
  culture: ["music", "show", "exhibit", "film", "festival"],
  academic: ["lecture", "class", "book", "contest"],
  community: ["market", "sports", "share", "meet"],
};

export const catColor = c => (CATS[c] || CATS.community).color;
export const catInk = c => (CATS[c] || CATS.community).ink;

// 인라인 아이콘 (크기·색 지정)
export function kindIcon(kind, size = 18, color = "currentColor", sw = 2) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[kind] || P.meet}</svg>`;
}

// 지도 핀: 분류 색 물방울 + 흰(노랑은 검정) 아이콘
const DROP = "M17 1.5C8.4 1.5 1.5 8.4 1.5 17c0 11.3 15.5 25.5 15.5 25.5S32.5 28.3 32.5 17C32.5 8.4 25.6 1.5 17 1.5z";
export function pinSvg(cat, kind, w = 34) {
  const h = Math.round(w * 44 / 34);
  return `<svg width="${w}" height="${h}" viewBox="0 0 34 44" aria-hidden="true"><path class="drop" d="${DROP}" fill="${catColor(cat)}"/>
    <g transform="translate(7.4 7.4) scale(.8)" fill="none" stroke="${catInk(cat)}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${P[kind] || P.meet}</g></svg>`;
}
export function clusterSvg(n, w = 36) {
  const h = Math.round(w * 44 / 34);
  return `<svg width="${w}" height="${h}" viewBox="0 0 34 44" aria-hidden="true"><path class="drop" d="${DROP}" fill="#1a1a1a"/><text class="cnt" x="17" y="21.5" text-anchor="middle">${n > 99 ? "99+" : n}</text></svg>`;
}

// 목록용 동그란 아이콘 배지
export function evBadge(e, size = 40) {
  return `<span class="ev-ic" style="width:${size}px;height:${size}px;background:${catColor(e.category)};color:${catInk(e.category)}">${kindIcon(e.kind, Math.round(size * .5), "currentColor", 2.2)}</span>`;
}
// "● 음악" 같은 분류 태그
export function kindTag(e) {
  return `<span class="ktag"><i style="background:${catColor(e.category)}"></i>${KINDS[e.kind] || e.kind_label || ""}</span>`;
}
