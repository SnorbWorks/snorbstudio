// App state: the project, the selection, undo/redo and the latest build.

import { curveProject } from './curvefit.js';
import type { Feature, Project, Vec3, ViewName } from './model.js';
import { bounds2d, featureCorners, depthExtent, depthRange, farDepth, into, isShape, nearDepth, newId, newProject, rotateFeature, scaleFeature, withGroups, profile, DEFAULT_FIT, type P2 } from './model.js';
import { type HoleSpec, defaultHole } from './holes.js';
import type { BuildResult } from './geometry.js';
import { VIEWS, axisOf } from './views.js';

export type Tool = 'select' | 'direct' | 'rotate' | 'scale' | 'measure' | 'section' | 'rect' | 'slot' | 'circle' | 'polygon' | 'line' | 'hole' | 'gear' | 'text' | 'edge' | 'dim' | 'zoom';
type Listener = (what: 'model' | 'select' | 'built' | 'tool' | 'view') => void;

const KEY = 'studio.design.project';
const VIEW_KEY = 'studio.design.viewOpts';
const HOLE_KEY = 'studio.design.lastHole';
const FIT_KEY = 'studio.design.fit';
const CLIP_KEY = 'studio.design.clip';

/** Everything that belongs to one open part (for switching between part tabs). */
export interface Doc { p: Project; undo: string[]; redo: string[]; sels: string[] }

/** The hole fit from the printer's size calibration (Maintenance › Size calibration), once loaded: PLA's if saved, else the first saved. */
export let calibratedFit: { fit: number; material: string; date: string } | null = null;
export async function loadCalibratedFit(): Promise<void> {
  try {
    const saved = ((await (await fetch('/studio-api/calibration/size')).json()).saved || {}) as Record<string, { hole_fit: number; date?: string }>;
    const k = saved.pla ? 'pla' : Object.keys(saved)[0];
    calibratedFit = k && Number.isFinite(saved[k].hole_fit) ? { fit: saved[k].hole_fit, material: k, date: saved[k].date || '' } : null;
  } catch { calibratedFit = null; }
}

/** The printer fit new parts start with: the size calibration's, else the owner's last setting, else 0.2 mm. */
export function defaultFit(): number {
  if (calibratedFit) return calibratedFit.fit;
  try { const v = parseFloat(localStorage.getItem(FIT_KEY) || ''); if (Number.isFinite(v) && v >= 0) return v; } catch { /* default */ }
  return DEFAULT_FIT;
}
export function rememberFit(v: number) { try { localStorage.setItem(FIT_KEY, String(v)); } catch { /* private mode */ } }

/** How the sheet is drawn (the Views tab): the owner's, not saved with the part. */
export interface ViewOpts { projLines: boolean; hidden: boolean; rulers: boolean; guides: boolean }

export class State {
  p: Project = newProject();
  sels: string[] = [];                // selected: 'stock' or feature ids
  sides: { id: string; sides: number[] } | null = null;   // Option-clicked sides of one rectangle
  activeView: ViewName = 'top';       // the view last worked in: alignment goes by its left/right/top/bottom
  tool: Tool = 'select';
  farFace = false;                    // the hidden-line tool: new shapes go on the far face, seen through the part
  edges: Vec3[] = [];                 // the edge tool: picked edges (a point on each)
  polygonSides = 6;                   // the polygon tool's last choice
  lastHole: HoleSpec = defaultHole();  // the hole tool starts from the last hole made
  repick: string | null = null;       // the edge tool is re-picking this fillet's edges
  viewOpts: ViewOpts = { projLines: true, hidden: true, rulers: true, guides: true };
  built: BuildResult | null = null;
  buildError = '';
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<Listener>();

  constructor() {
    try { this.viewOpts = { ...this.viewOpts, ...JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') }; } catch { /* defaults */ }
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.p = { ...newProject(), ...JSON.parse(raw) };
    } catch { /* fresh project */ }
    if (this.p.fit === undefined) this.p.fit = defaultFit();
    try { const h = localStorage.getItem(HOLE_KEY); if (h) this.lastHole = { ...this.lastHole, ...JSON.parse(h) }; } catch { /* default */ }
  }

  on(fn: Listener) { this.listeners.add(fn); }
  emit(what: Parameters<Listener>[0]) { for (const fn of this.listeners) fn(what); }

  setViewOpt<K extends keyof ViewOpts>(k: K, v: ViewOpts[K]) {
    this.viewOpts[k] = v;
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(this.viewOpts)); } catch { /* private mode */ }
    this.emit('select');
  }

  save() { try { localStorage.setItem(KEY, JSON.stringify(this.p)); } catch { /* private mode */ } }

  /** Record an undo point (call before changing p). */
  snapshot() {
    this.undoStack.push(JSON.stringify(this.p));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  change(fn: (p: Project) => void, record = true) {
    if (record) this.snapshot();
    fn(this.p);
    this.changed();
  }

  changed() { this.save(); this.emit('model'); }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(JSON.stringify(this.p));
    this.p = JSON.parse(s);
    this.prune();
    this.changed();
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(JSON.stringify(this.p));
    this.p = JSON.parse(s);
    this.prune();
    this.changed();
  }

  /** Drop selected things that no longer exist. */
  prune() {
    this.sels = this.sels.filter((id) => id === 'stock' || this.feature(id) || this.dim(id));
    if (this.sides && !this.feature(this.sides.id)) this.sides = null;
  }

  load(p: Project) {
    this.snapshot();
    this.p = { ...newProject(), ...p };
    delete (this.p as any).thumb;     // the library's picture lives in the saved file only
    curveProject(this.p);             // traced outlines from older imports become curves
    // parts from before printer fit: the owner's current fit (it only touches holes and slots, which they didn't have)
    if (this.p.fit === undefined) this.p.fit = defaultFit();
    this.sels = []; this.sides = null; this.changed();
  }

  /** The one selected thing, or null when none or several are selected. */
  get one(): string | null { return this.sels.length === 1 ? this.sels[0] : null; }

  /** Select these; grouped shapes bring their whole group unless `exact` (double-click into a group). */
  select(ids: string[], sides: State['sides'] = null, exact = false) {
    this.sels = [...new Set(exact ? ids : withGroups(this.p.features, ids))];
    this.sides = sides;
    this.emit('select');
  }

  deleteSelected() {
    const del = new Set(this.sels.filter((id) => id !== 'stock' || (!this.p.base && !this.p.stock.off)));
    if (!del.size) return;
    this.change((p) => {
      // the starting shape: gone, the shapes stand on their own (undo brings it back)
      if (del.has('stock')) { p.stock.off = true; delete p.shell; }
      p.features = p.features.filter((f) => !del.has(f.id));
      // dimensions go with what they measure
      p.dims = (p.dims || []).filter((d) => !del.has(d.id) && !del.has(d.target));
      if (p.measures) p.measures = p.measures.filter((m) => !del.has(m.id));
      if (p.rulerGuides) p.rulerGuides = p.rulerGuides.filter((g) => !del.has(g.id));
    });
    this.select([]);
  }
  /** Put this part away and take up another (the part tabs). */
  swap(next: Doc): Doc {
    const out: Doc = { p: this.p, undo: this.undoStack, redo: this.redoStack, sels: this.sels };
    this.p = { ...newProject(), ...next.p };
    if (this.p.fit === undefined) this.p.fit = defaultFit();
    curveProject(this.p);
    this.undoStack = next.undo; this.redoStack = next.redo;
    this.sels = next.sels; this.sides = null;
    this.prune();
    this.changed();
    this.emit('select');
    return out;
  }

  /** Turn the selected shapes about a point (world), anticlockwise as the view looks along `axis`. Returns how many couldn't turn. */
  rotateSelected(deg: number, pivot: Vec3, axis: Vec3, record = true): number {
    let skipped = 0;
    this.change((p) => {
      for (const id of this.sels) {
        const f = p.features.find((x) => x.id === id);
        if (f && !rotateFeature(f, pivot, axis, deg)) skipped++;
      }
    }, record);
    return skipped;
  }

  /** Scale the selected shapes about a point (sx across, sy up, as `view` shows them). How many only moved (holes, gears) or were left (other faces, stretched text). */
  scaleSelected(sx: number, sy: number, pivot: Vec3, view: ViewName, record = true): { moved: number; skipped: number } {
    const n = { moved: 0, skipped: 0 };
    this.change((p) => {
      for (const id of this.sels) {
        const f = p.features.find((x) => x.id === id);
        if (!f) continue;
        const r = scaleFeature(f, pivot, view, sx, sy);
        if (r !== 'scaled') n[r]++;
      }
    }, record);
    return n;
  }

  /** Copy the selected shapes (and the roundings and dimensions that only touch them) to a clipboard every part tab shares. */
  copy(): number {
    const ids = new Set(this.sels.filter((id) => id !== 'stock' && this.feature(id)));
    if (!ids.size) return 0;
    const feats = this.p.features.filter((f) => ids.has(f.id) || (f.type === 'fillet' && f.fillet?.refs?.length && f.fillet.refs.every((r) => r && ids.has(r.owner))));
    const dims = (this.p.dims || []).filter((d) => ids.has(d.target));
    const comps = Object.fromEntries([...new Set(feats.map((f) => f.comp?.name).filter(Boolean))].map((n) => [n, this.p.components?.[n!]]).filter(([, d]) => d));
    // the face the shapes were drawn on, so a paste can put them on another view's face at the same depths
    const views = [...new Set(feats.filter(isShape).map((f) => f.view))];
    const from = views.length === 1 ? { view: views[0], near: nearDepth(views[0], this.p) } : null;
    try { localStorage.setItem(CLIP_KEY, JSON.stringify({ features: feats, dims, comps, from, n: 0 })); } catch { return 0; }
    return ids.size;
  }

  get canPaste(): boolean { try { return !!localStorage.getItem(CLIP_KEY); } catch { return false; } }

  /**
   * Paste the clipboard. Into the part it came from, each paste lands a
   * little further down and right (in `view`) so it doesn't hide the
   * original; into another part, in the same place.
   */
  paste(view: ViewName, step = 5): number {
    let clip: { features: Feature[]; dims: any[]; comps?: Record<string, any>; from?: { view: ViewName; near: number } | null; n: number } | null = null;
    try { clip = JSON.parse(localStorage.getItem(CLIP_KEY) || 'null'); } catch { /* none */ }
    if (!clip || !clip.features.length) return 0;
    const same = clip.features.some((f) => this.feature(f.id));
    clip.n = same ? (clip.n || 0) + 1 : 0;
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(clip)); } catch { /* fine */ }
    const V = VIEWS[view];
    const turned = !!clip.from && clip.from.view !== view;     // onto another face: in its middle, no step
    const off: Vec3 = same && !turned ? V.toWorld(step * clip.n, -step * clip.n, 0) : [0, 0, 0];
    // shapes all from one face go onto the active view's face, the same depths in from it
    // (roundings stay behind: their edges belong to where the shapes were)
    const from = clip.from;
    const moveFace = !!from && (from.view !== view || !same);
    const dNear = from ? nearDepth(view, this.p) - from.near : 0;
    if (moveFace && from!.view !== view) clip.features = clip.features.filter((f) => f.type !== 'fillet');
    const map = new Map<string, string>();
    for (const f of clip.features) map.set(f.id, newId());
    const groups = new Map<string, string>();      // a pasted group is a new group of its own
    for (const f of clip.features) if (f.group && !groups.has(f.group)) groups.set(f.group, newId());
    const added: Feature[] = clip.features.map((f) => {
      const g: Feature = JSON.parse(JSON.stringify(f));
      g.id = map.get(f.id)!;
      if (moveFace && isShape(g)) { g.view = view; g.d0 += dNear; g.d1 += dNear; }
      if (g.group) g.group = groups.get(g.group);
      // a pasted copy of a component is another copy of it (the component comes along into another part)
      if (g.comp) {
        if (!this.p.components?.[g.comp.name] && !clip!.comps?.[g.comp.name]) delete g.comp;
        else g.comp = { ...g.comp, inst: g.group ?? newId() };
      }
      if (g.fillet?.refs) {
        g.fillet.refs = g.fillet.refs.map((r) => (r ? { ...r, owner: map.get(r.owner) ?? r.owner } : r));
        g.fillet.edges = g.fillet.edges.map((e) => [e[0] + off[0], e[1] + off[1], e[2] + off[2]] as Vec3);
      } else if (isShape(g)) featureItem(g, this.p).move(off);
      if (g.pattern) {
        if (g.pattern.kind === 'circular') g.pattern.center = [g.pattern.center[0] + off[0], g.pattern.center[1] + off[1], g.pattern.center[2] + off[2]];
      }
      if (g.mirror) g.mirror = { ...g.mirror, at: g.mirror.at + off[g.mirror.axis] };
      return g;
    });
    if (turned) {
      // centre the shapes on the middle of this view's face
      const pts = added.filter(isShape).flatMap((f) => profile(f, 16));
      if (pts.length) {
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        const s0 = this.p.stock, mid: Vec3 = s0.off ? [0, 0, 0] : [0, 1, 2].map((i) => (s0.min[i] + s0.max[i]) / 2) as Vec3;
        const [mu, mv] = VIEWS[view].toView(mid);
        const du = mu - (Math.min(...xs) + Math.max(...xs)) / 2, dv = mv - (Math.min(...ys) + Math.max(...ys)) / 2;
        for (const g of added) if (isShape(g)) { g.cu += du; g.cv += dv; }
      }
    }
    const dims = clip.dims.map((d) => ({ ...d, id: newId(), target: map.get(d.target) ?? d.target, ...(moveFace && d.view === from!.view ? { view } : {}) }));
    this.change((p) => {
      p.features.push(...added);
      p.dims = [...(p.dims || []), ...dims];
      for (const [n, d] of Object.entries(clip!.comps || {})) if (!p.components?.[n]) p.components = { ...(p.components || {}), [n]: d };
    });
    this.select(added.filter(isShape).map((f) => f.id));
    return added.filter(isShape).length;
  }

  /** A copy of the selection, just down and right of it. */
  duplicate(view: ViewName, step = 5): number {
    // leave whatever was copied on the clipboard
    let keep: string | null = null;
    try { keep = localStorage.getItem(CLIP_KEY); } catch { /* none */ }
    const n = this.copy() ? this.paste(view, step) : 0;
    try { if (keep) localStorage.setItem(CLIP_KEY, keep); else localStorage.removeItem(CLIP_KEY); } catch { /* fine */ }
    return n;
  }

  /** The selected shapes as one group (⌘G). Groups inside it merge into it. Returns how many. */
  group(): number {
    const ids = new Set(this.sels.filter((id) => { const f = this.feature(id); return !!f && isShape(f); }));
    if (ids.size < 2) return 0;
    const g = newId();
    this.change((p) => { for (const f of p.features) if (ids.has(f.id)) f.group = g; });
    this.emit('select');
    return ids.size;
  }

  /** Break the selected groups up into loose shapes (⇧⌘G). Returns how many groups. */
  ungroup(): number {
    const gs = new Set(this.sels.map((id) => this.feature(id)?.group).filter(Boolean));
    if (!gs.size) return 0;
    this.change((p) => { for (const f of p.features) if (f.group && gs.has(f.group)) delete f.group; });
    this.emit('select');
    return gs.size;
  }

  /** The selection is exactly one whole group. */
  get oneGroup(): string | null {
    const g = this.feature(this.sels[0] ?? null)?.group;
    if (!g || this.sels.some((id) => this.feature(id)?.group !== g)) return null;
    return this.p.features.filter((f) => f.group === g).length === this.sels.length ? g : null;
  }

  rememberHole(h: HoleSpec) { this.lastHole = { ...h }; try { localStorage.setItem(HOLE_KEY, JSON.stringify(h)); } catch { /* private mode */ } }
  setTool(t: Tool) { this.tool = t; if (t !== 'edge') { this.edges = []; this.repick = null; } this.emit('tool'); }

  feature(id: string | null): Feature | undefined { return this.p.features.find((f) => f.id === id); }
  dim(id: string | null) { return (this.p.dims || []).find((d) => d.id === id); }
  guide(id: string | null) { return (this.p.measures || []).find((m) => m.id === id); }
  rulerGuide(id: string | null) { return (this.p.rulerGuides || []).find((g) => g.id === id); }
}

// ------------------------------------------------------------ items
// The stock and every feature are boxes along the world axes, so selection,
// handles and dragging work the same way in every view.

export interface Item {
  id: string;
  extents(): [Vec3, Vec3];                       // world min, max
  setEdge(axis: number, side: 0 | 1, value: number): void;
  move(delta: Vec3): void;
  movable: boolean;
  resizable?(axis: number): boolean;
}

export function itemFor(st: State, id: string): Item | null {
  if (id === 'stock') {
    const s = st.p.stock;
    return {
      id, movable: false,
      extents: () => [[...s.min] as Vec3, [...s.max] as Vec3],
      setEdge(axis, side, value) {
        if (st.p.base) return;                  // a library model's size is its own
        if (side === 0) s.min[axis] = Math.min(value, s.max[axis] - 0.1);
        else s.max[axis] = Math.max(value, s.min[axis] + 0.1);
        // a cylinder stays round: the other way across follows, about its centre
        if (s.shape === 'cylinder' && axis < 2) {
          const o = 1 - axis, d = s.max[axis] - s.min[axis], c = (s.min[o] + s.max[o]) / 2;
          s.min[o] = c - d / 2; s.max[o] = c + d / 2;
        }
      },
      move() { /* the stock stays put */ },
    };
  }
  const f = st.feature(id);
  if (!f || !isShape(f)) return null;
  return featureItem(f, st.p);
}

/** Which feature axis (0 u, 1 v, 2 d) a world axis runs along, and the sign. */
function featAxis(f: Feature, worldAxis: number): [number, number] {
  const v = VIEWS[f.view];
  const dirs = [v.uDir, v.vDir, v.eye];
  for (let a = 0; a < 3; a++) if (dirs[a][worldAxis] !== 0) return [a, dirs[a][worldAxis]];
  return [0, 1];
}

export function featureItem(f: Feature, p: Project): Item {
  const v = VIEWS[f.view];
  const ranges = (): [number, number][] => {
    const [u0, v0, u1, v1] = bounds2d(f);
    const dr = depthExtent(f, p);
    // a through cut reaches just past the part to be sure; show it ending at the part's far side
    if (f.op === 'cut' && f.through) {
      if (f.far) dr[1] = Math.max(nearDepth(f.view, p), dr[0]);
      else dr[0] = Math.min(farDepth(f.view, p), dr[1]);
    }
    return [[u0, u1], [v0, v1], dr];
  };
  return {
    id: f.id, movable: true,
    resizable(axis) {
      if (f.revolve) return false;                    // a spun shape: sized by its outline's corners and the panel
      const [a] = featAxis(f, axis);
      if (a === 2) return true;
      if (f.type === 'gear' || f.type === 'hole') return false;      // sized in their boxes
      if (f.type === 'slot') return Math.abs(((f.rot || 0) % 90 + 90) % 90) < 1e-6;   // square to the view: like a rectangle
      return true;
    },
    extents() {
      if (f.revolve) {
        // the spun shape's box (round the centre line), not its flat outline
        const cs = featureCorners(f);
        return [[0, 1, 2].map((k) => Math.min(...cs.map((c) => c[k]))) as Vec3, [0, 1, 2].map((k) => Math.max(...cs.map((c) => c[k]))) as Vec3];
      }
      const r = ranges();
      const min: Vec3 = [0, 0, 0], max: Vec3 = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        const [a, s] = featAxis(f, i);
        const [lo, hi] = r[a];
        min[i] = s > 0 ? lo : -hi;
        max[i] = s > 0 ? hi : -lo;
      }
      return [min, max];
    },
    setEdge(axis, side, value) {
      const [a, s] = featAxis(f, axis);
      const fv = s * value;
      const fside = s > 0 ? side : 1 - side;
      if (a < 2) {
        const b = bounds2d(f);
        const lo0 = b[a], hi0 = b[a + 2];
        let lo = lo0, hi = hi0;
        if (fside === 0) lo = Math.min(fv, hi); else hi = Math.max(fv, lo);
        const k = hi0 - lo0 > 1e-9 ? (hi - lo) / (hi0 - lo0) : 1;
        if (f.type === 'hole' || f.type === 'gear') return;
        if (f.type === 'slot') {
          // turned 90°: its length runs up the view
          const across = Math.abs(((f.rot || 0) % 180 + 180) % 180 - 90) < 1e-6;
          const n = Math.max(0.1, hi - lo);
          if (a === 0) { f.cu = (lo + hi) / 2; if (across) f.h = n; else f.w = n; } else { f.cv = (lo + hi) / 2; if (across) f.w = n; else f.h = n; }
        } else if (f.type === 'rect') {
          if (a === 0) { f.cu = (lo + hi) / 2; f.w = hi - lo; } else { f.cv = (lo + hi) / 2; f.h = hi - lo; }
        } else if (f.type === 'circle') {
          const c = a === 0 ? f.cu : f.cv;
          f.r = Math.max(0, fside === 1 ? fv - c : c - fv);
        } else if (f.type === 'poly' && f.pts) {
          // stretch along this axis, the opposite side staying put
          const c0 = a === 0 ? f.cu : f.cv;
          const sc = (pt: P2): P2 => { const q = [...pt] as P2; q[a] = lo + (c0 + pt[a] - lo0) * k - c0; return q; };
          f.pts = f.pts.map(sc);
          if (f.curves) f.curves = f.curves.map((cc) => cc && [sc(cc[0]), sc(cc[1])]);
        } else if (f.type === 'polygon' || f.type === 'text') {
          // grow evenly, the opposite side staying put
          const c = a === 0 ? f.cu : f.cv;
          const anchor = fside === 0 ? hi0 : lo0;
          const nc = anchor + (c - anchor) * k;
          if (a === 0) f.cu = nc; else f.cv = nc;
          if (f.type === 'polygon') f.r *= k; else if (f.text) { f.text.size *= k; f.w *= k; f.h *= k; }
        }
        return;
      }
      // depth: move whichever end sits on that side
      if (f.through) {
        const dr = depthRange(f, p);
        f.d1 = f.far ? dr[1] : dr[0];
        f.through = false;
      }
      if (Math.abs(f.d0 - f.d1) < 1e-9) {
        // a sketch getting its depth: pushed into the material it cuts, pulled out it adds
        f.d1 = fv;
        f.op = (fv - f.d0) * into(f) > 0 ? 'cut' : 'add';
        return;
      }
      const d0IsLo = f.d0 <= f.d1;
      if ((fside === 0) === d0IsLo) f.d0 = fv; else f.d1 = fv;
    },
    move(delta) {
      const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      f.cu += dot(delta, v.uDir);
      f.cv += dot(delta, v.vDir);
      const dd = dot(delta, v.eye);
      f.d0 += dd; f.d1 += dd;
    },
  };
}

/** An item's extent across a view and up it: [u range, v range]. */
export function viewRanges(view: ViewName, it: Item): [[number, number], [number, number]] {
  const V = VIEWS[view];
  const [min, max] = it.extents();
  const rng = (dir: Vec3): [number, number] => {
    const [a, s] = axisOf(dir);
    return s > 0 ? [min[a], max[a]] : [-max[a], -min[a]];
  };
  return [rng(V.uDir), rng(V.vDir)];
}

export type AlignHow = 'left' | 'hcenter' | 'right' | 'top' | 'vmiddle' | 'bottom';

/**
 * Line the selected shapes up, the way the active view sees them: left,
 * right, top and bottom are that view's. To the selection's own bounds, or
 * to the part (the stock block).
 */
export function align(st: State, how: AlignHow, to: 'selection' | 'part') {
  // with the body selected too, it's the one the others line up to (it stays put)
  if (st.sels.includes('stock')) to = 'part';
  const view = st.activeView;
  const V = VIEWS[view];
  const items = st.sels.filter((id) => id !== 'stock').map((id) => itemFor(st, id)).filter((x): x is Item => !!x);
  if (!items.length) return;
  const horiz = how === 'left' || how === 'hcenter' || how === 'right';
  const k = horiz ? 0 : 1;
  const span = (it: Item) => viewRanges(view, it)[k];
  let lo: number, hi: number;
  if (to === 'part') [lo, hi] = viewRanges(view, itemFor(st, 'stock')!)[k];
  else { lo = Math.min(...items.map((it) => span(it)[0])); hi = Math.max(...items.map((it) => span(it)[1])); }
  st.change(() => {
    for (const it of items) {
      const [a, b] = span(it);
      let d = 0;
      if (how === 'left' || how === 'bottom') d = lo - a;
      else if (how === 'right' || how === 'top') d = hi - b;
      else d = (lo + hi) / 2 - (a + b) / 2;
      it.move(horiz ? V.toWorld(d, 0, 0) : V.toWorld(0, d, 0));
    }
  });
}

/** Space the selected shapes' centres evenly between the outermost two. */
export function distribute(st: State, dir: 'h' | 'v') {
  const view = st.activeView;
  const V = VIEWS[view];
  const k = dir === 'h' ? 0 : 1;
  const items = st.sels.filter((id) => id !== 'stock').map((id) => itemFor(st, id)).filter((x): x is Item => !!x);
  if (items.length < 3) return;
  const mid = (it: Item) => { const [a, b] = viewRanges(view, it)[k]; return (a + b) / 2; };
  const sorted = items.map((it) => ({ it, c: mid(it) })).sort((a, b) => a.c - b.c);
  const first = sorted[0].c, last = sorted[sorted.length - 1].c;
  st.change(() => {
    sorted.forEach(({ it, c }, i) => {
      const d = first + ((last - first) * i) / (sorted.length - 1) - c;
      it.move(dir === 'h' ? V.toWorld(d, 0, 0) : V.toWorld(0, d, 0));
    });
  });
}

export { axisOf };
