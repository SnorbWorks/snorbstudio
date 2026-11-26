// Traced outlines back into curves. An SVG is drawn in curves, but the import
// reads it as hundreds of points; every point would become a face on the
// part. This fits a few cubic Béziers through them (Schneider's method),
// keeping sharp corners sharp and straight runs straight, so the shape is
// smooth, light to build, and editable with Direct Selection like a Pen shape.
import type { Ctrl, Feature, P2, Project } from './model.js';

/** How far the curves may stray from the traced points (mm). */
export const FIT_TOL = 0.05;
/** Outlines with more points than this (and no curves yet) get fitted. */
export const FIT_MIN_POINTS = 24;
/** A turn sharper than this is a corner. */
const CORNER_DEG = 35;

export interface Fitted { pts: P2[]; curves: (Ctrl | null)[]; smooth: boolean[] }

const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: P2, s: number): P2 => [a[0] * s, a[1] * s];
const dot = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
const len = (a: P2) => Math.hypot(a[0], a[1]);
const unit = (a: P2): P2 => { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l] : [1, 0]; };
const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function bez(c: [P2, P2, P2, P2], t: number): P2 {
  const s = 1 - t;
  const a = s * s * s, b = 3 * s * s * t, d = 3 * s * t * t, e = t * t * t;
  return [a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0], a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1]];
}
function bezD1(c: [P2, P2, P2, P2], t: number): P2 {
  const s = 1 - t;
  return add(add(mul(sub(c[1], c[0]), 3 * s * s), mul(sub(c[2], c[1]), 6 * s * t)), mul(sub(c[3], c[2]), 3 * t * t));
}
function bezD2(c: [P2, P2, P2, P2], t: number): P2 {
  return add(mul(add(sub(c[2], mul(c[1], 2)), c[0]), 6 * (1 - t)), mul(add(sub(c[3], mul(c[2], 2)), c[1]), 6 * t));
}

/** Drop points sitting on top of the one before. */
function dedupe(pts: P2[], eps: number): P2[] {
  const out: P2[] = [];
  for (const p of pts) if (!out.length || dist(p, out[out.length - 1]) > eps) out.push(p);
  while (out.length > 2 && dist(out[0], out[out.length - 1]) <= eps) out.pop();
  return out;
}

/** Which points are corners: the turn, judged over a short reach either side, is sharp, and the sharpest nearby. */
function corners(pts: P2[], reach: number): number[] {
  const n = pts.length;
  const back = (i: number) => { let j = i, d = 0; for (let k = 0; k < n - 1 && d < reach; k++) { const p = (j - 1 + n) % n; d += dist(pts[j], pts[p]); j = p; } return pts[j]; };
  const fwd = (i: number) => { let j = i, d = 0; for (let k = 0; k < n - 1 && d < reach; k++) { const p = (j + 1) % n; d += dist(pts[j], pts[p]); j = p; } return pts[j]; };
  const near = (i: number): number => {
    // the plain turn at the point itself: catches corners on coarse outlines
    const a = sub(pts[i], pts[(i - 1 + n) % n]), b = sub(pts[(i + 1) % n], pts[i]);
    return Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b)))));
  };
  const turn = pts.map((p, i) => {
    const a = sub(p, back(i)), b = sub(fwd(i), p);
    const wide = Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b)))));
    return Math.max(wide, near(i) * 0.999);
  });
  const lim = (CORNER_DEG * Math.PI) / 180;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (turn[i] < lim) continue;
    // keep only the sharpest point of a cluster within the reach
    let best = true;
    for (let d = 1, s = 0; d < n && s < reach; d++) {
      const j = (i + d) % n, k = (i - d + n) % n;
      s += dist(pts[(i + d - 1) % n], pts[j]);
      if (turn[j] > turn[i] || turn[k] > turn[i] || (turn[j] === turn[i] && j < i) || (turn[k] === turn[i] && k < i)) { best = false; break; }
    }
    if (best) out.push(i);
  }
  return out;
}

function chordParams(pts: P2[]): number[] {
  const u = [0];
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + dist(pts[i], pts[i - 1]));
  const L = u[u.length - 1] || 1;
  return u.map((x) => x / L);
}

/** Least-squares cubic from pts[0] to pts[last] leaving along t0 and arriving back along t1 (t1 points backwards). */
function generate(pts: P2[], u: number[], t0: P2, t1: P2): [P2, P2, P2, P2] {
  const P0 = pts[0], P3 = pts[pts.length - 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < pts.length; i++) {
    const t = u[i], s = 1 - t;
    const b0 = s * s * s, b1 = 3 * s * s * t, b2 = 3 * s * t * t, b3 = t * t * t;
    const a0 = mul(t0, b1), a1 = mul(t1, b2);
    c00 += dot(a0, a0); c01 += dot(a0, a1); c11 += dot(a1, a1);
    const tmp = sub(pts[i], add(mul(P0, b0 + b1), mul(P3, b2 + b3)));
    x0 += dot(a0, tmp); x1 += dot(a1, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  const seg = dist(P0, P3);
  let al = det !== 0 ? (x0 * c11 - x1 * c01) / det : 0;
  let ar = det !== 0 ? (c00 * x1 - c01 * x0) / det : 0;
  if (!(al > 1e-6 * seg) || !(ar > 1e-6 * seg) || al > seg * 4 || ar > seg * 4) al = ar = seg / 3;
  return [P0, add(P0, mul(t0, al)), add(P3, mul(t1, ar)), P3];
}

function maxError(pts: P2[], c: [P2, P2, P2, P2], u: number[]): [number, number] {
  let worst = 0, at = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const d = dist(bez(c, u[i]), pts[i]);
    if (d > worst) { worst = d; at = i; }
  }
  return [worst, at];
}

function reparam(pts: P2[], c: [P2, P2, P2, P2], u: number[]): number[] {
  return u.map((t, i) => {
    const d = sub(bez(c, t), pts[i]), d1 = bezD1(c, t), d2 = bezD2(c, t);
    const den = dot(d1, d1) + dot(d, d2);
    if (Math.abs(den) < 1e-12) return t;
    return Math.max(0, Math.min(1, t - dot(d, d1) / den));
  });
}

/** Off a straight line by no more than tol everywhere? */
function straight(pts: P2[], tol: number): boolean {
  const a = pts[0], b = pts[pts.length - 1], L = dist(a, b);
  if (L < 1e-9) return false;
  const n: P2 = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
  return pts.every((p) => Math.abs(dot(sub(p, a), n)) <= tol && dot(sub(p, a), sub(b, a)) >= -tol && dot(sub(p, b), sub(a, b)) >= -tol);
}

type Piece = { end: P2; ctrl: Ctrl | null; smoothEnd: boolean };

/** Fit pts (first to last) with curves; t0 leaves the start, t1 points back from the end. */
function fitRun(pts: P2[], t0: P2, t1: P2, tol: number, depth = 0): Piece[] {
  const end = pts[pts.length - 1];
  if (pts.length <= 2 || straight(pts, tol)) return [{ end, ctrl: null, smoothEnd: false }];
  let u = chordParams(pts);
  let c = generate(pts, u, t0, t1);
  let [err, at] = maxError(pts, c, u);
  if (err > tol && err < tol * 8) {
    for (let k = 0; k < 6 && err > tol; k++) {
      u = reparam(pts, c, u);
      c = generate(pts, u, t0, t1);
      [err, at] = maxError(pts, c, u);
    }
  }
  if (err <= tol || depth > 24 || pts.length < 4) return [{ end, ctrl: [c[1], c[2]], smoothEnd: false }];
  at = Math.max(1, Math.min(pts.length - 2, at));
  const mid = unit(sub(pts[at + 1], pts[at - 1]));
  const left = fitRun(pts.slice(0, at + 1), t0, mul(mid, -1), tol, depth + 1);
  const right = fitRun(pts.slice(at), mid, t1, tol, depth + 1);
  left[left.length - 1].smoothEnd = true;
  return [...left, ...right];
}

/** Direction away from pts[i] along the run, judged a little way out (traced points wobble). */
function tangentFrom(pts: P2[], i: number, step: 1 | -1, reach: number): P2 {
  let j = i, d = 0;
  while (j + step >= 0 && j + step < pts.length && d < reach) { d += dist(pts[j], pts[j + step]); j += step; }
  return unit(sub(pts[j], pts[i]));
}

/** A closed traced outline as anchor points with Bézier sides. Null when it can't do better. */
export function fitOutline(raw: P2[], tol = FIT_TOL): Fitted | null {
  const pts = dedupe(raw, tol * 0.05);
  const n = pts.length;
  if (n < 4) return null;
  let size = 0;
  for (const p of pts) size = Math.max(size, dist(p, pts[0]));
  const reach = Math.min(Math.max(tol * 6, size * 0.004), size * 0.05);
  const cs = corners(pts, reach);
  const out: Fitted = { pts: [], curves: [], smooth: [] };
  const push = (start: P2, pieces: Piece[], startSmooth: boolean) => {
    out.pts.push(start); out.smooth.push(startSmooth);
    pieces.forEach((pc, k) => {
      out.curves.push(pc.ctrl);
      if (k < pieces.length - 1) { out.pts.push(pc.end); out.smooth.push(pc.smoothEnd); }
    });
  };
  if (!cs.length) {
    // all smooth: start anywhere, leave and return along the same tangent
    const ring = [...pts, pts[0]];
    const t = unit(sub(pts[1], pts[n - 1]));
    push(pts[0], fitRun(ring, t, mul(t, -1), tol), true);
  } else {
    for (let k = 0; k < cs.length; k++) {
      const a = cs[k], b = cs[(k + 1) % cs.length];
      const run: P2[] = [];
      for (let i = a; ; i = (i + 1) % n) { run.push(pts[i]); if (i === b && run.length > 1) break; }
      const t0 = tangentFrom(run, 0, 1, reach), t1 = tangentFrom(run, run.length - 1, -1, reach);
      push(pts[a], fitRun(run, t0, t1, tol), false);
    }
  }
  if (out.pts.length < 2 || out.pts.length >= n) return null;
  return out;
}

/** A dense traced outline (no curves of its own yet) that should be fitted? */
export function isDense(f: Feature): boolean {
  return f.type === 'poly' && !!f.pts && f.pts.length > FIT_MIN_POINTS
    && !f.curves?.some((c) => !!c) && !f.bulges?.some((b) => Math.abs(b) > 1e-9)
    && !(f.corner > 1e-9) && !f.corners?.some((c) => c > 1e-9);
}

/** Turn this outline's traced points into curves, in place. False if left alone. */
export function curveFeature(f: Feature, tol = FIT_TOL): boolean {
  if (!isDense(f)) return false;
  const r = fitOutline(f.pts!, tol);
  if (!r) return false;
  const q = (p: P2): P2 => [+p[0].toFixed(4), +p[1].toFixed(4)];
  f.pts = r.pts.map(q);
  f.curves = r.curves.map((c) => (c ? [q(c[0]), q(c[1])] as Ctrl : null));
  f.smooth = r.smooth;
  delete f.bulges; delete f.corners;
  return true;
}

/** Parts saved before imports kept their curves: fit every dense outline. How many changed. */
export function curveProject(p: Project): number {
  let n = 0;
  for (const f of p.features || []) if (curveFeature(f)) n++;
  return n;
}
