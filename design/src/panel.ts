// The properties panel: whatever is selected (or the project when nothing is).

import type { Feature } from './model.js';
import { cornerRadii, depthRange, sharedCorner } from './model.js';
import { VIEWS, axisOf } from './views.js';
import type { State } from './state.js';

const AX = 'XYZ';

export class Panel {
  constructor(private el: HTMLElement, private st: State) {
    st.on((w) => { if (w !== 'built' || this.st.sels.length) this.render(); });
    this.render();
  }

  private toUnits(mm: number) { return this.st.p.units === 'in' ? mm / 25.4 : mm; }
  private fromUnits(v: number) { return this.st.p.units === 'in' ? v * 25.4 : v; }

  /** A number field in the project's units, writing back through set(). */
  private num(label: string, mm: number, set: (mm: number) => void, opts: { min?: number; title?: string; raw?: boolean } = {}): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'ds-field';
    if (opts.title) wrap.title = opts.title;
    const span = document.createElement('span');
    span.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = 'any';
    const shown = opts.raw ? mm : this.toUnits(mm);
    inp.value = String(+shown.toFixed(opts.raw ? 4 : this.st.p.precision + 2));
    const unit = document.createElement('i');
    unit.textContent = opts.raw ? '' : this.st.p.units;
    const commit = () => {
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v)) return;
      let mmv = opts.raw ? v : this.fromUnits(v);
      if (opts.min !== undefined) mmv = Math.max(opts.min, mmv);
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

  private h(text: string, cls = 'ds-h'): HTMLElement { const e = document.createElement('div'); e.className = cls; e.textContent = text; return e; }

  render() {
    const st = this.st;
    const out: HTMLElement[] = [];
    const sel = st.one;
    const none = st.sels.length === 0;
    if (st.sides) {
      const f = st.feature(st.sides.id);
      if (f) out.push(...this.sides(f, st.sides.sides));
    } else if (st.sels.length > 1) {
      out.push(...this.many());
    } else if (sel === 'stock' || none) {
      const s = st.p.stock;
      out.push(this.h(sel === 'stock' ? 'Stock block' : 'Part'));
      if (none) out.push(this.h('Nothing selected. Draw on a view, or click a shape.', 'ds-note'));
      out.push(this.num('Width (X)', s.max[0] - s.min[0], (v) => { const c = (s.min[0] + s.max[0]) / 2; s.min[0] = c - v / 2; s.max[0] = c + v / 2; }, { min: 0.1 }));
      out.push(this.num('Depth (Y)', s.max[1] - s.min[1], (v) => { const c = (s.min[1] + s.max[1]) / 2; s.min[1] = c - v / 2; s.max[1] = c + v / 2; }, { min: 0.1 }));
      out.push(this.num('Height (Z)', s.max[2] - s.min[2], (v) => { s.max[2] = s.min[2] + v; }, { min: 0.1 }));
      if (none) {
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
        out.push(this.h('V select · R rectangle · C circle · Shift-click or drag a box to select several · Option-click a side of a rectangle, Option-Shift-click the side next to it for their corner · Delete removes · ⌘Z undo · F fit · Space-drag or right-drag to pan · pinch or ⌘-scroll to zoom · hold Option while dragging for no snapping', 'ds-note'));
      }
    } else {
      const f = st.feature(sel);
      if (f) out.push(...this.feature(f));
    }
    this.el.replaceChildren(...out);
  }

  private labelled(label: string, child: HTMLElement): HTMLElement {
    const w = document.createElement('div');
    w.className = 'ds-field';
    const s = document.createElement('span');
    s.textContent = label;
    w.append(s, child);
    return w;
  }

  /** Corner radius: one field for all four, or one per corner once they differ. */
  private cornerFields(f: Feature): HTMLElement[] {
    const r = cornerRadii(f);
    const lim = Math.min(f.w, f.h) / 2;
    const out: HTMLElement[] = [];
    if (r.every((x) => x === r[0])) {
      out.push(this.num('Corner radius', r[0], (v) => { f.corner = Math.min(v, lim); delete f.corners; }, { min: 0, title: 'All four corners. Option-click two sides that meet to round just their corner.' }));
    } else {
      const V = VIEWS[f.view];
      const names = this.cornerNames(f);
      r.forEach((x, i) => out.push(this.num(`${names[i]} corner`, x, (v) => { const c = [...cornerRadii(f)] as [number, number, number, number]; c[i] = Math.min(v, lim); f.corners = c; }, { min: 0 })));
      const b = document.createElement('button');
      b.className = 'btn ghost sm';
      b.textContent = 'Make all corners the same';
      b.onclick = () => this.st.change(() => { f.corner = Math.max(...r); delete f.corners; });
      out.push(b);
      void V;
    }
    return out;
  }

  /** Corner names as the drawing view sees them, e.g. "Bottom left". */
  private cornerNames(f: Feature): string[] {
    void f;
    return ['Bottom left', 'Bottom right', 'Top right', 'Top left'];
  }

  private sides(f: Feature, sides: number[]): HTMLElement[] {
    const st = this.st;
    const out: HTMLElement[] = [];
    const sideNames = ['Bottom', 'Right', 'Top', 'Left'];
    const V = VIEWS[f.view];
    const [ua] = axisOf(V.uDir), [va] = axisOf(V.vDir);
    if (sides.length === 1) {
      const k = sides[0];
      out.push(this.h(`${sideNames[k]} side of a rectangle`));
      const horiz = k === 0 || k === 2;
      out.push(this.num(`Length (${AX[horiz ? ua : va]})`, horiz ? f.w : f.h, (v) => {
        // grow away from the opposite... keep the shape centred
        if (horiz) f.w = v; else f.h = v;
      }, { min: 0 }));
      out.push(this.h('Option-Shift-click a side next to this one to pick the corner they share.', 'ds-note'));
    } else {
      const c = sharedCorner(sides[0], sides[1]);
      if (c < 0) {
        out.push(this.h('Opposite sides', 'ds-h'));
        out.push(this.h("These two sides don't meet, so they have no corner. Option-Shift-click one to drop it, then pick a side next to the other.", 'ds-note'));
      } else {
        const names = this.cornerNames(f);
        out.push(this.h(`${names[c]} corner`));
        const lim = Math.min(f.w, f.h) / 2;
        out.push(this.num('Corner radius', cornerRadii(f)[c], (v) => {
          const r = [...cornerRadii(f)] as [number, number, number, number];
          r[c] = Math.min(v, lim);
          f.corners = r;
        }, { min: 0, title: `Up to ${lim.toFixed(2)} mm (half the shorter side)` }));
      }
    }
    const back = document.createElement('button');
    back.className = 'btn ghost sm ds-del';
    back.textContent = 'Select the whole shape';
    back.onclick = () => st.select([f.id]);
    out.push(back);
    return out;
  }

  private many(): HTMLElement[] {
    const st = this.st;
    const feats = st.sels.map((id) => st.feature(id)).filter((f): f is Feature => !!f);
    const out: HTMLElement[] = [this.h(`${feats.length} shapes selected`)];
    const ops = new Set(feats.map((f) => f.op));
    out.push(this.labelled('Operation', this.seg([['add', 'Add ▲'], ['cut', 'Cut ▼']], ops.size === 1 ? [...ops][0] : '', (v) => st.change(() => {
      for (const f of feats) {
        if (f.op === v) continue;
        const depth = Math.abs(f.d1 - f.d0);
        f.op = v as 'add' | 'cut';
        f.d1 = f.op === 'add' ? f.d0 + depth : f.d0 - depth;
      }
    }))));
    out.push(this.h('Line them up with the align buttons in the bar above. Left, right, top and bottom are as the highlighted view sees them; click in a view to make it the one.', 'ds-note'));
    const del = document.createElement('button');
    del.className = 'btn ghost sm ds-del';
    del.textContent = `Delete ${feats.length} shapes`;
    del.onclick = () => st.deleteSelected();
    out.push(del);
    return out;
  }

  private feature(f: Feature): HTMLElement[] {
    const st = this.st;
    const V = VIEWS[f.view];
    const [ua, us] = axisOf(V.uDir), [va, vs] = axisOf(V.vDir), [da, ds] = axisOf(V.eye);
    const out: HTMLElement[] = [];
    const sketch = Math.abs(f.d0 - f.d1) < 1e-9 && !(f.op === 'cut' && f.through);
    const name = f.type === 'circle' ? 'Circle' : f.corner > 0 ? 'Rounded rectangle' : 'Rectangle';
    out.push(this.h(`${name} · drawn on ${V.label.toLowerCase()}`));
    const err = st.built?.errors[f.id];
    if (err) out.push(this.h(`Couldn't build this shape: ${err}`, 'ds-note ds-err'));
    else if (sketch) out.push(this.h('A sketch with no depth yet: give it a depth below, or drag its line in a side view.', 'ds-note ds-sk'));
    else if (st.built && st.built.effect[f.id] === false) out.push(this.h(f.op === 'add' ? 'Buried in solid material, so it changes nothing (shown faded).' : 'Cuts only empty space, so it changes nothing (shown faded).', 'ds-note'));

    out.push(this.labelled('Operation', this.seg([['add', 'Add ▲'], ['cut', 'Cut ▼']], f.op, (v) => st.change(() => {
      const depth = Math.abs(f.d1 - f.d0);
      f.op = v as 'add' | 'cut';
      f.d1 = f.op === 'add' ? f.d0 + depth : f.d0 - depth;
    }))));

    out.push(this.h('Position'));
    out.push(this.num(`Centre ${AX[ua]}`, us * f.cu, (v) => { f.cu = us * v; }));
    out.push(this.num(`Centre ${AX[va]}`, vs * f.cv, (v) => { f.cv = vs * v; }));

    out.push(this.h('Size'));
    if (f.type === 'circle') {
      out.push(this.num('Diameter', 2 * f.r, (v) => { f.r = v / 2; }, { min: 0 }));
    } else {
      out.push(this.num(`Width (${AX[ua]})`, f.w, (v) => { f.w = v; }, { min: 0 }));
      out.push(this.num(`Height (${AX[va]})`, f.h, (v) => { f.h = v; }, { min: 0 }));
      out.push(...this.cornerFields(f));
    }

    out.push(this.h('Depth'));
    out.push(this.num(`Starts at ${AX[da]}`, ds * f.d0, (v) => { const dep = f.d1 - f.d0; f.d0 = ds * v; f.d1 = f.d0 + dep; },
      { title: 'The face the shape sits on. It starts on the nearest surface under it.' }));
    const throughCut = f.op === 'cut' && f.through;
    if (!throughCut) {
      out.push(this.num('Depth', Math.abs(f.d1 - f.d0), (v) => { f.d1 = f.op === 'add' ? f.d0 + v : f.d0 - v; }, { min: 0 }));
      out.push(this.num(`Ends at ${AX[da]}`, ds * f.d1, (v) => { f.d1 = ds * v; }));
    } else {
      const [lo] = depthRange(f, st.p);
      out.push(this.h(`Runs right through the part (to ${AX[da]} ${(this.toUnits(ds * lo)).toFixed(st.p.precision)}).`, 'ds-note'));
    }
    if (f.op === 'cut') {
      const lab = document.createElement('label');
      lab.className = 'ds-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = f.through;
      cb.onchange = () => st.change(() => { f.through = cb.checked; if (!cb.checked && Math.abs(f.d1 - f.d0) < 1e-9) f.d1 = f.d0 - 1; });
      lab.append(cb, document.createTextNode(' Through all'));
      out.push(lab);
    }

    const del = document.createElement('button');
    del.className = 'btn ghost sm ds-del';
    del.textContent = 'Delete shape';
    del.onclick = () => st.deleteSelected();
    out.push(del);
    return out;
  }
}
