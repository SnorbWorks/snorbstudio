// SnorbCAM: the tab. A sheet of material with parts laid on it; click an
// outline to say how it's cut; the bit's paths show on the sheet as you go;
// Export writes the ShopBot G-code (one file per bit).
import { Bit, Contour, IN, Job, Op, OpKind, P2, Part, Placed, autoTabs, bitOf, camId, fractionAt, newJob, partBox, placedBox, placer, pointAt } from './job.js';
import { Plan, byBit, gcode, movesFor, planJob, runTime } from './toolpath.js';
import { importCad, importDxf, importSvg } from './importers.js';

interface Studio { show?: (p: string) => void }

const API = '/studio-api/cam';
const DRAFT = 'studio.cam.draft';
const NS = 'http://www.w3.org/2000/svg';

const html = `
<div class="ds-tools cm-tools">
  <input class="ds-name" id="cm-name" title="Job name" spellcheck="false">
  <div class="ds-seg">
    <button id="cm-new" title="Start a new job">New</button>
    <button id="cm-open" title="Open a saved job">Open…</button>
    <button id="cm-save" title="Save this job on the Pi">Save</button>
  </div>
  <div class="ds-seg">
    <button id="cm-add-file" title="Add outlines from an SVG (Illustrator) or DXF file">Add SVG / DXF…</button>
    <button id="cm-add-cad" title="Add a part drawn in SnorbCAD">Add SnorbCAD part…</button>
  </div>
  <input type="file" id="cm-file" accept=".svg,.dxf,image/svg+xml" multiple hidden>
  <span class="cm-grow"></span>
  <div class="ds-seg" title="Units shown">
    <button data-u="in">in</button><button data-u="mm">mm</button>
  </div>
  <label class="cm-show"><input type="checkbox" id="cm-paths" checked> Toolpaths</label>
  <button class="btn primary" id="cm-export" title="Write the G-code for the ShopBot">Export G-code</button>
</div>
<div class="ds-body">
  <div class="ds-sheet-wrap cm-wrap">
    <svg class="ds-sheet cm-sheet" id="cm-svg"></svg>
    <div class="cm-hint" id="cm-hint"></div>
  </div>
  <div class="ds-side"><div class="ds-panel" id="cm-panel"></div></div>
</div>
<div class="ds-status" id="cm-status"></div>
`;

export function mount(root: HTMLElement, _studio: Studio) {
  root.innerHTML = html;
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector(s) as T;
  const svg = $('#cm-svg') as unknown as SVGSVGElement;
  const panel = $('#cm-panel');

  let job: Job = loadDraft() || newJob();
  let units: 'in' | 'mm' = job.units;
  // selection: one placed part, and which of its outlines
  let selPlaced: string | null = null;
  let selKs = new Set<string>();
  let plan: Plan | null = null;
  let timeS = 0;
  const undo: string[] = [], redo: string[] = [];
  let dirty = false;

  // ------------------------------------------------------------ changes

  function change(fn: (j: Job) => void, keepRedo = false) {
    undo.push(JSON.stringify(job));
    if (undo.length > 80) undo.shift();
    if (!keepRedo) redo.length = 0;
    fn(job);
    dirty = true;
    saveDraft();
    refresh();
  }
  function saveDraft() { try { localStorage.setItem(DRAFT, JSON.stringify(job)); } catch { /* full */ } }
  function loadDraft(): Job | null { try { const s = localStorage.getItem(DRAFT); return s ? JSON.parse(s) : null; } catch { return null; } }

  // ------------------------------------------------------------ units

  const L = (mm: number) => (units === 'in' ? mm / IN : mm);
  const fromL = (v: number) => (units === 'in' ? v * IN : v);
  const fmt = (mm: number, d = units === 'in' ? 3 : 1) => `${+L(mm).toFixed(d)}`;
  const feedU = () => (units === 'in' ? 'in/min' : 'mm/min');

  // ------------------------------------------------------------ the view

  let view = { x: -50, y: -50, w: job.sheet.w + 100, h: job.sheet.h + 100 };
  function fit() {
    const r = svg.getBoundingClientRect();
    const W = job.sheet.w + 80, H = job.sheet.h + 80;
    const k = Math.max(W / Math.max(1, r.width), H / Math.max(1, r.height));
    view = { w: r.width * k, h: r.height * k, x: -40 - (r.width * k - W) / 2, y: -40 - (r.height * k - H) / 2 };
    applyView();
  }
  // sheet Y runs up; the screen's runs down: everything sits in a flipped group
  const applyView = () => svg.setAttribute('viewBox', `${view.x} ${-view.y - view.h} ${view.w} ${view.h}`);
  const pxPerMm = () => svg.getBoundingClientRect().width / view.w;
  function toSheet(e: { clientX: number; clientY: number }): P2 {
    const r = svg.getBoundingClientRect();
    return [view.x + ((e.clientX - r.left) / r.width) * view.w, view.y + view.h - ((e.clientY - r.top) / r.height) * view.h];
  }

  const el = (tag: string, attrs: Record<string, string | number>, parent?: Element) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    parent?.appendChild(e);
    return e;
  };
  const d = (pts: P2[], closed: boolean) => pts.length ? `M${pts.map((p) => `${p[0].toFixed(3)} ${p[1].toFixed(3)}`).join('L')}${closed ? 'Z' : ''}` : '';

  const partOf = (pl: Placed) => job.parts.find((p) => p.id === pl.part)!;

  function draw() {
    svg.innerHTML = '';
    const g = el('g', { transform: 'scale(1,-1)' }, svg);
    // the sheet, with a 1" (or 25 mm) grid; X0 Y0 at its lower-left corner
    el('rect', { x: 0, y: 0, width: job.sheet.w, height: job.sheet.h, class: 'cm-board' }, g);
    const step = units === 'in' ? IN : 25;
    const grid = el('path', { class: 'cm-grid', d: '' }, g);
    let gd = '';
    for (let x = step; x < job.sheet.w - 1e-6; x += step) gd += `M${x} 0V${job.sheet.h}`;
    for (let y = step; y < job.sheet.h - 1e-6; y += step) gd += `M0 ${y}H${job.sheet.w}`;
    grid.setAttribute('d', gd);
    const big = units === 'in' ? 12 * IN : 300;
    let bd = '';
    for (let x = big; x < job.sheet.w - 1e-6; x += big) bd += `M${x} 0V${job.sheet.h}`;
    for (let y = big; y < job.sheet.h - 1e-6; y += big) bd += `M0 ${y}H${job.sheet.w}`;
    el('path', { class: 'cm-grid2', d: bd }, g);
    // the zero
    el('path', { class: 'cm-zero', d: `M0 0h${big / 4}M0 0v${big / 4}` }, g);
    el('circle', { class: 'cm-zero-dot', cx: 0, cy: 0, r: 4 / pxPerMm() }, g);

    // toolpaths under the outlines
    if (($('#cm-paths') as HTMLInputElement).checked && plan) {
      const tp = el('g', { class: 'cm-tp' }, g);
      for (const c of plan.cuts) {
        for (const t of c.tracks) el('path', { d: d(t.pts, t.closed), 'stroke-width': c.bit.dia, class: `cm-cut cm-${c.op.kind}` }, tp);
      }
    }
    for (const pl of job.placed) {
      const part = partOf(pl);
      if (!part) continue;
      const T = placer(part, pl);
      const isSel = pl.id === selPlaced;
      const pg = el('g', { class: `cm-part${isSel ? ' sel' : ''}` }, g);
      const [x0, y0, x1, y1] = placedBox(part, pl);
      if (isSel) el('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, class: 'cm-box' }, pg);
      for (const c of part.contours) {
        const pts = c.pts.map(T);
        const on = isSel && selKs.has(c.id);
        el('path', { d: d(pts, c.closed), class: `cm-k cm-${c.op.kind}${on ? ' on' : ''}` }, pg);
        // tabs
        if (c.closed && c.op.tabs.length && (c.op.kind === 'outside' || c.op.kind === 'inside' || c.op.kind === 'on')) {
          c.op.tabs.forEach((f, i) => {
            const p = pointAt(pts, true, f);
            el('rect', { x: p[0] - 5 / pxPerMm(), y: p[1] - 5 / pxPerMm(), width: 10 / pxPerMm(), height: 10 / pxPerMm(), class: `cm-tab${on ? ' on' : ''}`, 'data-k': c.id, 'data-i': i }, pg);
          });
        }
      }
    }
  }

  // ------------------------------------------------------------ hit testing

  function hitOutline(p: P2, tolPx = 7): { pl: Placed; c: Contour } | null {
    const tol = tolPx / pxPerMm();
    let best: { pl: Placed; c: Contour } | null = null, bd = tol;
    for (const pl of [...job.placed].reverse()) {
      const part = partOf(pl), T = placer(part, pl);
      const [x0, y0, x1, y1] = placedBox(part, pl);
      if (p[0] < x0 - tol || p[0] > x1 + tol || p[1] < y0 - tol || p[1] > y1 + tol) continue;
      for (const c of part.contours) {
        const pts = c.pts.map(T), n = pts.length;
        for (let i = 0; i < (c.closed ? n : n - 1); i++) {
          const a = pts[i], b = pts[(i + 1) % n];
          const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
          const k = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
          const dd = Math.hypot(a[0] + dx * k - p[0], a[1] + dy * k - p[1]);
          if (dd < bd) { bd = dd; best = { pl, c }; }
        }
      }
    }
    return best;
  }
  function hitPart(p: P2): Placed | null {
    for (const pl of [...job.placed].reverse()) {
      const [x0, y0, x1, y1] = placedBox(partOf(pl), pl);
      if (p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1) return pl;
    }
    return null;
  }
  function hitTab(p: P2): { pl: Placed; c: Contour; i: number } | null {
    if (!selPlaced) return null;
    const pl = job.placed.find((q) => q.id === selPlaced);
    if (!pl) return null;
    const part = partOf(pl), T = placer(part, pl), tol = 8 / pxPerMm();
    for (const c of part.contours) {
      if (!selKs.has(c.id)) continue;
      const pts = c.pts.map(T);
      for (let i = 0; i < c.op.tabs.length; i++) {
        const q = pointAt(pts, true, c.op.tabs[i]);
        if (Math.hypot(q[0] - p[0], q[1] - p[1]) < tol) return { pl, c, i };
      }
    }
    return null;
  }

  // ------------------------------------------------------------ mouse

  type Drag =
    | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
    | { kind: 'move'; at: P2; pl: string; x: number; y: number; moved: boolean; snap: string }
    | { kind: 'tab'; pl: string; k: string; i: number; snap: string };
  let drag: Drag | null = null;

  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    svg.setPointerCapture(e.pointerId);
    const p = toSheet(e);
    if (e.button === 1 || e.altKey && !e.shiftKey) { drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }; return; }
    const tab = hitTab(p);
    if (tab) { drag = { kind: 'tab', pl: tab.pl.id, k: tab.c.id, i: tab.i, snap: JSON.stringify(job) }; return; }
    const h = hitOutline(p);
    if (h) {
      if (e.shiftKey && selPlaced === h.pl.id) { if (selKs.has(h.c.id)) selKs.delete(h.c.id); else selKs.add(h.c.id); }
      else if (!(selPlaced === h.pl.id && selKs.has(h.c.id))) { selPlaced = h.pl.id; selKs = new Set([h.c.id]); }
      drag = { kind: 'move', at: p, pl: h.pl.id, x: h.pl.x, y: h.pl.y, moved: false, snap: JSON.stringify(job) };
      refresh(false);
      return;
    }
    const pl = hitPart(p);
    if (pl) {
      selPlaced = pl.id; selKs = new Set(partOf(pl).contours.map((c) => c.id));
      drag = { kind: 'move', at: p, pl: pl.id, x: pl.x, y: pl.y, moved: false, snap: JSON.stringify(job) };
      refresh(false);
      return;
    }
    selPlaced = null; selKs.clear();
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    refresh(false);
  });

  svg.addEventListener('pointermove', (e) => {
    const p = toSheet(e);
    status(p);
    if (!drag) {
      svg.style.cursor = hitTab(p) ? 'grab' : hitOutline(p) || hitPart(p) ? 'move' : 'default';
      return;
    }
    if (drag.kind === 'pan') {
      const k = view.w / svg.getBoundingClientRect().width;
      view.x = drag.vx - (e.clientX - drag.sx) * k;
      view.y = drag.vy + (e.clientY - drag.sy) * k;
      applyView();
    } else if (drag.kind === 'move') {
      const dx = p[0] - drag.at[0], dy = p[1] - drag.at[1];
      if (!drag.moved && Math.hypot(dx, dy) * pxPerMm() < 3) return;
      drag.moved = true;
      const pl = job.placed.find((q) => q.id === (drag as any).pl)!;
      const snap = e.altKey ? 0.01 : units === 'in' ? IN / 16 : 1;
      pl.x = Math.round((drag.x + dx) / snap) * snap;
      pl.y = Math.round((drag.y + dy) / snap) * snap;
      plan = null;
      draw();
    } else if (drag.kind === 'tab') {
      const pl = job.placed.find((q) => q.id === (drag as any).pl)!;
      const part = partOf(pl), c = part.contours.find((k) => k.id === (drag as any).k)!;
      const T = placer(part, pl);
      c.op.tabs[drag.i] = +fractionAt(c.pts.map(T), true, p).toFixed(5);
      plan = null;
      draw();
    }
  });

  const endDrag = () => {
    if (!drag) return;
    if ((drag.kind === 'move' && drag.moved) || drag.kind === 'tab') {
      undo.push(drag.snap); redo.length = 0; dirty = true; saveDraft();
      drag = null;
      refresh();
      return;
    }
    drag = null;
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  svg.addEventListener('dblclick', (e) => {
    const p = toSheet(e);
    const tab = hitTab(p);
    if (tab) { change(() => { tab.c.op.tabs.splice(tab.i, 1); }); return; }
    const h = hitOutline(p);
    if (h && h.c.closed && ['outside', 'inside', 'on'].includes(h.c.op.kind)) {
      const T = placer(partOf(h.pl), h.pl);
      const f = +fractionAt(h.c.pts.map(T), true, p).toFixed(5);
      selPlaced = h.pl.id; selKs = new Set([h.c.id]);
      change(() => { h.c.op.tabs.push(f); h.c.op.tabs.sort((a, b) => a - b); });
    }
  });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = toSheet(e);
    const k = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
    const w = Math.min(Math.max(view.w * k, 20), 20000);
    const s = w / view.w;
    view = { x: p[0] - (p[0] - view.x) * s, y: p[1] - (p[1] - view.y) * s, w, h: view.h * s };
    applyView();
    draw();
  }, { passive: false });

  // ------------------------------------------------------------ keys

  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected || root.offsetParent === null) return;
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const mod = e.metaKey || e.ctrlKey;
    const pl = job.placed.find((q) => q.id === selPlaced);
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (mod && e.key.toLowerCase() === 'd' && pl) { e.preventDefault(); duplicate(pl); return; }
    if (e.key === 'f') { fit(); draw(); return; }
    if (!pl) return;
    if ((e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); removePlaced(pl); return; }
    if (e.key === 'r') { change(() => { pl.rot = ((pl.rot + (e.shiftKey ? -90 : 90)) % 360 + 360) % 360; }); return; }
    const step = (e.shiftKey ? 10 : 1) * (units === 'in' ? IN / 16 : 1);
    const mv: Record<string, P2> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (mv[e.key]) { e.preventDefault(); change(() => { pl.x += mv[e.key][0]; pl.y += mv[e.key][1]; }); }
    if (e.key === 'Escape') { selPlaced = null; selKs.clear(); refresh(false); }
  };
  document.addEventListener('keydown', onKey);

  function doUndo() { const s = undo.pop(); if (!s) return; redo.push(JSON.stringify(job)); job = JSON.parse(s); dirty = true; saveDraft(); refresh(); }
  function doRedo() { const s = redo.pop(); if (!s) return; undo.push(JSON.stringify(job)); job = JSON.parse(s); dirty = true; saveDraft(); refresh(); }

  // ------------------------------------------------------------ parts

  /** Put a new part on the sheet: to the right of what's there, else above it. */
  function place(part: Part) {
    const [px0, py0, px1, py1] = partBox(part);
    const w = px1 - px0, h = py1 - py0, gap = units === 'in' ? IN / 2 : 10;
    let x = gap, y = gap;
    if (job.placed.length) {
      const boxes = job.placed.map((pl) => placedBox(partOf(pl), pl));
      const right = Math.max(...boxes.map((b) => b[2]));
      if (right + gap + w <= job.sheet.w) { x = right + gap; y = gap; }
      else { x = gap; y = Math.max(...boxes.map((b) => b[3])) + gap; }
    }
    const pl: Placed = { id: camId('pl'), part: part.id, x, y, rot: 0 };
    change((j) => { j.parts.push(part); j.placed.push(pl); });
    selPlaced = pl.id; selKs = new Set(part.contours.map((c) => c.id));
    if (w > job.sheet.w || h > job.sheet.h) flash(`${part.name} is bigger than the sheet`);
    refresh(false);
  }

  function duplicate(pl: Placed) {
    const [x0, , x1] = placedBox(partOf(pl), pl);
    const np: Placed = { ...pl, id: camId('pl'), x: pl.x + (x1 - x0) + (units === 'in' ? IN / 4 : 6) };
    change((j) => { j.placed.push(np); });
    selPlaced = np.id;
    refresh(false);
  }

  function removePlaced(pl: Placed) {
    change((j) => {
      j.placed = j.placed.filter((q) => q.id !== pl.id);
      // drop the part itself once nothing on the sheet uses it
      if (!j.placed.some((q) => q.part === pl.part)) j.parts = j.parts.filter((p) => p.id !== pl.part);
    });
    selPlaced = null; selKs.clear();
    refresh(false);
  }

  // ------------------------------------------------------------ the side panel

  function render() {
    panel.innerHTML = '';
    const pl = job.placed.find((q) => q.id === selPlaced);
    const part = pl && partOf(pl);
    const ks = part ? part.contours.filter((c) => selKs.has(c.id)) : [];
    if (pl && part && ks.length) cutPanel(part, ks);
    if (pl && part) partPanel(pl, part);
    if (!pl) jobPanel();
  }

  const H = (t: string) => { const h = document.createElement('div'); h.className = 'ds-h'; h.textContent = t; panel.appendChild(h); return h; };
  const note = (t: string, cls = 'ds-note') => { const n = document.createElement('div'); n.className = cls; n.textContent = t; panel.appendChild(n); return n; };
  function field(label: string, value: number | null, unit: string, set: (v: number) => void, opts: { min?: number; step?: number; title?: string } = {}) {
    const row = document.createElement('label');
    row.className = 'ds-field';
    if (opts.title) row.title = opts.title;
    const s = document.createElement('span'); s.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = String(opts.step ?? 'any');
    inp.value = value === null ? '' : String(value);
    if (value === null) inp.placeholder = 'mixed';
    inp.onchange = () => {
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v) || (opts.min !== undefined && v < opts.min)) { inp.value = value === null ? '' : String(value); return; }
      set(v);
    };
    const u = document.createElement('i'); u.textContent = unit;
    row.append(s, inp, u);
    panel.appendChild(row);
    return inp;
  }
  function seg<T extends string>(label: string, opts: [T, string, string?][], cur: T | null, set: (v: T) => void) {
    const row = document.createElement('div'); row.className = 'cm-stack';
    const s = document.createElement('span'); s.textContent = label;
    const g = document.createElement('div'); g.className = 'ds-seg cm-seg';
    for (const [v, t, title] of opts) {
      const b = document.createElement('button');
      b.textContent = t; if (title) b.title = title;
      b.classList.toggle('active', v === cur);
      b.onclick = () => set(v);
      g.appendChild(b);
    }
    row.append(s, g);
    panel.appendChild(row);
  }
  function select(label: string, opts: [string, string][], cur: string | null, set: (v: string) => void) {
    const row = document.createElement('label'); row.className = 'cm-stack';
    const s = document.createElement('span'); s.textContent = label;
    const sel = document.createElement('select'); sel.className = 'cm-select';
    if (cur === null) sel.appendChild(new Option('mixed', '', true, true));
    for (const [v, t] of opts) sel.appendChild(new Option(t, v, false, v === cur));
    sel.onchange = () => sel.value && set(sel.value);
    row.append(s, sel);
    panel.appendChild(row);
  }
  function button(t: string, fn: () => void, cls = 'btn') {
    const b = document.createElement('button'); b.className = cls; b.textContent = t; b.onclick = fn;
    panel.appendChild(b);
    return b;
  }
  const same = <T,>(xs: T[]): T | null => (xs.every((x) => x === xs[0]) ? xs[0] : null);
  const num = (xs: number[], f: (v: number) => number = (v) => v) => { const v = same(xs.map((x) => +f(x).toFixed(4))); return v; };

  function cutPanel(part: Part, ks: Contour[]) {
    const ops = ks.map((k) => k.op);
    const all = (fn: (o: Op, k: Contour) => void) => change(() => ks.forEach((k) => fn(k.op, k)));
    H(ks.length > 1 ? `${ks.length} outlines` : ks[0].note || (ks[0].closed ? 'Outline' : 'Open line'));
    const kind = same(ops.map((o) => o.kind));
    const anyOpen = ks.some((k) => !k.closed);
    const kinds: [OpKind, string, string][] = anyOpen
      ? [['none', 'Off', 'Not cut'], ['on', 'On line', 'The bit runs along the line']]
      : [['none', 'Off', 'Not cut'], ['on', 'On', 'The bit runs on the line'], ['inside', 'Inside', 'Cut a hole: the bit stays inside the line'], ['outside', 'Outside', 'Cut the part out: the bit stays outside the line'], ['pocket', 'Pocket', 'Clear everything inside the line, to a depth']];
    seg('Cut', kinds, kind, (v) => all((o, k) => {
      o.kind = v;
      if (v === 'outside' && !o.tabs.length) o.tabs = autoTabs(k.pts, 4);
      if (v !== 'outside' && v !== 'inside' && v !== 'on') o.tabs = [];
      if (v === 'pocket' && o.depth >= job.sheet.t - 1e-6) o.depth = Math.min(job.sheet.t / 2, 0.25 * IN);
      if (v !== 'none' && o.depth <= 0) o.depth = job.sheet.t;
    }));
    if (kind === 'none') { note('Click Inside / Outside / Pocket to cut this outline.'); return; }
    field('Depth', num(ops.map((o) => o.depth), L), units, (v) => all((o) => { o.depth = fromL(v); }), { min: 0, title: 'How deep the cut goes, from where it starts' });
    const thru = ops.every((o) => o.z0 - o.depth <= -job.sheet.t + 1e-6);
    const row = document.createElement('div'); row.className = 'cm-quick';
    const b1 = document.createElement('button'); b1.className = 'btn ghost sm'; b1.textContent = 'Through the sheet';
    b1.title = `Depth = the sheet's thickness (${fmt(job.sheet.t)} ${units}) plus a hair, so it cuts clean into the spoilboard`;
    b1.onclick = () => all((o) => { o.depth = job.sheet.t + 0.01 * IN + o.z0; });
    b1.classList.toggle('active', thru);
    row.appendChild(b1);
    panel.appendChild(row);
    field('Starts at', num(ops.map((o) => -o.z0), L), `${units} down`, (v) => all((o) => { o.z0 = -fromL(Math.max(0, v)); }), { min: 0, title: 'Where the cut starts below the top of the material: for stepped shapes, cut after a pocket above it' });
    select('Bit', job.bits.map((b) => [b.id, b.name]), same(ops.map((o) => o.bit || job.bit)), (v) => all((o) => { o.bit = v === job.bit ? undefined : v; }));
    const b = bitOf(job, ops[0]);
    if (kind === 'pocket') {
      seg('Clear by', [['offset', 'Rings', 'Rings in from the edge, innermost first'], ['horizontal', 'Rows ↔', 'Back and forth along X'], ['vertical', 'Rows ↕', 'Back and forth along Y']], same(ops.map((o) => o.fill)), (v) => all((o) => { o.fill = v; }));
    }

    H('Passes');
    field('First pass', num(ops.map((o) => o.first ?? bitOf(job, o).pass), L), units, (v) => all((o) => { o.first = fromL(v); }), { min: 0.001, title: 'How deep the first pass goes (a light first pass keeps a compression bit\'s top edge clean)' });
    field('Then each', num(ops.map((o) => bitOf(job, o).pass), L), units, (v) => all((o) => { const bb = bitOf(job, o); bb.pass = fromL(v); }), { min: 0.001, title: `Depth per pass for the ${b.name} (changes the bit)` });
    field('Finishing pass', num(ops.map((o) => o.finish ?? 0), L), units, (v) => all((o) => { o.finish = fromL(v); }), { min: 0, title: 'A last, light pass at full depth for a clean bottom edge (0 = none)' });
    const levels = ops.length === 1 ? passCount(ops[0]) : null;
    if (levels) note(levels);
    field('Ramp in', num(ops.map((o) => o.ramp)), '°', (v) => all((o) => { o.ramp = Math.max(0, Math.min(90, v)); }), { min: 0, title: 'The bit slides down into the cut at this angle along the path (0 = straight down)' });
    seg('Direction', [['climb', 'Climb', 'Best finish with a compression bit'], ['conventional', 'Conventional', 'Gentler on the bit in hard material']], same(ops.map((o) => o.dir)), (v) => all((o) => { o.dir = v; }));

    if (kind === 'outside' || kind === 'inside' || kind === 'on') {
      H('Tabs');
      const n = same(ops.map((o) => o.tabs.length));
      field('How many', n, '', (v) => all((o, k) => { o.tabs = spread(Math.round(v)); void k; }), { min: 0, step: 1, title: 'Spread evenly round the outline' });
      field('Width', num(ops.map((o) => o.tabWidth), L), units, (v) => all((o) => { o.tabWidth = fromL(v); }), { min: 0 });
      field('Thickness', num(ops.map((o) => o.tabThick), L), units, (v) => all((o) => { o.tabThick = fromL(v); }), { min: 0, title: 'How much material each tab leaves, up from the bottom of the cut' });
      note('Drag a tab along the outline. Double-click the outline to add one, a tab to remove it.');
    }
  }
  const spread = (n: number) => Array.from({ length: Math.max(0, n) }, (_, i) => +((i + 0.5) / n).toFixed(4));

  function passCount(op: Op): string {
    const c = plan?.cuts.find((k) => k.op === op);
    const lv = c ? c.levels : null;
    if (!lv) return '';
    const top = op.z0;
    const ds = lv.map((z, i) => (i ? lv[i - 1] : top) - z);
    return `${lv.length} pass${lv.length > 1 ? 'es' : ''}: ${ds.map((x) => fmt(x)).join(' + ')} ${units}`;
  }

  function partPanel(pl: Placed, part: Part) {
    H(part.name);
    const [x0, y0, x1, y1] = placedBox(part, pl);
    note(`${fmt(x1 - x0)} × ${fmt(y1 - y0)} ${units} · ${part.contours.length} outline${part.contours.length > 1 ? 's' : ''}${job.placed.filter((q) => q.part === part.id).length > 1 ? ` · ${job.placed.filter((q) => q.part === part.id).length} copies cut the same` : ''}`);
    field('X', +L(pl.x).toFixed(4), units, (v) => change(() => { pl.x = fromL(v); }), { title: 'Left edge of the part, from the sheet\'s lower-left corner' });
    field('Y', +L(pl.y).toFixed(4), units, (v) => change(() => { pl.y = fromL(v); }), { title: 'Bottom edge of the part' });
    field('Turned', pl.rot, '°', (v) => change(() => { pl.rot = ((v % 360) + 360) % 360; }), { title: 'R turns it 90°' });
    if (x1 > job.sheet.w + 1e-6 || y1 > job.sheet.h + 1e-6 || x0 < -1e-6 || y0 < -1e-6) note('Off the edge of the sheet', 'ds-note ds-err');
    const row = document.createElement('div'); row.className = 'cm-row';
    panel.appendChild(row);
    const b = (t: string, fn: () => void, title: string) => { const x = document.createElement('button'); x.className = 'btn ghost sm'; x.textContent = t; x.title = title; x.onclick = fn; row.appendChild(x); };
    b('Turn 90°', () => change(() => { pl.rot = (pl.rot + 90) % 360; }), 'R');
    b('Duplicate', () => duplicate(pl), '⌘D');
    b('Remove', () => removePlaced(pl), 'Delete');
    if (selKs.size < part.contours.length) {
      const a = document.createElement('button'); a.className = 'btn ghost sm'; a.textContent = 'Select every outline';
      a.onclick = () => { selKs = new Set(part.contours.map((c) => c.id)); refresh(false); };
      row.appendChild(a);
    }
  }

  function jobPanel() {
    H('Sheet');
    field('Width (X)', +L(job.sheet.w).toFixed(4), units, (v) => change(() => { job.sheet.w = fromL(v); }), { min: 1 });
    field('Height (Y)', +L(job.sheet.h).toFixed(4), units, (v) => change(() => { job.sheet.h = fromL(v); }), { min: 1 });
    field('Thickness', +L(job.sheet.t).toFixed(4), units, (v) => change(() => {
      const old = job.sheet.t; job.sheet.t = fromL(v);
      // cuts that went through the old sheet go through the new one
      for (const p of job.parts) for (const c of p.contours) if (c.op.kind !== 'pocket' && c.op.depth >= old - 1e-6) c.op.depth += job.sheet.t - old;
    }), { min: 0.1 });
    note('Zero X/Y at the lower-left corner of the sheet, Z on top of the material.');
    H('Machine');
    field('Safe height', +L(job.safeZ).toFixed(4), units, (v) => change(() => { job.safeZ = fromL(v); }), { min: 0, title: 'The bit lifts to this between cuts' });
    field('Start / end height', +L(job.homeZ).toFixed(4), units, (v) => change(() => { job.homeZ = fromL(v); }), { min: 0 });
    seg('Order', [['path', 'Each cut', 'Each outline all the way down, then the next'], ['depth', 'Layers', 'Every outline one pass at a time (holds parts better, like Easel)']], job.order, (v) => change(() => { job.order = v; }));
    H('Bits');
    select('Default bit', job.bits.map((b) => [b.id, b.name]), job.bit, (v) => change(() => { job.bit = v; }));
    bitEditor();
    if (!job.placed.length) note('Add an SVG or DXF (Illustrator: File › Save As › SVG), or a part from SnorbCAD.');
    else note('Click an outline to say how it\'s cut. Drag parts to move them. F fits the sheet in view.');
  }

  let editBit = '';
  function bitEditor() {
    const b = job.bits.find((x) => x.id === (editBit || job.bit)) || job.bits[0];
    select('Edit bit', job.bits.map((x) => [x.id, x.name]), b.id, (v) => { editBit = v; render(); });
    const set = (fn: (x: Bit) => void) => change(() => fn(b));
    const nameRow = document.createElement('label'); nameRow.className = 'ds-field';
    const ns = document.createElement('span'); ns.textContent = 'Name';
    const ni = document.createElement('input'); ni.value = b.name; ni.className = 'cm-text';
    ni.onchange = () => set((x) => { x.name = ni.value.trim() || x.name; });
    nameRow.append(ns, ni, document.createElement('i'));
    panel.appendChild(nameRow);
    field('Diameter', +L(b.dia).toFixed(4), units, (v) => set((x) => { x.dia = fromL(v); }), { min: 0.01 });
    field('Feed', +(b.feed / (units === 'in' ? IN : 1)).toFixed(1), feedU(), (v) => set((x) => { x.feed = units === 'in' ? v * IN : v; }), { min: 1 });
    field('Plunge', +(b.plunge / (units === 'in' ? IN : 1)).toFixed(1), feedU(), (v) => set((x) => { x.plunge = units === 'in' ? v * IN : v; }), { min: 1 });
    field('Depth per pass', +L(b.pass).toFixed(4), units, (v) => set((x) => { x.pass = fromL(v); }), { min: 0.01 });
    field('Stepover', Math.round(b.stepover * 100), '%', (v) => set((x) => { x.stepover = Math.max(5, Math.min(95, v)) / 100; }), { min: 5, title: 'Pockets: how far over each ring or row moves, as a share of the bit' });
    const row = document.createElement('div'); row.className = 'cm-row';
    const add = document.createElement('button'); add.className = 'btn ghost sm'; add.textContent = 'New bit';
    add.onclick = () => { const nb = { ...b, id: camId('b'), name: `${b.name} copy` }; editBit = nb.id; change(() => { job.bits.push(nb); }); };
    const del = document.createElement('button'); del.className = 'btn ghost sm'; del.textContent = 'Remove bit';
    del.disabled = job.bits.length < 2;
    del.onclick = () => change(() => {
      job.bits = job.bits.filter((x) => x.id !== b.id);
      if (job.bit === b.id) job.bit = job.bits[0].id;
      for (const p of job.parts) for (const c of p.contours) if (c.op.bit === b.id) c.op.bit = undefined;
      editBit = '';
    });
    row.append(add, del);
    panel.appendChild(row);
  }

  // ------------------------------------------------------------ plan, status

  let planTimer = 0;
  function replan() {
    clearTimeout(planTimer);
    planTimer = window.setTimeout(() => {
      try {
        plan = planJob(job);
        timeS = byBit(job, plan).reduce((t, g) => t + runTime(job, movesFor(job, g.cuts), g.bit), 0);
      } catch (e: any) { plan = null; flash(`Toolpaths failed: ${e.message}`); }
      draw();
      render();
      status();
    }, 120);
  }

  function status(p?: P2) {
    const s: string[] = [];
    if (p) s.push(`X ${fmt(p[0])}  Y ${fmt(p[1])}`);
    if (plan) {
      const bits = byBit(job, plan);
      s.push(`${plan.cuts.length} cut${plan.cuts.length === 1 ? '' : 's'}`);
      if (bits.length) s.push(`${bits.map((b) => b.bit.name).join(', ')}`);
      if (timeS) s.push(`about ${Math.max(1, Math.round(timeS / 60))} min`);
      if (plan.warnings.length) s.push(`⚠ ${plan.warnings[0]}${plan.warnings.length > 1 ? ` (+${plan.warnings.length - 1})` : ''}`);
    }
    $('#cm-status').textContent = s.join('   ·   ');
  }

  let flashT = 0;
  function flash(t: string) {
    const h = $('#cm-hint');
    h.textContent = t; h.classList.add('show');
    clearTimeout(flashT);
    flashT = window.setTimeout(() => h.classList.remove('show'), 4000);
  }

  function refresh(replanToo = true) {
    ($('#cm-name') as HTMLInputElement).value = job.name;
    root.querySelectorAll<HTMLButtonElement>('[data-u]').forEach((b) => b.classList.toggle('active', b.dataset.u === units));
    if (replanToo) { plan = null; replan(); }
    draw();
    render();
    status();
  }

  // ------------------------------------------------------------ files

  ($('#cm-name') as HTMLInputElement).onchange = (e) => { const v = (e.target as HTMLInputElement).value.trim(); if (v) change(() => { job.name = v; }); };
  root.querySelectorAll<HTMLButtonElement>('[data-u]').forEach((b) => { b.onclick = () => { units = b.dataset.u as 'in' | 'mm'; job.units = units; saveDraft(); refresh(false); }; });
  ($('#cm-paths') as HTMLInputElement).onchange = () => draw();

  $('#cm-new').onclick = () => {
    if (dirty && job.placed.length && !confirmDiscard()) return;
    const bits = job.bits;
    job = newJob(); job.bits = bits; job.units = units;
    undo.length = 0; redo.length = 0; dirty = false; selPlaced = null; selKs.clear();
    saveDraft(); fit(); refresh();
  };
  const confirmDiscard = () => window.confirm('Start over? This job has changes that aren\'t saved on the Pi.');

  $('#cm-add-file').onclick = () => $<HTMLInputElement>('#cm-file').click();
  ($('#cm-file') as HTMLInputElement).onchange = async (e) => {
    const files = [...((e.target as HTMLInputElement).files || [])];
    (e.target as HTMLInputElement).value = '';
    for (const f of files) {
      try {
        const txt = await f.text();
        const nm = f.name.replace(/\.[^.]+$/, '');
        const part = /\.dxf$/i.test(f.name) ? importDxf(txt, nm, units) : importSvg(txt, nm);
        for (const c of part.contours) if (c.op.kind !== 'none' && c.op.kind !== 'on') c.op.depth = job.sheet.t + 0.01 * IN;
        place(part);
        flash(`Added ${nm}: ${part.contours.length} outline${part.contours.length > 1 ? 's' : ''}. Outer outlines cut out, ones inside cut through: click one to change it.`);
      } catch (err: any) { flash(`Couldn't read ${f.name}: ${err.message}`); }
    }
  };
  // drop files onto the sheet
  const wrap = $('.cm-wrap');
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('drop'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drop'));
  wrap.addEventListener('drop', (e) => {
    e.preventDefault(); wrap.classList.remove('drop');
    const inp = $('#cm-file') as HTMLInputElement;
    if (e.dataTransfer?.files.length) { inp.files = e.dataTransfer.files; inp.dispatchEvent(new Event('change')); }
  });

  /** A SnorbCAD part onto the sheet: cuts that go right through the part go right through the sheet. */
  function addCad(p: any, name: string) {
    const { part, notes } = importCad(p, name);
    const T = p.stock?.off ? null : p.stock.max[2] - p.stock.min[2];
    for (const c of part.contours) {
      if (T !== null && c.op.kind !== 'pocket' && c.op.z0 - c.op.depth <= -T + 1e-6) c.op.depth = job.sheet.t + 0.01 * IN + c.op.z0;
    }
    if (T !== null && Math.abs(T - job.sheet.t) > 0.3) notes.unshift(`The part is ${fmt(T)} ${units} thick, the sheet ${fmt(job.sheet.t)} ${units}: pockets keep their depths, through cuts go through the sheet`);
    place(part);
    flash(notes.length ? notes.join(' · ') : `Added ${name}: the body cuts out, holes and cuts from the top keep their depths.`);
  }
  $('#cm-add-cad').onclick = () => picker('Add a SnorbCAD part', '/studio-api/designs', 'designs', async (name) => {
    addCad(await (await fetch(`/studio-api/designs/${encodeURIComponent(name)}.json`)).json(), name);
  });

  $('#cm-open').onclick = () => picker('Open a job', API, 'cam', async (name) => {
    const j = await (await fetch(`${API}/${encodeURIComponent(name)}.json`)).json();
    if (dirty && job.placed.length && !confirmDiscard()) return;
    job = j; units = job.units || 'in';
    undo.length = 0; redo.length = 0; dirty = false; selPlaced = null; selKs.clear();
    saveDraft(); fit(); refresh();
  }, true);

  async function save() {
    const nm = job.name.trim() || 'job';
    try {
      const r = await fetch(`${API}/${encodeURIComponent(nm)}.json?replace=1`, { method: 'PUT', body: JSON.stringify(job), headers: { 'Content-Type': 'application/json' } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      dirty = false;
      flash(`Saved ${nm}`);
    } catch (e: any) { flash(`Couldn't save: ${e.message}`); }
  }
  $('#cm-save').onclick = save;

  /** A small list to pick a saved job or part from. */
  async function picker(title: string, url: string, key: string, pick: (name: string) => Promise<void>, deletable = false) {
    let list: { name: string; modified: number }[] = [];
    try { list = (await (await fetch(url)).json())[key] || []; } catch (e: any) { flash(`Couldn't list them: ${e.message}`); return; }
    const back = document.createElement('div'); back.className = 'cm-modal';
    const box = document.createElement('div'); box.className = 'cm-dialog';
    back.appendChild(box);
    const h = document.createElement('div'); h.className = 'ds-h'; h.textContent = title; box.appendChild(h);
    if (!list.length) { const n = document.createElement('div'); n.className = 'ds-note'; n.textContent = 'Nothing saved yet.'; box.appendChild(n); }
    const ul = document.createElement('div'); ul.className = 'cm-list'; box.appendChild(ul);
    for (const it of list) {
      const row = document.createElement('div'); row.className = 'cm-item';
      const b = document.createElement('button'); b.className = 'cm-pick';
      b.innerHTML = `<b></b><span></span>`;
      b.querySelector('b')!.textContent = it.name;
      b.querySelector('span')!.textContent = new Date(it.modified * 1000).toLocaleString();
      b.onclick = async () => { close(); try { await pick(it.name); } catch (e: any) { flash(`Couldn't open ${it.name}: ${e.message}`); } };
      row.appendChild(b);
      if (deletable) {
        const x = document.createElement('button'); x.className = 'btn ghost sm'; x.textContent = 'Delete';
        x.onclick = async () => { if (!window.confirm(`Delete the job "${it.name}"?`)) return; await fetch(`${url}/${encodeURIComponent(it.name)}.json`, { method: 'DELETE' }); row.remove(); };
        row.appendChild(x);
      }
      ul.appendChild(row);
    }
    const cancel = document.createElement('button'); cancel.className = 'btn'; cancel.textContent = 'Cancel';
    cancel.onclick = () => close();
    box.appendChild(cancel);
    const close = () => { back.remove(); document.removeEventListener('keydown', esc, true); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', esc, true);
    back.onclick = (e) => { if (e.target === back) close(); };
    root.appendChild(back);
  }

  $('#cm-export').onclick = () => {
    const p = planJob(job);
    if (!p.cuts.length) { flash(p.warnings[0] || 'Nothing to cut yet: click an outline and pick Inside, Outside or Pocket.'); return; }
    const off = job.placed.filter((pl) => { const [x0, y0, x1, y1] = placedBox(partOf(pl), pl); return x0 < -1e-6 || y0 < -1e-6 || x1 > job.sheet.w + 1e-6 || y1 > job.sheet.h + 1e-6; });
    if (off.length && !window.confirm(`${off.length} part${off.length > 1 ? 's are' : ' is'} off the edge of the sheet. Export anyway?`)) return;
    const groups = byBit(job, p);
    groups.forEach((g, i) => {
      const nc = gcode(job, movesFor(job, g.cuts), g.bit);
      const tag = groups.length > 1 ? ` - ${i + 1} ${g.bit.name.replace(/["/\\]/g, (c) => (c === '"' ? 'in' : '-'))}` : '';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([nc], { type: 'text/plain' }));
      a.download = `${job.name || 'job'}${tag}.nc`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    flash(groups.length > 1 ? `${groups.length} files, one per bit: run them in order, changing the bit between.` : `Exported ${job.name}.nc for the ${groups[0].bit.name}`);
    if (p.warnings.length) flash(p.warnings.join(' · '));
  };

  // ------------------------------------------------------------ start

  new ResizeObserver(() => { if (svg.getBoundingClientRect().width) { if (!fitted) { fitted = true; fit(); } draw(); } }).observe(svg);
  let fitted = false;
  refresh();
  (window as any).__cam = { get job() { return job; }, get plan() { return plan; } };
  return {
    /** Add a SnorbCAD project (from the Design tab's "Send to SnorbCAM"). */
    addCad(p: any, name?: string) { addCad(p, name || p.name || 'part'); },
  };
}

