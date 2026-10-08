// 보행 그래프 + 경로 계산 (지름길 / 일반 / 배리어프리, 공사 회피, 쪽문 시간, 메모 경유 루트)
// 간선: [a, b, 길이m, 종류, 플래그, 경사%]
export const T = { ROAD: 0, FOOT: 1, STEPS: 2, SERVICE: 3, BRIDGE: 4, CROSS: 5, MAJOR: 6 };
export const F = { INSIDE: 1, GATE: 2, RESTRICT: 4, STAIRS: 8, STEEP: 16, BLOCK: 32, CONSTR: 64, CUSTOM: 128 };

export const MODES = {
  shortcut: { label: "지름길", speed: 67 },
  normal: { label: "일반 도보", speed: 67 },
  accessible: { label: "편한 길 찾기(배리어프리)", btn: `편한 길 찾기<span class="mode-sub">(배리어프리)</span>`, speed: 50 },
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
}
