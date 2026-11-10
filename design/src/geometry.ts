// Solid modelling with replicad (OpenCASCADE). Runs in the worker, and in
// node for the tests. Nothing here touches the DOM.

import {
  getOC, makeBaseBox, makeProjectedEdges, measureVolume, Plane, ProjectionCamera,
  draw, drawCircle, drawRectangle, drawRoundedRectangle,
} from 'replicad';
import type { Feature, Project, ViewName } from './model.js';
import { cornerRadii, depthRange } from './model.js';
import { VIEWS, VIEW_ORDER } from './views.js';

export type Line = number[];         // flat [u0, v0, u1, v1, ...]

export interface ViewEdges { visible: Line[]; hidden: Line[] }

export interface BuildResult {
  views: Partial<Record<ViewName, ViewEdges>>;
  effect: Record<string, boolean>;   // feature id -> does it change the part
  mesh: { vertices: number[]; triangles: number[] } | null;
  volume: number;
  bbox: [number[], number[]] | null;
  errors: Record<string, string>;
}

type Solid = any;

export function featureSolid(f: Feature, p: Project): Solid | null {
  const [lo, hi] = depthRange(f, p);
  if (hi - lo < 1e-6) return null;
  if (f.type === 'circle' && f.r <= 1e-6) return null;
  if (f.type === 'rect' && (f.w <= 1e-6 || f.h <= 1e-6)) return null;
  const v = VIEWS[f.view];
  const plane = new Plane(v.toWorld(0, 0, lo), v.uDir, v.eye);
  let d;
  if (f.type === 'circle') d = drawCircle(f.r);
  else {
    const r = cornerRadii(f).map((x) => Math.min(x, Math.min(f.w, f.h) / 2 - 1e-4)).map((x) => (x > 1e-4 ? x : 0));
    if (r.every((x) => x === 0)) d = drawRectangle(f.w, f.h);
    else if (r.every((x) => x === r[0])) d = drawRoundedRectangle(f.w, f.h, r[0]);
    else d = roundedRect(f.w / 2, f.h / 2, r);
  }
  return d.translate(f.cu, f.cv).sketchOnPlane(plane).extrude(hi - lo);
}

/** A rectangle centred on 0,0 with its own radius on each corner (0 bl, 1 br, 2 tr, 3 tl). */
function roundedRect(hw: number, hh: number, r: number[]) {
  const arc = (cx: number, cy: number, rr: number, a0: number): [[number, number], [number, number]] => {
    const m = ((a0 + 45) * Math.PI) / 180, e = ((a0 + 90) * Math.PI) / 180;
    return [[cx + rr * Math.cos(e), cy + rr * Math.sin(e)], [cx + rr * Math.cos(m), cy + rr * Math.sin(m)]];
  };
  let pen = draw([-hw + r[0], -hh]).lineTo([hw - r[1], -hh]);
  if (r[1]) { const [e, m] = arc(hw - r[1], -hh + r[1], r[1], -90); pen = pen.threePointsArcTo(e, m); }
  pen = pen.lineTo([hw, hh - r[2]]);
  if (r[2]) { const [e, m] = arc(hw - r[2], hh - r[2], r[2], 0); pen = pen.threePointsArcTo(e, m); }
  pen = pen.lineTo([-hw + r[3], hh]);
  if (r[3]) { const [e, m] = arc(-hw + r[3], hh - r[3], r[3], 90); pen = pen.threePointsArcTo(e, m); }
  pen = pen.lineTo([-hw, -hh + r[0]]);
  if (r[0]) { const [e, m] = arc(-hw + r[0], -hh + r[0], r[0], 180); pen = pen.threePointsArcTo(e, m); }
  return pen.close();
}

export function stockSolid(p: Project): Solid {
  const [a, b] = [p.stock.min, p.stock.max];
  return makeBaseBox(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    .translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, a[2]);
}

/** The finished part, plus which features actually changed it. */
export function buildSolid(p: Project): { solid: Solid; effect: Record<string, boolean>; errors: Record<string, string> } {
  let solid = stockSolid(p);
  let vol = measureVolume(solid);
  const effect: Record<string, boolean> = {};
  const errors: Record<string, string> = {};
  for (const f of p.features) {
    let tool: Solid | null = null;
    try { tool = featureSolid(f, p); } catch (e: any) { errors[f.id] = String(e?.message || e); }
    if (!tool) { effect[f.id] = false; continue; }
    try {
      const next = f.op === 'add' ? solid.fuse(tool) : solid.cut(tool);
      const nv = measureVolume(next);
      effect[f.id] = Math.abs(nv - vol) > 1e-6 * Math.max(1, vol);
      solid = next;
      vol = nv;
    } catch (e: any) {
      effect[f.id] = false;
      errors[f.id] = String(e?.message || e);
    }
  }
  return { solid, effect, errors };
}

function edgePolyline(e: any, view: ViewName): Line {
  const oc = getOC();
  const c = new oc.BRepAdaptor_Curve(e.wrapped);
  const a = c.FirstParameter(), b = c.LastParameter();
  const isLine = c.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line;
  let n = 1;
  if (!isLine) {
    // enough points for a smooth curve: by its length, at least 12
    const p0 = c.Value(a), pm = c.Value((a + b) / 2), p1 = c.Value(b);
    const len = Math.hypot(pm.X() - p0.X(), pm.Y() - p0.Y()) + Math.hypot(p1.X() - pm.X(), p1.Y() - pm.Y());
    p0.delete(); pm.delete(); p1.delete();
    n = Math.max(12, Math.min(160, Math.ceil(len / 0.4)));
  }
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const p = c.Value(a + ((b - a) * i) / n);
    out.push(p.X(), p.Y());
    p.delete();
  }
  c.delete();
  void view;
  return out;
}

export function projectView(solid: Solid, view: ViewName): ViewEdges {
  const v = VIEWS[view];
  const cam = new ProjectionCamera([0, 0, 0], v.eye, v.uDir);
  const { visible, hidden } = makeProjectedEdges(solid, cam);
  const vis = visible.map((e: any) => edgePolyline(e, view));
  const hid = hidden.map((e: any) => edgePolyline(e, view));
  return { visible: vis, hidden: subtractCovered(hid, vis) };
}

/**
 * Drafting rule: a visible line wins over a hidden one in the same place.
 * Cut the hidden lines into short pieces and drop the pieces that lie on a
 * visible line.
 */
export function subtractCovered(hidden: Line[], visible: Line[], tol = 0.01): Line[] {
  const cell = 2;
  const grid = new Map<string, number[]>();     // cell -> segment list [x0,y0,x1,y1,...]
  const key = (i: number, j: number) => `${i},${j}`;
  for (const l of visible) {
    for (let k = 0; k + 3 < l.length; k += 2) {
      const x0 = l[k], y0 = l[k + 1], x1 = l[k + 2], y1 = l[k + 3];
      const i0 = Math.floor((Math.min(x0, x1) - tol) / cell), i1 = Math.floor((Math.max(x0, x1) + tol) / cell);
      const j0 = Math.floor((Math.min(y0, y1) - tol) / cell), j1 = Math.floor((Math.max(y0, y1) + tol) / cell);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const kk = key(i, j);
        let a = grid.get(kk);
        if (!a) grid.set(kk, (a = []));
        a.push(x0, y0, x1, y1);
      }
    }
  }
  const covered = (x: number, y: number) => {
    const a = grid.get(key(Math.floor(x / cell), Math.floor(y / cell)));
    if (!a) return false;
    for (let k = 0; k < a.length; k += 4) if (segDist(x, y, a[k], a[k + 1], a[k + 2], a[k + 3]) < tol) return true;
    return false;
  };
  const out: Line[] = [];
  for (const l of hidden) {
    let cur: number[] = [];
    const flush = () => { if (cur.length >= 4) out.push(cur); cur = []; };
    for (let k = 0; k + 3 < l.length; k += 2) {
      const x0 = l[k], y0 = l[k + 1], x1 = l[k + 2], y1 = l[k + 3];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.2));
      for (let s = 0; s < n; s++) {
        const ax = x0 + ((x1 - x0) * s) / n, ay = y0 + ((y1 - y0) * s) / n;
        const bx = x0 + ((x1 - x0) * (s + 1)) / n, by = y0 + ((y1 - y0) * (s + 1)) / n;
        const hid = covered((ax + bx) / 2, (ay + by) / 2) && covered(ax, ay) && covered(bx, by);
        if (hid) { flush(); continue; }
        if (!cur.length) cur.push(ax, ay);
        cur.push(bx, by);
      }
    }
    flush();
  }
  return dedupe(out.map(simplify));
}

/** Lines running the same way, with duplicates dropped: two hidden edges on top of each
 *  other drawn in opposite directions would fill in each other's dash gaps. */
export function dedupe(lines: Line[]): Line[] {
  const seen = new Set<string>();
  const out: Line[] = [];
  for (let l of lines) {
    const n = l.length;
    if (l[0] > l[n - 2] + 1e-9 || (Math.abs(l[0] - l[n - 2]) <= 1e-9 && l[1] > l[n - 1])) {
      const r: number[] = [];
      for (let k = n - 2; k >= 0; k -= 2) r.push(l[k], l[k + 1]);
      l = r;
    }
    const key = l.map((x) => x.toFixed(3)).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/** Merge runs of collinear points back into single segments. */
function simplify(l: Line): Line {
  if (l.length <= 4) return l;
  const out = [l[0], l[1]];
  for (let k = 2; k + 2 < l.length; k += 2) {
    const ax = out[out.length - 2], ay = out[out.length - 1];
    const bx = l[k], by = l[k + 1], cx = l[k + 2], cy = l[k + 3];
    const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(cross) > 1e-6) out.push(bx, by);
  }
  out.push(l[l.length - 2], l[l.length - 1]);
  return out;
}

function segDist(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0;
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - x0) * dx + (py - y0) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

export function build(p: Project, views: ViewName[] = VIEW_ORDER, withMesh = true): BuildResult {
  const { solid, effect, errors } = buildSolid(p);
  const out: BuildResult = { views: {}, effect, errors, mesh: null, volume: measureVolume(solid), bbox: null };
  for (const v of views) out.views[v] = projectView(solid, v);
  if (withMesh) {
    const m = solid.mesh({ tolerance: 0.05, angularTolerance: 0.2 });
    out.mesh = { vertices: m.vertices, triangles: m.triangles };
  }
  const bb = solid.boundingBox.bounds;
  out.bbox = [bb[0], bb[1]];
  return out;
}

export function stl(p: Project): Blob {
  const { solid } = buildSolid(p);
  return solid.blobSTL({ tolerance: 0.01, angularTolerance: 0.1, binary: true });
}
