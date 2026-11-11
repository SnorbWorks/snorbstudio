// The properties panel: whatever is selected (or the project when nothing is).

import type { Dim, Feature, Vec3 } from './model.js';
import { makeLid, cornerRadii, depthRange, sharedCorner, verts, into, isShape, bounds2d, dot, boxCorners, takesFit, hasArcs, canTeardrop, canRevolve, revolveAxis, type RevolveSide } from './model.js';
import { holeLabel, KIND_LABEL, SCREWS } from './holes.js';
import { rememberFit } from './state.js';
import { pitchRadius, outerRadius } from './gears.js';
import { VIEWS, axisOf } from './views.js';
import type { State } from './state.js';
import { cutPlane, flipSection } from './section.js';
import { evalExpr, isFormula, sizeValues, applyFormulas, validName } from './sizes.js';
import type { Project } from './model.js';

const AX = 'XYZ';

export interface PanelHooks {
  gear(id: string): void;                       // open the gear dialog
  hole(id: string): void;                       // open the hole box
  dimValue(dm: Dim): number | null;
  dimSize(dm: Dim, size: number): void;
  repick(id: string): void;                     // pick a fillet's edges again
  unbase(): void;                               // the body back to a plain block
  lid(lid: Project): void;                      // open the matching lid as the other part tab
  fitTest(): void;                              // the fit test plate: find the printer fit
}

const NAMES: Record<string, string> = {
  rect: 'Rectangle', circle: 'Circle', polygon: 'Polygon', poly: 'Outline', gear: 'Gear', text: 'Text', fillet: 'Fillet', hole: 'Hole', slot: 'Slot',
};

export function featureName(f: Feature): string {
  if (f.type === 'rect' && (f.corner > 0 || f.corners?.some((c) => c > 0))) return 'Rounded rectangle';
  if (f.type === 'polygon') return `${f.sides || 6}-sided polygon`;
  if (f.type === 'gear' && f.gear) return `${f.gear.teeth}T ${({ spur: 'spur gear', helical: 'helical gear', ring: 'ring gear', rack: 'rack' })[f.gear.kind]}`;
  if (f.type === 'text' && f.text) return `Text “${f.text.s}”`;
  if (f.type === 'hole' && f.hole) return `${holeLabel(f.hole)} hole`;
  if (f.type === 'poly' && hasArcs(f)) return 'Outline with arcs';
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
  private num(label: string, mm: number, set: (mm: number) => void, opts: { min?: number; max?: number; title?: string; raw?: boolean; unit?: string; step?: number; bind?: { key: string; f: Feature | null } } = {}): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'ds-field';
    if (opts.title) wrap.title = opts.title;
    const span = document.createElement('span');
    span.textContent = label;
    const inp = document.createElement('input');
    // text, not number: a box takes a sum or a named size too (wall*2+1)
    inp.type = 'text';
    inp.inputMode = 'decimal';
    inp.spellcheck = false;
    const shown = opts.raw ? mm : this.toUnits(mm);
    const plain = String(+shown.toFixed(opts.raw ? 4 : this.st.p.precision + 2));
    inp.value = plain;
    const b = opts.bind;
    const exprsOf = () => (b ? (b.f ? (b.f.exprs ||= {}) : (this.st.p.exprs ||= {})) : null);
    const formula = b ? (b.f ? b.f.exprs : this.st.p.exprs)?.[b.key] : undefined;
    if (formula) {
      inp.classList.add('ds-formula');
      wrap.title = `= ${formula}${opts.title ? `\n${opts.title}` : ''}\nType a number to drop the formula.`;
      inp.addEventListener('focus', () => { inp.value = formula; inp.select(); });
      inp.addEventListener('blur', () => { if (inp.value.trim() === formula) inp.value = plain; });
    }
    const unit = document.createElement('i');
    unit.textContent = opts.unit ?? (opts.raw ? '' : this.st.p.units);
    const commit = () => {
      const text = inp.value.trim();
      if (!text || (formula && text === formula)) return;
      let v: number;
      try { v = evalExpr(text, sizeValues(this.st.p)); }
      catch (e: any) { inp.classList.add('ds-bad'); wrap.title = `Can't work that out: ${e.message}`; return; }
      let mmv = +(opts.raw ? v : this.fromUnits(v)).toFixed(9);
      if (opts.min !== undefined) mmv = Math.max(opts.min, mmv);
      if (opts.max !== undefined) mmv = Math.min(opts.max, mmv);
      this.st.change(() => {
        set(mmv);
        const ex = exprsOf();
        if (ex && b) { if (isFormula(text)) ex[b.key] = text; else delete ex[b.key]; }
      });
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

  private button(label: string, fn: () => void, cls = 'btn ghost sm ds-del', title = ''): HTMLElement {
    const b = document.createElement('button');
    b.className = cls;
    if (title) b.title = title;
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
    if (st.p.base) {
      out.push(this.h(`From the library: ${st.p.base.model}`, 'ds-note'));
      if (st.built?.errors.base) out.push(this.h(st.built.errors.base, 'ds-note ds-err'));
      out.push(this.h('An STL is only a skin of triangles, so its own walls keep their size; add or cut shapes on it, round its edges.', 'ds-note'));
      const fmt = (mm: number) => `${this.toUnits(mm).toFixed(st.p.precision)}`;
      out.push(this.h(`${fmt(s.max[0] - s.min[0])} × ${fmt(s.max[1] - s.min[1])} × ${fmt(s.max[2] - s.min[2])} ${st.p.units}`, 'ds-note'));
      out.push(this.button('Use a plain block instead', () => this.hooks.unbase(), 'btn ghost sm'));
      if (!none) return out;
      out.push(...this.history());
      return out;
    }
    out.push(this.check('Start from a block', !s.off, (on) => { s.off = !on; },
      'Off: no block, the shapes you add stand on their own (a gear, say). Cuts then only cut those shapes.'));
    if (!s.off) {
      out.push(this.num('Width (X)', s.max[0] - s.min[0], (v) => { const c = (s.min[0] + s.max[0]) / 2; s.min[0] = c - v / 2; s.max[0] = c + v / 2; }, { min: 0.1, bind: { key: 'stock.x', f: null } }));
      out.push(this.num('Depth (Y)', s.max[1] - s.min[1], (v) => { const c = (s.min[1] + s.max[1]) / 2; s.min[1] = c - v / 2; s.max[1] = c + v / 2; }, { min: 0.1, bind: { key: 'stock.y', f: null } }));
      out.push(this.num('Height (Z)', s.max[2] - s.min[2], (v) => { s.max[2] = s.min[2] + v; }, { min: 0.1, bind: { key: 'stock.z', f: null } }));
      // hollow: an enclosure, open on one face, and its lid
      const sh = st.p.shell;
      out.push(this.check('Hollow', !!sh, (on) => { if (on) st.p.shell = { wall: 2, open: 'top' }; else delete st.p.shell; },
        'Take the inside out, leaving walls: a box or an enclosure. Holes and shapes still cut and add as usual.'));
      if (sh) {
        out.push(this.num('Walls', sh.wall, (v) => { sh.wall = v; }, { min: 0.2, bind: { key: 'shell.wall', f: null } }));
        const sel = document.createElement('select');
        sel.className = 'ds-select';
        for (const [v, t] of [['top', 'Top'], ['bottom', 'Bottom'], ['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'], ['none', 'None (closed)']]) sel.appendChild(new Option(t, v, false, v === sh.open));
        sel.onchange = () => st.change(() => { sh.open = sel.value as any; });
        out.push(this.labelled('Open face', sel));
        if (sh.open !== 'none') out.push(this.button('Make a lid', () => { const lid = makeLid(st.p); if (lid) this.hooks.lid(lid); }, 'btn ghost sm',
          'A lid for the open face, with a lip that slips inside (the printer fit plus a little play). It opens as the other part tab.'));
      }
    }
    if (!none) return out;
    out.push(...this.sectionsSection());
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
    out.push(...this.sizesSection());
    out.push(this.h('Printer fit'));
    out.push(this.num('Holes print small by', st.p.fit ?? 0, (v) => { st.p.fit = v; rememberFit(v); }, { min: 0, max: 2,
      title: 'Printed holes come out a little small. Holes and cut slots are made this much bigger across so they fit; the sizes you type stay the real ones. New parts start with this.' }));
    out.push(this.h('Holes and cut slots grow by this. Any other cut can take it too (its “Add printer fit” box).', 'ds-note'));
    out.push(this.button('Fit test…', () => this.hooks.fitTest(), 'btn ghost sm', 'Print a little plate of M3 holes, then click the one a screw fits: that sets this for you'));
    out.push(this.h('Tips', 'ds-h'));
    out.push(this.h('V select (drag just outside a selection’s corner to turn it) · ⇧R rotate (angle and pivot) · M measure · ⌘C / ⌘V copy and paste, also between the two part tabs (+ Part, top left) · ⌘D duplicate · R rectangle · S slot · C circle · P polygon · L line (click corners, click the first to close; drag a side’s ◆ to bow it into an arc) · O hole · G gear · T text · E edges (fillet/chamfer) · D dimension (double-click its number to type a size) · H draw on the far face (hidden lines) · Z zoom · Shift-click or drag a box to select several · Option-click a side, Option-Shift-click the side next to it for their corner · Delete removes · ⌘Z undo · F fit · Space-drag or right-drag to pan · pinch or ⌘-scroll to zoom · hold Option while dragging for no snapping', 'ds-note'));
    return out;
  }

  /** Named sizes: wall = 2. Any size box takes a name or a sum of them. */
  private sizesSection(): HTMLElement[] {
    const st = this.st;
    const out: HTMLElement[] = [this.h('Sizes')];
    const list = st.p.sizes || [];
    const vals = sizeValues(st.p);
    const commit = (fn: (l: { name: string; expr: string }[]) => void) => st.change((p) => {
      p.sizes = [...(p.sizes || [])].map((x) => ({ ...x }));
      fn(p.sizes);
      if (!p.sizes.length) delete p.sizes;
      applyFormulas(p, (v) => this.fromUnits(v));
    });
    list.forEach((sz, i) => {
      const row = document.createElement('div');
      row.className = 'ds-size';
      const n = document.createElement('input');
      n.value = sz.name; n.spellcheck = false; n.className = 'ds-size-name';
      const e = document.createElement('input');
      e.value = sz.expr; e.spellcheck = false; e.className = 'ds-size-expr';
      const v = document.createElement('i');
      const ok = sz.name in vals;
      v.textContent = ok ? (isFormula(sz.expr) ? `= ${+vals[sz.name].toFixed(4)}` : '') : '?';
      if (!ok) { row.classList.add('ds-bad'); try { evalExpr(sz.expr, vals); } catch (er: any) { row.title = er.message; } }
      const x = document.createElement('button');
      x.className = 'ds-size-x'; x.textContent = '×'; x.title = 'Remove this size (boxes using it keep their numbers)';
      for (const inp of [n, e]) inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') inp.blur(); });
      n.onchange = () => {
        const nm = n.value.trim();
        if (!validName(nm) || list.some((o, j) => j !== i && o.name === nm)) { n.classList.add('ds-bad'); n.title = 'A name: letters, digits and _, starting with a letter, not used yet'; return; }
        const old = sz.name;
        commit((l) => {
          l[i].name = nm;
          // boxes and other sizes that used the old name follow
          const re = new RegExp(`\\b${old}\\b`, 'g');
          for (const o of l) o.expr = o.expr.replace(re, nm);
          const fix = (ex?: Record<string, string>) => { for (const k in ex || {}) ex![k] = ex![k].replace(re, nm); };
          fix(st.p.exprs); for (const f of st.p.features) fix(f.exprs);
        });
      };
      e.onchange = () => commit((l) => { l[i].expr = e.value.trim() || '0'; });
      x.onclick = () => commit((l) => { l.splice(i, 1); });
      row.append(n, document.createTextNode('='), e, v, x);
      out.push(row);
    });
    out.push(this.button('+ Size', () => {
      let k = 1; const taken = new Set(list.map((x) => x.name));
      const nm = list.length ? (() => { while (taken.has(`size${k}`)) k++; return `size${k}`; })() : 'wall';
      commit((l) => { l.push({ name: nm, expr: nm === 'wall' ? (st.p.units === 'in' ? '0.08' : '2') : '1' }); });
    }, 'btn ghost sm', 'A name for a size: type it (or a sum like wall*2+1) in any size box, and changing it here changes them all'));
    if (list.length) out.push(this.h('Type a name or a sum (wall*2+1) in a size box. Blue boxes follow their formula.', 'ds-note'));
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
      out.push(this.num('Corner radius', r[0], (v) => { f.corner = Math.min(v, lim); delete f.corners; }, { min: 0, bind: { key: 'corner', f }, title: 'Every corner. Option-click two sides that meet to round just their corner.' }));
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
    const sketch = Math.abs(f.d0 - f.d1) < 1e-9 && !(f.op === 'cut' && f.through) && !f.revolve;
    out.push(this.h(`${featureName(f)} · drawn on ${V.label.toLowerCase()}${f.far ? ' (far face)' : ''}`));
    const err = st.built?.errors[f.id];
    if (err) out.push(this.h(`Couldn't build this shape: ${err}`, 'ds-note ds-err'));
    else if (sketch) out.push(this.h('A sketch with no depth yet: give it a depth below, or drag its line in a side view.', 'ds-note ds-sk'));
    else if (st.built && st.built.effect[f.id] === false) out.push(this.h(f.op === 'add' ? 'Buried in solid material, so it changes nothing (shown faded).' : 'Cuts only empty space, so it changes nothing (shown faded).', 'ds-note'));

    if (f.type !== 'hole') out.push(this.labelled('Operation', this.seg([['add', 'Add ▲'], ['cut', 'Cut ▼']], f.op, (v) => st.change(() => setOp(f, v as 'add' | 'cut')))));

    if (f.type === 'hole' && f.hole) out.push(...this.holeSummary(f));
    if (f.type === 'gear' && f.gear) out.push(...this.gearSummary(f));
    if (f.type === 'text' && f.text) out.push(...this.textFields(f));

    out.push(this.h('Position'));
    out.push(this.num(`Centre ${AX[ua]}`, us * f.cu, (v) => { f.cu = us * v; }, { bind: { key: 'cu', f } }));
    out.push(this.num(`Centre ${AX[va]}`, vs * f.cv, (v) => { f.cv = vs * v; }, { bind: { key: 'cv', f } }));
    if (f.type === 'polygon' || f.type === 'gear' || f.type === 'text' || f.type === 'slot') {
      out.push(this.num('Turned', f.rot || 0, (v) => { f.rot = v; }, { raw: true, unit: '°', title: 'Degrees, anticlockwise as the drawing view sees it' }));
    }

    if (f.type !== 'gear' && f.type !== 'text' && f.type !== 'hole') {
      out.push(this.h('Size'));
      if (f.type === 'circle') {
        out.push(this.num('Diameter', 2 * f.r, (v) => { f.r = v / 2; }, { min: 0, bind: { key: 'dia', f } }));
      } else if (f.type === 'slot') {
        out.push(this.num('Length', Math.max(f.w, f.h), (v) => { if (f.w >= f.h) f.w = Math.max(v, f.h); else f.h = Math.max(v, f.w); }, { min: 0.01, title: 'End to end, round ends included' }));
        out.push(this.num('Width', Math.min(f.w, f.h), (v) => { if (f.w >= f.h) f.h = Math.min(v, f.w); else f.w = Math.min(v, f.h); }, { min: 0.01, title: 'Across: the screw or pin that slides in it' }));
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
        out.push(...this.arcFields(f));
      } else {
        out.push(this.num(`Width (${AX[ua]})`, f.w, (v) => { f.w = v; }, { min: 0, bind: { key: 'w', f } }));
        out.push(this.num(`Height (${AX[va]})`, f.h, (v) => { f.h = v; }, { min: 0, bind: { key: 'h', f } }));
        out.push(...this.cornerFields(f));
      }
    }

    if (f.revolve && canRevolve(f)) {
      // spun round a centre line: no depth, just where the line is and how far round
      const r = f.revolve;
      out.push(this.h('Revolve'));
      out.push(this.h('Spun round the dash-dot centre line. Draw half the outline against it: a knob, spacer, pulley, button cap.', 'ds-note'));
      const sides: [RevolveSide, string][] = [['left', 'Left side'], ['right', 'Right side'], ['bottom', 'Bottom'], ['top', 'Top']];
      const sel = document.createElement('select');
      sel.className = 'ds-select';
      const now = sides.find(([k]) => { const a = revolveAxis(f, k); return Math.hypot(a.at[0] - r.at[0], a.at[1] - r.at[1]) < 1e-6 && Math.abs(a.dir[0] * r.dir[1] - a.dir[1] * r.dir[0]) < 1e-6; })?.[0];
      for (const [k, t] of sides) sel.appendChild(new Option(t, k, false, k === now));
      if (!now) sel.appendChild(new Option('Where it was turned to', '', false, true));
      sel.onchange = () => { if (sel.value) st.change(() => { Object.assign(r, revolveAxis(f, sel.value as RevolveSide)); }); };
      out.push(this.labelled('Centre line', sel));
      out.push(this.num(`Line at ${AX[da]}`, ds * f.d0, (v) => { f.d0 = f.d1 = ds * v; }, { title: 'How far in the centre line sits, across this view' }));
      out.push(this.num('Angle', r.angle, (v) => { r.angle = Math.max(1, Math.min(360, v)); }, { raw: true, unit: '°', title: '360 for all the way round' }));
      out.push(this.button('Stop spinning', () => st.change(() => {
        const [a, b] = r.prev ?? [f.d0, f.d0 + into(f) * 5];
        f.d0 = a; f.d1 = b; delete f.revolve;
      }), 'btn ghost sm', 'Back to an ordinary shape pushed straight in'));
      out.push(...this.copies(f));
      out.push(this.button('Delete shape', () => st.deleteSelected()));
      return out;
    }

    out.push(this.h('Depth'));
    out.push(this.num(`Starts at ${AX[da]}`, ds * f.d0, (v) => { const dep = f.d1 - f.d0; f.d0 = ds * v; f.d1 = f.d0 + dep; },
      { title: f.far ? 'The far face the shape sits on, seen through the part.' : 'The face the shape sits on. It starts on the nearest surface under it.' }));
    const throughCut = f.op === 'cut' && f.through;
    if (!throughCut) {
      out.push(this.num('Depth', Math.abs(f.d1 - f.d0), (v) => { f.d1 = f.d0 + dirOf(f) * v; }, { min: 0, bind: { key: 'depth', f } }));
      out.push(this.num(`Ends at ${AX[da]}`, ds * f.d1, (v) => { f.d1 = ds * v; }));
    } else {
      const [lo, hi] = depthRange(f, st.p);
      out.push(this.h(`Runs right through the part (to ${AX[da]} ${(this.toUnits(ds * (f.far ? hi : lo))).toFixed(st.p.precision)}).`, 'ds-note'));
    }
    if (f.op === 'cut') {
      out.push(this.check('Through all', f.through, (on) => { f.through = on; if (!on && Math.abs(f.d1 - f.d0) < 1e-9) f.d1 = f.d0 + into(f); }));
      if (f.type !== 'hole' && f.type !== 'gear' && f.type !== 'text') {
        out.push(this.check(`Add printer fit (${this.toUnits(st.p.fit ?? 0).toFixed(st.p.precision)} ${st.p.units})`, takesFit(f), (on) => { f.fit = on; },
          'Make this cut bigger across by the part’s printer fit (Sheet › Printer fit), so a printed peg or screw fits in it'));
      }
    }
    if (f.op === 'cut' && canTeardrop(f)) {
      out.push(this.check('Teardrop (prints without support)', !!f.teardrop, (on) => { if (on) f.teardrop = true; else delete f.teardrop; },
        'A round hole lying on its side sags at the top. A 45° point on top prints clean with no support.'));
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

    if (canRevolve(f)) {
      out.push(this.button('Revolve: spin it round a side', () => st.change(() => {
        const [lo, hi] = depthRange(f, st.p);
        const mid = f.op === 'cut' && f.through ? (lo + hi) / 2 : (f.d0 + f.d1) / 2;
        f.revolve = { ...revolveAxis(f, 'left'), angle: 360, prev: [f.d0, f.d1] };
        f.d0 = f.d1 = +mid.toFixed(9);
      }), 'btn ghost sm', 'Spin this outline round a centre line on its left side (change the side after): knobs, spacers, pulleys, button caps'));
    }
    out.push(...this.copies(f));
    out.push(this.button('Delete shape', () => st.deleteSelected()));
    return out;
  }

  /** Section views (made with the Section tool): where each cut is, which way it looks, remove. */
  private sectionsSection(): HTMLElement[] {
    const st = this.st, secs = st.p.sections || [];
    if (!secs.length) return [];
    const out: HTMLElement[] = [this.h('Sections')];
    const AXN = ['X', 'Y', 'Z'];
    for (const sc of secs) {
      const { axis, at } = cutPlane(sc);
      out.push(this.h(`${sc.label}–${sc.label}: cut on the ${VIEWS[sc.from].label.toLowerCase()} view, seen from the ${VIEWS[sc.view].label.toLowerCase()}`, 'ds-note'));
      out.push(this.num(`Cut at ${AXN[axis]}`, at, (v) => { sc.d = v * VIEWS[sc.view].eye[axis]; }));
      const row = document.createElement('div');
      row.className = 'ds-btnrow';
      row.append(
        this.button('Look the other way', () => st.change((p) => {
          const f = flipSection(sc);
          p.sections = (p.sections || []).filter((x) => x.id !== sc.id && x.view !== f.view);
          p.sections.push(f);
          if (!p.views.includes(f.view)) p.views.push(f.view);
        }), 'btn ghost sm', 'Show what is on the other side of the cut (in the opposite view)'),
        this.button('Remove', () => st.change((p) => { p.sections = (p.sections || []).filter((x) => x.id !== sc.id); }), 'btn ghost sm', 'Back to the plain view'),
      );
      out.push(row);
    }
    return out;
  }

  private holeSummary(f: Feature): HTMLElement[] {
    const h = f.hole!;
    const st = this.st;
    const fit = takesFit(f) ? (st.p.fit ?? 0) : 0;
    const fmt = (mm: number) => `${this.toUnits(mm).toFixed(st.p.precision)} ${st.p.units}`;
    const lines = [`${SCREWS[h.size]?.label ?? 'Custom'} · ${KIND_LABEL[h.kind]}${h.kind === 'clear' || h.kind === 'cbore' || h.kind === 'csk' || h.kind === 'nut' ? ` (${h.fit} fit)` : ''}`,
      `Hole Ø ${fmt(h.d)}${fit ? `, made ${fmt(h.d + fit)} for the printer` : ''}`];
    if (h.kind === 'cbore') lines.push(`Counterbore Ø ${fmt(h.headD)} × ${fmt(h.headDepth)} deep`);
    if (h.kind === 'csk') lines.push(`Countersink Ø ${fmt(h.headD)}, 90°`);
    if (h.kind === 'nut') lines.push(`Nut pocket ${fmt(h.nutAF)} across flats × ${fmt(h.nutDepth)} deep, on the far end`);
    if (h.kind === 'insert') lines.push(`For an insert ${fmt(h.insertLen)} long`);
    return [this.h('Hole'), ...lines.map((l) => this.h(l, 'ds-note')),
      this.button('Edit hole…', () => this.hooks.hole(f.id), 'btn sm'),
      this.check('Add printer fit', takesFit(f), (on) => { f.fit = on; }, 'Make it bigger across by the part’s printer fit (Sheet › Printer fit)')];
  }

  /** An outline's bowed sides: their radius, and a way back to straight. */
  private arcFields(f: Feature): HTMLElement[] {
    const out: HTMLElement[] = [];
    const n = f.pts?.length || 0;
    const arcs = (f.bulges || []).map((s, k) => ({ s, k })).filter((x) => Math.abs(x.s) > 1e-9);
    if (!arcs.length) {
      out.push(this.h('Drag the ◆ in the middle of a side to bow it into an arc.', 'ds-note'));
      return out;
    }
    out.push(this.h('Arcs'));
    for (const { s, k } of arcs) {
      const a = f.pts![k], b = f.pts![(k + 1) % n];
      const c = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const R = (c * c / 4 + s * s) / (2 * Math.abs(s));
      out.push(this.num(`Side ${k + 1} radius`, R, (v) => {
        // the bulge that gives this radius on this side (the smaller arc, same way out)
        const r = Math.max(v, c / 2);
        const sag = r - Math.sqrt(Math.max(0, r * r - c * c / 4));
        const bb = [...(f.bulges || [])];
        bb[k] = Math.sign(s) * sag;
        f.bulges = bb;
      }, { min: 0.01, title: 'At least half the side: that makes a half circle' }));
    }
    out.push(this.button('Straighten all sides', () => this.st.change(() => { delete f.bulges; }), 'btn ghost sm'));
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
    const now = st.built?.fillets?.[f.id];
    const lost = now ? now.filter((q) => !q).length : 0;
    if (lost) {
      out.push(this.h(`${lost} of its ${fl.edges.length} edges ${lost === 1 ? 'is' : 'are'} no longer on the part (a shape changed too much to follow).`, 'ds-note ds-err'));
      out.push(this.button('Re-pick its edges', () => this.hooks.repick(f.id), 'btn sm primary'));
    } else out.push(this.h('Its edges follow when shapes change size or move.', 'ds-note'));
    out.push(this.labelled('Kind', this.seg([['fillet', 'Fillet'], ['chamfer', 'Chamfer']], fl.mode, (v) => st.change(() => { fl.mode = v as 'fillet' | 'chamfer'; }))));
    out.push(this.num(fl.mode === 'fillet' ? 'Radius' : 'Size', fl.size, (v) => { fl.size = v; }, { min: 0.01 }));
    if (!lost) out.push(this.button('Change which edges', () => this.hooks.repick(f.id), 'btn ghost sm'));
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
