// App state: the project, the selection, undo/redo and the latest build.

import type { Feature, Project, Vec3, ViewName } from './model.js';
import { bounds2d, depthExtent, depthRange, farDepth, into, isShape, nearDepth, newId, newProject, rotateFeature, DEFAULT_FIT, type P2 } from './model.js';
import { type HoleSpec, defaultHole } from './holes.js';
import type { BuildResult } from './geometry.js';
import { VIEWS, axisOf } from './views.js';

export type Tool = 'select' | 'rotate' | 'measure' | 'rect' | 'slot' | 'circle' | 'polygon' | 'line' | 'hole' | 'gear' | 'text' | 'edge' | 'dim' | 'zoom';
type Listener = (what: 'model' | 'select' | 'built' | 'tool' | 'view') => void;

const KEY = 'studio.design.project';
const VIEW_KEY = 'studio.design.viewOpts';
const HOLE_KEY = 'studio.design.lastHole';
const FIT_KEY = 'studio.design.fit';
const CLIP_KEY = 'studio.design.clip';

/** Everything that belongs to one open part (for switching between part tabs). */
export interface Doc { p: Project; undo: string[]; redo: string[]; sels: string[] }

/** The printer fit new parts start with: the owner's last setting, else 0.2 mm. */
export function defaultFit(): number {
  try { const v = parseFloat(localStorage.getItem(FIT_KEY) || ''); if (Number.isFinite(v) && v >= 0) return v; } catch { /* default */ }
  return DEFAULT_FIT;
}
export function rememberFit(v: number) { try { localStorage.setItem(FIT_KEY, String(v)); } catch { /* private mode */ } }

/** How the sheet is drawn (the Views tab): the owner's, not saved with the part. */
export interface ViewOpts { projLines: boolean; hidden: boolean }

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
  viewOpts: ViewOpts = { projLines: true, hidden: true };
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
    // parts from before printer fit: the owner's current fit (it only touches holes and slots, which they didn't have)
    if (this.p.fit === undefined) this.p.fit = defaultFit();
    this.sels = []; this.sides = null; this.changed();
  }

  /** The one selected thing, or null when none or several are selected. */
  get one(): string | null { return this.sels.length === 1 ? this.sels[0] : null; }

  select(ids: string[], sides: State['sides'] = null) {
    this.sels = [...new Set(ids)];
    this.sides = sides;
    this.emit('select');
  }

  deleteSelected() {
    const del = new Set(this.sels.filter((id) => id !== 'stock'));
    if (!del.size) return;
    this.change((p) => {
      p.features = p.features.filter((f) => !del.has(f.id));
      // dimensions go with what they measure
      p.dims = (p.dims || []).filter((d) => !del.has(d.id) && !del.has(d.target));
    });
    this.select([]);
  }
  /** Put this part away and take up another (the part tabs). */
  swap(next: Doc): Doc {
    const out: Doc = { p: this.p, undo: this.undoStack, redo: this.redoStack, sels: this.sels };
    this.p = { ...newProject(), ...next.p };
    if (this.p.fit === undefined) this.p.fit = defaultFit();
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

  /** Copy the selected shapes (and the roundings and dimensions that only touch them) to a clipboard every part tab shares. */
  copy(): number {
    const ids = new Set(this.sels.filter((id) => id !== 'stock' && this.feature(id)));
    if (!ids.size) return 0;
    const feats = this.p.features.filter((f) => ids.has(f.id) || (f.type === 'fillet' && f.fillet?.refs?.length && f.fillet.refs.every((r) => r && ids.has(r.owner))));
    const dims = (this.p.dims || []).filter((d) => ids.has(d.target));
    try { localStorage.setItem(CLIP_KEY, JSON.stringify({ features: feats, dims, n: 0 })); } catch { return 0; }
    return ids.size;
  }

  get canPaste(): boolean { try { return !!localStorage.getItem(CLIP_KEY); } catch { return false; } }

  /**
   * Paste the clipboard. Into the part it came from, each paste lands a
   * little further down and right (in `view`) so it doesn't hide the
   * original; into another part, in the same place.
   */
  paste(view: ViewName, step = 5): number {
    let clip: { features: Feature[]; dims: any[]; n: number } | null = null;
    try { clip = JSON.parse(localStorage.getItem(CLIP_KEY) || 'null'); } catch { /* none */ }
    if (!clip || !clip.features.length) return 0;
    const same = clip.features.some((f) => this.feature(f.id));
    clip.n = same ? (clip.n || 0) + 1 : 0;
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(clip)); } catch { /* fine */ }
    const V = VIEWS[view];
    const off: Vec3 = same ? V.toWorld(step * clip.n, -step * clip.n, 0) : [0, 0, 0];
    const map = new Map<string, string>();
    for (const f of clip.features) map.set(f.id, newId());
    const added: Feature[] = clip.features.map((f) => {
      const g: Feature = JSON.parse(JSON.stringify(f));
      g.id = map.get(f.id)!;
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
    const dims = clip.dims.map((d) => ({ ...d, id: newId(), target: map.get(d.target) ?? d.target }));
    this.change((p) => { p.features.push(...added); p.dims = [...(p.dims || []), ...dims]; });
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

  rememberHole(h: HoleSpec) { this.lastHole = { ...h }; try { localStorage.setItem(HOLE_KEY, JSON.stringify(h)); } catch { /* private mode */ } }
  setTool(t: Tool) { this.tool = t; if (t !== 'edge') { this.edges = []; this.repick = null; } this.emit('tool'); }

  feature(id: string | null): Feature | undefined { return this.p.features.find((f) => f.id === id); }
  dim(id: string | null) { return (this.p.dims || []).find((d) => d.id === id); }
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
      const [a] = featAxis(f, axis);
      if (a === 2) return true;
      if (f.type === 'gear' || f.type === 'hole') return false;      // sized in their boxes
      if (f.type === 'slot') return Math.abs(((f.rot || 0) % 90 + 90) % 90) < 1e-6;   // square to the view: like a rectangle
      return true;
    },
    extents() {
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
          f.pts = f.pts.map((pt) => { const q = [...pt] as P2; q[a] = lo + (c0 + pt[a] - lo0) * k - c0; return q; });
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
