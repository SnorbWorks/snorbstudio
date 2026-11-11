// SnorbCAM: a job is a sheet of material, the bits, and parts placed on the
// sheet. Each part is a set of outlines ("contours"), and each outline says
// how it's cut. All lengths mm, feeds mm/min, angles degrees. Sheet
// coordinates: X right, Y up from the lower-left corner; Z 0 is the top of
// the material, down is negative.

export type P2 = [number, number];

export type OpKind = 'none' | 'on' | 'inside' | 'outside' | 'pocket';
export type Fill = 'offset' | 'horizontal' | 'vertical';

export interface Op {
  kind: OpKind;
  depth: number;          // how deep the cut goes, from z0 (mm)
  z0: number;             // where the cut starts: 0 = top of the material, -3 = 3 mm down (stepped shapes)
  bit?: string;           // a bit id; else the job's bit
  fill: Fill;             // pockets
  tabs: number[];         // tabs, as fractions round the outline (0..1)
  tabWidth: number;       // across the tab, in the finished part
  tabThick: number;       // how much material the tab leaves (from the bottom of the cut)
  first?: number;         // first pass depth (else the bit's pass depth)
  finish?: number;        // finishing pass depth (0/undefined: none)
  ramp: number;           // ramp-in angle (0 = plunge straight down)
  dir: 'climb' | 'conventional';
}

export interface Contour { id: string; pts: P2[]; closed: boolean; op: Op; note?: string }

export interface Part {
  id: string;
  name: string;
  source: 'svg' | 'dxf' | 'cad';
  contours: Contour[];    // in the part's own mm coordinates (Y up)
}

/** A part on the sheet: turned rot degrees, then moved so its box's lower-left corner sits at (x, y). */
export interface Placed { id: string; part: string; x: number; y: number; rot: number }

export type BitType = 'compression' | 'upcut' | 'downcut' | 'straight' | 'ball' | 'vbit' | 'surfacing';
export interface Bit {
  id: string;
  name: string;
  type: BitType;
  dia: number;            // mm
  angle?: number;         // V-bit included angle
  feed: number;           // mm/min
  plunge: number;         // mm/min
  pass: number;           // depth per pass, mm
  stepover: number;       // 0..1 of the diameter (pockets)
}

export interface Job {
  version: 1;
  name: string;
  units: 'in' | 'mm';     // shown; the G-code is always inches (ShopBot via Easel-style G-code)
  sheet: { w: number; h: number; t: number };
  safeZ: number;          // between cuts, above the material
  homeZ: number;          // at the start and end
  rapid: number;          // for the time estimate, mm/min
  order: 'path' | 'depth';
  bits: Bit[];
  bit: string;            // default bit id
  parts: Part[];
  placed: Placed[];
}

export const IN = 25.4;
const ipm = (v: number) => v * IN;

export const DEFAULT_BITS: Bit[] = [
  { id: 'c250', name: '1/4" compression', type: 'compression', dia: 6.35, feed: ipm(160), plunge: ipm(60), pass: 0.2 * IN, stepover: 0.4 },
  { id: 'c375', name: '3/8" compression', type: 'compression', dia: 9.525, feed: ipm(170), plunge: ipm(60), pass: 0.25 * IN, stepover: 0.4 },
  { id: 'c500', name: '1/2" compression', type: 'compression', dia: 12.7, feed: ipm(180), plunge: ipm(50), pass: 0.25 * IN, stepover: 0.4 },
  { id: 'u125', name: '1/8" upcut', type: 'upcut', dia: 3.175, feed: ipm(80), plunge: ipm(30), pass: 0.0625 * IN, stepover: 0.4 },
  { id: 'u063', name: '1/16" upcut', type: 'upcut', dia: 1.5875, feed: ipm(50), plunge: ipm(15), pass: 0.03 * IN, stepover: 0.4 },
  { id: 's750', name: '3/4" surfacing', type: 'surfacing', dia: 19.05, feed: ipm(150), plunge: ipm(40), pass: 0.0625 * IN, stepover: 0.6 },
  { id: 's1', name: '1" surfacing', type: 'surfacing', dia: 25.4, feed: ipm(150), plunge: ipm(40), pass: 0.0625 * IN, stepover: 0.6 },
  { id: 's2', name: '2" surfacing', type: 'surfacing', dia: 50.8, feed: ipm(200), plunge: ipm(40), pass: 0.04 * IN, stepover: 0.7 },
  { id: 's3', name: '3" surfacing', type: 'surfacing', dia: 76.2, feed: ipm(200), plunge: ipm(30), pass: 0.03 * IN, stepover: 0.7 },
  { id: 'v60', name: '60° V-bit', type: 'vbit', dia: 12.7, angle: 60, feed: ipm(100), plunge: ipm(30), pass: 0.1 * IN, stepover: 0.2 },
  { id: 'v90', name: '90° V-bit', type: 'vbit', dia: 12.7, angle: 90, feed: ipm(100), plunge: ipm(30), pass: 0.1 * IN, stepover: 0.2 },
];

export function newJob(): Job {
  return {
    version: 1, name: 'job', units: 'in',
    sheet: { w: 96 * IN, h: 48 * IN, t: 0.75 * IN },
    safeZ: 0.25 * IN, homeZ: 2 * IN, rapid: ipm(300), order: 'path',
    bits: DEFAULT_BITS.map((b) => ({ ...b })), bit: 'c250',
    parts: [], placed: [],
  };
}

export function newOp(kind: OpKind, depth: number): Op {
  return { kind, depth, z0: 0, fill: 'offset', tabs: [], tabWidth: 0.375 * IN, tabThick: 0.125 * IN, ramp: 10, dir: 'climb' };
}

let seq = 0;
export const camId = (p = 'c') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export function bitOf(job: Job, op: Op): Bit {
  return job.bits.find((b) => b.id === (op.bit || job.bit)) || job.bits[0];
}

// ------------------------------------------------------------ geometry helpers

export function bbox(pts: P2[][]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of pts) for (const [x, y] of l) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}

export function partBox(part: Part): [number, number, number, number] {
  return bbox(part.contours.map((c) => c.pts));
}

/** The transform of a placed part: part coords → sheet coords. */
export function placer(part: Part, pl: Placed): (p: P2) => P2 {
  const a = (pl.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const rot = (p: P2): P2 => [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
  const pts = part.contours.flatMap((k) => k.pts.map(rot));
  const [x0, y0] = bbox([pts]);
  return (p) => { const q = rot(p); return [q[0] - x0 + pl.x, q[1] - y0 + pl.y]; };
}

/** A placed part's box on the sheet. */
export function placedBox(part: Part, pl: Placed): [number, number, number, number] {
  const T = placer(part, pl);
  return bbox(part.contours.map((k) => k.pts.map(T)));
}

export function pathLength(pts: P2[], closed: boolean): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (closed && pts.length > 1) L += Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
  return L;
}

export function signedArea(pts: P2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}

export function pointIn(p: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The point at a fraction round an outline. */
export function pointAt(pts: P2[], closed: boolean, t: number): P2 {
  const L = pathLength(pts, closed);
  let want = ((t % 1) + 1) % 1 * L;
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (want <= l || i === (closed ? n : n - 1) - 1) { const k = l > 0 ? Math.min(1, want / l) : 0; return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]; }
    want -= l;
  }
  return pts[0];
}

/** The fraction round an outline nearest a point. */
export function fractionAt(pts: P2[], closed: boolean, p: P2): number {
  const L = pathLength(pts, closed) || 1;
  const n = pts.length;
  let best = Infinity, at = 0, run = 0;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy, l = Math.sqrt(l2);
    const k = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    const d = Math.hypot(a[0] + dx * k - p[0], a[1] + dy * k - p[1]);
    if (d < best) { best = d; at = run + k * l; }
    run += l;
  }
  return at / L;
}

/** Which closed outlines sit inside which: parent index for each (-1 for none). */
export function nesting(contours: { pts: P2[]; closed: boolean }[]): number[] {
  const area = contours.map((c) => (c.closed ? Math.abs(signedArea(c.pts)) : 0));
  return contours.map((c, i) => {
    let best = -1;
    const probe = c.pts[0];
    contours.forEach((o, j) => {
      if (j === i || !o.closed || area[j] <= area[i]) return;
      if (pointIn(probe, o.pts) && (best < 0 || area[j] < area[best])) best = j;
    });
    return best;
  });
}

/**
 * A sensible first guess at how each outline is cut, Easel style: the
 * outermost outlines cut out (outside), the ones inside them cut through
 * (inside), open lines cut on the line.
 */
export function guessOps(contours: Contour[], thickness: number) {
  const parent = nesting(contours);
  const depthOf = (i: number): number => (parent[i] < 0 ? 0 : 1 + depthOf(parent[i]));
  contours.forEach((c, i) => {
    if (!c.closed) c.op = newOp('on', Math.min(thickness, 3));
    else c.op = newOp(depthOf(i) % 2 === 0 ? 'outside' : 'inside', thickness);
    if (c.op.kind === 'outside') c.op.tabs = autoTabs(c.pts, 4);
  });
}

/** n tabs spread evenly round an outline, kept off the corners where they can. */
export function autoTabs(pts: P2[], n: number): number[] {
  const L = pathLength(pts, true);
  if (L < 60) return [];
  const k = Math.max(2, Math.min(n, Math.floor(L / 150)));
  return Array.from({ length: k }, (_, i) => +((i + 0.5) / k).toFixed(4));
}
