// SnorbCAM: the tab. A sheet of material with parts laid on it; click an
// outline to say how it's cut; the bit's paths show on the sheet as you go;
// Export writes the ShopBot G-code (one file per bit).
import { Bit, Contour, CutGroup, IN, Job, Op, OpKind, P2, Part, Placed, Step, StepKind, autoTabs, bitOf, camId, fractionAt, newJob, partBox, placedBox, placer, pointAt } from './job.js';
import { Plan, byBit, gcode, movesFor, planJob, runTime } from './toolpath.js';
import { importCad, importDxf, importSvg } from './importers.js';
import { Entry, GROUP_NAME, STEP_NAME, describeStep, groupOf, moveUnit, newStep, planText, runList, sequence, toSeq, unitsOf } from './sequence.js';

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
  <button class="btn" id="cm-export" title="Save the G-code as files (one per stage) to run in the ShopBot software yourself">Export G-code</button>
  <button class="btn primary" id="cm-send" title="Send the whole job, with its cut order and steps, to SnorbCut on the ShopBot laptop">Send to SnorbCut</button>
</div>
<div class="ds-body">
  <div class="ds-sheet-wrap cm-wrap">
    <svg class="ds-sheet cm-sheet" id="cm-svg"></svg>
    <div class="cm-hint" id="cm-hint"></div>
  </div>
  <div class="ds-side">
    <div class="cm-tabs" id="cm-tabs">
      <button data-tab="props" title="The sheet, the bits, and how the selected outline is cut">Properties</button>
      <button data-tab="order" title="The order the cuts run in, and the steps between them">Cut Order</button>
    </div>
    <div class="ds-panel" id="cm-panel"></div>
  </div>
</div>
<div class="ds-status" id="cm-status"></div>
`;

export function mount(root: HTMLElement, studio: Studio) {
  root.innerHTML = html;
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector(s) as T;
  const svg = $('#cm-svg') as unknown as SVGSVGElement;
  const panel = $('#cm-panel');

  let job: Job = loadDraft() || newJob();
  let units: 'in' | 'mm' = job.units;
  // selection: outlines, as "placed id:outline id" (they can be on different parts), and the part last clicked
  let selPlaced: string | null = null;
  let sel = new Set<string>();
  const K = (plId: string, cId: string) => `${plId}:${cId}`;
  const selAll = (pl: Placed) => new Set(partOf(pl).contours.map((c) => K(pl.id, c.id)));
  let openGroups = new Set<string>();   // groups shown opened in the Cut Order
  let nameGroup = '';                   // the group being renamed
  let plan: Plan | null = null;
  let entries: Entry[] = [];        // the cut order, worked out from the plan
  let sideTab: 'props' | 'order' = 'props';
  let hot = new Set<string>();      // the cuts the pointer is over in the Cut Order list
  let editStep = '';                // the step whose settings are open
  let spots: string[] = [];         // saved spots in SnorbCut, for a step's "move the head to"
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
        for (const t of c.tracks) el('path', { d: d(t.pts, t.closed), 'stroke-width': c.bit.dia, class: `cm-cut cm-${c.op.kind}${hot.has(c.key) ? ' hot' : ''}` }, tp);
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
        const on = sel.has(K(pl.id, c.id));
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
    if (!sel.size) return null;
    const tol = 8 / pxPerMm();
    for (const pl of job.placed) {
      const part = partOf(pl), T = placer(part, pl);
      for (const c of part.contours) {
        if (!sel.has(K(pl.id, c.id))) continue;
        const pts = c.pts.map(T);
        for (let i = 0; i < c.op.tabs.length; i++) {
          const q = pointAt(pts, true, c.op.tabs[i]);
          if (Math.hypot(q[0] - p[0], q[1] - p[1]) < tol) return { pl, c, i };
        }
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
      const k = K(h.pl.id, h.c.id);
      if (e.shiftKey || e.metaKey) { if (sel.has(k)) sel.delete(k); else sel.add(k); selPlaced = h.pl.id; }
      else if (!sel.has(k)) { selPlaced = h.pl.id; sel = new Set([k]); }
      else selPlaced = h.pl.id;
      drag = { kind: 'move', at: p, pl: h.pl.id, x: h.pl.x, y: h.pl.y, moved: false, snap: JSON.stringify(job) };
      refresh(false);
      return;
    }
    const pl = hitPart(p);
    if (pl) {
      selPlaced = pl.id; sel = selAll(pl);
      drag = { kind: 'move', at: p, pl: pl.id, x: pl.x, y: pl.y, moved: false, snap: JSON.stringify(job) };
      refresh(false);
      return;
    }
    selPlaced = null; sel.clear();
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
      selPlaced = h.pl.id; sel = new Set([K(h.pl.id, h.c.id)]);
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
    if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); e.shiftKey ? doUngroup() : doGroup(); return; }
    if (e.key === 'f') { fit(); draw(); return; }
    if (e.key === 'Escape' && !pl && sel.size) { sel.clear(); refresh(false); return; }
    if (!pl) return;
    if ((e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); removePlaced(pl); return; }
    if (e.key === 'r') { change(() => { pl.rot = ((pl.rot + (e.shiftKey ? -90 : 90)) % 360 + 360) % 360; }); return; }
    const step = (e.shiftKey ? 10 : 1) * (units === 'in' ? IN / 16 : 1);
    const mv: Record<string, P2> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (mv[e.key]) { e.preventDefault(); change(() => { pl.x += mv[e.key][0]; pl.y += mv[e.key][1]; }); }
    if (e.key === 'Escape') { selPlaced = null; sel.clear(); refresh(false); }
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
    selPlaced = pl.id; sel = selAll(pl);
    if (w > job.sheet.w || h > job.sheet.h) flash(`${part.name} is bigger than the sheet`);
    refresh(false);
  }

  function duplicate(pl: Placed) {
    const [x0, , x1] = placedBox(partOf(pl), pl);
    const np: Placed = { ...pl, id: camId('pl'), x: pl.x + (x1 - x0) + (units === 'in' ? IN / 4 : 6) };
    change((j) => { j.placed.push(np); });
    selPlaced = np.id; sel = selAll(np);
    refresh(false);
  }

  function removePlaced(pl: Placed) {
    change((j) => {
      j.placed = j.placed.filter((q) => q.id !== pl.id);
      // drop the part itself once nothing on the sheet uses it
      if (!j.placed.some((q) => q.part === pl.part)) j.parts = j.parts.filter((p) => p.id !== pl.part);
      if (j.groups) { j.groups = j.groups.map((g) => ({ ...g, cuts: g.cuts.filter((k) => !k.startsWith(pl.id + ':')) })).filter((g) => g.cuts.length); }
    });
    selPlaced = null; sel.clear();
    refresh(false);
  }

  // ------------------------------------------------------------ groups

  const groups = (): CutGroup[] => job.groups || [];
  const groupOfKey = (k: string) => groups().find((g) => g.cuts.includes(k));
  /** The selected outlines that exist, with their part. */
  function picked(): { pl: Placed; c: Contour; key: string }[] {
    const out: { pl: Placed; c: Contour; key: string }[] = [];
    for (const pl of job.placed) { const part = partOf(pl); if (part) for (const c of part.contours) if (sel.has(K(pl.id, c.id))) out.push({ pl, c, key: K(pl.id, c.id) }); }
    return out;
  }
  function resolve(key: string): { pl: Placed; c: Contour } | null {
    const [pid, cid] = key.split(':');
    const pl = job.placed.find((q) => q.id === pid); const c = pl && partOf(pl)?.contours.find((x) => x.id === cid);
    return pl && c ? { pl, c } : null;
  }
  const liveCuts = (g: CutGroup) => g.cuts.filter((k) => { const r = resolve(k); return !!r && r.c.op.kind !== 'none'; });
  const selectKeys = (keys: string[]) => { sel = new Set(keys); const first = keys[0] && resolve(keys[0]); selPlaced = first ? first.pl.id : null; refresh(false); };
  /** The groups the selection touches. */
  const selGroups = () => groups().filter((g) => g.cuts.some((k) => sel.has(k)));

  function doGroup() {
    const keys = picked().filter((x) => x.c.op.kind !== 'none').map((x) => x.key);
    if (!keys.length) { flash('Select the cuts to group first (outlines that are set to be cut).'); return; }
    let n = 1; while (groups().some((g) => g.name === `Group ${n}`)) n++;
    const g: CutGroup = { id: camId('g'), name: `Group ${n}`, cuts: keys };
    change((j) => { j.groups = [...(j.groups || []).map((x) => ({ ...x, cuts: x.cuts.filter((k) => !keys.includes(k)) })).filter((x) => x.cuts.length), g]; });
    flash(`${g.name}: ${keys.length} cut${keys.length === 1 ? '' : 's'}. It is one row in the Cut Order.`);
  }
  /** Split: the groups the selection touches are dissolved; their cuts stay where they are in the order. */
  function doUngroup(only?: string) {
    const ids = only ? [only] : selGroups().map((g) => g.id);
    if (!ids.length) { flash('Nothing selected is in a group.'); return; }
    const asShown = toSeq(entries);   // the cuts stay where the group stood
    change((j) => { j.groups = (j.groups || []).filter((g) => !ids.includes(g.id)); if (j.seq) j.seq = asShown; });
  }
  function addToGroup(gid: string) {
    const keys = picked().filter((x) => x.c.op.kind !== 'none').map((x) => x.key);
    if (!keys.length) return;
    change((j) => { j.groups = (j.groups || []).map((g) => ({ ...g, cuts: g.id === gid ? [...new Set([...g.cuts, ...keys])] : g.cuts.filter((k) => !keys.includes(k)) })).filter((g) => g.cuts.length); });
  }
  function removeFromGroup(keys: string[]) {
    change((j) => { j.groups = (j.groups || []).map((g) => ({ ...g, cuts: g.cuts.filter((k) => !keys.includes(k)) })).filter((g) => g.cuts.length); });
  }

  /** Other outlines like this one. 'size': the same shape size and cut; 'type': every hole, every pocket... */
  function selectSimilar(key: string, how: 'size' | 'type') {
    const src = resolve(key); if (!src) return;
    const size = (c: Contour) => { const xs = c.pts.map((p) => p[0]), ys = c.pts.map((p) => p[1]); const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys); return [Math.min(w, h), Math.max(w, h)]; };
    const typeOf = (k: string, c: Contour) => { const cut = plan?.cuts.find((x) => x.key === k); return cut ? groupOf(cut) : c.op.kind; };
    const [sw, sh] = size(src.c), st = typeOf(key, src.c);
    const keys: string[] = [];
    for (const pl of job.placed) for (const c of partOf(pl).contours) {
      const k = K(pl.id, c.id);
      if (how === 'type') { if (typeOf(k, c) === st) keys.push(k); continue; }
      const [w, h] = size(c);
      if (c.closed === src.c.closed && c.op.kind === src.c.op.kind && Math.abs(w - sw) < 0.2 && Math.abs(h - sh) < 0.2) keys.push(k);
    }
    selectKeys([key, ...keys.filter((k) => k !== key)]);
    flash(`${keys.length} selected`);
  }
  const TYPE_WORDS: Record<string, string> = { hole: 'holes', pocket: 'pockets', line: 'on-the-line cuts', inside: 'inside cuts', outside: 'cut-outs', none: 'outlines that are off', on: 'on-the-line cuts' };

  /** Copy how one cut is set to every cut in its group (tabs are spread again on each outline). */
  function applyToGroup(g: CutGroup, from: Contour) {
    const src: Op = JSON.parse(JSON.stringify(from.op));
    const tabKinds = ['outside', 'inside', 'on'];
    change(() => {
      const done = new Set<Contour>([from]);
      for (const k of g.cuts) {
        const r = resolve(k); if (!r || done.has(r.c)) continue;
        done.add(r.c);
        const old = r.c.op;
        const kind = !r.c.closed && src.kind !== 'on' && src.kind !== 'none' ? old.kind : src.kind;   // an open line can't be an inside cut or a pocket
        const tabs = r.c.closed && tabKinds.includes(kind) && src.tabs.length ? (old.tabs.length === src.tabs.length ? old.tabs : spread(src.tabs.length)) : [];
        r.c.op = { ...JSON.parse(JSON.stringify(src)), kind, tabs };
      }
    });
    flash(`Applied to all of ${g.name}.`);
  }

  /** At the top of Properties when the selection is in a group. */
  function groupBar() {
    const gs = selGroups();
    if (gs.length !== 1) return;
    const g = gs[0], live = liveCuts(g), ps = picked();
    if (!ps.every((x) => g.cuts.includes(x.key))) return;
    const box = document.createElement('div'); box.className = 'cm-grpbar';
    const t = document.createElement('b'); t.textContent = `${g.name} · ${live.length} cut${live.length === 1 ? '' : 's'}`;
    const row = document.createElement('div'); row.className = 'cm-row';
    const ap = document.createElement('button'); ap.className = 'btn primary sm'; ap.textContent = 'Apply to entire group';
    ap.title = ps.length > 1 ? 'Every cut in the group gets the settings of the first selected cut' : 'Every cut in the group gets this cut\'s settings: type, depth, bit, passes, tabs';
    ap.onclick = () => applyToGroup(g, ps[0].c);
    row.appendChild(ap);
    if (ps.length < live.length) { const a = document.createElement('button'); a.className = 'btn ghost sm'; a.textContent = 'Select the group'; a.onclick = () => selectKeys(live); row.appendChild(a); }
    box.append(t, row); panel.appendChild(box);
  }

  // right-click menu, on the sheet and in the Cut Order
  let menuEl: HTMLElement | null = null;
  const closeMenu = () => { menuEl?.remove(); menuEl = null; };
  document.addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.contains(e.target as Node)) closeMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); }, true);
  function showMenu(x: number, y: number, key: string | null) {
    closeMenu();
    const items: ([string, () => void, boolean?] | null)[] = [];
    const ps = picked(), cutN = ps.filter((q) => q.c.op.kind !== 'none').length, gs = selGroups();
    if (ps.length) {
      items.push([`Group${cutN > 1 ? ` these ${cutN} cuts` : ''}   ⌘G`, doGroup, !cutN]);
      for (const g of groups()) if (!ps.every((q) => g.cuts.includes(q.key))) items.push([`Add to ${g.name}`, () => addToGroup(g.id), !cutN]);
      if (gs.length) {
        items.push(null);
        items.push(['Remove from group', () => removeFromGroup(ps.map((q) => q.key))]);
        for (const g of gs) items.push([`Split ${g.name}   ⇧⌘G`, () => doUngroup(g.id)]);
        if (gs.length === 1 && ps.length < liveCuts(gs[0]).length) items.push([`Select all of ${gs[0].name}`, () => selectKeys(liveCuts(gs[0]))]);
      }
    }
    if (key) {
      const r = resolve(key);
      if (r) {
        const cut = plan?.cuts.find((c) => c.key === key);
        const ty = cut ? groupOf(cut) : r.c.op.kind;
        if (items.length) items.push(null);
        items.push(['Select similar: same size and cut', () => selectSimilar(key, 'size')]);
        items.push([`Select similar: all ${TYPE_WORDS[ty] || 'like this'}`, () => selectSimilar(key, 'type')]);
        if (sideTab === 'order') items.push(['Open in Properties', () => { sideTab = 'props'; hot.clear(); draw(); render(); }]);
      }
    }
    if (!items.length) return;
    const m = document.createElement('div'); m.className = 'cm-menu';
    for (const it of items) {
      if (!it) { const hr = document.createElement('hr'); m.appendChild(hr); continue; }
      const b = document.createElement('button'); b.textContent = it[0]; b.disabled = !!it[2];
      b.onclick = () => { closeMenu(); it[1](); };
      m.appendChild(b);
    }
    document.body.appendChild(m); menuEl = m;
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 6))}px`;
    m.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 6))}px`;
  }
  svg.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const h = hitOutline(toSheet(e));
    if (h) { const k = K(h.pl.id, h.c.id); if (!sel.has(k)) { sel = new Set([k]); selPlaced = h.pl.id; refresh(false); } showMenu(e.clientX, e.clientY, k); }
    else if (sel.size) showMenu(e.clientX, e.clientY, null);
  });

  // ------------------------------------------------------------ the side panel

  function render() {
    panel.innerHTML = '';
    root.querySelectorAll<HTMLButtonElement>('#cm-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === sideTab));
    if (sideTab === 'order') { orderPanel(); return; }
    const pl = job.placed.find((q) => q.id === selPlaced);
    const part = pl && partOf(pl);
    const ks = [...new Set(picked().map((x) => x.c))];
    if (ks.length) { groupBar(); cutPanel(ks); }
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

  function cutPanel(ks: Contour[]) {
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
    if (part.contours.some((c) => !sel.has(K(pl.id, c.id)))) {
      const a = document.createElement('button'); a.className = 'btn ghost sm'; a.textContent = 'Select every outline';
      a.onclick = () => { sel = selAll(pl); refresh(false); };
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

  // ------------------------------------------------------------ the Cut Order tab

  root.querySelectorAll<HTMLButtonElement>('#cm-tabs button').forEach((b) => {
    b.onclick = () => { sideTab = b.dataset.tab as 'props' | 'order'; hot.clear(); if (sideTab === 'order') loadSpots(); draw(); render(); };
  });
  /** The saved spots live in SnorbCut (on the ShopBot laptop); ask for their names when the tab opens. */
  async function loadSpots() {
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 5000);
      const s = await (await fetch('/cut-api/status', { signal: c.signal })).json(); clearTimeout(t);
      const names = (s.places || []).map((p: any) => String(p.name));
      if (names.join('|') !== spots.join('|')) { spots = names; if (sideTab === 'order') render(); }
    } catch { /* the ShopBot isn't reachable: steps keep the spot names they have */ }
  }
  /** Rearranging: the whole order as shown becomes the job's own. */
  function reorder(fn: (list: Entry[]) => void) {
    const list = [...entries];
    fn(list);
    change(() => { job.seq = toSeq(list); });
  }
  function setStep(id: string, fn: (s: Step) => void) {
    reorder((l) => {
      const e = l.find((x) => x.t === 'step' && x.step.id === id);
      if (!e || e.t !== 'step') return;
      const s = { ...e.step }; fn(s);
      if (s.auto) { delete s.auto; s.id = camId('s'); editStep = s.id; }   // once changed by hand it is the owner's step
      l[l.indexOf(e)] = { t: 'step', step: s };
    });
  }

  function orderPanel() {
    if (!plan || !entries.length) {
      H('Cut Order');
      note(plan ? 'Nothing to cut yet. In Properties, click an outline and pick Inside, Outside or Pocket.' : 'Working out the toolpaths…');
      return;
    }
    const run = runList(entries);
    const stageList = run.filter((r) => r.t === 'stage');
    const nCuts = entries.filter((e) => e.t === 'cut').length;
    H('Cut Order');
    note(`${nCuts} cut${nCuts === 1 ? '' : 's'} in ${stageList.length} stage${stageList.length === 1 ? '' : 's'}, top to bottom. Drag a row or use the arrows; click cuts to select them. ${job.seq ? 'This is your own order.' : 'This is the automatic order: holes, pockets and inside cuts first, cut-outs last.'}`);
    const add = document.createElement('div'); add.className = 'cm-row';
    for (const [kind, t] of [['pause', '+ Pause'], ['toolchange', '+ Tool change'], ['material', '+ Material change'], ['custom', '+ Other step']] as [StepKind, string][]) {
      const b = document.createElement('button'); b.className = 'btn ghost sm'; b.textContent = t;
      b.title = 'Adds the step right after the selected cut or group (at the end of the list if nothing is selected)';
      b.onclick = () => {
        const s = newStep(kind); editStep = s.id;
        // after the last selected cut; a group counts whole, so the step never lands inside it
        let at = -1;
        for (const u of unitsOf(entries)) for (let k = u.start; k < u.start + u.len; k++) { const e = entries[k]; if (e.t === 'cut' && sel.has(e.cut.key)) at = u.start + u.len; }
        reorder((l) => { if (at < 0) l.push({ t: 'step', step: s }); else l.splice(at, 0, { t: 'step', step: s }); });
      };
      add.appendChild(b);
    }
    panel.appendChild(add);

    // group / ungroup for what is selected
    const grow = document.createElement('div'); grow.className = 'cm-row';
    const gb = (txt: string, title: string, fn: () => void, off: boolean) => { const b = document.createElement('button'); b.className = 'btn ghost sm'; b.textContent = txt; b.title = title; b.disabled = off; b.onclick = fn; grow.appendChild(b); };
    const selCuts = picked().filter((x) => x.c.op.kind !== 'none').length;
    gb('Group', 'Keep the selected cuts together as one row (⌘G). Click a cut to select it; ⌘-click or Shift-click for more.', doGroup, !selCuts);
    gb('Split group', 'Take the selected group apart (⇧⌘G)', () => doUngroup(), !selGroups().length);
    panel.appendChild(grow);

    const list = document.createElement('div'); list.className = 'cm-ord';
    const us = unitsOf(entries);
    const moveU = (u: number, to: number) => { if (to < 0 || to >= us.length) return; const l = moveUnit(entries, us, u, to); change(() => { job.seq = toSeq(l); }); };
    // the arrows step over automatic tool changes (those follow the bits, they can't be passed)
    const isAuto = (k: number) => { const e = entries[us[k].start]; return e.t === 'step' && !!e.step.auto; };
    const nudge = (u: number, dir: 1 | -1) => { let to = u + dir; if (!isAuto(u)) while (to >= 0 && to < us.length && isAuto(to)) to += dir; moveU(u, to); };
    const canNudge = (u: number, dir: 1 | -1) => { let to = u + dir; if (!isAuto(u)) while (to >= 0 && to < us.length && isAuto(to)) to += dir; return to >= 0 && to < us.length; };
    let stageNo = 0, lastWasCut = false, cutNo = 0, lastBit = '';
    const stageHead = (e: Entry): HTMLElement | null => {
      let h: HTMLElement | null = null;
      if (e.t === 'cut' && (!lastWasCut || e.cut.bit.id !== lastBit)) {
        const st = stageList[stageNo++];
        if (st && st.t === 'stage') { h = document.createElement('div'); h.className = 'cm-ord-stage'; h.textContent = `Stage ${st.stage.n} · ${st.stage.bit.name}`; }
      }
      lastWasCut = e.t === 'cut'; if (e.t === 'cut') lastBit = e.cut.bit.id;
      return h;
    };
    const tools = (row: HTMLElement) => {
      const box = document.createElement('div'); box.className = 'cm-ord-tools'; row.appendChild(box);
      return (txt: string, title: string, fn: () => void, off = false) => { const b = document.createElement('button'); b.className = 'cm-ord-b'; b.textContent = txt; b.title = title; b.disabled = off; b.onclick = (ev) => { ev.stopPropagation(); fn(); }; box.appendChild(b); };
    };
    // dragging a row by its grip (pointer events, so it works with a mouse, a trackpad and a finger)
    const gripFor = (row: HTMLElement, u: number) => {
      const grip = document.createElement('span'); grip.className = 'cm-ord-grip'; grip.textContent = '⋮⋮'; grip.title = 'Drag to move';
      grip.onpointerdown = (ev) => {
        ev.preventDefault(); grip.setPointerCapture(ev.pointerId); row.classList.add('drag');
        let to = u;
        const clear = () => list.querySelectorAll('.over-a, .over-b').forEach((x) => x.classList.remove('over-a', 'over-b'));
        grip.onpointermove = (mv) => {
          clear();
          const rows = [...list.querySelectorAll<HTMLElement>('[data-u]')];
          let best: HTMLElement | null = null, after = false;
          for (const r of rows) { const b = r.getBoundingClientRect(); if (mv.clientY >= b.top - 6) { best = r; after = mv.clientY > b.top + b.height / 2; } }
          if (!best) { best = rows[0]; after = false; }
          const bi = +best.dataset.u!;
          to = bi + (after ? 1 : 0); if (u < to) to--;
          if (to !== u) best.classList.add(after ? 'over-b' : 'over-a');
          // keep the list scrolling while dragging near its edges
          const pr = panel.getBoundingClientRect();
          if (mv.clientY < pr.top + 30) panel.scrollTop -= 12; else if (mv.clientY > pr.bottom - 30) panel.scrollTop += 12;
        };
        const end = (cancel: boolean) => { grip.onpointermove = grip.onpointerup = grip.onpointercancel = null; clear(); row.classList.remove('drag'); if (!cancel && to !== u) moveU(u, to); };
        grip.onpointerup = () => end(false);
        grip.onpointercancel = () => end(true);
      };
      return grip;
    };
    const cutBody = (e: Entry & { t: 'cut' }, row: HTMLElement) => {
      const body = document.createElement('div'); body.className = 'cm-ord-body';
      const t = document.createElement('b'), sub = document.createElement('span');
      t.textContent = `${++cutNo}. ${e.cut.label}`;
      const deep = -e.cut.levels[e.cut.levels.length - 1];
      sub.textContent = `${GROUP_NAME[e.group]} · ${fmt(deep)} ${units} deep${e.cut.levels.length > 1 ? ` in ${e.cut.levels.length} passes` : ''}`;
      body.append(t, sub);
      if (e.warn) { const w = document.createElement('span'); w.className = 'cm-ord-warn'; w.textContent = `⚠ ${e.warn}`; body.appendChild(w); }
      const key = e.cut.key;
      if (sel.has(key)) row.classList.add('sel');
      row.onmouseenter = () => { hot = new Set([key]); draw(); };
      row.onmouseleave = () => { if (hot.has(key)) { hot.clear(); draw(); } };
      row.onclick = (ev) => {
        if (ev.metaKey || ev.shiftKey || ev.ctrlKey) { if (sel.has(key)) sel.delete(key); else sel.add(key); selPlaced = key.split(':')[0]; refresh(false); }
        else selectKeys([key]);
      };
      row.ondblclick = () => { selectKeys([key]); sideTab = 'props'; hot.clear(); draw(); render(); };
      row.oncontextmenu = (ev) => { ev.preventDefault(); if (!sel.has(key)) selectKeys([key]); showMenu(ev.clientX, ev.clientY, key); };
      body.title = 'Click to select (⌘-click for more), double-click to open in Properties, right-click for more';
      return body;
    };
    us.forEach((u, ui) => {
      const first = entries[u.start];
      const g = u.gid ? groups().find((x) => x.id === u.gid) : undefined;
      if (g && first.t === 'cut') {
        // a group: one row; its cuts show underneath when it is opened
        const inner = entries.slice(u.start, u.start + u.len);
        const cuts = inner.filter((x): x is Entry & { t: 'cut' } => x.t === 'cut');
        const keys = cuts.map((x) => x.cut.key);
        const open = openGroups.has(g.id);
        const h0 = stageHead(first); if (h0) list.appendChild(h0);
        const row = document.createElement('div'); row.className = 'cm-ord-row cm-ord-grp'; row.dataset.u = String(ui);
        if (keys.every((k) => sel.has(k))) row.classList.add('sel');
        const body = document.createElement('div'); body.className = 'cm-ord-body';
        const sub = document.createElement('span');
        const kinds = [...new Set(cuts.map((x) => GROUP_NAME[x.group]))], bits = [...new Set(cuts.map((x) => x.cut.bit.name))];
        sub.textContent = `${cuts.length} cut${cuts.length === 1 ? '' : 's'} · ${kinds.length === 1 ? kinds[0] : 'mixed'} · ${bits.length === 1 ? bits[0] : `${bits.length} bits (tool change inside)`}`;
        if (nameGroup === g.id) {
          const inp = document.createElement('input'); inp.className = 'cm-input'; inp.value = g.name; inp.spellcheck = false;
          const done = () => { const v = inp.value.trim(); nameGroup = ''; if (v && v !== g.name) change((j) => { j.groups = (j.groups || []).map((x) => (x.id === g.id ? { ...x, name: v } : x)); }); else render(); };
          inp.onkeydown = (ev) => { if (ev.key === 'Enter') inp.blur(); if (ev.key === 'Escape') { inp.value = g.name; inp.blur(); } };
          inp.onblur = done; inp.onclick = (ev) => ev.stopPropagation();
          body.append(inp, sub); setTimeout(() => { inp.focus(); inp.select(); });
        } else { const t = document.createElement('b'); t.textContent = g.name; body.append(t, sub); }
        const warn = cuts.find((x) => x.warn); if (warn) { const w = document.createElement('span'); w.className = 'cm-ord-warn'; w.textContent = `⚠ ${warn.warn}`; body.appendChild(w); }
        row.onmouseenter = () => { hot = new Set(keys); draw(); };
        row.onmouseleave = () => { hot.clear(); draw(); };
        row.onclick = (ev) => { if (ev.metaKey || ev.shiftKey || ev.ctrlKey) { const allIn = keys.every((k) => sel.has(k)); keys.forEach((k) => (allIn ? sel.delete(k) : sel.add(k))); refresh(false); } else selectKeys(keys); };
        row.ondblclick = () => { selectKeys(keys); sideTab = 'props'; hot.clear(); draw(); render(); };
        row.oncontextmenu = (ev) => { ev.preventDefault(); if (!keys.every((k) => sel.has(k))) selectKeys(keys); showMenu(ev.clientX, ev.clientY, null); };
        body.title = 'Click to select the group, double-click to open it in Properties, right-click for more';
        row.append(gripFor(row, ui), body);
        const tb = tools(row);
        tb(open ? '▾' : '▸', open ? 'Hide the cuts in this group' : 'Show the cuts in this group', () => { if (open) openGroups.delete(g.id); else openGroups.add(g.id); render(); });
        tb('▲', 'Earlier', () => nudge(ui, -1), !canNudge(ui, -1));
        tb('▼', 'Later', () => nudge(ui, 1), !canNudge(ui, 1));
        tb('✎', 'Rename this group', () => { nameGroup = g.id; render(); });
        tb('Split', 'Take the group apart; the cuts stay where they are', () => doUngroup(g.id));
        list.appendChild(row);
        const kids = document.createElement('div'); kids.className = 'cm-ord-kids';
        inner.forEach((e, n) => {
          const h = n ? stageHead(e) : null;
          if (e.t === 'cut') {
            if (h) kids.appendChild(h);
            const r = document.createElement('div'); r.className = `cm-ord-row cm-ord-cut cm-ord-sub cm-g-${e.group}`;
            r.appendChild(cutBody(e, r));
            tools(r)('✕', 'Take this cut out of the group', () => removeFromGroup([e.cut.key]));
            kids.appendChild(r);
          } else { const sn = document.createElement('div'); sn.className = 'cm-ord-stage'; sn.textContent = `${e.step.name} (${describeStep(e.step)})`; kids.appendChild(sn); }
        });
        if (open) list.appendChild(kids);
        return;
      }
      const e = first;
      const h = stageHead(e); if (h) list.appendChild(h);
      const row = document.createElement('div');
      row.className = `cm-ord-row ${e.t === 'cut' ? `cm-ord-cut cm-g-${e.group}` : 'cm-ord-step'}`;
      row.dataset.u = String(ui);
      row.appendChild(gripFor(row, ui));
      if (e.t === 'cut') row.appendChild(cutBody(e, row));
      else {
        const body = document.createElement('div'); body.className = 'cm-ord-body';
        const t = document.createElement('b'), sub = document.createElement('span');
        const s = e.step;
        t.textContent = s.name || STEP_NAME[s.kind];
        sub.textContent = `${STEP_NAME[s.kind]}${s.auto ? ' (automatic: the bit changes here)' : ''}: ${describeStep(s)}`;
        body.append(t, sub);
        if (s.note) { const n = document.createElement('span'); n.className = 'cm-ord-note'; n.textContent = s.note; body.appendChild(n); }
        row.appendChild(body);
      }
      const tb = tools(row);
      tb('▲', 'Earlier', () => nudge(ui, -1), !canNudge(ui, -1));
      tb('▼', 'Later', () => nudge(ui, 1), !canNudge(ui, 1));
      if (e.t === 'step') {
        const s = e.step;
        tb(editStep === s.id ? 'Done' : 'Edit', 'What this step does', () => { editStep = editStep === s.id ? '' : s.id; render(); });
        tb('✕', s.auto ? 'The bit changes here, so a tool change is needed' : 'Remove this step', () => reorder((l) => { l.splice(u.start, 1); }), !!s.auto);
      }
      list.appendChild(row);
      if (e.t === 'step' && editStep === e.step.id) list.appendChild(stepEditor(e.step));
    });
    panel.appendChild(list);
    const foot = document.createElement('div'); foot.className = 'cm-row';
    const auto = document.createElement('button'); auto.className = 'btn ghost sm'; auto.textContent = 'Back to the automatic order';
    auto.disabled = !job.seq; auto.title = 'Drops your arrangement and every step you added';
    auto.onclick = () => { if (window.confirm('Go back to the automatic order? Your arrangement and the steps you added are removed. Groups stay.')) { editStep = ''; change(() => { delete job.seq; }); } };
    foot.appendChild(auto);
    panel.appendChild(foot);
    note('Each stage is one G-code file. Steps happen between stages: the machine stops and waits for you at the ShopBot.');
  }

  function stepEditor(s: Step): HTMLElement {
    const box = document.createElement('div'); box.className = 'cm-ord-edit';
    const lab = (t: string, child: HTMLElement) => { const l = document.createElement('label'); l.className = 'cm-stack'; const sp = document.createElement('span'); sp.textContent = t; l.append(sp, child); box.appendChild(l); };
    const name = document.createElement('input'); name.className = 'cm-text'; name.value = s.name; name.maxLength = 40;
    name.onchange = () => setStep(s.id, (x) => { x.name = name.value.trim() || STEP_NAME[x.kind]; });
    lab('Name', name);
    const kind = document.createElement('select'); kind.className = 'cm-select';
    for (const k of ['pause', 'toolchange', 'material', 'custom'] as StepKind[]) kind.appendChild(new Option(k === 'custom' ? 'Other' : STEP_NAME[k], k, false, k === s.kind));
    kind.onchange = () => setStep(s.id, (x) => { const was = STEP_NAME[x.kind]; x.kind = kind.value as StepKind; if (x.name === was) x.name = STEP_NAME[x.kind]; });
    lab('Kind', kind);
    const go = document.createElement('select'); go.className = 'cm-select';
    const places: [string, string][] = [['', 'Stay where it is'], ['machine', 'Machine Home'], ['project', 'Project Home'], ...spots.map((n) => [n, n] as [string, string])];
    if (s.goto && !places.some((p) => p[0] === s.goto)) places.push([s.goto, `${s.goto} (not found in SnorbCut right now)`]);
    for (const [v, t] of places) go.appendChild(new Option(t, v, false, v === s.goto));
    go.onchange = () => setStep(s.id, (x) => { x.goto = go.value; });
    lab('Move the head to', go);
    if (!spots.length) { const n = document.createElement('div'); n.className = 'ds-note'; n.textContent = 'Saved spots such as Load Bit come from SnorbCut (Machine control › Saved spots). None could be read just now.'; box.appendChild(n); }
    const zr = document.createElement('label'); zr.className = 'cm-check';
    const zc = document.createElement('input'); zc.type = 'checkbox'; zc.checked = s.rezero;
    zc.onchange = () => setStep(s.id, (x) => { x.rezero = zc.checked; });
    zr.append(zc, document.createTextNode(' Ask for a new Z zero before carrying on'));
    box.appendChild(zr);
    const nt = document.createElement('input'); nt.className = 'cm-text'; nt.value = s.note; nt.maxLength = 120; nt.placeholder = 'For example: fit the 1/8" bit';
    nt.onchange = () => setStep(s.id, (x) => { x.note = nt.value.trim(); });
    lab('Note shown at the machine', nt);
    const sum = document.createElement('div'); sum.className = 'ds-note'; sum.textContent = `At this step the machine will: stop, ${describeStep(s)}.`; box.appendChild(sum);
    return box;
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
        entries = sequence(job, plan);
        timeS = runList(entries).reduce((t, r) => t + (r.t === 'stage' ? runTime(job, movesFor(job, r.stage.cuts), r.stage.bit) : 0), 0);
      } catch (e: any) { plan = null; entries = []; flash(`Toolpaths failed: ${e.message}`); }
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
      const nStages = runList(entries).filter((r) => r.t === 'stage').length;
      s.push(`${plan.cuts.length} cut${plan.cuts.length === 1 ? '' : 's'}${nStages > 1 ? ` in ${nStages} stages` : ''}`);
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
    undo.length = 0; redo.length = 0; dirty = false; selPlaced = null; sel.clear();
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
    undo.length = 0; redo.length = 0; dirty = false; selPlaced = null; sel.clear();
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
    const run = runList(sequence(job, p));
    const groups = run.flatMap((r) => (r.t === 'stage' ? [r.stage] : []));
    const steps = run.filter((r) => r.t === 'step').length;
    groups.forEach((g, i) => {
      const nc = gcode(job, movesFor(job, g.cuts), g.bit);
      const tag = groups.length > 1 ? ` - ${i + 1} ${g.bit.name.replace(/["/\\]/g, (c) => (c === '"' ? 'in' : '-'))}` : '';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([nc], { type: 'text/plain' }));
      a.download = `${job.name || 'job'}${tag}.nc`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    flash(groups.length > 1 ? `${groups.length} files, one per stage: run them in order${steps ? `, doing the ${steps} step${steps > 1 ? 's' : ''} in Cut Order between them` : ''}.` : `Exported ${job.name}.nc for the ${groups[0].bit.name}`);
    if (p.warnings.length) flash(p.warnings.join(' · '));
  };

  /** The whole job, cut order and steps included, to SnorbCut. It is started at the ShopBot laptop. */
  $('#cm-send').onclick = async () => {
    const p = planJob(job);
    if (!p.cuts.length) { flash(p.warnings[0] || 'Nothing to cut yet: click an outline and pick Inside, Outside or Pocket.'); return; }
    const off = job.placed.filter((pl) => { const [x0, y0, x1, y1] = placedBox(partOf(pl), pl); return x0 < -1e-6 || y0 < -1e-6 || x1 > job.sheet.w + 1e-6 || y1 > job.sheet.h + 1e-6; });
    if (off.length && !window.confirm(`${off.length} part${off.length > 1 ? 's are' : ' is'} off the edge of the sheet. Send anyway?`)) return;
    const run = runList(sequence(job, p));
    const stages = run.filter((r) => r.t === 'stage').length, steps = run.length - stages;
    try {
      const r = await fetch(`/cut-api/plan?name=${encodeURIComponent(job.name || 'job')}`, { method: 'POST', body: planText(job, run) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) throw new Error((j && j.message) || 'the ShopBot laptop did not answer');
      flash(`Sent to SnorbCut: ${stages} stage${stages > 1 ? 's' : ''}${steps ? ` and ${steps} step${steps > 1 ? 's' : ''}` : ''}. Start it at the ShopBot laptop.`);
      (studio as any)?.show?.('cut');
    } catch (e: any) { flash(`Couldn't send it: ${e.message}. Is the ShopBot laptop on, with SnorbCut running?`); }
  };

  // ------------------------------------------------------------ start

  new ResizeObserver(() => { if (svg.getBoundingClientRect().width) { if (!fitted) { fitted = true; fit(); } draw(); } }).observe(svg);
  let fitted = false;
  refresh();
  (window as any).__cam = { get job() { return job; }, get plan() { return plan; }, get entries() { return entries; } };
  return {
    /** Add a SnorbCAD project (from the Design tab's "Send to SnorbCAM"). */
    addCad(p: any, name?: string) { addCad(p, name || p.name || 'part'); },
  };
}

