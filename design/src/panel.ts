// The properties panel: whatever is selected (or the project when nothing is).

import type { Feature } from './model.js';
import { depthRange } from './model.js';
import { VIEWS, axisOf } from './views.js';
import type { State } from './state.js';

const AX = 'XYZ';

export class Panel {
  constructor(private el: HTMLElement, private st: State) {
    st.on((w) => { if (w !== 'built' || this.st.sel) this.render(); });
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
    if (st.sel === 'stock' || !st.sel) {
      const s = st.p.stock;
      out.push(this.h(st.sel === 'stock' ? 'Stock block' : 'Part'));
      if (!st.sel) out.push(this.h('Nothing selected. Draw on a view, or click a shape.', 'ds-note'));
      out.push(this.num('Width (X)', s.max[0] - s.min[0], (v) => { const c = (s.min[0] + s.max[0]) / 2; s.min[0] = c - v / 2; s.max[0] = c + v / 2; }, { min: 0.1 }));
      out.push(this.num('Depth (Y)', s.max[1] - s.min[1], (v) => { const c = (s.min[1] + s.max[1]) / 2; s.min[1] = c - v / 2; s.max[1] = c + v / 2; }, { min: 0.1 }));
      out.push(this.num('Height (Z)', s.max[2] - s.min[2], (v) => { s.max[2] = s.min[2] + v; }, { min: 0.1 }));
      if (!st.sel) {
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
        out.push(this.h('R rectangle · C circle · V select · Delete removes · ⌘Z undo · F fit · Space-drag or right-drag to pan · pinch or ⌘-scroll to zoom · Option = no snapping', 'ds-note'));
      }
    } else {
      const f = st.feature(st.sel);
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
      out.push(this.num('Corner radius', f.corner, (v) => { f.corner = Math.min(v, f.w / 2, f.h / 2); }, { min: 0 }));
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
    del.onclick = () => { st.change((p) => { p.features = p.features.filter((x) => x.id !== f.id); }); st.select(null); };
    out.push(del);
    return out;
  }
}
