// 보행 그래프 + 경로 계산 (지름길 / 일반 / 배리어프리, 공사 회피, 쪽문 시간, 메모 경유 루트)
// 간선: [a, b, 길이m, 종류, 플래그, 경사%]
export const T = { ROAD: 0, FOOT: 1, STEPS: 2, SERVICE: 3, BRIDGE: 4, CROSS: 5, MAJOR: 6 };
export const F = { INSIDE: 1, GATE: 2, RESTRICT: 4, STAIRS: 8, STEEP: 16, BLOCK: 32, CONSTR: 64, CUSTOM: 128 };

export const MODES = {
  shortcut: { label: "지름길", speed: 67 },
  normal: { label: "일반 도보", speed: 67 },
  accessible: { label: "배리어프리", speed: 50 },
};

const KX = 111320 * Math.cos(37.62 * Math.PI / 180), KY = 110540;
export const distM = (a, b) => Math.hypot((b[1] - a[1]) * KX, (b[0] - a[0]) * KY);

function parseHours(s) {
  // "06:00-23:00" 또는 OSM 형식 "Mo-Su 06:00-23:00" 의 첫 시간대만 해석
  const m = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/.exec(s || "");
  if (!m) return null;
  return [+m[1] * 60 + +m[2], +m[3] * 60 + +m[4]];
}
function isOpen(h, minutes) {
  if (!h) return true;
  const [a, b] = h;
  return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, topK = k[0], topV = v[0], lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) {
        let l = 2 * i + 1, r = l + 1, m = i, mk = lk;
        if (l < n && k[l] < mk) { m = l; mk = k[l]; }
        if (r < n && k[r] < mk) { m = r; mk = k[r]; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return [topK, topV];
  }
}

export class Graph {
  constructor(data) {
    this.n = data.n; this.e = data.e; this.zones = data.z || [];
    this.N = this.n.length;
    this.hours = {};
    for (const [k, v] of Object.entries(data.h || {})) this.hours[k] = parseHours(v);
    this.adj = Array.from({ length: this.N }, () => []);
    this.e.forEach((e, i) => { this.adj[e[0]].push(i); this.adj[e[1]].push(i); });
    // 가까운 노드 찾기용 격자 (50m)
    this.cell = 50; this.grid = new Map();
    this.n.forEach((p, i) => {
      const key = this._key(p[0], p[1]);
      if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key).push(i);
    });
  }
  _key(lat, lng) { return `${Math.floor(lng * KX / this.cell)},${Math.floor(lat * KY / this.cell)}`; }

  // 간선 비용 (Infinity = 못 지나감)
  cost(i, mode, opt) {
    const [, , L, t, f, g] = this.e[i];
    if (f & F.BLOCK) return Infinity;
    if (this.hours[i] && !isOpen(this.hours[i], opt.minutes)) return Infinity;
    if (opt.avoidConstruction && (f & F.CONSTR)) return Infinity;
    let w = 1;
    if (mode === "normal") {
      if (t === T.BRIDGE || t === T.CROSS || (f & (F.INSIDE | F.RESTRICT | F.CUSTOM))) return Infinity;
      if (t === T.STEPS) w = 1.2; else if (t === T.MAJOR) w = 1.5;
    } else if (mode === "accessible") {
      if (t === T.STEPS || (f & (F.STAIRS | F.STEEP))) return Infinity;
      if (g > 8.3) return Infinity;              // 1/12 초과는 휠체어 통행 곤란
      if (g > 5.6) w = 2.5;                       // 1/18(법정 접근로 기준) 초과
      else if (g > 3) w = 1.3;
      if (t === T.BRIDGE) w *= 1.5;               // 연결부 턱 가능성
      if (t === T.CROSS) w *= 1.2;
      if (t === T.MAJOR) w *= 1.5;
      if (f & F.RESTRICT) w *= 1.3;
    } else { // shortcut
      if (t === T.STEPS) w = 1.2; else if (t === T.CROSS) w = 1.08; else if (t === T.MAJOR) w = 1.5;
      if (f & F.RESTRICT) w *= 1.3;
      if (f & F.STAIRS) w *= 1.2;
      if (f & F.STEEP) w *= 1.15;
    }
    return L * w;
  }

  // 반경 안 가까운 노드 [노드, 접근거리]
  nearest(lat, lng, mode, opt, k = 8, radius = 150) {
    const cx = Math.floor(lng * KX / this.cell), cy = Math.floor(lat * KY / this.cell);
    const r = Math.ceil(radius / this.cell);
    const out = [];
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      const list = this.grid.get(`${cx + dx},${cy + dy}`);
      if (!list) continue;
      for (const i of list) {
        const d = distM([lat, lng], this.n[i]);
        if (d > radius) continue;
        if (!this.adj[i].some(ei => this.cost(ei, mode, opt) < Infinity)) continue;
        out.push([i, d]);
      }
    }
    out.sort((a, b) => a[1] - b[1]);
    if (out.length) return out.slice(0, k);
    if (radius < 600) return this.nearest(lat, lng, mode, opt, k, radius * 2);
    return [];
  }

  // 다중 출발 다익스트라. targets 가 있으면 도착 후보에 닿는 즉시 멈춤
  search(srcs, mode, opt, targets = null) {
    const N = this.N, dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), pe = new Int32Array(N).fill(-1);
    const heap = new Heap();
    for (const [s, d0] of srcs) if (d0 < dist[s]) { dist[s] = d0; heap.push(d0, s); }
    const tmap = targets ? new Map(targets) : null;
    let best = Infinity, bestNode = -1;
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > dist[u]) continue;
      if (tmap) {
        if (d >= best) break;
        if (tmap.has(u) && d + tmap.get(u) < best) { best = d + tmap.get(u); bestNode = u; }
      }
      for (const ei of this.adj[u]) {
        const c = this.cost(ei, mode, opt);
        if (c === Infinity) continue;
        const e = this.e[ei], v = e[0] === u ? e[1] : e[0], nd = d + c;
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; pe[v] = ei; heap.push(nd, v); }
      }
    }
    return { dist, prev, pe, best, bestNode };
  }

  _trace(prev, pe, node) {
    const nodes = [], edges = [];
    for (let u = node; u !== -1; u = prev[u]) { nodes.push(u); if (pe[u] >= 0) edges.push(pe[u]); }
    nodes.reverse(); edges.reverse();
    return { nodes, edges };
  }

  options(o = {}) {
    const d = new Date(Date.now() + 9 * 3600e3);
    return { minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), avoidConstruction: false, ...o };
  }

  route(from, to, mode = "shortcut", o = {}) {
    const opt = this.options(o);
    const A = this.nearest(from[0], from[1], mode, opt), B = this.nearest(to[0], to[1], mode, opt);
    if (!A.length || !B.length) return null;
    const r = this.search(A, mode, opt, B);
    if (r.bestNode < 0) return null;
    const { nodes, edges } = this._trace(r.prev, r.pe, r.bestNode);
    const acc = distM(from, this.n[nodes[0]]) + distM(to, this.n[nodes[nodes.length - 1]]);
    return this._summarize(nodes, edges, from, to, acc, mode);
  }

  _summarize(nodes, edges, from, to, acc, mode) {
    const s = { inside: 0, cross: 0, bridge: 0, custom: 0, gates: 0, steps: 0, stepsCount: 0, steep: 0, restrict: 0, constr: 0, hoursGates: 0 };
    let length = 0, prevSteps = false;
    for (const ei of edges) {
      const [, , L, t, f, g] = this.e[ei];
      length += L;
      if (f & F.INSIDE) s.inside += L;
      if (t === T.CROSS) s.cross += L;
      if (t === T.BRIDGE) s.bridge++;
      if (f & F.CUSTOM) s.custom += L;
      if (f & F.GATE) s.gates++;
      if (this.hours[ei]) s.hoursGates++;
      const isSteps = t === T.STEPS || (f & F.STAIRS);
      if (isSteps) { s.steps += L; if (!prevSteps) s.stepsCount++; }
      prevSteps = isSteps;
      if ((f & F.STEEP) || g > 5.6) s.steep += L;
      if (f & F.RESTRICT) s.restrict += L;
      if (f & F.CONSTR) s.constr++;
    }
    const zones = s.constr ? this.zones.filter(z => edges.some(ei => {
      const e = this.e[ei];
      return distM([z.lat, z.lng], this.n[e[0]]) <= z.radius_m + 15 || distM([z.lat, z.lng], this.n[e[1]]) <= z.radius_m + 15;
    })) : [];
    return {
      mode, nodes, edges, length, total: length + acc, stats: s, zones,
      latlngs: [from, ...nodes.map(i => this.n[i]), to],
      minutes: (length + acc) / MODES[mode].speed,
    };
  }

  // 비공식 구간(관통·연결·주민 추가길) 좌표 묶음 — 지도 강조용
  specialSegments(result) {
    const out = [];
    result.edges.forEach((ei, k) => {
      const [, , , t, f] = this.e[ei];
      if (t === T.CROSS || t === T.BRIDGE || (f & (F.INSIDE | F.CUSTOM | F.GATE))) out.push([this.n[result.nodes[k]], this.n[result.nodes[k + 1]]]);
    });
    return out;
  }

  /* 메모 경유 루트
     needs: [{text, cats:[...]}], pois: [{name,cat,lat,lng}], start/end: [lat,lng] (end 없으면 출발지로 복귀)
     → 모든 필요를 채우는 가게 조합과 순서 중 가장 짧은 것 (부분집합 DP) */
  planStops(start, end, needs, pois, mode = "shortcut", o = {}) {
    const opt = this.options(o);
    const MAX_NEEDS = 8, MAX_CAND = 16;
    const usable = needs.map((nd, i) => ({ ...nd, i })).filter(nd => nd.cats.length);
    const missing = [];
    const perNeed = [];
    for (const nd of usable) {
      const matches = pois.filter(p => nd.cats.includes(p.cat))
        .map(p => ({ p, d: distM(start, [p.lat, p.lng]) + (end ? distM(end, [p.lat, p.lng]) : 0) }))
        .filter(x => x.d < 5000).sort((a, b) => a.d - b.d);
      if (!matches.length) missing.push(nd); else perNeed.push({ nd, matches });
    }
    const overflow = perNeed.slice(MAX_NEEDS).map(x => ({ ...x.nd, overflow: true }));   // 한 번에 8가지까지
    const kept = perNeed.slice(0, MAX_NEEDS);
    const needList = kept.map(x => x.nd);
    // 필요마다 후보 자리를 고르게 나눠 가짐 (앞 항목이 자리를 다 차지하지 않도록)
    const share = Math.max(1, Math.floor(MAX_CAND / Math.max(1, kept.length)));
    const cand = new Map();
    for (let round = 0; round < share; round++) {
      for (const { matches } of kept) {
        const m = matches[round];
        if (m && cand.size < MAX_CAND) cand.set(`${m.p.lat},${m.p.lng},${m.p.name}`, m.p);
      }
    }
    missing.push(...overflow);
    const C = [...cand.values()];
    if (!needList.length || !C.length) return { ok: false, missing, noCats: needs.filter(n => !n.cats.length) };

    const pts = [start, ...C.map(p => [p.lat, p.lng]), end || start];
    const near = pts.map(p => this.nearest(p[0], p[1], mode, opt));
    if (near.some(x => !x.length)) return { ok: false, missing, noCats: [], error: "경로를 만들 수 없는 위치가 있어요." };
    const runs = near.map(src => this.search(src, mode, opt));
    const M = pts.length;
    const D = Array.from({ length: M }, (_, i) => Array.from({ length: M }, (_, j) => {
      if (i === j) return 0;
      let b = Infinity;
      for (const [node, acc] of near[j]) b = Math.min(b, runs[i].dist[node] + acc);
      return b;
    }));
    const cover = C.map(p => needList.reduce((m, nd, k) => m | (nd.cats.includes(p.cat) ? 1 << k : 0), 0));
    const FULL = (1 << needList.length) - 1;
    const dp = new Map(), par = new Map();
    const key = (mask, c) => mask * 64 + c;
    C.forEach((_, c) => {
      const k = key(cover[c], c), v = D[0][c + 1];
      if (v < (dp.get(k) ?? Infinity)) { dp.set(k, v); par.set(k, -1); }
    });
    for (let mask = 1; mask <= FULL; mask++) {
      for (let c = 0; c < C.length; c++) {
        const cur = dp.get(key(mask, c));
        if (cur === undefined || cur === Infinity) continue;
        for (let c2 = 0; c2 < C.length; c2++) {
          if (!(cover[c2] & ~mask)) continue;
          const nm = mask | cover[c2], v = cur + D[c + 1][c2 + 1], k2 = key(nm, c2);
          if (v < (dp.get(k2) ?? Infinity)) { dp.set(k2, v); par.set(k2, key(mask, c)); }
        }
      }
    }
    let best = Infinity, bestK = null;
    C.forEach((_, c) => {
      const v = dp.get(key(FULL, c));
      if (v !== undefined && v + D[c + 1][M - 1] < best) { best = v + D[c + 1][M - 1]; bestK = key(FULL, c); }
    });
    if (bestK === null) return { ok: false, missing, noCats: [], error: "가게까지 가는 길을 찾지 못했어요." };
    const order = [];
    for (let k = bestK; k !== -1; k = par.get(k)) order.push(k % 64);
    order.reverse();
    // 구간별 실제 경로
    const seq = [0, ...order.map(c => c + 1), M - 1];
    let latlngs = [], length = 0, allEdges = [];
    for (let s = 0; s + 1 < seq.length; s++) {
      const i = seq[s], j = seq[s + 1];
      let bestN = -1, bv = Infinity;
      for (const [node, acc] of near[j]) { const v = runs[i].dist[node] + acc; if (v < bv) { bv = v; bestN = node; } }
      if (bestN < 0) continue;
      const tr = this._trace(runs[i].prev, runs[i].pe, bestN);
      tr.edges.forEach(ei => { length += this.e[ei][2]; allEdges.push(ei); });
      latlngs.push(pts[i], ...tr.nodes.map(x => this.n[x]), pts[j]);
    }
    const stops = order.map(c => ({ ...C[c], covers: needList.filter((_, k) => cover[c] & (1 << k)).map(nd => nd.text) }));
    const coveredTexts = new Set(stops.flatMap(s => s.covers));
    stops.forEach(s => { s.covers = s.covers.filter(t => { if (coveredTexts.has(t)) { coveredTexts.delete(t); return true; } return false; }); });
    return { ok: true, stops, latlngs, length, minutes: length / MODES[mode].speed, missing, noCats: needs.filter(n => !n.cats.length), edges: allEdges };
  }
}
