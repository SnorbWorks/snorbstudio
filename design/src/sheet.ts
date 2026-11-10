// The drafting sheet: every shown view on one white sheet, drawn as SVG
// from the latest build, plus the tools (select, rectangle, circle),
// multi-selection (shift-click, drag a box), side picks (Option-click),
// handles, T-square guides and pan/zoom.

import type { Feature, ViewName, Vec3 } from './model.js';
import { newId, profile, sharedCorner, cornerRadii } from './model.js';
import { VIEWS, VIEW_ORDER, NEIGHBOURS, axisOf, parallel, layout, type Box2 } from './views.js';
import { State, itemFor, viewRanges, type Item } from './state.js';

const HANDLE_PX = 5;
const PICK_PX = 7;
const SNAP_PX = 8;

type Placed = Record<ViewName, { box: Box2; ou: number; ov: number }>;

interface Guide { axis: number; value: number }

type Drag =
  | { kind: 'pan'; x0: number; y0: number; px: number; py: number }
  | { kind: 'draw'; view: ViewName; type: 'rect' | 'circle'; u0: number; v0: number; u1: number; v1: number }
  | { kind: 'edge'; id: string; view: ViewName; axis: number; side: 0 | 1; orig: string; started: boolean; sx: number; sy: number }
  | { kind: 'move'; ids: string[]; view: ViewName; u0: number; v0: number; orig: string; started: boolean; sx: number; sy: number }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number; add: boolean; onStock: boolean; view: ViewName | null; started: boolean; sx: number; sy: number };

// Tool cursors: a crosshair with the tool's shape beside it (hotspot at the cross).
const cursorSvg = (shape: string) => `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28'><g fill='none' stroke-linecap='round'>`
  + `<path d='M9 1v16M1 9h16' stroke='white' stroke-width='3'/><path d='M9 1v16M1 9h16' stroke='black' stroke-width='1.2'/>`
  + `<g stroke='white' stroke-width='3'>${shape}</g><g stroke='black' stroke-width='1.3'>${shape}</g></g></svg>`)}") 9 9, crosshair`;
const CURSORS: Record<string, string> = {
  rect: cursorSvg("<rect x='15' y='16' width='11' height='8' rx='0.5'/>"),
  circle: cursorSvg("<circle cx='21' cy='21' r='5.5'/>"),
};

export class Sheet {
  svg: SVGSVGElement;
  zoom = 6;                 // px per mm
  panX = 40;
  panY = 40;
  placed!: Placed;
  private drag: Drag | null = null;
  private guides: Guide[] = [];
  private hover: string | null = null;
  private hoverCursor = '';
  private cursor: { view: ViewName; u: number; v: number } | null = null;
  private fitted = false;
  private spaceDown = false;
  onStatus: (text: string) => void = () => {};

  constructor(private host: HTMLElement, private st: State) {
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.classList.add('ds-sheet');
    host.appendChild(this.svg);
    this.relayout();
    this.svg.addEventListener('pointerdown', (e) => this.down(e));
    this.svg.addEventListener('pointermove', (e) => this.moveEvt(e));
    this.svg.addEventListener('pointerup', (e) => this.up(e));
    this.svg.addEventListener('pointercancel', () => { this.drag = null; this.render(); });
    this.svg.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.svg.addEventListener('contextmenu', (e) => e.preventDefault());
    this.svg.addEventListener('pointerleave', () => { this.cursor = null; this.status(); });
    window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !isTyping() && !this.spaceDown) { this.spaceDown = true; this.setCursor(); } });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') { this.spaceDown = false; this.setCursor(); } });
    new ResizeObserver(() => { if (!this.fitted && host.clientWidth > 0) this.fit(); else this.render(); }).observe(host);
  }

  // ------------------------------------------------------------ layout

  /** Re-place the views around everything in the model. Not during a drag, so views don't jump. */
  relayout() {
    if (this.drag) return;
    const p = this.st.p;
    const min: Vec3 = [...p.stock.min] as Vec3, max: Vec3 = [...p.stock.max] as Vec3;
    const grow = (a: Vec3, b: Vec3) => { for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], a[i]); max[i] = Math.max(max[i], b[i]); } };
    for (const f of p.features) {
      if (f.op === 'cut' && (f.through || f.d0 !== f.d1)) continue;      // cuts never make the part bigger
      const it = itemFor(this.st, f.id);
      if (it) { const [a, b] = it.extents(); grow(a, b); }
    }
    const bb = this.st.built?.bbox;
    if (bb) grow(bb[0] as Vec3, bb[1] as Vec3);
    // round out to 5 mm so small edits don't shuffle the sheet
    for (let i = 0; i < 3; i++) { min[i] = Math.floor((min[i] + 0.01) / 5) * 5; max[i] = Math.ceil((max[i] - 0.01) / 5) * 5; }
    this.placed = layout(min, max, new Set(p.views));
  }

  toSheet(view: ViewName, u: number, v: number): [number, number] {
    const pl = this.placed[view];
    return [pl.ou + u, pl.ov - v];
  }

  fromSheet(view: ViewName, x: number, y: number): [number, number] {
    const pl = this.placed[view];
    return [x - pl.ou, pl.ov - y];
  }

  private screenToSheet(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.svg.getBoundingClientRect();
    return [(e.clientX - r.left - this.panX) / this.zoom, (e.clientY - r.top - this.panY) / this.zoom];
  }

  private viewAt(x: number, y: number): ViewName | null {
    for (const v of this.st.p.views) {
      const b = this.placed[v].box;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return v;
    }
    return null;
  }

  private ghosts(): ViewName[] {
    const shown = new Set(this.st.p.views);
    return VIEW_ORDER.filter((v) => !shown.has(v) && NEIGHBOURS[v].some((n) => shown.has(n)));
  }

  fit() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.relayout();
    const boxes = [...this.st.p.views, ...this.ghosts()].map((v) => this.placed[v].box);
    const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
    const z = Math.min((w - 60) / (x1 - x0), (h - 70) / (y1 - y0), 40);
    this.zoom = z;
    this.panX = (w - (x1 - x0) * z) / 2 - x0 * z;
    this.panY = (h - 20 - (y1 - y0) * z) / 2 - y0 * z;
    this.fitted = true;
    this.render();
  }

  // ------------------------------------------------------------ geometry of items in a view

  /** An item's outline in a view: the profile in its own (or a parallel) view, else its side-on rectangle. */
  outline(view: ViewName, id: string): [number, number][] | null {
    const it = itemFor(this.st, id);
    if (!it) return null;
    const f = id === 'stock' ? undefined : this.st.feature(id);
    if (f && parallel(f.view, view)) return profile(f).map(([u, v]) => this.featToView(f, view, u, v));
    const [ur, vr] = viewRanges(view, it);
    return [[ur[0], vr[0]], [ur[1], vr[0]], [ur[1], vr[1]], [ur[0], vr[1]]];
  }

  /** A point in a feature's own (u, v) seen in another view. */
  private featToView(f: Feature, view: ViewName, u: number, v: number): [number, number] {
    const q = VIEWS[view].toView(VIEWS[f.view].toWorld(u, v, 0));
    return [q[0], q[1]];
  }

  /** The straight part of each side of a rectangle (0 bottom, 1 right, 2 top, 3 left), in a view. */
  private sideSegs(f: Feature, view: ViewName): [number, number][][] {
    const hw = f.w / 2, hh = f.h / 2, r = cornerRadii(f);
    const L = f.cu - hw, R = f.cu + hw, B = f.cv - hh, T = f.cv + hh;
    const segs: [number, number][][] = [
      [[L + r[0], B], [R - r[1], B]], [[R, B + r[1]], [R, T - r[2]]],
      [[R - r[2], T], [L + r[3], T]], [[L, T - r[3]], [L, B + r[0]]],
    ];
    return segs.map((s) => s.map(([u, v]) => this.featToView(f, view, u, v)));
  }

  /** Handles of a single selected item in a view: edge midpoints, with the world axis and side they move. */
  private handles(view: ViewName, id: string): { u: number; v: number; axis: number; side: 0 | 1; horiz: boolean }[] {
    const it = itemFor(this.st, id);
    if (!it) return [];
    const V = VIEWS[view];
    const [ur, vr] = viewRanges(view, it);
    const [ua, us] = axisOf(V.uDir), [va, vs] = axisOf(V.vDir);
    const um = (ur[0] + ur[1]) / 2, vm = (vr[0] + vr[1]) / 2;
    const out = [
      { u: ur[0], v: vm, axis: ua, side: (us > 0 ? 0 : 1) as 0 | 1, horiz: true },
      { u: ur[1], v: vm, axis: ua, side: (us > 0 ? 1 : 0) as 0 | 1, horiz: true },
      { u: um, v: vr[0], axis: va, side: (vs > 0 ? 0 : 1) as 0 | 1, horiz: false },
      { u: um, v: vr[1], axis: va, side: (vs > 0 ? 1 : 0) as 0 | 1, horiz: false },
    ];
    // a sketch seen edge-on is a line: one handle pulls its depth
    if (Math.abs(ur[1] - ur[0]) < 1e-9) out.splice(0, 1);
    else if (Math.abs(vr[1] - vr[0]) < 1e-9) out.splice(2, 1);
    return out;
  }

  private handleAt(view: ViewName, u: number, v: number) {
    const one = this.st.one;
    if (!one || this.st.sides) return null;
    const tol = (HANDLE_PX + 3) / this.zoom;
    return this.handles(view, one).find((h) => Math.abs(h.u - u) <= tol && Math.abs(h.v - v) <= tol) || null;
  }

  /** The feature under a point (outlines first, then the smallest shape), else 'stock', else null. */
  private pick(view: ViewName, u: number, v: number): string | null {
    const tol = PICK_PX / this.zoom;
    let best: string | null = null, bestScore = Infinity;
    for (const f of [...this.st.p.features].reverse()) {
      const poly = this.outline(view, f.id);
      if (!poly) continue;
      const edge = polyDist(poly, u, v);
      const inside = pointInPoly(poly, u, v);
      if (edge > tol && !inside) continue;
      const score = (edge <= tol ? 0 : 1e9) + polyArea(poly);
      if (score < bestScore) { bestScore = score; best = f.id; }
    }
    if (best) return best;
    const sp = this.outline(view, 'stock');
    if (sp && (pointInPoly(sp, u, v) || polyDist(sp, u, v) <= tol)) return 'stock';
    return null;
  }

  /** The side of a rectangle under a point, in a view that sees its face. */
  private pickSide(view: ViewName, u: number, v: number): { id: string; side: number } | null {
    const tol = PICK_PX / this.zoom;
    let best: { id: string; side: number } | null = null, bd = tol;
    for (const f of this.st.p.features) {
      if (f.type !== 'rect' || !parallel(f.view, view)) continue;
      this.sideSegs(f, view).forEach((seg, side) => {
        const d = polyDist(seg, u, v, false);
        if (d <= bd) { bd = d; best = { id: f.id, side }; }
      });
    }
    return best;
  }

  // ------------------------------------------------------------ snapping

  /** Values along each world axis worth snapping to: the part's edges and corners, the stock, features. */
  private snapTargets(exclude: Set<string>): Set<number>[] {
    const out = [new Set<number>(), new Set<number>(), new Set<number>()];
    const add = (axis: number, v: number) => out[axis].add(Math.round(v * 1e4) / 1e4);
    const s = this.st.p.stock;
    for (let i = 0; i < 3; i++) { add(i, s.min[i]); add(i, s.max[i]); add(i, (s.min[i] + s.max[i]) / 2); }
    for (const f of this.st.p.features) {
      if (exclude.has(f.id)) continue;
      const it = itemFor(this.st, f.id);
      if (!it) continue;
      const [a, b] = it.extents();
      for (let i = 0; i < 3; i++) { add(i, a[i]); add(i, b[i]); add(i, (a[i] + b[i]) / 2); }
    }
    const built = this.st.built;
    if (built && !this.drag) {
      const edges = [new Set<number>(), new Set<number>(), new Set<number>()];
      for (const [name, ve] of Object.entries(built.views)) {
        const V = VIEWS[name as ViewName];
        const [ua, us] = axisOf(V.uDir), [va, vs] = axisOf(V.vDir);
        for (const l of ve!.visible) {
          for (const k of [0, l.length - 2]) { edges[ua].add(Math.round(us * l[k] * 1e4) / 1e4); edges[va].add(Math.round(vs * l[k + 1] * 1e4) / 1e4); }
        }
      }
      this.edgeTargets = edges;
    }
    // the part's edges, unless they include the very shapes being dragged
    if (this.edgeTargets && exclude.size === 0) for (let i = 0; i < 3; i++) for (const v of this.edgeTargets[i]) out[i].add(v);
    return out;
  }
  private edgeTargets: Set<number>[] | null = null;

  /** Snap a world value along an axis: to a target (shows a guide) or the grid. */
  private snap(axis: number, raw: number, targets: Set<number>[], free: boolean): { value: number; guide: boolean; dist: number } {
    if (free) return { value: raw, guide: false, dist: Infinity };
    const tol = SNAP_PX / this.zoom;
    let best = raw, bd = Infinity;
    for (const t of targets[axis]) { const d = Math.abs(t - raw); if (d < bd) { bd = d; best = t; } }
    if (bd <= tol) return { value: best, guide: true, dist: bd };
    const g = this.st.p.grid;
    const gv = g > 0 ? Math.round(raw / g) * g : raw;
    return { value: gv, guide: false, dist: Math.abs(gv - raw) };
  }

  private snapView(view: ViewName, u: number, v: number, targets: Set<number>[], free: boolean): [number, number] {
    const V = VIEWS[view];
    const [ua, us] = axisOf(V.uDir), [va, vs] = axisOf(V.vDir);
    const su = this.snap(ua, us * u, targets, free), sv = this.snap(va, vs * v, targets, free);
    this.guides = [];
    if (su.guide) this.guides.push({ axis: ua, value: su.value });
    if (sv.guide) this.guides.push({ axis: va, value: sv.value });
    return [us * su.value, vs * sv.value];
  }

  // ------------------------------------------------------------ surface under a point

  /** Depth (toward the viewer) of the part's nearest surface under (u, v) in a view. */
  surfaceAt(view: ViewName, u: number, v: number): number {
    const V = VIEWS[view];
    const m = this.st.built?.mesh;
    let best = -Infinity;
    if (m) {
      const P = m.vertices, T = m.triangles;
      const q = (i: number) => V.toView([P[3 * i], P[3 * i + 1], P[3 * i + 2]]);
      for (let k = 0; k < T.length; k += 3) {
        const a = q(T[k]), b = q(T[k + 1]), c = q(T[k + 2]);
        const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        if (Math.abs(d) < 1e-12) continue;
        const l1 = ((b[1] - c[1]) * (u - c[0]) + (c[0] - b[0]) * (v - c[1])) / d;
        const l2 = ((c[1] - a[1]) * (u - c[0]) + (a[0] - c[0]) * (v - c[1])) / d;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
        best = Math.max(best, l1 * a[2] + l2 * b[2] + l3 * c[2]);
      }
    }
    if (best > -Infinity) return best;
    // off the part: the stock's near face
    const s = this.st.p.stock;
    let hi = -Infinity;
    for (const x of [s.min[0], s.max[0]]) for (const y of [s.min[1], s.max[1]]) for (const z of [s.min[2], s.max[2]]) hi = Math.max(hi, V.toView([x, y, z])[2]);
    return hi;
  }

  // ------------------------------------------------------------ pointer

  private down(e: PointerEvent) {
    this.svg.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 || this.spaceDown) {
      this.drag = { kind: 'pan', x0: e.clientX, y0: e.clientY, px: this.panX, py: this.panY };
      this.setCursor();
      return;
    }
    const [x, y] = this.screenToSheet(e);
    // ghost box: add that view
    for (const g of this.ghosts()) {
      const b = this.placed[g].box;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        this.st.change((p) => { p.views.push(g); });
        this.st.emit('view');
        return;
      }
    }
    // a view label's hide button
    for (const v of this.st.p.views) {
      const hb = this.hideBox(v);
      if (this.st.p.views.length > 1 && x >= hb.x && x <= hb.x + hb.w && y >= hb.y && y <= hb.y + hb.h) {
        this.st.change((p) => { p.views = p.views.filter((w) => w !== v); });
        this.st.emit('view');
        return;
      }
    }
    const view = this.viewAt(x, y);
    const tool = this.st.tool;
    if (view && view !== this.st.activeView) { this.st.activeView = view; this.st.emit('select'); }
    if (view && (tool === 'rect' || tool === 'circle')) {
      const [u, v] = this.fromSheet(view, x, y);
      const [su, sv] = this.snapView(view, u, v, this.snapTargets(new Set()), e.altKey);
      this.drag = { kind: 'draw', view, type: tool, u0: su, v0: sv, u1: su, v1: sv };
      this.render();
      return;
    }
    const startBox = (onStock: boolean) => {
      this.drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y, add: e.shiftKey, onStock, view, started: false, sx: e.clientX, sy: e.clientY };
    };
    if (!view) { startBox(false); return; }
    const [u, v] = this.fromSheet(view, x, y);
    // Option-click: one side of a rectangle; Option-Shift adds a side of the same one
    if (e.altKey) {
      const ps = this.pickSide(view, u, v);
      if (ps) {
        const cur = this.st.sides;
        if (e.shiftKey && cur && cur.id === ps.id) {
          const has = cur.sides.includes(ps.side);
          const sides = has ? cur.sides.filter((s) => s !== ps.side) : [...cur.sides, ps.side].slice(-2);
          this.st.select([ps.id], sides.length ? { id: ps.id, sides } : null);
        } else this.st.select([ps.id], { id: ps.id, sides: [ps.side] });
        this.render();
        return;
      }
    }
    // a handle of the one selected item
    const h = this.handleAt(view, u, v);
    if (h) {
      this.drag = { kind: 'edge', id: this.st.one!, view, axis: h.axis, side: h.side, orig: JSON.stringify(this.st.p), started: false, sx: e.clientX, sy: e.clientY };
      return;
    }
    const hit = this.pick(view, u, v);
    if (!hit || hit === 'stock') { startBox(hit === 'stock'); return; }
    let sels = this.st.sels.filter((id) => id !== 'stock');
    if (e.shiftKey) {
      // shift-click toggles a shape in or out of the selection
      sels = sels.includes(hit) ? sels.filter((id) => id !== hit) : [...sels, hit];
      this.st.select(sels);
      if (!sels.includes(hit)) { this.render(); return; }
    } else if (!sels.includes(hit) || this.st.sides) {
      sels = [hit];
      this.st.select(sels);
    }
    this.drag = { kind: 'move', ids: sels, view, u0: u, v0: v, orig: JSON.stringify(this.st.p), started: false, sx: e.clientX, sy: e.clientY };
    this.render();
  }

  private moveEvt(e: PointerEvent) {
    const d = this.drag;
    const [x, y] = this.screenToSheet(e);
    const cv = d && 'view' in d && d.view ? d.view : this.viewAt(x, y);
    if (cv && d?.kind !== 'box') { const [u, v] = this.fromSheet(cv, x, y); this.cursor = { view: cv, u, v }; } else this.cursor = null;
    if (!d) { this.hoverAt(x, y, e.altKey); this.status(); return; }
    if (d.kind === 'pan') {
      this.panX = d.px + e.clientX - d.x0;
      this.panY = d.py + e.clientY - d.y0;
      this.render();
      return;
    }
    if (d.kind === 'box') {
      d.x1 = x; d.y1 = y;
      if (!d.started && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) >= 3) d.started = true;
      if (d.started) this.render();
      return;
    }
    const [u, v] = this.fromSheet(d.view, x, y);
    const free = e.altKey;
    if (d.kind === 'draw') {
      [d.u1, d.v1] = this.snapView(d.view, u, v, this.snapTargets(new Set()), free);
      this.render();
      this.status();
      return;
    }
    if (!d.started) {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return;
      d.started = true;
      this.st.snapshot();
    }
    // start each step from the state at drag start, so snapping never drifts
    const orig = JSON.parse(d.orig);
    const ids = d.kind === 'move' ? d.ids : [d.id];
    const targets = this.snapTargets(new Set(ids));
    this.st.p.stock = orig.stock;
    for (const id of ids) {
      const fo = orig.features.find((f: Feature) => f.id === id);
      const fi = this.st.p.features.findIndex((f) => f.id === id);
      if (fo && fi >= 0) this.st.p.features[fi] = fo;
    }
    const V = VIEWS[d.view];
    if (d.kind === 'edge') {
      const it = itemFor(this.st, d.id);
      if (!it) return;
      const [ua, us] = axisOf(V.uDir), [, vs] = axisOf(V.vDir);
      const raw = d.axis === ua ? us * u : vs * v;
      const sn = this.snap(d.axis, raw, targets, free);
      this.guides = sn.guide ? [{ axis: d.axis, value: sn.value }] : [];
      it.setEdge(d.axis, d.side, sn.value);
    } else {
      // move them all: snap whichever edge (or centre) of the group is closest to a target
      const items = ids.map((id) => itemFor(this.st, id)).filter((x): x is Item => !!x);
      const delta = V.toWorld(u - d.u0, v - d.v0, 0);
      const mn: Vec3 = [Infinity, Infinity, Infinity], mx: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (const it of items) { const [a, b] = it.extents(); for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], a[i]); mx[i] = Math.max(mx[i], b[i]); } }
      this.guides = [];
      for (const axis of [axisOf(V.uDir)[0], axisOf(V.vDir)[0]]) {
        let best: { off: number; dist: number; guide: boolean; value: number } | null = null;
        for (const base of [mn[axis], mx[axis], (mn[axis] + mx[axis]) / 2]) {
          const sn = this.snap(axis, base + delta[axis], targets, free);
          const cand = { off: sn.value - base, dist: sn.guide ? sn.dist - 1e6 : sn.dist, guide: sn.guide, value: sn.value };
          if (!best || cand.dist < best.dist) best = cand;
        }
        if (best) { delta[axis] = best.off; if (best.guide) this.guides.push({ axis, value: best.value }); }
      }
      for (const it of items) it.move(delta);
    }
    this.st.changed();
    this.status();
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    this.guides = [];
    if (!d) return;
    if (d.kind === 'draw') this.finishDraw(d);
    else if (d.kind === 'box') this.finishBox(d);
    else if (d.kind === 'move' && !d.started && !e.shiftKey && this.st.sels.length > 1) {
      // a plain click on one of several selected shapes picks just that one
      const [x, y] = this.screenToSheet(e);
      const [u, v] = this.fromSheet(d.view, x, y);
      const hit = this.pick(d.view, u, v);
      if (hit && hit !== 'stock') this.st.select([hit]);
    } else if (d.kind !== 'pan' && 'started' in d && d.started) { this.relayout(); this.st.changed(); }
    this.setCursor();
    this.render();
  }

  private finishBox(d: Extract<Drag, { kind: 'box' }>) {
    if (!d.started) {
      // just a click: on the part it selects the stock block, off it clears
      if (d.add) return;
      this.st.select(d.onStock ? ['stock'] : []);
      return;
    }
    const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
    const hits = new Set<string>();
    for (const view of this.st.p.views) {
      // the box in this view's coordinates
      const [ua, va] = this.fromSheet(view, x0, y1), [ub, vb] = this.fromSheet(view, x1, y0);
      const rect: [number, number][] = [[ua, va], [ub, va], [ub, vb], [ua, vb]];
      for (const f of this.st.p.features) {
        const poly = this.outline(view, f.id);
        if (poly && touches(poly, rect)) hits.add(f.id);
      }
    }
    const base = d.add ? this.st.sels.filter((id) => id !== 'stock') : [];
    this.st.select([...base, ...hits]);
  }

  private finishDraw(d: Extract<Drag, { kind: 'draw' }>) {
    const w = Math.abs(d.u1 - d.u0), h = Math.abs(d.v1 - d.v0);
    const r = Math.hypot(d.u1 - d.u0, d.v1 - d.v0);
    if ((d.type === 'rect' && (w < 1e-6 || h < 1e-6)) || (d.type === 'circle' && r < 1e-6)) return;
    const f: Feature = {
      id: newId(), type: d.type, view: d.view,
      cu: d.type === 'rect' ? (d.u0 + d.u1) / 2 : d.u0,
      cv: d.type === 'rect' ? (d.v0 + d.v1) / 2 : d.v0,
      w, h, r, corner: 0, d0: 0, d1: 0, op: 'add', through: false,
    };
    // it starts on the nearest surface under it, as a sketch with no depth yet
    f.d0 = f.d1 = round4(this.surfaceAt(d.view, f.cu, f.cv));
    this.st.change((p) => { p.features.push(f); });
    this.st.select([f.id]);
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const r = this.svg.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    // pinch (ctrl) or a mouse wheel zooms; a trackpad scroll pans
    const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY));
    if (e.ctrlKey || e.metaKey || mouseWheel) {
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      const z = Math.max(0.3, Math.min(400, this.zoom * k));
      this.panX = mx - ((mx - this.panX) * z) / this.zoom;
      this.panY = my - ((my - this.panY) * z) / this.zoom;
      this.zoom = z;
    } else {
      this.panX -= e.deltaX;
      this.panY -= e.deltaY;
    }
    this.render();
  }

  // ------------------------------------------------------------ hover + cursor

  private hoverAt(x: number, y: number, alt: boolean) {
    const view = this.viewAt(x, y);
    let h: string | null = null, cur = '';
    if (view && this.st.tool === 'select') {
      const [u, v] = this.fromSheet(view, x, y);
      const hd = this.handleAt(view, u, v);
      if (hd) cur = hd.horiz ? 'ew-resize' : 'ns-resize';
      else if (alt && this.pickSide(view, u, v)) cur = 'pointer';
      else {
        h = this.pick(view, u, v);
        if (h && h !== 'stock' && this.st.sels.includes(h)) cur = 'move';
      }
    } else if (!view && this.ghosts().some((g) => { const b = this.placed[g].box; return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h; })) cur = 'pointer';
    if (h !== this.hover || cur !== this.hoverCursor) { this.hover = h; this.hoverCursor = cur; this.render(); }
  }

  setCursor() {
    let c: string;
    if (this.drag?.kind === 'pan') c = 'grabbing';
    else if (this.spaceDown) c = 'grab';
    else if (this.st.tool !== 'select') c = CURSORS[this.st.tool];
    else c = this.hoverCursor || 'default';
    if (this.svg.style.cursor !== c) this.svg.style.cursor = c;
  }

  // ------------------------------------------------------------ status line

  status() {
    const c = this.cursor;
    const fmt = (mm: number) => fmtLen(mm, this.st.p);
    let t = '';
    if (c) {
      const V = VIEWS[c.view];
      const [ua, us] = axisOf(V.uDir), [va, vs] = axisOf(V.vDir);
      t = `${V.label}   ${'XYZ'[ua]} ${fmt(us * c.u)}   ${'XYZ'[va]} ${fmt(vs * c.v)}`;
    }
    const d = this.drag;
    if (d && d.kind === 'draw') {
      t += d.type === 'rect'
        ? `     ${fmt(Math.abs(d.u1 - d.u0))} × ${fmt(Math.abs(d.v1 - d.v0))}`
        : `     Ø ${fmt(2 * Math.hypot(d.u1 - d.u0, d.v1 - d.v0))}`;
    }
    this.onStatus(t);
  }

  // ------------------------------------------------------------ drawing

  private hideBox(v: ViewName): Box2 {
    const b = this.placed[v].box;
    const fs = 12 / this.zoom;
    return { x: b.x + b.w - fs * 1.2, y: b.y + b.h + fs * 0.2, w: fs * 1.2, h: fs * 1.3 };
  }

  render() {
    if (!this.placed) return;
    const z = this.zoom;
    const px = (n: number) => n / z;                 // screen px -> sheet mm
    const st = this.st, p = st.p;
    const parts: string[] = [];
    const built = st.built;
    const path = (view: ViewName, pts: [number, number][] | number[], closed = false) => {
      let s = '';
      if (pts.length && Array.isArray(pts[0])) {
        (pts as [number, number][]).forEach(([u, v], i) => { const [x, y] = this.toSheet(view, u, v); s += `${i ? 'L' : 'M'}${x.toFixed(3)} ${y.toFixed(3)}`; });
      } else {
        const a = pts as number[];
        for (let k = 0; k < a.length; k += 2) { const [x, y] = this.toSheet(view, a[k], a[k + 1]); s += `${k ? 'L' : 'M'}${x.toFixed(3)} ${y.toFixed(3)}`; }
      }
      return closed ? `${s}Z` : s;
    };

    // ghost boxes
    for (const g of this.ghosts()) {
      const b = this.placed[g].box;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2, r = Math.min(b.w, b.h) * 0.14;
      parts.push(`<g class="ds-ghost"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${Math.min(px(14), b.w / 6)}" stroke-dasharray="5 5"/>`
        + `<path d="M${cx - r} ${cy - r * 0.4}H${cx + r}M${cx} ${cy - r * 1.4}V${cy + r * 0.6}"/>`
        + `<text x="${cx}" y="${cy + r * 0.6 + px(16)}" font-size="${px(11)}">${VIEWS[g].label}</text></g>`);
    }

    // guides: faint lines right across the sheet, through every aligned view
    const all = Object.values(this.placed).map((q) => q.box);
    const sx0 = Math.min(...all.map((b) => b.x)) - 200, sx1 = Math.max(...all.map((b) => b.x + b.w)) + 200;
    const sy0 = Math.min(...all.map((b) => b.y)) - 200, sy1 = Math.max(...all.map((b) => b.y + b.h)) + 200;
    for (const g of this.guides) {
      for (const v of p.views) {
        const V = VIEWS[v];
        const [ua, us] = axisOf(V.uDir), [va, vs] = axisOf(V.vDir);
        if (ua === g.axis) { const [x] = this.toSheet(v, us * g.value, 0); parts.push(`<line class="ds-guide" x1="${x}" y1="${sy0}" x2="${x}" y2="${sy1}"/>`); }
        if (va === g.axis) { const [, y] = this.toSheet(v, 0, vs * g.value); parts.push(`<line class="ds-guide" x1="${sx0}" y1="${y}" x2="${sx1}" y2="${y}"/>`); }
      }
    }

    const selected = new Set(st.sels);
    for (const view of p.views) {
      const b = this.placed[view].box;
      parts.push(`<rect class="ds-viewbox" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`);
      const ve = built?.views[view];
      if (ve) {
        if (ve.hidden.length) parts.push(`<path class="ds-hidden" stroke-dasharray="6 4" d="${ve.hidden.map((l) => path(view, l)).join('')}"/>`);
        parts.push(`<path class="ds-visible" d="${ve.visible.map((l) => path(view, l)).join('')}"/>`);
      }
      // features that aren't plain geometry: sketches, ones that do nothing, ones that failed
      for (const f of p.features) {
        const poly = this.outline(view, f.id);
        if (!poly) continue;
        const sketch = Math.abs(f.d0 - f.d1) < 1e-9 && !(f.op === 'cut' && f.through);
        let cls = '';
        if (built?.errors[f.id]) cls = 'ds-error';
        else if (sketch) cls = 'ds-sketch';
        else if (built && built.effect[f.id] === false) cls = 'ds-faded';
        if (f.id === this.hover && !selected.has(f.id)) cls += ' ds-hover';
        if (cls) parts.push(`<path class="ds-feat ${cls}" d="${path(view, poly, true)}"/>`);
      }
      if (this.hover === 'stock' && !selected.has('stock') && !this.drag) {
        const poly = this.outline(view, 'stock');
        if (poly) parts.push(`<path class="ds-feat ds-hover" d="${path(view, poly, true)}"/>`);
      }
      const fs = px(12);
      parts.push(`<text class="ds-label${view === st.activeView ? ' ds-active' : ''}" x="${b.x + b.w / 2}" y="${b.y + b.h + fs * 1.3}" font-size="${fs}">${VIEWS[view].label.toUpperCase()}</text>`);
      if (p.views.length > 1) {
        const hb = this.hideBox(view);
        parts.push(`<text class="ds-hide" x="${hb.x + hb.w / 2}" y="${hb.y + hb.h * 0.8}" font-size="${fs}"><title>Hide this view</title>×</text>`);
      }
    }

    // the selection, in every view; handles when it's just one thing
    const sideSel = st.sides;
    for (const id of st.sels) {
      for (const view of p.views) {
        const poly = this.outline(view, id);
        if (!poly) continue;
        parts.push(`<path class="ds-feat ${sideSel ? 'ds-selected-soft' : 'ds-selected'}" d="${path(view, poly, true)}"/>`);
        if (st.one && !sideSel) {
          for (const h of this.handles(view, id)) {
            const [x, y] = this.toSheet(view, h.u, h.v);
            const s = px(HANDLE_PX);
            parts.push(`<rect class="ds-handle" x="${x - s}" y="${y - s}" width="${2 * s}" height="${2 * s}"/>`);
          }
        }
      }
    }
    // picked sides, and the corner two of them share
    if (sideSel) {
      const f = st.feature(sideSel.id);
      if (f) {
        for (const view of p.views) {
          if (!parallel(f.view, view)) continue;
          const segs = this.sideSegs(f, view);
          for (const k of sideSel.sides) parts.push(`<path class="ds-side" d="${path(view, segs[k])}"/>`);
          const c = sideSel.sides.length === 2 ? sharedCorner(sideSel.sides[0], sideSel.sides[1]) : -1;
          if (c >= 0) {
            const hw = f.w / 2, hh = f.h / 2;
            const cu = f.cu + (c === 1 || c === 2 ? hw : -hw), cv = f.cv + (c >= 2 ? hh : -hh);
            const [x, y] = this.toSheet(view, ...this.featToView(f, view, cu, cv));
            parts.push(`<circle class="ds-corner" cx="${x}" cy="${y}" r="${px(5)}"/>`);
          }
        }
      }
    }

    // the shape being drawn, the selection box
    const d = this.drag;
    if (d && d.kind === 'draw') {
      let poly: [number, number][];
      if (d.type === 'rect') poly = [[d.u0, d.v0], [d.u1, d.v0], [d.u1, d.v1], [d.u0, d.v1]];
      else {
        const r = Math.hypot(d.u1 - d.u0, d.v1 - d.v0);
        poly = Array.from({ length: 64 }, (_, i) => [d.u0 + r * Math.cos((i / 64) * 2 * Math.PI), d.v0 + r * Math.sin((i / 64) * 2 * Math.PI)] as [number, number]);
      }
      parts.push(`<path class="ds-feat ds-drawing" d="${path(d.view, poly, true)}"/>`);
    }
    if (d && d.kind === 'box' && d.started) {
      parts.push(`<rect class="ds-marquee" x="${Math.min(d.x0, d.x1)}" y="${Math.min(d.y0, d.y1)}" width="${Math.abs(d.x1 - d.x0)}" height="${Math.abs(d.y1 - d.y0)}"/>`);
    }

    this.svg.innerHTML = `<g transform="matrix(${z} 0 0 ${z} ${this.panX} ${this.panY})">${parts.join('')}</g>`;
    this.setCursor();
  }
}

// ------------------------------------------------------------ helpers

export function isTyping(): boolean {
  const a = document.activeElement;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a as HTMLElement).isContentEditable);
}

export function fmtLen(mm: number, p: { units: 'mm' | 'in'; precision: number }): string {
  const v = p.units === 'in' ? mm / 25.4 : mm;
  return `${(Math.abs(v) < 0.5 * 10 ** -p.precision ? 0 : v).toFixed(p.precision)}${p.units === 'in' ? '"' : ''}`;
}

function round4(n: number) { return Math.round(n * 1e4) / 1e4; }

function pointInPoly(poly: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polyDist(poly: [number, number][], x: number, y: number, closed = true): number {
  let best = Infinity;
  const n = poly.length;
  for (let i = closed ? 0 : 1; i < n; i++) {
    const [x0, y0] = poly[i === 0 ? n - 1 : i - 1], [x1, y1] = poly[i];
    const dx = x1 - x0, dy = y1 - y0, L = dx * dx + dy * dy;
    const t = L > 0 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)));
  }
  return best;
}

function polyArea(poly: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a / 2);
}

/** Does a shape's outline touch a selection rectangle (inside it, around it, or crossing it)? */
function touches(poly: [number, number][], rect: [number, number][]): boolean {
  const xs = rect.map((p) => p[0]), ys = rect.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (poly.some(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)) return true;
  if (rect.some(([x, y]) => pointInPoly(poly, x, y))) return true;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    for (let j = 0; j < 4; j++) if (segsCross(a, b, rect[j], rect[(j + 1) % 4])) return true;
  }
  return false;
}

function segsCross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const o = (p: [number, number], q: [number, number], r: [number, number]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
