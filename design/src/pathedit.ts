// Editing an outline's points (the Direct Selection tool, A) and turning a
// plain shape into an outline the first time its points are moved.
//
// An outline (type 'poly') is corners f.pts (relative to cu, cv), and per side
// k (corner k to k+1) either a straight line, an arc (f.bulges[k]) or a
// Bézier curve (f.curves[k] = its two handles, relative to cu, cv).
import type { Feature, P2, Ctrl } from './model.js';
import { verts, cornerRadii, roundCorner, slotPath, bezierAt, takesFit, bulgeMid } from './model.js';

const KAPPA = 0.5522847498;   // a quarter circle as a Bézier
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const p4 = (p: P2): P2 => [r4(p[0]), r4(p[1])];

/** How far m sits right of the chord a→b (the bulge that puts an arc through m). */
export function bulgeThrough(a: P2, b: P2, m: P2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  return (m[0] - (a[0] + b[0]) / 2) * (dy / L) + (m[1] - (a[1] + b[1]) / 2) * (-dx / L);
}

/** Shapes that can become an outline (gears, text and holes keep their own boxes). */
export const canOutline = (f: Feature) => ['rect', 'polygon', 'slot', 'circle', 'poly'].includes(f.type) && !f.teardrop;

/** Turn a rectangle, polygon, slot or circle into an outline with the same shape, in place. False if it can't. */
export function toOutline(f: Feature): boolean {
  if (f.type === 'poly') return true;
  if (!canOutline(f)) return false;
  const fit = takesFit(f);
  let pts: P2[] = [], bulges: number[] = [], curves: (Ctrl | null)[] = [];
  if (f.type === 'circle') {
    const r = f.r, k = KAPPA * r;
    pts = [[r, 0], [0, r], [-r, 0], [0, -r]];
    curves = [[[r, k], [k, r]], [[-k, r], [-r, k]], [[-r, -k], [-k, -r]], [[k, -r], [r, -k]]];
    bulges = [0, 0, 0, 0];
  } else if (f.type === 'slot') {
    const s = slotPath(f);
    if (!s) return false;
    const rel = (p: P2): P2 => [p[0] - f.cu, p[1] - f.cv];
    pts = [s.a, s.b, s.c, s.d].map(rel);
    bulges = [0, bulgeThrough(s.b, s.c, s.m1), 0, bulgeThrough(s.d, s.a, s.m2)];
  } else {
    const v = verts(f);
    if (!v) return false;
    const r = cornerRadii(f), n = v.length;
    v.forEach((P, i) => {
      const rc = roundCorner(v[(i + n - 1) % n], P, v[(i + 1) % n], r[i]);
      if (!rc) { pts.push(P); bulges.push(0); return; }
      pts.push(rc.t1, rc.t2);
      bulges.push(bulgeThrough(rc.t1, rc.t2, rc.mid), 0);
    });
    pts = pts.map((p) => [p[0] - f.cu, p[1] - f.cv]);
  }
  f.type = 'poly';
  f.pts = pts.map(p4);
  f.bulges = bulges.some((b) => Math.abs(b) > 1e-9) ? bulges.map(r4) : undefined;
  f.curves = curves.some(Boolean) ? curves.map((c) => c && [p4(c[0]), p4(c[1])]) : undefined;
  f.smooth = f.curves ? f.pts.map(() => true) : undefined;
  if (fit) f.fit = true;
  f.w = 0; f.h = 0; f.r = 0; f.corner = 0;
  delete f.corners; delete f.rot; delete f.sides;
  return true;
}

/** Each point of an outline, absolute, with its handles (in: the end of the side before; out: the start of the side after). */
export function anchors(f: Feature): { p: P2; inH: P2 | null; outH: P2 | null; smooth: boolean }[] {
  const pts = f.pts || [], n = pts.length;
  const abs = (q: P2): P2 => [f.cu + q[0], f.cv + q[1]];
  return pts.map((q, i) => {
    const before = f.curves?.[(i + n - 1) % n], after = f.curves?.[i];
    return { p: abs(q), inH: before ? abs(before[1]) : null, outH: after ? abs(after[0]) : null, smooth: !!f.smooth?.[i] };
  });
}

/** Move point i (and its handles with it) to an absolute place. */
export function movePoint(f: Feature, i: number, to: P2) {
  const pts = f.pts!, n = pts.length;
  const d: P2 = [to[0] - f.cu - pts[i][0], to[1] - f.cv - pts[i][1]];
  pts[i] = p4([pts[i][0] + d[0], pts[i][1] + d[1]]);
  const c0 = f.curves?.[(i + n - 1) % n], c1 = f.curves?.[i];
  if (c0) c0[1] = p4([c0[1][0] + d[0], c0[1][1] + d[1]]);
  if (c1) c1[0] = p4([c1[0][0] + d[0], c1[0][1] + d[1]]);
}

/**
 * Drag a handle of point i ('in' or 'out') to an absolute place. A smooth
 * point's other handle turns to stay in line, keeping its own length
 * (Option breaks it: the point becomes a corner).
 */
export function moveHandle(f: Feature, i: number, which: 'in' | 'out', to: P2, breakIt = false) {
  const n = f.pts!.length, P: P2 = f.pts![i];
  const rel: P2 = [to[0] - f.cu, to[1] - f.cv];
  ensureCurves(f);
  const side = which === 'out' ? i : (i + n - 1) % n;
  const c = f.curves![side] ?? (f.curves![side] = straightCtrl(f, side));
  c[which === 'out' ? 0 : 1] = p4(rel);
  if (f.bulges) f.bulges[side] = 0;
  if (breakIt) { setSmoothFlag(f, i, false); return; }
  if (!f.smooth?.[i]) return;
  const otherSide = which === 'out' ? (i + n - 1) % n : i;
  const o = f.curves![otherSide];
  if (!o) return;
  const end = which === 'out' ? 1 : 0;
  const len = Math.hypot(o[end][0] - P[0], o[end][1] - P[1]);
  const dx = P[0] - rel[0], dy = P[1] - rel[1], L = Math.hypot(dx, dy);
  if (L < 1e-9) return;
  o[end] = p4([P[0] + (dx / L) * len, P[1] + (dy / L) * len]);
}

/** Corner ↔ smooth (Option-click a point). */
export function toggleSmooth(f: Feature, i: number) {
  const pts = f.pts!, n = pts.length;
  const prev = (i + n - 1) % n;
  if (f.smooth?.[i]) {
    // a corner: pull its handles back into the point; sides with no handle left go straight
    setSmoothFlag(f, i, false);
    const a = f.curves?.[prev], b = f.curves?.[i];
    if (a) a[1] = [...pts[i]] as P2;
    if (b) b[0] = [...pts[i]] as P2;
    for (const s of [prev, i]) {
      const c = f.curves?.[s];
      const S = pts[s], E = pts[(s + 1) % n];
      if (c && onChord(S, E, c[0]) && onChord(S, E, c[1])) f.curves![s] = null;
    }
    tidy(f);
    return;
  }
  // smooth: handles along the line from the point before to the point after, a third of each side long
  const P = pts[i], A = pts[prev], B = pts[(i + 1) % n];
  let tx = B[0] - A[0], ty = B[1] - A[1];
  const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
  const la = Math.hypot(P[0] - A[0], P[1] - A[1]) / 3, lb = Math.hypot(B[0] - P[0], B[1] - P[1]) / 3;
  ensureCurves(f);
  const ca = f.curves![prev] ?? (f.curves![prev] = straightCtrl(f, prev));
  const cb = f.curves![i] ?? (f.curves![i] = straightCtrl(f, i));
  ca[1] = p4([P[0] - tx * la, P[1] - ty * la]);
  cb[0] = p4([P[0] + tx * lb, P[1] + ty * lb]);
  if (f.bulges) { f.bulges[prev] = 0; f.bulges[i] = 0; }
  setSmoothFlag(f, i, true);
  tidy(f);
}

/** Add a point on side k at t (0..1) without changing the shape. Returns the new point's index. */
export function splitSide(f: Feature, k: number, t: number): number {
  const pts = f.pts!, n = pts.length;
  const A = pts[k], B = pts[(k + 1) % n];
  const c = f.curves?.[k];
  const b = f.bulges?.[k] || 0;
  let M: P2, left: Ctrl | null = null, right: Ctrl | null = null, bl = 0, br = 0;
  if (c) {
    // de Casteljau
    const lerp = (p: P2, q: P2): P2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    const ab = lerp(A, c[0]), bc = lerp(c[0], c[1]), cd = lerp(c[1], B);
    const abc = lerp(ab, bc), bcd = lerp(bc, cd);
    M = lerp(abc, bcd);
    left = [p4(ab), p4(abc)]; right = [p4(bcd), p4(cd)];
  } else if (Math.abs(b) > 1e-9) {
    // an arc: a point on it, then each half is an arc through its own middle
    const onArc = (s: number) => arcPoint(A, bulgeMid(A, B, b), B, s);
    M = onArc(t);
    bl = bulgeThrough(A, M, onArc(t / 2));
    br = bulgeThrough(M, B, onArc((1 + t) / 2));
  } else M = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];
  pts.splice(k + 1, 0, p4(M));
  if (f.curves || left) { ensureCurves(f, n); f.curves!.splice(k, 1, left, right); }
  if (f.bulges || bl || br) { const bs = f.bulges ?? Array(n).fill(0); bs.splice(k, 1, r4(bl), r4(br)); f.bulges = bs; }
  if (f.smooth) f.smooth.splice(k + 1, 0, !!c);
  else if (c) { f.smooth = pts.map(() => false); f.smooth[k + 1] = true; }
  tidy(f);
  return k + 1;
}

/** Remove point i (an outline keeps at least 3). The two sides it joined become one. */
export function deletePoint(f: Feature, i: number): boolean {
  const pts = f.pts!, n = pts.length;
  if (n <= 3) return false;
  const prev = (i + n - 1) % n;
  const a = f.curves?.[prev], b = f.curves?.[i];
  const joined: Ctrl | null = a || b ? [a ? a[0] : [...pts[prev]] as P2, b ? b[1] : [...pts[(i + 1) % n]] as P2] : null;
  pts.splice(i, 1);
  if (f.curves) {
    f.curves[prev] = joined;
    f.curves.splice(i, 1);
  }
  if (f.bulges) { f.bulges[prev] = 0; f.bulges.splice(i, 1); }
  if (f.smooth) f.smooth.splice(i, 1);
  // prev may have moved down by one when i was 0
  tidy(f);
  return true;
}

/** Which side (and where along it) a point is nearest, within tol. */
export function sideAt(f: Feature, p: P2, tol: number): { k: number; t: number } | null {
  const pts = (f.pts || []).map((q) => [f.cu + q[0], f.cv + q[1]] as P2), n = pts.length;
  let best: { k: number; t: number } | null = null, bd = tol;
  for (let k = 0; k < n; k++) {
    const A = pts[k], B = pts[(k + 1) % n];
    const c = f.curves?.[k], b = f.bulges?.[k] || 0;
    const at = (s: number): P2 => c ? bezierAt(A, [f.cu + c[0][0], f.cv + c[0][1]], [f.cu + c[1][0], f.cv + c[1][1]], B, s)
      : Math.abs(b) > 1e-9 ? arcPoint(A, bulgeMid(A, B, b), B, s) : [A[0] + (B[0] - A[0]) * s, A[1] + (B[1] - A[1]) * s];
    for (let j = 1; j < 40; j++) {
      const s = j / 40, q = at(s), d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) { bd = d; best = { k, t: s }; }
    }
  }
  return best;
}

/** Keep cu, cv in the middle of the outline (the panel's Centre), the shape staying put. */
export function recentre(f: Feature) {
  const pts = f.pts;
  if (!pts?.length) return;
  const us = pts.map((p) => p[0]), vs = pts.map((p) => p[1]);
  const du = (Math.min(...us) + Math.max(...us)) / 2, dv = (Math.min(...vs) + Math.max(...vs)) / 2;
  if (Math.abs(du) < 1e-6 && Math.abs(dv) < 1e-6) return;
  const sh = (p: P2): P2 => p4([p[0] - du, p[1] - dv]);
  f.pts = pts.map(sh);
  if (f.curves) f.curves = f.curves.map((c) => c && [sh(c[0]), sh(c[1])]);
  if (f.revolve) f.revolve.at = sh(f.revolve.at);
  f.cu = r4(f.cu + du); f.cv = r4(f.cv + dv);
}

// ------------------------------------------------------------ helpers

function ensureCurves(f: Feature, n = f.pts!.length) {
  if (!f.curves) f.curves = Array(n).fill(null);
  while (f.curves.length < n) f.curves.push(null);
}
function straightCtrl(f: Feature, k: number): Ctrl {
  const pts = f.pts!, n = pts.length, A = pts[k], B = pts[(k + 1) % n];
  return [p4([A[0] + (B[0] - A[0]) / 3, A[1] + (B[1] - A[1]) / 3]), p4([A[0] + (2 * (B[0] - A[0])) / 3, A[1] + (2 * (B[1] - A[1])) / 3])];
}
function setSmoothFlag(f: Feature, i: number, on: boolean) {
  if (!f.smooth) f.smooth = f.pts!.map(() => false);
  f.smooth[i] = on;
}
/** A handle lying on the straight line between the side's ends (so the side is really straight). */
function onChord(S: P2, E: P2, c: P2): boolean {
  const dx = E[0] - S[0], dy = E[1] - S[1], L = Math.hypot(dx, dy) || 1;
  return Math.abs(((c[0] - S[0]) * dy - (c[1] - S[1]) * dx) / L) < 1e-4;
}
function tidy(f: Feature) {
  if (f.curves && !f.curves.some(Boolean)) delete f.curves;
  if (f.bulges && !f.bulges.some((b) => Math.abs(b) > 1e-9)) delete f.bulges;
  if (f.smooth && !f.smooth.some(Boolean)) delete f.smooth;
}
/** A point s (0..1) of the way round the arc from a through m to b. */
function arcPoint(a: P2, m: P2, b: P2, s: number): P2 {
  const ax = a[0], ay = a[1], bx = m[0], by = m[1], cx = b[0], cy = b[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const R = Math.hypot(ax - ux, ay - uy);
  const t0 = Math.atan2(ay - uy, ax - ux), tm = Math.atan2(by - uy, bx - ux), t1 = Math.atan2(cy - uy, cx - ux);
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // go the way that passes through m
  let sweep = norm(t1 - t0);
  if (norm(tm - t0) > sweep) sweep -= 2 * Math.PI;
  const t = t0 + sweep * s;
  return [ux + R * Math.cos(t), uy + R * Math.sin(t)];
}
