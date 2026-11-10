// Solid modelling with replicad (OpenCASCADE). Runs in the worker, and in
// node for the tests. Nothing here touches the DOM.

import {
  cast, getOC, makeBaseBox, makeCylinder, makeProjectedEdges, measureVolume, Plane, ProjectionCamera,
  draw, drawCircle, drawText,
} from 'replicad';
import type { Feature, Op, P2, Project, Vec3, ViewName } from './model.js';
import { cornerRadii, depthRange, fromRef, gearProfile, instances, isShape, roundCorner, verts } from './model.js';
import { pitchRadius, outerRadius, gearPath, placePath, type Path } from './gears.js';
import { VIEWS, VIEW_ORDER } from './views.js';

export type Line = number[];         // flat [u0, v0, u1, v1, ...]

export interface ViewEdges { visible: Line[]; hidden: Line[] }

export interface BuildResult {
  views: Partial<Record<ViewName, ViewEdges>>;
  effect: Record<string, boolean>;   // feature id -> does it change the part
  mesh: { vertices: number[]; triangles: number[] } | null;
  edges: number[][];                 // the part's edges in 3D, flat [x,y,z, ...], for picking edges to round
  textSize: Record<string, [number, number]>;   // text features: measured width and height
  volume: number;
  bbox: [number[], number[]] | null;
  errors: Record<string, string>;
  fillets: Record<string, (Vec3 | null)[]>;   // fillet id -> where each of its edges is now (null: gone)
  baseBox: [Vec3, Vec3] | null;               // the library model's box, when the body is one
}

type Solid = any;

/** Fonts for the text tool, loaded by whoever runs the builds (worker or tests). */
export const fonts = { sans: false, bold: false };

/** A closed outline with its own radius at each corner. */
function roundedPolygon(v: P2[], r: number[]) {
  const n = v.length;
  const start = roundCorner(v[n - 1], v[0], v[1], r[0]);
  let pen = draw(start ? start.t2 : v[0]);
  for (let k = 1; k <= n; k++) {
    const i = k % n;
    const rc = roundCorner(v[(i + n - 1) % n], v[i], v[(i + 1) % n], r[i]);
    if (!rc) { if (i !== 0) pen = pen.lineTo(v[i]); continue; }
    pen = pen.lineTo(rc.t1).threePointsArcTo(rc.t2, rc.mid);
  }
  return pen.close();
}

function polyline(pts: P2[]) {
  let pen = draw(pts[0]);
  for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
  return pen.close();
}

/** A closed outline of lines, Béziers and arcs. */
function smooth(path: Path) {
  let pen = draw(path.start);
  const n = path.segs.length;
  path.segs.forEach((g, i) => {
    if (i === n - 1 && g.t === 'L') return;          // close() draws the last line
    const end = i === n - 1 ? path.start : g.p;
    if (g.t === 'L') pen = pen.lineTo(end);
    else if (g.t === 'C') pen = pen.cubicBezierCurveTo(end, g.c1, g.c2);
    else pen = pen.threePointsArcTo(end, g.m);
  });
  return pen.close();
}

/** The feature's 2D drawing in its own view (u, v). */
function drawing(f: Feature) {
  if (f.type === 'circle') return f.r > 1e-6 ? drawCircle(f.r).translate(f.cu, f.cv) : null;
  if (f.type === 'gear' && f.gear) {
    const g = f.gear, rot = f.rot || 0;
    if (g.kind === 'rack') return polyline(gearProfile(f).outer);
    if (g.kind === 'ring') {
      const R = outerRadius(g);
      return drawCircle(R).translate(f.cu, f.cv).cut(smooth(placePath(gearPath(g.module, g.teeth, g.pa, 1.25, 1, -g.backlash), f.cu, f.cv, rot)));
    }
    return smooth(placePath(gearPath(g.module, g.teeth, g.pa, 1, 1.25, g.backlash), f.cu, f.cv, rot));
  }
  if (f.type === 'text' && f.text) {
    if (!f.text.s.trim()) return null;
    const fam = f.text.bold && fonts.bold ? 'bold' : 'sans';
    let d = drawText(f.text.s, { fontSize: f.text.size, fontFamily: fam });
    const bb = d.boundingBox;
    const [[x0, y0], [x1, y1]] = bb.bounds;
    d = d.translate(f.cu - (x0 + x1) / 2, f.cv - (y0 + y1) / 2);
    if (f.rot) d = d.rotate(f.rot, [f.cu, f.cv]);
    return d;
  }
  const v = verts(f);
  if (!v) return null;
  if (f.type === 'rect' && (f.w <= 1e-6 || f.h <= 1e-6)) return null;
  return roundedPolygon(v, cornerRadii(f));
}

/** Measured size of a text feature (before turning). */
export function textSize(f: Feature): [number, number] | null {
  if (f.type !== 'text' || !f.text || !f.text.s.trim()) return null;
  const fam = f.text.bold && fonts.bold ? 'bold' : 'sans';
  const [[x0, y0], [x1, y1]] = drawText(f.text.s, { fontSize: f.text.size, fontFamily: fam }).boundingBox.bounds;
  return [x1 - x0, y1 - y0];
}

/** The feature's own solid (one copy), before patterns and mirrors. */
export function featureSolid(f: Feature, p: Project): Solid | null {
  if (!isShape(f)) return null;
  const [lo, hi] = depthRange(f, p);
  if (hi - lo < 1e-6) return null;
  const d = drawing(f);
  if (!d) return null;
  const v = VIEWS[f.view];
  const plane = new Plane(v.toWorld(0, 0, lo), v.uDir, v.eye);
  const g = f.gear;
  let solid: Solid;
  if (g && g.kind === 'helical') {
    // teeth twist round the axis: the helix angle measured at the pitch circle
    const twist = (((hi - lo) * Math.tan((g.helix * Math.PI) / 180)) / pitchRadius(g)) * (180 / Math.PI);
    solid = d.sketchOnPlane(plane).extrude(hi - lo, { twistAngle: twist, origin: v.toWorld(f.cu, f.cv, lo) });
  } else solid = d.sketchOnPlane(plane).extrude(hi - lo);
  if (g && g.kind !== 'rack') solid = gearExtras(f, solid);
  return solid;
}

/** A gear's hub, bore and set screw. */
function gearExtras(f: Feature, solid: Solid): Solid {
  const g = f.gear!, V = VIEWS[f.view];
  const out = f.d1 >= f.d0 ? -1 : 1;                   // the hub sticks out the other way from the teeth
  const axisW = (d: number) => V.toWorld(f.cu, f.cv, d);
  const dir: Vec3 = [V.eye[0] * out, V.eye[1] * out, V.eye[2] * out];
  if (g.hubD > 0 && g.hubLen > 0) solid = solid.fuse(makeCylinder(g.hubD / 2, g.hubLen, axisW(f.d0), dir));
  const span = Math.abs(f.d1 - f.d0) + g.hubLen + 2;
  const startD = f.d0 + out * (g.hubLen + 1);
  const back: Vec3 = [-dir[0], -dir[1], -dir[2]];
  if (g.bore !== 'none' && g.boreD > 0) {
    const r = g.boreD / 2;
    let hole = makeCylinder(r, span, axisW(startD), back);
    if (g.bore === 'd') {
      // a flat on the -u side: the shaft's flat face sits flat_x from the centre
      const flatX = g.flat - r;
      // a block covering everything past the flat on the -u side, removed from the hole
      const blockPlane = new Plane(V.toWorld(0, 0, Math.min(startD, startD - out * span)), V.uDir, V.eye);
      const block = drawRectFrom(f.cu - 3 * r, f.cu - flatX, f.cv - 2 * r, f.cv + 2 * r).sketchOnPlane(blockPlane).extrude(span);
      hole = (hole as any).cut(block);
    }
    solid = solid.cut(hole);
  }
  if (g.screw > 0) {
    // radial, along +u, through the middle of the hub (or of the gear without one)
    const mid = g.hubLen > 0 ? f.d0 + out * g.hubLen / 2 : (f.d0 + f.d1) / 2;
    const R = Math.max(g.hubD / 2, pitchRadius(g) + g.module * 2);
    solid = solid.cut(makeCylinder(g.screw / 2, R + 1, V.toWorld(f.cu, f.cv, mid), V.uDir));
  }
  return solid;
}

function drawRectFrom(u0: number, u1: number, v0: number, v1: number) {
  return draw([u0, v0]).lineTo([u1, v0]).lineTo([u1, v1]).lineTo([u0, v1]).close();
}

/** Move a copy of a solid by a list of moves (see model.instances). */
function applyOpsSolid(s: Solid, ops: Op[]): Solid {
  for (const o of ops) {
    if ('t' in o) s = s.translate(o.t[0], o.t[1], o.t[2]);
    else if ('mir' in o) { const n: Vec3 = [0, 0, 0]; n[o.mir] = 1; const c: Vec3 = [0, 0, 0]; c[o.mir] = o.at; s = s.mirror(n, c); }
    else s = s.rotate(o.rot, o.c, o.ax);
  }
  return s;
}

/** Every copy of a feature (pattern, mirror) as one tool. */
export function featureTool(f: Feature, p: Project): Solid | null {
  const base = featureSolid(f, p);
  if (!base) return null;
  const list = instances(f);
  if (list.length === 1) return base;
  let tool: Solid = null;
  for (const ops of list) {
    const c = applyOpsSolid(base.clone(), ops);
    tool = tool ? tool.fuse(c) : c;
  }
  return tool;
}

/** Library models used as bodies, loaded by whoever runs the builds (worker or tests), by name. */
export const bases: Record<string, Solid> = {};

/**
 * An STL (a skin of triangles) as a solid OpenCASCADE can cut and fillet:
 * the triangles sewn into one shell, flat neighbours merged into faces.
 */
export function importMesh(bytes: Uint8Array): Solid {
  const n = bytes.length >= 84 ? new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true) : 0;
  if (n > 60000 && bytes.length === 84 + 50 * n) throw new Error(`It has ${n.toLocaleString()} triangles; the most the Design tab can work with is 60,000`);
  const oc = getOC();
  const file = `/mesh${Date.now()}.stl`;
  oc.FS.writeFile(file, bytes);
  try {
    const raw = new oc.TopoDS_Shell();
    if (!new oc.StlAPI_Reader().Read(raw, file.slice(1))) throw new Error('Not an STL file');
    const sew = new oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false);
    sew.Add(raw);
    sew.Perform(new oc.Message_ProgressRange());
    const u = new oc.ShapeUpgrade_UnifySameDomain(sew.SewedShape(), true, true, false);
    u.Build();
    const mk = new oc.BRepBuilderAPI_MakeSolid();
    const ex = new oc.TopExp_Explorer(u.Shape(), oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    let shells = 0;
    for (; ex.More(); ex.Next()) { mk.Add(oc.TopoDS.Shell(ex.Current())); shells++; }
    if (!shells) throw new Error("Couldn't make a closed solid from it");
    let solid: Solid = cast(mk.Solid());
    // the triangles' winding decides inside from outside: turn it out the right way
    if (measureVolume(solid) < 0) solid = cast(solid.wrapped.Reversed());
    return solid;
  } finally {
    try { oc.FS.unlink(file); } catch { /* gone */ }
  }
}

export function stockSolid(p: Project): Solid | null {
  if (p.base) {
    const b = bases[p.base.model];
    if (!b) throw new Error(`The library model “${p.base.model}” isn't loaded`);
    return b.clone();
  }
  if (p.stock.off) return null;
  const [a, b] = [p.stock.min, p.stock.max];
  return makeBaseBox(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    .translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, a[2]);
}

/** Does an edge pass within tol of a point? (Rounds and chamfers find their edges this way.) */
function edgeNear(e: any, pt: Vec3, tol = 0.05): boolean {
  const poly = edgePoints(e, 24);
  for (let k = 0; k + 5 < poly.length; k += 3) {
    if (segDist3(pt, [poly[k], poly[k + 1], poly[k + 2]], [poly[k + 3], poly[k + 4], poly[k + 5]]) < tol) return true;
  }
  return false;
}

/** The finished part, plus which features actually changed it. */
export function buildSolid(p: Project): { solid: Solid | null; effect: Record<string, boolean>; errors: Record<string, string>; fillets: Record<string, (Vec3 | null)[]> } {
  const fillets: Record<string, (Vec3 | null)[]> = {};
  let solid: Solid | null = null;
  try { solid = stockSolid(p); } catch (e: any) { (fillets as any).__baseError = String(e?.message || e); }
  let vol = solid ? measureVolume(solid) : 0;
  const effect: Record<string, boolean> = {};
  const errors: Record<string, string> = {};
  for (const f of p.features) {
    try {
      let next: Solid | null = null;
      if (f.type === 'fillet' && f.fillet) {
        if (!solid) { effect[f.id] = false; continue; }
        const { mode, size, edges, refs } = f.fillet;
        // each edge: where its reference says it is now, else where it was
        const polys: number[][] = solid.edges.map((e: any) => edgePoints(e, 24));
        const onEdge = (pt: Vec3) => polys.some((poly) => nearPoly(poly, pt));
        const found = edges.map((pt, i) => {
          const r = refs?.[i];
          const viaRef = r ? fromRef(r, p) : null;
          if (viaRef && onEdge(viaRef)) return viaRef;
          return onEdge(pt) ? pt : null;
        });
        fillets[f.id] = found;
        const live = found.filter((q): q is Vec3 => !!q);
        if (!(size > 0) || !live.length) { effect[f.id] = false; continue; }
        const pick = (e: any) => (live.some((pt) => edgeNear(e, pt)) ? size : 0);
        next = mode === 'chamfer' ? solid.chamfer(pick as any) : solid.fillet(pick as any);
      } else {
        const tool = featureTool(f, p);
        if (!tool) { effect[f.id] = false; continue; }
        if (f.op === 'add') next = solid ? solid.fuse(tool) : tool;
        else if (solid) next = solid.cut(tool);
        else { effect[f.id] = false; continue; }
      }
      const nv = measureVolume(next);
      effect[f.id] = Math.abs(nv - vol) > 1e-6 * Math.max(1, vol);
      solid = next;
      vol = nv;
    } catch (e: any) {
      effect[f.id] = false;
      errors[f.id] = String(e?.message || e);
    }
  }
  return { solid, effect, errors, fillets };
}

function nearPoly(poly: number[], pt: Vec3, tol = 0.05): boolean {
  for (let k = 0; k + 5 < poly.length; k += 3) {
    if (segDist3(pt, [poly[k], poly[k + 1], poly[k + 2]], [poly[k + 3], poly[k + 4], poly[k + 5]]) < tol) return true;
  }
  return false;
}

/** Points along an edge, flat [x,y,z, ...]. */
function edgePoints(e: any, nCurve = 24): number[] {
  const oc = getOC();
  const c = new oc.BRepAdaptor_Curve(e.wrapped);
  const a = c.FirstParameter(), b = c.LastParameter();
  const n = c.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line ? 1 : nCurve;
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const q = c.Value(a + ((b - a) * i) / n);
    out.push(q.X(), q.Y(), q.Z());
    q.delete();
  }
  c.delete();
  return out;
}

function segDist3(p: Vec3, a: Vec3, b: Vec3): number {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
  let t = L > 0 ? ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1], p[2] - a[2] - t * d[2]);
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

export function build(p: Project, views: ViewName[] = VIEW_ORDER, withMesh = true, withEdges = true): BuildResult {
  const { solid, effect, errors, fillets } = buildSolid(p);
  const baseErr = (fillets as any).__baseError;
  delete (fillets as any).__baseError;
  if (baseErr) errors.base = baseErr;
  let baseBox: [Vec3, Vec3] | null = null;
  if (p.base && bases[p.base.model]) { const bb = bases[p.base.model].boundingBox.bounds; baseBox = [bb[0], bb[1]]; }
  const out: BuildResult = { views: {}, effect, errors, fillets, baseBox, mesh: null, edges: [], textSize: {}, volume: 0, bbox: null };
  for (const f of p.features) {
    try { const ts = textSize(f); if (ts) out.textSize[f.id] = ts; } catch (e: any) { errors[f.id] = String(e?.message || e); }
  }
  if (!solid) return out;
  out.volume = measureVolume(solid);
  for (const v of views) out.views[v] = projectView(solid, v);
  if (withMesh) {
    const m = solid.mesh({ tolerance: 0.05, angularTolerance: 0.2 });
    out.mesh = { vertices: m.vertices, triangles: m.triangles };
  }
  // every edge in 3D, for the edge tool (skipped otherwise: on a big STL body it takes a while)
  if (withEdges) out.edges = solid.edges.map((e: any) => edgePoints(e, 24));
  const bb = solid.boundingBox.bounds;
  out.bbox = [bb[0], bb[1]];
  return out;
}

export function stl(p: Project): Blob | null {
  const { solid } = buildSolid(p);
  return solid ? solid.blobSTL({ tolerance: 0.01, angularTolerance: 0.1, binary: true }) : null;
}
