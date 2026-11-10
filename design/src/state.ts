// App state: the project, the selection, undo/redo and the latest build.

import type { Feature, Project, Vec3, ViewName } from './model.js';
import { depthRange, newProject } from './model.js';
import type { BuildResult } from './geometry.js';
import { VIEWS, axisOf } from './views.js';

export type Tool = 'select' | 'rect' | 'circle';
type Listener = (what: 'model' | 'select' | 'built' | 'tool' | 'view') => void;

const KEY = 'studio.design.project';

export class State {
  p: Project = newProject();
  sels: string[] = [];                // selected: 'stock' or feature ids
  sides: { id: string; sides: number[] } | null = null;   // Option-clicked sides of one rectangle
  activeView: ViewName = 'top';       // the view last worked in: alignment goes by its left/right/top/bottom
  tool: Tool = 'select';
  built: BuildResult | null = null;
  buildError = '';
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<Listener>();

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.p = { ...newProject(), ...JSON.parse(raw) };
    } catch { /* fresh project */ }
  }

  on(fn: Listener) { this.listeners.add(fn); }
  emit(what: Parameters<Listener>[0]) { for (const fn of this.listeners) fn(what); }

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
    this.sels = this.sels.filter((id) => id === 'stock' || this.feature(id));
    if (this.sides && !this.feature(this.sides.id)) this.sides = null;
  }

  load(p: Project) { this.snapshot(); this.p = { ...newProject(), ...p }; this.sels = []; this.sides = null; this.changed(); }

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
    this.change((p) => { p.features = p.features.filter((f) => !del.has(f.id)); });
    this.select([]);
  }
  setTool(t: Tool) { this.tool = t; this.emit('tool'); }

  feature(id: string | null): Feature | undefined { return this.p.features.find((f) => f.id === id); }
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
}

export function itemFor(st: State, id: string): Item | null {
  if (id === 'stock') {
    const s = st.p.stock;
    return {
      id, movable: false,
      extents: () => [[...s.min] as Vec3, [...s.max] as Vec3],
      setEdge(axis, side, value) {
        if (side === 0) s.min[axis] = Math.min(value, s.max[axis] - 0.1);
        else s.max[axis] = Math.max(value, s.min[axis] + 0.1);
      },
      move() { /* the stock stays put */ },
    };
  }
  const f = st.feature(id);
  if (!f) return null;
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
    const hu = f.type === 'circle' ? f.r : f.w / 2;
    const hv = f.type === 'circle' ? f.r : f.h / 2;
    return [[f.cu - hu, f.cu + hu], [f.cv - hv, f.cv + hv], depthRange(f, p)];
  };
  return {
    id: f.id, movable: true,
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
        const c = a === 0 ? f.cu : f.cv;
        if (f.type === 'circle') {
          f.r = Math.max(0, fside === 1 ? fv - c : c - fv);
        } else {
          const half = (a === 0 ? f.w : f.h) / 2;
          let lo = c - half, hi = c + half;
          if (fside === 0) lo = Math.min(fv, hi); else hi = Math.max(fv, lo);
          if (a === 0) { f.cu = (lo + hi) / 2; f.w = hi - lo; } else { f.cv = (lo + hi) / 2; f.h = hi - lo; }
        }
        return;
      }
      // depth: move whichever end sits on that side
      if (f.through) { f.d1 = depthRange(f, p)[0]; f.through = false; }
      if (Math.abs(f.d0 - f.d1) < 1e-9) {
        // a sketch getting its depth: pulled out it adds, pushed in it cuts
        f.d1 = fv;
        f.op = fv < f.d0 ? 'cut' : 'add';
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
