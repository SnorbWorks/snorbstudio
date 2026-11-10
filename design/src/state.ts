// App state: the project, the selection, undo/redo and the latest build.

import type { Feature, Project, Vec3 } from './model.js';
import { depthRange, newProject } from './model.js';
import type { BuildResult } from './geometry.js';
import { VIEWS, axisOf } from './views.js';

export type Tool = 'select' | 'rect' | 'circle';
type Listener = (what: 'model' | 'select' | 'built' | 'tool' | 'view') => void;

const KEY = 'studio.design.project';

export class State {
  p: Project = newProject();
  sel: string | null = null;          // 'stock' | feature id
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
    if (this.sel && this.sel !== 'stock' && !this.feature(this.sel)) this.sel = null;
    this.changed();
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(JSON.stringify(this.p));
    this.p = JSON.parse(s);
    if (this.sel && this.sel !== 'stock' && !this.feature(this.sel)) this.sel = null;
    this.changed();
  }

  load(p: Project) { this.snapshot(); this.p = { ...newProject(), ...p }; this.sel = null; this.changed(); }

  select(id: string | null) { this.sel = id; this.emit('select'); }
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

export { axisOf };
