// Printability check: will this print as drawn (its bottom on the bed)?
// Looks at the built part for walls thinner than two nozzle widths, gaps
// narrower than one, and overhangs steeper than 45°; and at the shapes for
// round holes lying sideways (offers a teardrop) and bits too small to print.
// It only warns: the owner can always print anyway. No DOM here.
import type { Feature, Project, Vec3 } from './model.js';
import { canTeardrop, depthRange, isShape } from './model.js';
import { VIEWS } from './views.js';

export interface Mesh { vertices: number[]; triangles: number[] }

export interface Issue {
  kind: 'thin' | 'gap' | 'overhang' | 'sideways' | 'tiny';
  title: string;            // one line: what and how bad
  text: string;             // what to do about it
  tris?: number[];          // triangles to light up in 3D
  feature?: string;         // the shape it's about
  fix?: 'teardrop';
  at?: Vec3;                // roughly where (mm)
}

export interface CheckOpts { nozzle?: number; layer?: number }

/** Thin walls and narrow gaps smaller than this (mm² of surface) are left out: sharp tips, not walls. */
const MIN_PATCH = 2;

// ------------------------------------------------------------ mesh helpers

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

interface Tri { a: V3; b: V3; c: V3; n: V3; area: number }

function triangles(m: Mesh): Tri[] {
  const P = (i: number): V3 => [m.vertices[3 * i], m.vertices[3 * i + 1], m.vertices[3 * i + 2]];
  const out: Tri[] = [];
  let vol = 0;
  for (let t = 0; t < m.triangles.length; t += 3) {
    const a = P(m.triangles[t]), b = P(m.triangles[t + 1]), c = P(m.triangles[t + 2]);
    const n = cross(sub(b, a), sub(c, a));
    const l = Math.hypot(n[0], n[1], n[2]);
    vol += dot(a, cross(b, c));
    out.push({ a, b, c, n: l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 0], area: l / 2 });
  }
  // normals point out of the part (flip the lot if the mesh is wound the other way)
  if (vol < 0) for (const t of out) t.n = [-t.n[0], -t.n[1], -t.n[2]];
  return out;
}

/** A sparse grid of triangles, for finding the ones near a short ray. */
class Grid {
  cells = new Map<number, number[]>();
  constructor(private tris: Tri[], private size: number, private lo: V3) {
    tris.forEach((t, i) => {
      const [i0, j0, k0] = this.cell([Math.min(t.a[0], t.b[0], t.c[0]), Math.min(t.a[1], t.b[1], t.c[1]), Math.min(t.a[2], t.b[2], t.c[2])]);
      const [i1, j1, k1] = this.cell([Math.max(t.a[0], t.b[0], t.c[0]), Math.max(t.a[1], t.b[1], t.c[1]), Math.max(t.a[2], t.b[2], t.c[2])]);
      for (let x = i0; x <= i1; x++) for (let y = j0; y <= j1; y++) for (let z = k0; z <= k1; z++) {
        const k = this.key(x, y, z);
        const l = this.cells.get(k);
        if (l) l.push(i); else this.cells.set(k, [i]);
      }
    });
  }
  cell(p: V3): V3 { return [Math.floor((p[0] - this.lo[0]) / this.size), Math.floor((p[1] - this.lo[1]) / this.size), Math.floor((p[2] - this.lo[2]) / this.size)]; }
  key(i: number, j: number, k: number) { return (i * 4096 + j) * 4096 + k; }
  /**
   * The nearest hit along o + t·d for 0 < t ≤ len, skipping triangle `skip`,
   * on a surface that faces the ray the given way (+1: it looks along the ray,
   * as the far side of a wall does; -1: back at it, as across a gap). Grazing
   * hits (a wall the ray runs alongside) don't count.
   */
  cast(o: V3, d: V3, len: number, skip: number, facing: 1 | -1): number {
    const e: V3 = [o[0] + d[0] * len, o[1] + d[1] * len, o[2] + d[2] * len];
    const [i0, j0, k0] = this.cell([Math.min(o[0], e[0]), Math.min(o[1], e[1]), Math.min(o[2], e[2])]);
    const [i1, j1, k1] = this.cell([Math.max(o[0], e[0]), Math.max(o[1], e[1]), Math.max(o[2], e[2])]);
    let best = Infinity;
    const seen = new Set<number>();
    for (let x = i0; x <= i1; x++) for (let y = j0; y <= j1; y++) for (let z = k0; z <= k1; z++) {
      for (const ti of this.cells.get(this.key(x, y, z)) || []) {
        if (ti === skip || seen.has(ti)) continue;
        seen.add(ti);
        if (dot(this.tris[ti].n, d) * facing < 0.5) continue;
        const t = rayTri(o, d, this.tris[ti]);
        if (t > 1e-4 && t <= len && t < best) best = t;
      }
    }
    return best;
  }
}

function rayTri(o: V3, d: V3, t: Tri): number {
  const e1 = sub(t.b, t.a), e2 = sub(t.c, t.a);
  const p = cross(d, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return Infinity;
  const inv = 1 / det;
  const s = sub(o, t.a);
  const u = dot(s, p) * inv;
  if (u < 0 || u > 1) return Infinity;
  const q = cross(s, e1);
  const v = dot(d, q) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  return dot(e2, q) * inv;
}

/** Group triangles into patches that touch (share a corner). */
function patches(tris: Tri[], pick: number[]): number[][] {
  const key = (p: V3) => `${p[0].toFixed(3)},${p[1].toFixed(3)},${p[2].toFixed(3)}`;
  const parent = new Map<number, number>();
  const find = (x: number): number => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
  const at = new Map<string, number>();
  for (const i of pick) {
    parent.set(i, i);
    for (const p of [tris[i].a, tris[i].b, tris[i].c]) {
      const k = key(p), j = at.get(k);
      if (j === undefined) at.set(k, i); else parent.set(find(i), find(j));
    }
  }
  const groups = new Map<number, number[]>();
  for (const i of pick) { const r = find(i); const g = groups.get(r); if (g) g.push(i); else groups.set(r, [i]); }
  return [...groups.values()];
}

function boxOf(tris: Tri[], ids: number[]): [V3, V3] {
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const i of ids) for (const p of [tris[i].a, tris[i].b, tris[i].c]) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  return [lo, hi];
}
const mid = ([lo, hi]: [V3, V3]): V3 => [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
const mm = (v: number) => `${+v.toFixed(2)} mm`;

// ------------------------------------------------------------ the check

/** Every problem found, worst first. */
export function checkPrint(p: Project, mesh: Mesh | null, o: CheckOpts = {}): Issue[] {
  const nozzle = o.nozzle ?? 0.4;
  const issues: Issue[] = [];
  const sideways = sidewaysHoles(p);

  if (mesh && mesh.triangles.length) {
    const tris = triangles(mesh);
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const t of tris) for (const q of [t.a, t.b, t.c]) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
    const grid = new Grid(tris, Math.max(1, nozzle * 4), lo);

    // thin walls (inward) and narrow gaps (outward), from a few points on each triangle
    const thinLen = nozzle * 2, gapLen = nozzle;
    const thin: number[] = [], gap: number[] = [];
    let thinnest = Infinity, narrowest = Infinity;
    const thinIn: Record<number, number> = {}, gapOut: Record<number, number> = {};
    tris.forEach((t, i) => {
      if (t.area < 1e-6) return;
      const c: V3 = [(t.a[0] + t.b[0] + t.c[0]) / 3, (t.a[1] + t.b[1] + t.c[1]) / 3, (t.a[2] + t.b[2] + t.c[2]) / 3];
      const pts: V3[] = [c];
      if (t.area > nozzle * nozzle * 4) for (const v of [t.a, t.b, t.c]) pts.push([(c[0] + v[0]) / 2, (c[1] + v[1]) / 2, (c[2] + v[2]) / 2]);
      const inw: V3 = [-t.n[0], -t.n[1], -t.n[2]];
      let tIn = Infinity, tOut = Infinity;
      for (const q of pts) {
        tIn = Math.min(tIn, grid.cast(q, inw, thinLen, i, 1));
        tOut = Math.min(tOut, grid.cast(q, t.n, gapLen, i, -1));
      }
      if (tIn < thinLen) { thin.push(i); thinIn[i] = tIn; }
      if (tOut < gapLen) { gap.push(i); gapOut[i] = tOut; }
    });
    // the sharp tip of a wedge is thin for a hair's breadth: only patches big enough to matter
    const keep = (ids: number[]) => patches(tris, ids).filter((g) => g.reduce((a, k) => a + tris[k].area, 0) >= MIN_PATCH);
    const thinPs = keep(thin), gapPs = keep(gap);
    thin.length = 0; gap.length = 0;
    for (const g of thinPs) for (const k of g) { thin.push(k); thinnest = Math.min(thinnest, thinIn[k]); }
    for (const g of gapPs) for (const k of g) { gap.push(k); narrowest = Math.min(narrowest, gapOut[k]); }
    if (thin.length) {
      const ps = thinPs;
      issues.push({
        kind: 'thin', tris: thin, at: mid(boxOf(tris, ps[0])),
        title: `Thin wall${ps.length > 1 ? `s in ${ps.length} places` : ''}: ${mm(thinnest)} at the thinnest`,
        text: `Under ${mm(thinLen)} (two lines of a ${nozzle} mm nozzle) prints weak or not at all. Make it thicker, or leave it if it's meant to flex or break off.`,
      });
    }
    if (gap.length) {
      issues.push({
        kind: 'gap', tris: gap, at: mid(boxOf(tris, gap)),
        title: `Narrow gap: ${mm(narrowest)}`,
        text: `Gaps under ${mm(gapLen)} (one nozzle width) close up when printed. Widen it, or join the two sides on purpose.`,
      });
    }

    // overhangs: faces looking down more steeply than 45°, not on the bed
    const down = Math.cos(Math.PI / 4) + 0.02;
    const bed = lo[2] + 0.01;
    const over: number[] = [];
    tris.forEach((t, i) => {
      if (t.n[2] < -down && Math.max(t.a[2], t.b[2], t.c[2]) > bed) over.push(i);
    });
    const support: number[] = [], bridges: number[] = [];
    let steep = 0, longBridge = 0;
    for (const g of patches(tris, over)) {
      const b = boxOf(tris, g);
      // the tops of sideways holes are reported with the hole
      if (sideways.some((h) => inside(b, h.box))) continue;
      const area = g.reduce((s, i) => s + tris[i].area, 0);
      if (area < nozzle * nozzle * 4) continue;
      const flat = g.every((i) => tris[i].n[2] < -0.985);
      const span = Math.min(b[1][0] - b[0][0], b[1][1] - b[0][1]);
      if (flat && span <= 10) continue;                       // a short bridge prints fine
      if (flat) { bridges.push(...g); longBridge = Math.max(longBridge, span); }
      else { support.push(...g); steep++; }
    }
    if (support.length) {
      issues.push({
        kind: 'overhang', tris: support, at: mid(boxOf(tris, support)),
        title: `Overhang steeper than 45°${steep > 1 ? ` in ${steep} places` : ''}`,
        text: 'It will droop without support. Turn on supports in Prepare, chamfer it to 45°, or print the part another way up.',
      });
    }
    if (bridges.length) {
      issues.push({
        kind: 'overhang', tris: bridges, at: mid(boxOf(tris, bridges)),
        title: `Long flat overhang: ${mm(longBridge)} across`,
        text: 'Bridges past about 10 mm sag. Turn on supports in Prepare, or split it into shorter spans.',
      });
    }
  }

  for (const h of sideways) {
    issues.push({
      kind: 'sideways', feature: h.f.id, fix: 'teardrop', at: mid(h.box),
      title: `Hole on its side: ${mm(h.d)} across`,
      text: 'The top of a round hole lying sideways sags. A teardrop (a 45° point on top) prints clean without support.',
    });
  }

  for (const f of p.features) {
    const t = tinyReason(f, nozzle);
    if (t) issues.push({ kind: 'tiny', feature: f.id, title: t[0], text: t[1] });
  }

  const rank = { thin: 0, overhang: 1, sideways: 2, gap: 3, tiny: 4 } as const;
  return issues.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

function inside(b: [V3, V3], h: [V3, V3]) {
  const e = 0.3;
  return [0, 1, 2].every((k) => b[0][k] >= h[0][k] - e && b[1][k] <= h[1][k] + e);
}

/** Round holes drawn on a side view (their axis lies flat), 2 mm across or more, not already teardrops. */
export function sidewaysHoles(p: Project): { f: Feature; d: number; box: [V3, V3] }[] {
  const out: { f: Feature; d: number; box: [V3, V3] }[] = [];
  for (const f of p.features) {
    if (!isShape(f) || f.teardrop || !canTeardrop(f)) continue;
    if (f.type === 'circle' && f.op !== 'cut') continue;
    const d = f.type === 'hole' && f.hole ? f.hole.d : f.r * 2;
    if (d < 2) continue;
    const V = VIEWS[f.view];
    const [d0, d1] = depthRange(f, p);
    // the hole's own extent, plus room for a counterbore head
    const R = (f.type === 'hole' && f.hole?.headD ? Math.max(f.hole.headD, d) : d) / 2 + 0.5;
    const corners: V3[] = [];
    for (const du of [-R, R]) for (const dv of [-R, R]) for (const dd of [d0 - 0.6, d1 + 0.6]) corners.push(V.toWorld(f.cu + du, f.cv + dv, dd) as V3);
    const lo: V3 = [0, 1, 2].map((k) => Math.min(...corners.map((c) => c[k]))) as V3;
    const hi: V3 = [0, 1, 2].map((k) => Math.max(...corners.map((c) => c[k]))) as V3;
    out.push({ f, d, box: [lo, hi] });
  }
  return out;
}

/** Why a shape is too small to print, or null. */
function tinyReason(f: Feature, nozzle: number): [string, string] | null {
  if (!isShape(f)) return null;
  const small = nozzle * 2;
  if (f.type === 'text' && f.text) {
    const h = f.h || f.text.size;
    if (h > 0 && h < 3) return [`Small text: ${mm(h)} tall`, 'Letters under about 3 mm tall come out as blobs. Make it bigger, or bolder.'];
    return null;
  }
  if (f.op !== 'add') return null;
  let least = Infinity;
  if (f.type === 'circle' || f.type === 'polygon') least = f.r * 2;
  else if (f.type === 'rect') least = Math.min(f.w, f.h);
  if (least > 0 && least < small) return [`Tiny ${f.type === 'rect' ? 'rib' : 'post'}: ${mm(least)} across`, `Anything under ${mm(small)} across is too fine for the nozzle and may not print. Make it at least ${mm(small)}.`];
  return null;
}
