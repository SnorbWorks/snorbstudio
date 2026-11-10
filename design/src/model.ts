// The project: a body (stock block) plus an ordered list of features. Every
// view, the 3D preview and the STL are made from this and nothing else.

import { VIEWS } from './views.js';
import { type GearSpec, gearOutline, rackOutline, outerRadius, pitchRadius, place } from './gears.js';

export type ViewName = 'top' | 'front' | 'right' | 'left' | 'back' | 'bottom';
export type Vec3 = [number, number, number];
export type P2 = [number, number];

export interface Stock {
  min: Vec3;          // mm, world coordinates (X right, Y back, Z up)
  max: Vec3;
  off?: boolean;      // no body: the shapes stand on their own (e.g. a gear)
}

export type ShapeType = 'rect' | 'circle' | 'polygon' | 'poly' | 'gear' | 'text';

export interface TextSpec { s: string; size: number; bold: boolean }
/**
 * Which edge a fillet means, so it can follow the edge when shapes change:
 * the shape (or body) whose box the edge lies on, which copy of it, and where
 * in that box (0..1 along each world axis).
 */
export interface EdgeRef { owner: string; inst: number; rel: Vec3 }
export interface FilletSpec { mode: 'fillet' | 'chamfer'; size: number; edges: Vec3[]; refs?: (EdgeRef | null)[] }

/** Repeat a feature: in a row (step each time) or round a centre. World coordinates. */
export interface Pattern {
  kind: 'linear' | 'circular';
  count: number;
  step: Vec3;         // linear
  center: Vec3;       // circular
  axis: Vec3;         // circular: turn about this direction
  angle: number;      // circular: degrees from the first copy to the last (360 = all the way round)
}

/** A mirrored copy across the plane where world axis `axis` = `at`. */
export interface Mirror { axis: 0 | 1 | 2; at: number }

export interface Feature {
  id: string;
  type: ShapeType | 'fillet';
  view: ViewName;     // the view it was drawn in: its profile lives in that view's (u, v)
  cu: number;         // centre, in the view's u/v (mm)
  cv: number;
  w: number;          // rect width/height (u/v); text: its measured size
  h: number;
  r: number;          // circle radius; polygon: centre to corner
  corner: number;     // corner radius for every corner (rect, polygon, poly)
  corners?: number[]; // per corner, overriding corner (rect: 0 (-u,-v) 1 (+u,-v) 2 (+u,+v) 3 (-u,+v))
  sides?: number;     // polygon
  rot?: number;       // polygon / gear / text: turned this many degrees
  pts?: P2[];         // poly: corners relative to (cu, cv)
  gear?: GearSpec;
  text?: TextSpec;
  fillet?: FilletSpec;
  d0: number;         // start: the face it was drawn on, as depth toward the viewer
  d1: number;         // finish: the other end
  op: 'add' | 'cut';
  through: boolean;   // cut: run right through the part
  far?: boolean;      // drawn on the far face, seen through the part (the hidden-line tool)
  pattern?: Pattern;
  mirror?: Mirror;
}

/** A drafting dimension on a view: the size of a shape along one of the view's axes. */
export interface Dim {
  id: string;
  target: string;     // feature id or 'stock'
  view: ViewName;
  axis: 'u' | 'v' | 'dia';
  off: number;        // how far from the shape the dimension line sits (mm, outward)
}

export interface Project {
  version: 1;
  base?: { model: string };   // the body is a model from the library (an STL) instead of a block
  name: string;
  units: 'mm' | 'in';
  precision: number;  // decimals shown
  grid: number;       // snap increment, mm
  stock: Stock;
  views: ViewName[];  // shown views
  features: Feature[];
  dims?: Dim[];
}

export function newProject(): Project {
  return {
    version: 1,
    name: 'part',
    units: 'mm',
    precision: 2,
    grid: 1,
    stock: { min: [-10, -10, 0], max: [10, 10, 20] },
    views: ['top'],
    features: [],
    dims: [],
  };
}

let seq = 0;
export function newId(): string {
  seq += 1;
  return `f${Date.now().toString(36)}${seq}`;
}

export const isShape = (f: Feature) => f.type !== 'fillet';

/** Which way is "into the material" for a feature, in its depth: -1 from the near face, +1 from the far face. */
export const into = (f: Feature) => (f.far ? 1 : -1);

/** The feature's extruded depth range [lo, hi] (depth toward its viewer). */
export function depthRange(f: Feature, p: Project): [number, number] {
  if (f.op === 'cut' && f.through) {
    if (f.far) return [Math.min(f.d0, f.d1), Math.max(nearDepth(f.view, p) + 1, f.d0)];
    return [Math.min(farDepth(f.view, p) - 1, f.d0), Math.max(f.d0, f.d1)];
  }
  return [Math.min(f.d0, f.d1), Math.max(f.d0, f.d1)];
}

/** The depth (toward the viewer) of the far side of everything in the project. */
export function farDepth(view: ViewName, p: Project): number {
  return depthSpan(view, p)[0];
}

/** The depth of the near side of everything in the project. */
export function nearDepth(view: ViewName, p: Project): number {
  return depthSpan(view, p)[1];
}

function depthSpan(view: ViewName, p: Project): [number, number] {
  const v = VIEWS[view];
  let lo = Infinity, hi = -Infinity;
  const take = (c: Vec3) => { const d = dot(c, v.eye); lo = Math.min(lo, d); hi = Math.max(hi, d); };
  if (!p.stock.off) for (const c of boxCorners(p.stock.min, p.stock.max)) take(c);
  for (const f of p.features) {
    if (f.op !== 'add' || !isShape(f)) continue;
    for (const c of featureCorners(f)) take(c);
  }
  if (lo === Infinity) return [0, 0];
  return [lo, hi];
}

export function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

export function boxCorners(a: Vec3, b: Vec3): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) out.push([x, y, z]);
  return out;
}

// ------------------------------------------------------------ outlines

/** The corners of a straight-sided shape, in its view's (u, v), going round anticlockwise. */
export function verts(f: Feature): P2[] | null {
  if (f.type === 'rect') {
    const hw = f.w / 2, hh = f.h / 2;
    return [[f.cu - hw, f.cv - hh], [f.cu + hw, f.cv - hh], [f.cu + hw, f.cv + hh], [f.cu - hw, f.cv + hh]];
  }
  if (f.type === 'polygon') {
    const n = Math.max(3, Math.round(f.sides || 6));
    // a flat side at the bottom, then turned by rot
    const a0 = -Math.PI / 2 + Math.PI / n + ((f.rot || 0) * Math.PI) / 180;
    return Array.from({ length: n }, (_, k) => [f.cu + f.r * Math.cos(a0 + (2 * Math.PI * k) / n), f.cv + f.r * Math.sin(a0 + (2 * Math.PI * k) / n)] as P2);
  }
  if (f.type === 'poly' && f.pts && f.pts.length >= 3) {
    const pts = f.pts.map(([u, v]) => [f.cu + u, f.cv + v] as P2);
    return signedArea(pts) < 0 ? pts.reverse() : pts;
  }
  return null;
}

export function signedArea(pts: P2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]);
  return a / 2;
}

/** Corner radius at each corner, each limited so neighbouring rounds fit on their side. */
export function cornerRadii(f: Feature): number[] {
  const v = verts(f);
  if (!v) return [];
  const n = v.length;
  const want = Array.from({ length: n }, (_, i) => Math.max(0, (f.corners && f.corners[i] !== undefined ? f.corners[i] : f.corner) || 0));
  return want.map((r, i) => {
    if (r <= 0) return 0;
    const P = v[i], A = v[(i + n - 1) % n], B = v[(i + 1) % n];
    const la = Math.hypot(A[0] - P[0], A[1] - P[1]), lb = Math.hypot(B[0] - P[0], B[1] - P[1]);
    const th = angleAt(A, P, B);
    if (th < 1e-6 || th > Math.PI - 1e-6) return 0;
    // the round may use at most half of each side next to it
    const tmax = Math.min(la, lb) / 2;
    return Math.min(r, tmax * Math.tan(th / 2));
  });
}

function angleAt(A: P2, P: P2, B: P2): number {
  const ux = A[0] - P[0], uy = A[1] - P[1], vx = B[0] - P[0], vy = B[1] - P[1];
  const c = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy));
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

/**
 * A rounded corner at P (coming from A, going to B): where the round starts
 * and ends on the two sides, and a point half way round it.
 */
export function roundCorner(A: P2, P: P2, B: P2, r: number): { t1: P2; t2: P2; mid: P2 } | null {
  if (r <= 1e-9) return null;
  const th = angleAt(A, P, B);
  if (th < 1e-6 || th > Math.PI - 1e-6) return null;
  const ua = norm([A[0] - P[0], A[1] - P[1]]), ub = norm([B[0] - P[0], B[1] - P[1]]);
  const t = r / Math.tan(th / 2);
  const bis = norm([ua[0] + ub[0], ua[1] + ub[1]]);
  const dc = r / Math.sin(th / 2);
  const C: P2 = [P[0] + bis[0] * dc, P[1] + bis[1] * dc];
  return { t1: [P[0] + ua[0] * t, P[1] + ua[1] * t], t2: [P[0] + ub[0] * t, P[1] + ub[1] * t], mid: [C[0] - bis[0] * r, C[1] - bis[1] * r] };
}

const norm = (v: P2): P2 => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };

/** The straight part of each side (side k runs from corner k to corner k+1). */
export function sideSegs(f: Feature): P2[][] {
  const v = verts(f);
  if (!v) return [];
  const r = cornerRadii(f), n = v.length;
  return v.map((P, k) => {
    const Q = v[(k + 1) % n];
    const rc0 = roundCorner(v[(k + n - 1) % n], P, Q, r[k]);
    const rc1 = roundCorner(P, Q, v[(k + 2) % n], r[(k + 1) % n]);
    return [rc0 ? rc0.t2 : P, rc1 ? rc1.t1 : Q];
  });
}

/** The corner two sides share, or -1 (side k joins corners k and k+1). */
export function sharedCorner(a: number, b: number, n = 4): number {
  if ((a + 1) % n === b) return b;
  if ((b + 1) % n === a) return a;
  return -1;
}

/** The outline in the feature's own view (u, v), closed. Rings and text use their outside. */
export function profile(f: Feature, segs = 48): P2[] {
  if (f.type === 'circle') {
    return Array.from({ length: segs }, (_, i) => [f.cu + f.r * Math.cos((i / segs) * 2 * Math.PI), f.cv + f.r * Math.sin((i / segs) * 2 * Math.PI)] as P2);
  }
  if (f.type === 'gear' && f.gear) return gearProfile(f).outer;
  if (f.type === 'text') {
    const hw = f.w / 2, hh = f.h / 2;
    return rotatePts([[f.cu - hw, f.cv - hh], [f.cu + hw, f.cv - hh], [f.cu + hw, f.cv + hh], [f.cu - hw, f.cv + hh]], f.cu, f.cv, f.rot || 0);
  }
  const v = verts(f);
  if (!v) return [];
  const r = cornerRadii(f), n = v.length;
  const out: P2[] = [];
  v.forEach((P, i) => {
    const rc = roundCorner(v[(i + n - 1) % n], P, v[(i + 1) % n], r[i]);
    if (!rc) { out.push(P); return; }
    // the round, as a few points from t1 to t2 through mid
    const arc = arcPoints(rc.t1, rc.mid, rc.t2, 8);
    out.push(...arc);
  });
  return out;
}

/** Points on the circle through a, m, b, from a to b. */
export function arcPoints(a: P2, m: P2, b: P2, n: number): P2[] {
  const [cx, cy, R] = circle3(a, m, b);
  if (!Number.isFinite(R)) return [a, b];
  const a0 = Math.atan2(a[1] - cy, a[0] - cx), am = Math.atan2(m[1] - cy, m[0] - cx), a1 = Math.atan2(b[1] - cy, b[0] - cx);
  // go the way that passes through m
  const norm2 = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const span = norm2(am - a0) < norm2(a1 - a0) ? norm2(a1 - a0) : -norm2(a0 - a1);
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) { const t = a0 + (span * i) / n; out.push([cx + R * Math.cos(t), cy + R * Math.sin(t)]); }
  return out;
}

function circle3(a: P2, b: P2, c: P2): [number, number, number] {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return [0, 0, Infinity];
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return [x, y, Math.hypot(a[0] - x, a[1] - y)];
}

export function rotatePts(pts: P2[], cu: number, cv: number, deg: number): P2[] {
  if (!deg) return pts;
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
  return pts.map(([x, y]) => [cu + (x - cu) * c - (y - cv) * s, cv + (x - cu) * s + (y - cv) * c]);
}

/** A gear's outline: outside, and for a ring the toothed hole. */
export function gearProfile(f: Feature): { outer: P2[]; hole?: P2[] } {
  const g = f.gear!;
  const rot = f.rot || 0;
  if (g.kind === 'rack') return { outer: place(rackOutline(g.module, g.teeth, g.pa, g.rim, g.backlash), f.cu, f.cv, rot) };
  if (g.kind === 'ring') {
    const R = outerRadius(g);
    const outer = Array.from({ length: 96 }, (_, i) => [f.cu + R * Math.cos((i / 96) * 2 * Math.PI), f.cv + R * Math.sin((i / 96) * 2 * Math.PI)] as P2);
    // the tooth spaces are the shape of an external gear's teeth, with the clearance the other way
    return { outer, hole: place(gearOutline(g.module, g.teeth, g.pa, 1.25, 1, -g.backlash), f.cu, f.cv, rot) };
  }
  return { outer: place(gearOutline(g.module, g.teeth, g.pa, 1, 1.25, g.backlash), f.cu, f.cv, rot) };
}

/** The feature's extent in its own view: [u0, v0, u1, v1]. */
export function bounds2d(f: Feature): [number, number, number, number] {
  if (f.type === 'circle') return [f.cu - f.r, f.cv - f.r, f.cu + f.r, f.cv + f.r];
  if (f.type === 'gear' && f.gear && f.gear.kind !== 'rack') {
    const R = Math.max(outerRadius(f.gear), f.gear.hubD / 2);
    return [f.cu - R, f.cv - R, f.cu + R, f.cv + R];
  }
  const pts = f.type === 'rect' || f.type === 'polygon' || f.type === 'poly' ? verts(f) || [] : profile(f);
  if (!pts.length) return [f.cu, f.cv, f.cu, f.cv];
  const us = pts.map((p) => p[0]), vs = pts.map((p) => p[1]);
  return [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)];
}

/** The feature's depth extent including a gear's hub (which sits on the start side). */
export function depthExtent(f: Feature, p: Project): [number, number] {
  const [lo, hi] = depthRange(f, p);
  if (f.type === 'gear' && f.gear && f.gear.hubLen > 0 && f.gear.hubD > 0) {
    const out = f.d1 >= f.d0 ? -1 : 1;     // the hub sticks out the other way from the teeth
    const end = f.d0 + out * f.gear.hubLen;
    return [Math.min(lo, end), Math.max(hi, end)];
  }
  return [lo, hi];
}

/** The 8 corners of the feature's bounding prism, in world coordinates (through cuts: just their drawn depth). */
export function featureCorners(f: Feature, p?: Project): Vec3[] {
  const v = VIEWS[f.view];
  const [lo, hi] = p ? depthExtent(f, p) : [Math.min(f.d0, f.d1), Math.max(f.d0, f.d1)];
  const [u0, v0, u1, v1] = bounds2d(f);
  const out: Vec3[] = [];
  for (const u of [u0, u1]) for (const vv of [v0, v1]) for (const d of [lo, hi]) out.push(v.toWorld(u, vv, d));
  return out;
}

export { pitchRadius, outerRadius };

// ------------------------------------------------------------ copies (pattern, mirror)

/** A rigid move of a copy: applied in order. */
export type Op =
  | { t: Vec3 }
  | { rot: number; c: Vec3; ax: Vec3 }
  | { mir: 0 | 1 | 2; at: number };

/** Every copy of a feature as a list of moves; the first is the feature itself (no moves). */
export function instances(f: Feature): Op[][] {
  let list: Op[][] = [[]];
  const pt = f.pattern;
  if (pt && pt.count > 1) {
    list = [];
    for (let k = 0; k < pt.count; k++) {
      if (pt.kind === 'linear') list.push(k ? [{ t: [pt.step[0] * k, pt.step[1] * k, pt.step[2] * k] }] : []);
      else {
        const full = Math.abs(Math.abs(pt.angle) - 360) < 1e-9;
        const each = pt.angle / (full ? pt.count : Math.max(1, pt.count - 1));
        list.push(k ? [{ rot: each * k, c: pt.center, ax: pt.axis }] : []);
      }
    }
  }
  if (f.mirror) list = [...list, ...list.map((ops) => [...ops, { mir: f.mirror!.axis, at: f.mirror!.at } as Op])];
  return list;
}

export function applyOps(p: Vec3, ops: Op[]): Vec3 {
  let q: Vec3 = [...p] as Vec3;
  for (const o of ops) {
    if ('t' in o) q = [q[0] + o.t[0], q[1] + o.t[1], q[2] + o.t[2]];
    else if ('mir' in o) q[o.mir] = 2 * o.at - q[o.mir];
    else q = rotateAbout(q, o.c, o.ax, o.rot);
  }
  return q;
}

export function rotateAbout(p: Vec3, c: Vec3, ax: Vec3, deg: number): Vec3 {
  const l = Math.hypot(ax[0], ax[1], ax[2]) || 1;
  const k: Vec3 = [ax[0] / l, ax[1] / l, ax[2] / l];
  const a = (deg * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
  const v: Vec3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const kd = dot(k, v);
  const kx: Vec3 = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  return [0, 1, 2].map((i) => c[i] + v[i] * cs + kx[i] * sn + k[i] * kd * (1 - cs)) as Vec3;
}

// ------------------------------------------------------------ boxes and edge references

/** A feature's box in world coordinates (a through cut stops at the part's far side). */
export function featureExtents(f: Feature, p: Project): [Vec3, Vec3] {
  const [u0, v0, u1, v1] = bounds2d(f);
  const dr = depthExtent(f, p);
  if (f.op === 'cut' && f.through) {
    if (f.far) dr[1] = Math.max(nearDepth(f.view, p), dr[0]);
    else dr[0] = Math.min(farDepth(f.view, p), dr[1]);
  }
  const V = VIEWS[f.view];
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const u of [u0, u1]) for (const v of [v0, v1]) for (const d of dr) {
    const w = V.toWorld(u, v, d);
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], w[i]); max[i] = Math.max(max[i], w[i]); }
  }
  return [min, max];
}

/** The box of the body or a shape. */
export function ownerExtents(id: string, p: Project): [Vec3, Vec3] | null {
  if (id === 'stock') return p.stock.off && !p.base ? null : [p.stock.min, p.stock.max];
  const f = p.features.find((q) => q.id === id);
  return f && isShape(f) ? featureExtents(f, p) : null;
}

/** Undo a copy's moves (for finding where on the original a point of a copy is). */
export function invertOps(ops: Op[]): Op[] {
  return [...ops].reverse().map((o) => ('t' in o ? { t: [-o.t[0], -o.t[1], -o.t[2]] as Vec3 } : 'mir' in o ? o : { ...o, rot: -o.rot }));
}

const ON = 0.01;   // mm: how close counts as on a box face

/** The best reference for a point on an edge: the shape whose box it sits on in the most directions (later shapes win ties). */
export function findRef(pt: Vec3, p: Project, before = p.features.length): EdgeRef | null {
  let best: EdgeRef | null = null, bestScore = -1;
  const consider = (owner: string, inst: number, q: Vec3, ext: [Vec3, Vec3], order: number) => {
    const [mn, mx] = ext;
    let faces = 0;
    for (let i = 0; i < 3; i++) {
      if (q[i] < mn[i] - ON || q[i] > mx[i] + ON) return;
      if (Math.abs(q[i] - mn[i]) < ON || Math.abs(q[i] - mx[i]) < ON) faces++;
    }
    if (!faces) return;
    const score = faces * 1e4 + order;
    if (score <= bestScore) return;
    bestScore = score;
    best = { owner, inst, rel: [0, 1, 2].map((i) => (mx[i] - mn[i] > 1e-9 ? (q[i] - mn[i]) / (mx[i] - mn[i]) : 0)) as Vec3 };
  };
  const se = ownerExtents('stock', p);
  if (se) consider('stock', 0, pt, se, 0);
  p.features.slice(0, before).forEach((f, idx) => {
    if (!isShape(f)) return;
    const ext = featureExtents(f, p);
    instances(f).forEach((ops, k) => consider(f.id, k, k ? applyOps(pt, invertOps(ops)) : pt, ext, idx + 1));
  });
  return best;
}

/** Where a reference says its edge is now. */
export function fromRef(ref: EdgeRef, p: Project): Vec3 | null {
  const ext = ownerExtents(ref.owner, p);
  if (!ext) return null;
  const [mn, mx] = ext;
  const q = [0, 1, 2].map((i) => mn[i] + ref.rel[i] * (mx[i] - mn[i])) as Vec3;
  if (ref.owner === 'stock' || !ref.inst) return q;
  const f = p.features.find((x) => x.id === ref.owner)!;
  const ops = instances(f)[ref.inst];
  return ops ? applyOps(q, ops) : null;
}
