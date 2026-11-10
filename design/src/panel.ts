// The properties panel: whatever is selected (or the project when nothing is).

import type { Dim, Feature, Vec3 } from './model.js';
import { cornerRadii, depthRange, sharedCorner, verts, into, isShape, bounds2d, dot, boxCorners } from './model.js';
import { pitchRadius, outerRadius } from './gears.js';
import { VIEWS, axisOf } from './views.js';
import type { State } from './state.js';

const AX = 'XYZ';

export interface PanelHooks {
  gear(id: string): void;                       // open the gear dialog
  dimValue(dm: Dim): number | null;
  dimSize(dm: Dim, size: number): void;
}

const NAMES: Record<string, string> = {
  rect: 'Rectangle', circle: 'Circle', polygon: 'Polygon', poly: 'Outline', gear: 'Gear', text: 'Text', fillet: 'Fillet',
};

export function featureName(f: Feature): string {
  if (f.type === 'rect' && (f.corner > 0 || f.corners?.some((c) => c > 0))) return 'Rounded rectangle';
  if (f.type === 'polygon') return `${f.sides || 6}-sided polygon`;
  if (f.type === 'gear' && f.gear) return `${f.gear.teeth}T ${({ spur: 'spur gear', helical: 'helical gear', ring: 'ring gear', rack: 'rack' })[f.gear.kind]}`;
  if (f.type === 'text' && f.text) return `Text “${f.text.s}”`;
  if (f.type === 'fillet' && f.fillet) return `${f.fillet.mode === 'fillet' ? 'Fillet' : 'Chamfer'} ${f.fillet.size} mm × ${f.fillet.edges.length} edge${f.fillet.edges.length === 1 ? '' : 's'}`;
  return NAMES[f.type] || f.type;
}

export class Panel {
  constructor(private el: HTMLElement, private st: State, private hooks: PanelHooks) {
    st.on((w) => {
      // a finished build mustn't pull the rug from under a field being typed in
      if (w === 'built' && this.el.contains(document.activeElement)) return;
      if (w !== 'built' || this.st.sels.length || this.st.tool === 'edge') this.render();
    });
    this.render();
  }

  private toUnits(mm: number) { return this.st.p.units === 'in' ? mm / 25.4 : mm; }
  private fromUnits(v: number) { return this.st.p.units === 'in' ? v * 25.4 : v; }

  /** A number field in the project's units, writing back through set(). */
  private num(label: string, mm: number, set: (mm: number) => void, opts: { min?: number; max?: number; title?: string; raw?: boolean; unit?: string; step?: number } = {}): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'ds-field';
    if (opts.title) wrap.title = opts.title;
    const span = document.createElement('span');
    span.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = opts.step ? String(opts.step) : 'any';
    const shown = opts.raw ? mm : this.toUnits(mm);
    inp.value = String(+shown.toFixed(opts.raw ? 4 : this.st.p.precision + 2));
    const unit = document.createElement('i');
    unit.textContent = opts.unit ?? (opts.raw ? '' : this.st.p.units);
    const commit = () => {
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v)) return;
      let mmv = opts.raw ? v : this.fromUnits(v);
      if (opts.min !== undefined) mmv = Math.max(opts.min, mmv);
      if (opts.max !== undefined) mmv = Math.min(opts.max, mmv);
      this.st.change(() => set(mmv));
    };
    inp.addEventListener('change', commit);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { inp.blur(); } e.stopPropagation(); });
    wrap.append(span, inp, unit);
    return wrap;
  }

  private seg(options: [string, string][], value: string, set: (v: string) => void): HTMLElement {
    const d = document.createElement('div');
    d.className = 'ds-seg';
    for (const [v, label] of options) {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = v === value ? 'active' : '';
      b.onclick = () => { if (v !== value) set(v); };
      d.appendChild(b);
    }
    return d;
  }

  private check(label: string, on: boolean, set: (on: boolean) => void, title = ''): HTMLElement {
    const lab = document.createElement('label');
    lab.className = 'ds-check';
    if (title) lab.title = title;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = on;
    cb.onchange = () => this.st.change(() => set(cb.checked));
    lab.append(cb, document.createTextNode(` ${label}`));
    return lab;
  }

  private button(label: string, fn: () => void, cls = 'btn ghost sm ds-del'): HTMLElement {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.onclick = fn;
    return b;
  }

  private h(text: string, cls = 'ds-h'): HTMLElement { const e = document.createElement('div'); e.className = cls; e.textContent = text; return e; }

  render() {
    const st = this.st;
    const out: HTMLElement[] = [];
    const sel = st.one;
    const none = st.sels.length === 0;
    const dm = sel ? st.dim(sel) : undefined;
    if (st.tool === 'edge') {
      out.push(...this.edgeHelp());
    } else if (dm) {
      out.push(...this.dimension(dm));
    } else if (st.sides) {
      const f = st.feature(st.sides.id);
      if (f) out.push(...this.sides(f, st.sides.sides));
    } else if (st.sels.filter((id) => id !== 'stock').length > 1 || (st.sels.length > 1 && !st.sels.includes('stock'))) {
      out.push(...this.many());
    } else if (sel === 'stock' || none || st.sels.includes('stock')) {
      out.push(...this.body(none));
    } else {
      const f = st.feature(sel);
      if (f) out.push(...(f.type === 'fillet' ? this.fillet(f) : this.feature(f)));
    }
    this.el.replaceChildren(...out);
  }

  private body(none: boolean): HTMLElement[] {
    const st = this.st;
    const s = st.p.stock;
    const out: HTMLElement[] = [this.h('Body')];
    if (none) out.push(this.h('Nothing selected. Draw on a view, or click a shape.', 'ds-note'));
    out.push(this.check('Start from a block', !s.off, (on) => { s.off = !on; },
      'Off: no block, the shapes you add stand on their own (a gear, say). Cuts then only cut those shapes.'));
    if (!s.off) {
      out.push(this.num('Width (X)', s.max[0] - s.min[0], (v) => { const c = (s.min[0] + s.max[0]) / 2; s.min[0] = c - v / 2; s.max[0] = c + v / 2; }, { min: 0.1 }));
      out.push(this.num('Depth (Y)', s.max[1] - s.min[1], (v) => { const c = (s.min[1] + s.max[1]) / 2; s.min[1] = c - v / 2; s.max[1] = c + v / 2; }, { min: 0.1 }));
      out.push(this.num('Height (Z)', s.max[2] - s.min[2], (v) => { s.max[2] = s.min[2] + v; }, { min: 0.1 }));
    }
    if (!none) return out;
    out.push(...this.history());
    out.push(this.h('Sheet'));
    out.push(this.labelled('Units', this.seg([['mm', 'mm'], ['in', 'inch']], st.p.units, (v) => st.change((p) => {
      p.units = v as 'mm' | 'in';
      // a sensible grid for the units, unless it was changed by hand
      if (v === 'in' && p.grid === 1) p.grid = 1.27;
      if (v === 'mm' && Math.abs(p.grid - 1.27) < 1e-9) p.grid = 1;
    }))));
    out.push(this.num('Grid snap', st.p.grid, (v) => { st.p.grid = v; }, { min: 0, title: 'Snap increment (0 = off). Hold Option while dragging to place freely.' }));
    out.push(this.num('Decimals', st.p.precision, (v) => { st.p.precision = Math.round(Math.max(0, Math.min(4, v))); }, { raw: true }));
    out.push(this.h('Tips', 'ds-h'));
    out.push(this.h('V select · R rectangle · C circle · P polygon · L line (click corners, click the first to close) · G gear · T text · E edges (fillet/chamfer) · D dimension (double-click its number to type a size) · H draw on the far face (hidden lines) · Z zoom · Shift-click or drag a box to select several · Option-click a side, Option-Shift-click the side next to it for their corner · Delete removes · ⌘Z undo · F fit · Space-drag or right-drag to pan · pinch or ⌘-scroll to zoom · hold Option while dragging for no snapping', 'ds-note'));
    return out;
  }

  /** Everything in the project, in the order it's built: click one to select it. */
  private history(): HTMLElement[] {
    const st = this.st;
    if (!st.p.features.length) return [];
    const list = document.createElement('div');
    list.className = 'ds-list';
    st.p.features.forEach((f, i) => {
      const b = document.createElement('button');
      const err = st.built?.errors[f.id];
      b.className = err ? 'ds-err' : '';
      const op = f.type === 'fillet' ? '◠' : f.op === 'cut' ? '▼' : '▲';
      b.textContent = `${i + 1}. ${op} ${featureName(f)}${f.far ? ' (far face)' : ''}${f.pattern || f.mirror ? ' ⧉' : ''}`;
      b.title = err || '';
      b.onclick = () => { if (st.tool === 'edge') st.setTool('select'); st.select([f.id]); };
      list.appendChild(b);
    });
    return [this.h('Features'), list];
  }

  private labelled(label: string, child: HTMLElement): HTMLElement {
    const w = document.createElement('div');
    w.className = 'ds-field';
    const s = document.createElement('span');
    s.textContent = label;
    w.append(s, child);
    return w;
  }

  /** Corner radius: one field for all corners, or one per corner once they differ. */
  private cornerFields(f: Feature): HTMLElement[] {
    const r = cornerRadii(f);
    if (!r.length) return [];
    const out: HTMLElement[] = [];
    const lim = f.type === 'rect' ? Math.min(f.w, f.h) / 2 : Infinity;
    if (r.every((x) => Math.abs(x - r[0]) < 1e-9)) {
      out.push(this.num('Corner radius', r[0], (v) => { f.corner = Math.min(v, lim); delete f.corners; }, { min: 0, title: 'Every corner. Option-click two sides that meet to round just their corner.' }));
    } else {
      const names = this.cornerNames(f);
      r.forEach((x, i) => out.push(this.num(`${names[i]} corner`, x, (v) => { const c = [...cornerRadii(f)]; c[i] = Math.min(v, lim); f.corners = c; }, { min: 0 })));
      out.push(this.button('Make all corners the same', () => this.st.change(() => { f.corner = Math.max(...r); delete f.corners; }), 'btn ghost sm'));
    }
    return out;
  }

  /** Corner names as the drawing view sees them, e.g. "Bottom left". */
  private cornerNames(f: Feature): string[] {
    if (f.type === 'rect') return ['Bottom left', 'Bottom right', 'Top right', 'Top left'];
    return (verts(f) || []).map((_, i) => `Corner ${i + 1}`);
  }

  private sides(f: Feature, sides: number[]): HTMLElement[] {
    const st = this.st;
    const out: HTMLElement[] = [];
    const rect = f.type === 'rect';
    const n = (verts(f) || []).length;
    const sideNames = rect ? ['Bottom', 'Right', 'Top', 'Left'] : Array.from({ length: n }, (_, i) => `Side ${i + 1}`);
    const V = VIEWS[f.view];
    const [ua] = axisOf(V.uDir), [va] = axisOf(V.vDir);
    if (sides.length === 1) {
      const k = sides[0];
      out.push(this.h(`${sideNames[k]} side of ${rect ? 'a rectangle' : `a ${featureName(f).toLowerCase()}`}`));
      if (rect) {
        const horiz = k === 0 || k === 2;
        out.push(this.num(`Length (${AX[horiz ? ua : va]})`, horiz ? f.w : f.h, (v) => { if (horiz) f.w = v; else f.h = v; }, { min: 0 }));
      } else {
        const vs = verts(f)!, a = vs[k], b = vs[(k + 1) % n];
        out.push(this.h(`Length ${(this.toUnits(Math.hypot(b[0] - a[0], b[1] - a[1]))).toFixed(st.p.precision)} ${st.p.units}`, 'ds-note'));
      }
      out.push(this.h('Option-Shift-click a side next to this one to pick the corner they share.', 'ds-note'));
    } else {
      const c = sharedCorner(sides[0], sides[1], n);
      if (c < 0) {
        out.push(this.h('Sides that don’t meet', 'ds-h'));
        out.push(this.h("These two sides don't meet, so they have no corner. Option-Shift-click one to drop it, then pick a side next to the other.", 'ds-note'));
      } else {
        const names = this.cornerNames(f);
        out.push(this.h(`${names[c]} corner`));
        const lim = rect ? Math.min(f.w, f.h) / 2 : Infinity;
        out.push(this.num('Corner radius', cornerRadii(f)[c], (v) => {
          const r = [...cornerRadii(f)];
          r[c] = Math.min(v, lim);
          f.corners = r;
        }, { min: 0, title: rect ? `Up to ${lim.toFixed(2)} mm (half the shorter side)` : 'Limited so the rounds fit on their sides' }));
      }
    }
    out.push(this.button('Select the whole shape', () => st.select([f.id])));
    return out;
  }

  private many(): HTMLElement[] {
    const st = this.st;
    const feats = st.sels.map((id) => st.feature(id)).filter((f): f is Feature => !!f && isShape(f));
    const out: HTMLElement[] = [this.h(`${st.sels.length} things selected`)];
    const ops = new Set(feats.map((f) => f.op));
    if (feats.length) {
      out.push(this.labelled('Operation', this.seg([['add', 'Add ▲'], ['cut', 'Cut ▼']], ops.size === 1 ? [...ops][0] : '', (v) => st.change(() => {
        for (const f of feats) setOp(f, v as 'add' | 'cut');
      }))));
    }
    out.push(this.h('Line them up with the align buttons in the bar above. Left, right, top and bottom are as the highlighted view sees them; click in a view to make it the one.', 'ds-note'));
    out.push(this.button(`Delete ${st.sels.filter((id) => id !== 'stock').length} things`, () => st.deleteSelected()));
    return out;
  }

  private feature(f: Feature): HTMLElement[] {
    const st = this.st;
    const V = VIEWS[f.view];
    const [ua, us] = axisOf(V.uDir), [va, vs] = axisOf(V.vDir), [da, ds] = axisOf(V.eye);
    const out: HTMLElement[] = [];
    const sketch = Math.abs(f.d0 - f.d1) < 1e-9 && !(f.op === 'cut' && f.through);
    out.push(this.h(`${featureName(f)} · drawn on ${V.label.toLowerCase()}${f.far ? ' (far face)' : ''}`));
    const err = st.built?.errors[f.id];
    if (err) out.push(this.h(`Couldn't build this shape: ${err}`, 'ds-note ds-err'));
    else if (sketch) out.push(this.h('A sketch with no depth yet: give it a depth below, or drag its line in a side view.', 'ds-note ds-sk'));
    else if (st.built && st.built.effect[f.id] === false) out.push(this.h(f.op === 'add' ? 'Buried in solid material, so it changes nothing (shown faded).' : 'Cuts only empty space, so it changes nothing (shown faded).', 'ds-note'));

    out.push(this.labelled('Operation', this.seg([['add', 'Add ▲'], ['cut', 'Cut ▼']], f.op, (v) => st.change(() => setOp(f, v as 'add' | 'cut')))));

    if (f.type === 'gear' && f.gear) out.push(...this.gearSummary(f));
    if (f.type === 'text' && f.text) out.push(...this.textFields(f));

    out.push(this.h('Position'));
    out.push(this.num(`Centre ${AX[ua]}`, us * f.cu, (v) => { f.cu = us * v; }));
    out.push(this.num(`Centre ${AX[va]}`, vs * f.cv, (v) => { f.cv = vs * v; }));
    if (f.type === 'polygon' || f.type === 'gear' || f.type === 'text') {
      out.push(this.num('Turned', f.rot || 0, (v) => { f.rot = v; }, { raw: true, unit: '°', title: 'Degrees, anticlockwise as the drawing view sees it' }));
    }

    if (f.type !== 'gear' && f.type !== 'text') {
      out.push(this.h('Size'));
      if (f.type === 'circle') {
        out.push(this.num('Diameter', 2 * f.r, (v) => { f.r = v / 2; }, { min: 0 }));
      } else if (f.type === 'polygon') {
        const n = Math.max(3, Math.round(f.sides || 6));
        out.push(this.num('Sides', n, (v) => { f.sides = Math.round(Math.max(3, Math.min(64, v))); st.polygonSides = f.sides; delete f.corners; }, { raw: true, step: 1 }));
        out.push(this.num('Across corners', 2 * f.r, (v) => { f.r = v / 2; }, { min: 0 }));
        out.push(this.num('Across flats', 2 * f.r * Math.cos(Math.PI / n), (v) => { f.r = v / 2 / Math.cos(Math.PI / n); }, { min: 0, title: 'What a spanner measures (even sides)' }));
        out.push(...this.cornerFields(f));
      } else if (f.type === 'poly') {
        const [u0, v0, u1, v1] = bounds2d(f);
        const scale = (k: 0 | 1, size: number) => {
          const old = k === 0 ? u1 - u0 : v1 - v0;
          if (old < 1e-9 || !f.pts) return;
          const lo = k === 0 ? u0 : v0, c = k === 0 ? f.cu : f.cv;
          f.pts = f.pts.map((p) => { const q = [...p] as [number, number]; q[k] = lo + (c + p[k] - lo) * (size / old) - c; return q; });
        };
        out.push(this.num(`Width (${AX[ua]})`, u1 - u0, (v) => scale(0, v), { min: 0.01 }));
        out.push(this.num(`Height (${AX[va]})`, v1 - v0, (v) => scale(1, v), { min: 0.01 }));
        out.push(...this.cornerFields(f));
      } else {
        out.push(this.num(`Width (${AX[ua]})`, f.w, (v) => { f.w = v; }, { min: 0 }));
        out.push(this.num(`Height (${AX[va]})`, f.h, (v) => { f.h = v; }, { min: 0 }));
        out.push(...this.cornerFields(f));
      }
    }

    out.push(this.h('Depth'));
    out.push(this.num(`Starts at ${AX[da]}`, ds * f.d0, (v) => { const dep = f.d1 - f.d0; f.d0 = ds * v; f.d1 = f.d0 + dep; },
      { title: f.far ? 'The far face the shape sits on, seen through the part.' : 'The face the shape sits on. It starts on the nearest surface under it.' }));
    const throughCut = f.op === 'cut' && f.through;
    if (!throughCut) {
      out.push(this.num('Depth', Math.abs(f.d1 - f.d0), (v) => { f.d1 = f.d0 + dirOf(f) * v; }, { min: 0 }));
      out.push(this.num(`Ends at ${AX[da]}`, ds * f.d1, (v) => { f.d1 = ds * v; }));
    } else {
      const [lo, hi] = depthRange(f, st.p);
      out.push(this.h(`Runs right through the part (to ${AX[da]} ${(this.toUnits(ds * (f.far ? hi : lo))).toFixed(st.p.precision)}).`, 'ds-note'));
    }
    if (f.op === 'cut') {
      out.push(this.check('Through all', f.through, (on) => { f.through = on; if (!on && Math.abs(f.d1 - f.d0) < 1e-9) f.d1 = f.d0 + into(f); }));
    }
    if (!st.p.stock.off) {
      out.push(this.check('On the far face (hidden)', !!f.far, (on) => {
        // move it onto the other face of the body, keeping its depth
        const dep = Math.abs(f.d1 - f.d0);
        f.far = on;
        const ds2 = boxCorners(st.p.stock.min, st.p.stock.max).map((c) => dot(c, V.eye));
        f.d0 = on ? Math.min(...ds2) : Math.max(...ds2);
        f.d1 = f.d0 + dirOf(f) * dep;
      }, 'Drawn on the back of the part, seen through it: shows as hidden (dashed) lines in this view'));
    }

    out.push(...this.copies(f));
    out.push(this.button('Delete shape', () => st.deleteSelected()));
    return out;
  }

  private gearSummary(f: Feature): HTMLElement[] {
    const g = f.gear!;
    const st = this.st;
    const fmt = (mm: number) => `${this.toUnits(mm).toFixed(st.p.precision)} ${st.p.units}`;
    const pitch = g.pitch === 'dp' ? `DP ${+(25.4 / g.module).toFixed(3)}` : `module ${+g.module.toFixed(3)}`;
    const lines = [
      `${g.teeth} teeth, ${pitch}, ${g.pa}° pressure angle${g.kind === 'helical' ? `, ${g.helix}° helix` : ''}`,
      g.kind === 'rack' ? `Length ${fmt(g.teeth * Math.PI * g.module)}` : `Pitch Ø ${fmt(2 * pitchRadius(g))} · outside Ø ${fmt(2 * outerRadius(g))}`,
      g.bore === 'none' ? 'No bore' : `${g.bore === 'd' ? 'D-shaft' : 'Round'} bore Ø ${fmt(g.boreD)}${g.screw > 0 ? `, set screw Ø ${fmt(g.screw)}` : ''}`,
    ];
    return [this.h('Gear'), ...lines.map((l) => this.h(l, 'ds-note')), this.button('Edit gear…', () => this.hooks.gear(f.id), 'btn sm')];
  }

  private textFields(f: Feature): HTMLElement[] {
    const t = f.text!;
    const st = this.st;
    const wrap = document.createElement('label');
    wrap.className = 'ds-field ds-text';
    const span = document.createElement('span');
    span.textContent = 'Text';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.id = 'ds-text-input';
    inp.value = t.s;
    inp.addEventListener('change', () => { if (inp.value.trim()) st.change(() => { t.s = inp.value; }); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); });
    wrap.append(span, inp);
    return [
      this.h('Text'), wrap,
      this.num('Height', t.size, (v) => { t.size = v; }, { min: 0.5, title: 'Letter height (capitals)' }),
      this.check('Bold', t.bold, (on) => { t.bold = on; }),
    ];
  }

  /** Pattern and mirror: copies made from this shape. */
  private copies(f: Feature): HTMLElement[] {
    const st = this.st;
    const V = VIEWS[f.view];
    const s = st.p.stock;
    const mid: Vec3 = [0, 1, 2].map((i) => (s.min[i] + s.max[i]) / 2) as Vec3;
    const out: HTMLElement[] = [this.h('Copies')];
    const kind = f.pattern ? f.pattern.kind : 'none';
    out.push(this.labelled('Pattern', this.seg([['none', 'None'], ['linear', 'Row'], ['circular', 'Circle']], kind, (v) => st.change(() => {
      if (v === 'none') { delete f.pattern; return; }
      const [u0, , u1] = bounds2d(f);
      const gap = Math.max(1, Math.round((u1 - u0) * 1.5));
      const q = V.toView(mid);
      const c = V.toWorld(q[0], q[1], f.d0);
      f.pattern = { kind: v as 'linear' | 'circular', count: v === 'linear' ? 3 : 6, step: [V.uDir[0] * gap, V.uDir[1] * gap, V.uDir[2] * gap], center: c, axis: [...V.eye] as Vec3, angle: 360 };
    }))));
    const pt = f.pattern;
    if (pt) {
      out.push(this.num('Count', pt.count, (v) => { pt.count = Math.round(Math.max(1, Math.min(200, v))); }, { raw: true, step: 1, title: 'How many in all, the shape itself included' }));
      if (pt.kind === 'linear') {
        for (let i = 0; i < 3; i++) out.push(this.num(`Step ${AX[i]}`, pt.step[i], (v) => { pt.step[i] = v; }));
      } else {
        const [ua] = axisOf(V.uDir), [va] = axisOf(V.vDir);
        out.push(this.num(`Centre ${AX[ua]}`, pt.center[ua], (v) => { pt.center[ua] = v; }, { title: 'The point they go round' }));
        out.push(this.num(`Centre ${AX[va]}`, pt.center[va], (v) => { pt.center[va] = v; }));
        out.push(this.num('Angle', pt.angle, (v) => { pt.angle = v; }, { raw: true, unit: '°', title: '360 = evenly all the way round; less spreads them from the first to the last' }));
        out.push(this.button('Centre on the body', () => st.change(() => { pt.center[ua] = mid[ua]; pt.center[va] = mid[va]; }), 'btn ghost sm'));
      }
    }
    const mAxis = f.mirror ? String(f.mirror.axis) : 'none';
    out.push(this.labelled('Mirror', this.seg([['none', 'None'], ['0', 'X'], ['1', 'Y'], ['2', 'Z']], mAxis, (v) => st.change(() => {
      if (v === 'none') { delete f.mirror; return; }
      const a = +v as 0 | 1 | 2;
      f.mirror = { axis: a, at: mid[a] };
    }))));
    if (f.mirror) {
      const m = f.mirror;
      out.push(this.num(`Across ${AX[m.axis]} =`, m.at, (v) => { m.at = v; }, { title: 'The mirror plane. Starts at the middle of the body.' }));
    }
    return out;
  }

  private fillet(f: Feature): HTMLElement[] {
    const st = this.st;
    const fl = f.fillet!;
    const out: HTMLElement[] = [this.h(featureName(f))];
    const err = st.built?.errors[f.id];
    if (err) out.push(this.h(`Couldn't round these edges: ${err}. Try a smaller size.`, 'ds-note ds-err'));
    else if (st.built && st.built.effect[f.id] === false) out.push(this.h('None of its edges are on the part any more, so it does nothing.', 'ds-note'));
    out.push(this.labelled('Kind', this.seg([['fillet', 'Fillet'], ['chamfer', 'Chamfer']], fl.mode, (v) => st.change(() => { fl.mode = v as 'fillet' | 'chamfer'; }))));
    out.push(this.num(fl.mode === 'fillet' ? 'Radius' : 'Size', fl.size, (v) => { fl.size = v; }, { min: 0.01 }));
    out.push(this.h('To change which edges, delete this and pick them again with the edge tool (E).', 'ds-note'));
    out.push(this.button('Delete', () => st.deleteSelected()));
    return out;
  }

  private edgeHelp(): HTMLElement[] {
    const n = this.st.edges.length;
    return [
      this.h('Edges'),
      this.h(n ? `${n} edge${n === 1 ? '' : 's'} picked. Set the size in the bar above and press Apply.` : 'Click an edge in any view to round or bevel it; Shift-click for more. Visible edges come before hidden ones behind them.', 'ds-note'),
      ...this.history(),
    ];
  }

  private dimension(dm: Dim): HTMLElement[] {
    const st = this.st;
    const value = this.hooks.dimValue(dm);
    const out: HTMLElement[] = [this.h(`Dimension · ${VIEWS[dm.view].label.toLowerCase()} view`)];
    if (value !== null) {
      out.push(this.num(dm.axis === 'dia' ? 'Diameter' : 'Size', value, (v) => this.hooks.dimSize(dm, v), { min: 0.01, title: 'Type a size: the shape changes to match (its left or bottom stays put)' }));
    }
    out.push(this.h('Double-click its number on the sheet to type a size there. Drag it to move it further out.', 'ds-note'));
    out.push(this.button('Delete dimension', () => st.deleteSelected()));
    return out;
  }
}

/** Which way the finish end goes from the start: into the material for a cut, out of it for an add. */
function dirOf(f: Feature): number { return f.op === 'cut' ? into(f) : -into(f); }

function setOp(f: Feature, op: 'add' | 'cut') {
  if (f.op === op) return;
  const depth = Math.abs(f.d1 - f.d0);
  f.op = op;
  f.d1 = f.d0 + dirOf(f) * depth;
}
