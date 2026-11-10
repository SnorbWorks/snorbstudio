// The project: a stock block plus an ordered list of features. Every view,
// the 3D preview and the STL are made from this and nothing else.

export type ViewName = 'top' | 'front' | 'right' | 'left' | 'back' | 'bottom';
export type Vec3 = [number, number, number];

export interface Stock {
  min: Vec3;          // mm, world coordinates (X right, Y back, Z up)
  max: Vec3;
}

export interface Feature {
  id: string;
  type: 'rect' | 'circle';
  view: ViewName;     // the view it was drawn in: its profile lives in that view's (u, v)
  cu: number;         // centre, in the view's u/v (mm)
  cv: number;
  w: number;          // rect width/height (u/v)
  h: number;
  r: number;          // circle radius
  corner: number;     // rect corner radius (0 = sharp)
  d0: number;         // start: the face it was drawn on, as depth toward the viewer
  d1: number;         // finish: the other end
  op: 'add' | 'cut';
  through: boolean;   // cut: run right through the part, away from the viewer
}

export interface Project {
  version: 1;
  name: string;
  units: 'mm' | 'in';
  precision: number;  // decimals shown
  grid: number;       // snap increment, mm
  stock: Stock;
  views: ViewName[];  // shown views
  features: Feature[];
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
  };
}

let seq = 0;
export function newId(): string {
  seq += 1;
  return `f${Date.now().toString(36)}${seq}`;
}

/** The feature's extruded depth range [lo, hi] (depth toward its viewer). */
export function depthRange(f: Feature, p: Project): [number, number] {
  if (f.op === 'cut' && f.through) {
    const far = farDepth(f.view, p) - 1;
    return [Math.min(far, f.d0), Math.max(f.d0, f.d1)];
  }
  return [Math.min(f.d0, f.d1), Math.max(f.d0, f.d1)];
}

import { VIEWS } from './views.js';

/** The depth (toward the viewer) of the far side of everything in the project. */
export function farDepth(view: ViewName, p: Project): number {
  const v = VIEWS[view];
  let lo = Infinity;
  const corners = boxCorners(p.stock.min, p.stock.max);
  for (const c of corners) lo = Math.min(lo, dot(c, v.eye));
  for (const f of p.features) {
    if (f.op !== 'add') continue;
    for (const c of featureCorners(f, p)) lo = Math.min(lo, dot(c, v.eye));
  }
  return lo;
}

export function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

export function boxCorners(a: Vec3, b: Vec3): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) out.push([x, y, z]);
  return out;
}

/** The 2D profile outline in the feature's own view (u, v), closed. */
export function profile(f: Feature, segs = 48): [number, number][] {
  if (f.type === 'circle') {
    const pts: [number, number][] = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push([f.cu + f.r * Math.cos(a), f.cv + f.r * Math.sin(a)]);
    }
    return pts;
  }
  const hw = f.w / 2, hh = f.h / 2;
  const r = Math.max(0, Math.min(f.corner, hw, hh));
  if (r <= 1e-6) {
    return [[f.cu - hw, f.cv - hh], [f.cu + hw, f.cv - hh], [f.cu + hw, f.cv + hh], [f.cu - hw, f.cv + hh]];
  }
  const pts: [number, number][] = [];
  const cs: [number, number, number][] = [
    [f.cu + hw - r, f.cv - hh + r, -90], [f.cu + hw - r, f.cv + hh - r, 0],
    [f.cu - hw + r, f.cv + hh - r, 90], [f.cu - hw + r, f.cv - hh + r, 180],
  ];
  for (const [x, y, a0] of cs) {
    for (let i = 0; i <= 8; i++) {
      const a = ((a0 + (i / 8) * 90) * Math.PI) / 180;
      pts.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
    }
  }
  return pts;
}

/** The 8 corners of the feature's bounding prism, in world coordinates. */
export function featureCorners(f: Feature, p: Project): Vec3[] {
  const v = VIEWS[f.view];
  const [lo, hi] = f.op === 'cut' && f.through ? [Math.min(f.d0, f.d1), Math.max(f.d0, f.d1)] : depthRange(f, p);
  const hu = f.type === 'circle' ? f.r : f.w / 2;
  const hv = f.type === 'circle' ? f.r : f.h / 2;
  const out: Vec3[] = [];
  for (const u of [f.cu - hu, f.cu + hu]) for (const vv of [f.cv - hv, f.cv + hv]) for (const d of [lo, hi]) out.push(v.toWorld(u, vv, d));
  return out;
}
