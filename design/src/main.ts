// The Design tab: an orthographic drafting sheet that builds a printable
// solid. Studio loads this module the first time the tab is opened.

import type { Feature, Project } from './model.js';
import { newProject, newId, isShape } from './model.js';
import { State, align, distribute, type AlignHow, type Tool } from './state.js';
import { VIEWS, parallel } from './views.js';
import { fmtLen } from './sheet.js';
import { Sheet, isTyping } from './sheet.js';
import { Panel, featureName } from './panel.js';
import { Preview3D } from './preview3d.js';
import { openGearDialog } from './geardialog.js';

interface Studio {
  prepare: { addFiles(files: { name: string; buffer: ArrayBuffer }[]): Promise<void> };
  show(page: string): void;
  onPage(fn: (p: string) => void): void;
  page: string;
}

const ico = (body: string) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;
const ICONS = {
  select: ico('<path d="M6 3.5l12.5 8.2-6 1.2-3 5.6z" fill="currentColor" stroke-width="1.2"/>'),
  rect: ico('<rect x="4" y="6" width="16" height="12" rx="0.5"/>'),
  circle: ico('<circle cx="12" cy="12" r="8"/>'),
  zoom: ico('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5l5 5M7.5 10.5h6M10.5 7.5v6"/>'),
  polygon: ico('<path d="M8 4.5h8l4 7.5-4 7.5H8l-4-7.5z"/>'),
  line: ico('<path d="M4 19l4-11 6 6 6-10"/><circle cx="4" cy="19" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="14" cy="14" r="1.3" fill="currentColor"/><circle cx="20" cy="4" r="1.3" fill="currentColor"/>'),
  gear: ico('<circle cx="12" cy="12" r="3"/><path d="M10.6 3h2.8l.5 2.6 2 .9 2.2-1.5 2 2-1.5 2.2.9 2 2.6.5v2.8l-2.6.5-.9 2 1.5 2.2-2 2-2.2-1.5-2 .9-.5 2.6h-2.8l-.5-2.6-2-.9-2.2 1.5-2-2 1.5-2.2-.9-2L3 13.4v-2.8l2.6-.5.9-2L5 5.9l2-2 2.2 1.5 2-.9z"/>'),
  text: ico('<path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6"/>'),
  edge: ico('<path d="M4 20V12a8 8 0 0 1 8-8h8"/><path d="M4 20h16V4" stroke-dasharray="2 2.5"/>'),
  dim: ico('<path d="M3 8v8M21 8v8M3 12h18M6 9.5L3 12l3 2.5M18 9.5l3 2.5-3 2.5"/>'),
  far: ico('<rect x="4" y="4" width="16" height="16" rx="1"/><rect x="8" y="8" width="8" height="8" stroke-dasharray="2.2 1.8"/>'),
  left: ico('<path d="M4 3v18"/><rect x="7" y="6" width="12" height="4"/><rect x="7" y="14" width="7" height="4"/>'),
  hcenter: ico('<path d="M12 3v18"/><rect x="5" y="6" width="14" height="4"/><rect x="8" y="14" width="8" height="4"/>'),
  right: ico('<path d="M20 3v18"/><rect x="5" y="6" width="12" height="4"/><rect x="10" y="14" width="7" height="4"/>'),
  top: ico('<path d="M3 4h18"/><rect x="6" y="7" width="4" height="12"/><rect x="14" y="7" width="4" height="7"/>'),
  vmiddle: ico('<path d="M3 12h18"/><rect x="6" y="5" width="4" height="14"/><rect x="14" y="8" width="4" height="8"/>'),
  bottom: ico('<path d="M3 20h18"/><rect x="6" y="5" width="4" height="12"/><rect x="14" y="10" width="4" height="7"/>'),
  disth: ico('<path d="M3 4v16M21 4v16"/><rect x="6" y="8" width="3" height="8"/><rect x="15" y="8" width="3" height="8"/><rect x="10.5" y="8" width="3" height="8"/>'),
  distv: ico('<path d="M4 3h16M4 21h16"/><rect x="8" y="6" width="8" height="3"/><rect x="8" y="15" width="8" height="3"/><rect x="8" y="10.5" width="8" height="3"/>'),
  trash: ico('<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>'),
};

const html = `
<div class="ds-tools">
  <div class="ds-ctx" id="ds-ctx"></div>
  <span class="spacer"></span>
  <span class="ds-busy hidden" id="ds-busy">Building…</span>
  <div class="ds-seg">
    <button id="ds-undo" title="Undo (⌘Z)">Undo</button>
    <button id="ds-redo" title="Redo (⇧⌘Z)">Redo</button>
  </div>
  <button class="btn sm ghost" id="ds-fit" title="Fit the sheet (F)">Fit</button>
  <input class="ds-name" id="ds-name" title="Part name" spellcheck="false">
  <button class="btn sm ghost" id="ds-new" title="Start a new part">New</button>
  <button class="btn sm ghost" id="ds-open" title="Open a part saved on the printer">Open…</button>
  <button class="btn sm ghost" id="ds-save" title="Save this part on the printer (⌘S)">Save</button>
  <button class="btn sm ghost" id="ds-stl" title="Download the STL">STL</button>
  <button class="btn sm primary" id="ds-send" title="Put it on the plate in Prepare">Send to Prepare</button>
</div>
<div class="ds-body">
  <nav class="ds-toolbox" id="ds-tool">
    <button data-tool="select" title="Select (V)&#10;Shift-click or drag a box to select several.&#10;Option-click a side of a rectangle.">${ICONS.select}</button>
    <button data-tool="rect" title="Rectangle (R)">${ICONS.rect}</button>
    <button data-tool="circle" title="Circle (C): drag out from the centre">${ICONS.circle}</button>
    <button data-tool="polygon" title="Polygon (P): drag out from the centre&#10;Set the number of sides on the right.">${ICONS.polygon}</button>
    <button data-tool="line" title="Line (L): click each corner of an outline,&#10;click the first one (or press Return) to close it.&#10;Shift keeps a side level or plumb.">${ICONS.line}</button>
    <button data-tool="gear" title="Gear (G): drag out roughly how big,&#10;then set it up in the box that opens.">${ICONS.gear}</button>
    <button data-tool="text" title="Text (T): click where it goes">${ICONS.text}</button>
    <span class="ds-tool-sep"></span>
    <button data-toggle="far" title="Hidden lines (H): draw on the far face of the part,&#10;seen through it. New shapes go on the back as pockets.">${ICONS.far}</button>
    <span class="ds-tool-sep"></span>
    <button data-tool="edge" title="Edges (E): click edges in any view to fillet or chamfer them.&#10;Shift-click for more.">${ICONS.edge}</button>
    <button data-tool="dim" title="Dimension (D): click a shape near the side to measure.&#10;Double-click a dimension's number to type a new size.">${ICONS.dim}</button>
    <span class="ds-tool-sep"></span>
    <button data-tool="zoom" title="Zoom (Z)&#10;Click to zoom in, Option-click to zoom out,&#10;drag a box to zoom to it.">${ICONS.zoom}</button>
  </nav>
  <div class="ds-sheet-wrap" id="ds-sheet"><div class="ds-loading" id="ds-loading">Loading the CAD engine…</div></div>
  <div class="ds-splitter" id="ds-splitter" title="Drag to resize the panel (double-click to reset)"></div>
  <aside class="ds-side" id="ds-side">
    <div class="ds-3d" id="ds-3d"></div>
    <div class="ds-panel" id="ds-panel"></div>
  </aside>
</div>
<div class="ds-status"><span id="ds-status"></span><span class="spacer"></span>
  <button class="ds-zbtn" id="ds-zout" title="Zoom out (⌘−)">−</button>
  <button class="ds-zpct" id="ds-zpct" title="Actual size (⌘1)">100%</button>
  <button class="ds-zbtn" id="ds-zin" title="Zoom in (⌘+)">+</button>
  <button class="ds-zbtn ds-zfit" id="ds-zfit" title="Fit the sheet (⌘0 or F)">Fit</button>
</div>`;

export function mount(root: HTMLElement, studio: Studio) {
  root.innerHTML = html;
  const $ = (s: string) => root.querySelector(s) as HTMLElement;
  const st = new State();
  const sheet = new Sheet($('#ds-sheet'), st);
  new Panel($('#ds-panel'), st, {
    gear: (id) => editGear(id, false),
    dimValue: (dm) => sheet.dimGeom(dm)?.value ?? null,
    dimSize: (dm, size) => sheet.resizeTo(dm, size),
  });
  const preview = new Preview3D($('#ds-3d'));
  (window as any).__design = { st, sheet };     // for poking at from the console
  // the panel on the right: drag its edge to make it narrower or wider (remembered)
  const side = $('#ds-side'), split = $('#ds-splitter');
  const PANEL_KEY = 'studio.design.panelWidth', PANEL_DEFAULT = 300;
  const setPanel = (w: number) => { side.style.width = `${Math.round(Math.max(200, Math.min(640, w)))}px`; };
  try { const w = +(localStorage.getItem(PANEL_KEY) || 0); if (w) setPanel(w); } catch { /* default */ }
  split.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    split.setPointerCapture(e.pointerId);
    split.classList.add('dragging');
    const x0 = e.clientX, w0 = side.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => setPanel(w0 - (ev.clientX - x0));
    const up = () => {
      split.classList.remove('dragging');
      split.removeEventListener('pointermove', move);
      split.removeEventListener('pointerup', up);
      try { localStorage.setItem(PANEL_KEY, String(side.getBoundingClientRect().width)); } catch { /* ignore */ }
    };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', up);
  });
  split.addEventListener('dblclick', () => { setPanel(PANEL_DEFAULT); try { localStorage.removeItem(PANEL_KEY); } catch { /* ignore */ } });

  sheet.onStatus = (t) => { $('#ds-status').textContent = t; };
  sheet.onGear = (id) => editGear(id, true);
  sheet.onText = () => requestAnimationFrame(() => { const i = root.querySelector('#ds-text-input') as HTMLInputElement | null; if (i) { i.focus(); i.select(); } });
  sheet.onEdges = () => { st.emit('select'); };

  /** The gear box: on a new gear, Cancel takes it away again. */
  function editGear(id: string, isNew: boolean) {
    const f = st.feature(id);
    if (!f || !f.gear) return;
    const others = st.p.features.filter((q) => q.id !== id && q.type === 'gear' && q.gear && (q.gear.kind === 'spur' || q.gear.kind === 'helical'))
      .map((q) => ({ id: q.id, label: `${featureName(q)} (module ${+q.gear!.module.toFixed(3)})`, gear: q.gear!, view: q.view, cu: q.cu, cv: q.cv, rot: q.rot || 0, d0: q.d0, d1: q.d1, same: parallel(q.view, f.view) }));
    openGearDialog(root, {
      gear: f.gear, thickness: Math.abs(f.d1 - f.d0) || 5, units: st.p.units, isNew,
      others: others.filter((o) => o.same),
      apply: (r) => {
        st.change(() => {
          f.gear = r.gear;
          const dir = f.d1 >= f.d0 ? 1 : -1;
          f.d1 = f.d0 + dir * r.thickness;
          if (r.place) { f.cu = r.place.cu; f.cv = r.place.cv; f.rot = r.place.rot; f.d0 = r.place.d0; f.d1 = r.place.d1; }
          f.r = 0;
        }, !isNew);
        if (isNew) st.save();
      },
      cancel: () => { if (isNew) { st.undo(); st.select([]); } },
    });
  }
  sheet.onZoom = () => { $('#ds-zpct').textContent = `${Math.round(sheet.zoomPct)}%`; };
  $('#ds-zin').onclick = () => sheet.zoomBy(1.5);
  $('#ds-zout').onclick = () => sheet.zoomBy(1 / 1.5);
  $('#ds-zpct').onclick = () => sheet.zoomBy(100 / sheet.zoomPct);
  $('#ds-zfit').onclick = () => sheet.fit();

  // ---------------------------------------------------------- the worker
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  let nextId = 1;
  const waiting = new Map<number, { ok: (v: any) => void; err: (e: Error) => void }>();
  worker.onmessage = (ev) => {
    const m = ev.data, w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.ok) w.ok(m.result); else if (m.skipped) w.ok(null); else w.err(new Error(m.error));
  };
  worker.onerror = (e) => { $('#ds-loading').textContent = `The CAD engine failed to start: ${e.message}`; };
  const call = (msg: object, transfer: Transferable[] = []) => new Promise<any>((ok, err) => {
    const id = nextId++;
    waiting.set(id, { ok, err });
    worker.postMessage({ ...msg, id }, transfer);
  });

  // one build in flight; edits made meanwhile are built straight after
  let inFlight = false, pending = false;
  const requestBuild = async () => {
    if (inFlight) { pending = true; return; }
    inFlight = true;
    $('#ds-busy').classList.remove('hidden');
    const project: Project = JSON.parse(JSON.stringify(st.p));
    try {
      const r = await call({ type: 'build', project, views: ['top', 'front', 'right', 'left', 'back', 'bottom'] });
      if (r) {
        st.built = r;
        st.buildError = '';
        // text: the font decides its size, so take the measured box (not an undo step)
        for (const [id, wh] of Object.entries(r.textSize || {}) as [string, [number, number]][]) {
          const f = st.feature(id);
          if (f && (Math.abs(f.w - wh[0]) > 1e-3 || Math.abs(f.h - wh[1]) > 1e-3)) { f.w = wh[0]; f.h = wh[1]; st.save(); }
        }
        $('#ds-loading').classList.add('hidden');
        preview.setMesh(r.mesh);
        sheet.rebuilt();
        sheet.relayout();
        sheet.autoFit();
        st.emit('built');
      }
    } catch (e: any) {
      st.buildError = e.message;
      $('#ds-status').textContent = `Couldn't build the part: ${e.message}`;
    }
    inFlight = false;
    $('#ds-busy').classList.add('hidden');
    if (pending) { pending = false; requestBuild(); }
  };

  st.on((w) => {
    if (w === 'model') { requestBuild(); sheet.relayout(); }
    if (w === 'view') sheet.fit();
    if (w === 'tool') sheet.cancelLine();
    sheet.render();
    syncToolbar();
  });

  // ---------------------------------------------------------- toolbar
  root.querySelectorAll<HTMLButtonElement>('#ds-tool button[data-tool]').forEach((b) => { b.onclick = () => st.setTool(b.dataset.tool as Tool); });
  const toggleFar = () => {
    st.farFace = !st.farFace;
    // the hidden-line toggle goes with drawing, so pick a drawing tool if none is
    if (st.farFace && !['rect', 'circle', 'polygon', 'line', 'text'].includes(st.tool)) st.setTool('rect'); else st.emit('tool');
  };
  ($('#ds-tool button[data-toggle="far"]') as HTMLButtonElement).onclick = toggleFar;
  $('#ds-undo').onclick = () => st.undo();
  $('#ds-redo').onclick = () => st.redo();
  $('#ds-fit').onclick = () => sheet.fit();
  const name = $('#ds-name') as HTMLInputElement;
  name.onchange = () => st.change((p) => { p.name = name.value.trim().replace(/[\\/]/g, '-') || 'part'; });
  name.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); };
  $('#ds-new').onclick = () => {
    if (st.p.features.length && !confirm('Start a new part? (Undo brings this one back.)')) return;
    st.load(newProject());
    sheet.fit();
  };
  // ---------------------------------------------------------- save / open on the printer
  const API = '/studio-api/designs/';
  const flash = (t: string) => { $('#ds-status').textContent = t; };
  const save = async () => {
    const nm = (st.p.name || 'part').trim();
    try {
      const r = await fetch(`${API}${encodeURIComponent(nm)}.json`, { method: 'PUT', body: JSON.stringify(st.p), headers: { 'Content-Type': 'application/json' } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      flash(`Saved “${nm}” on the printer.`);
    } catch (e: any) { flash(`Couldn't save: ${e.message}`); }
  };
  $('#ds-save').onclick = save;
  $('#ds-open').onclick = async () => {
    let list: { name: string; modified: number }[] = [];
    try { list = (await (await fetch(API.slice(0, -1))).json()).designs || []; } catch (e: any) { flash(`Couldn't list saved parts: ${e.message}`); return; }
    const box = document.createElement('div');
    box.className = 'ds-modal';
    const card = document.createElement('div');
    card.className = 'ds-dialog';
    card.innerHTML = `<h3>Open a part</h3>${list.length ? '' : '<p class="ds-note">Nothing saved on the printer yet. Use Save.</p>'}`;
    const ul = document.createElement('div');
    ul.className = 'ds-list ds-open-list';
    for (const d of list) {
      const row = document.createElement('div');
      row.className = 'ds-open-row';
      const b = document.createElement('button');
      b.textContent = d.name;
      b.title = new Date(d.modified * 1000).toLocaleString();
      b.onclick = async () => {
        try {
          const p = await (await fetch(`${API}${encodeURIComponent(d.name)}.json`)).json();
          st.load(p);
          sheet.fit();
          close();
          flash(`Opened “${d.name}”.`);
        } catch (e: any) { flash(`Couldn't open it: ${e.message}`); }
      };
      const del = document.createElement('button');
      del.className = 'ds-open-del';
      del.textContent = '×';
      del.title = 'Delete this saved part from the printer';
      let armed = false;
      del.onclick = async () => {
        // two clicks to delete: no browser dialogs
        if (!armed) { armed = true; del.textContent = 'Delete?'; del.classList.add('armed'); return; }
        await fetch(`${API}${encodeURIComponent(d.name)}.json`, { method: 'DELETE' });
        row.remove();
      };
      row.append(b, del);
      ul.appendChild(row);
    }
    card.appendChild(ul);
    const foot = document.createElement('div');
    foot.className = 'ds-dialog-foot';
    const cancel = document.createElement('button');
    cancel.className = 'btn sm ghost';
    cancel.textContent = 'Cancel';
    foot.appendChild(cancel);
    card.appendChild(foot);
    box.appendChild(card);
    root.appendChild(box);
    const close = () => box.remove();
    cancel.onclick = close;
    box.addEventListener('pointerdown', (e) => { if (e.target === box) close(); });
  };

  const fileName = () => `${(st.p.name || 'part').replace(/\.stl$/i, '')}.stl`;
  const getSTL = async (): Promise<ArrayBuffer> => call({ type: 'stl', project: JSON.parse(JSON.stringify(st.p)) });
  $('#ds-stl').onclick = async () => {
    const buf = await getSTL();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'model/stl' }));
    a.download = fileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $('#ds-send').onclick = async () => {
    const b = $('#ds-send') as HTMLButtonElement;
    b.disabled = true;
    try {
      const buf = await getSTL();
      studio.show('prepare');
      await studio.prepare.addFiles([{ name: fileName(), buffer: buf }]);
      // pick how it sits on the bed; Prepare shows it and can be changed there
      (document.querySelector('#auto-orient') as HTMLButtonElement | null)?.click();
    } finally { b.disabled = false; }
  };

  function syncToolbar() {
    root.querySelectorAll<HTMLButtonElement>('#ds-tool button[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === st.tool));
    $('#ds-tool button[data-toggle="far"]').classList.toggle('active', st.farFace);
    ($('#ds-undo') as HTMLButtonElement).disabled = !st.canUndo;
    ($('#ds-redo') as HTMLButtonElement).disabled = !st.canRedo;
    if (document.activeElement !== name) name.value = st.p.name;
    renderCtx();
  }

  // ---------------------------------------------------------- the bar that follows the selection
  let alignTo: 'selection' | 'part' = 'selection';
  let edgeMode: 'fillet' | 'chamfer' = 'fillet', edgeSize = 1;
  const applyEdges = () => {
    if (!st.edges.length || !(edgeSize > 0)) return;
    const f: Feature = {
      id: newId(), type: 'fillet', view: st.activeView, cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, d0: 0, d1: 0, op: 'add', through: false,
      fillet: { mode: edgeMode, size: edgeSize, edges: st.edges.map((e) => [...e] as [number, number, number]) },
    };
    st.change((p) => { p.features.push(f); });
    st.edges = [];
    st.emit('select');
  };
  const ctx = $('#ds-ctx');
  const mk = (tag: string, cls: string, html = '', title = '') => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html) e.innerHTML = html;
    if (title) e.title = title;
    return e;
  };
  const iconBtn = (icon: string, title: string, fn: () => void, disabled = false) => {
    const b = mk('button', 'ds-ibtn', icon, title) as HTMLButtonElement;
    b.onclick = fn;
    b.disabled = disabled;
    return b;
  };
  const group = (...kids: HTMLElement[]) => { const g = mk('div', 'ds-group'); g.append(...kids); return g; };
  const label = (t: string) => mk('span', 'ds-ctx-label', t);
  const alignGroup = (to: 'selection' | 'part') => {
    const hows: [AlignHow, string, string][] = [
      ['left', ICONS.left, 'Align left edges'], ['hcenter', ICONS.hcenter, 'Align centres across'], ['right', ICONS.right, 'Align right edges'],
      ['top', ICONS.top, 'Align top edges'], ['vmiddle', ICONS.vmiddle, 'Align middles up and down'], ['bottom', ICONS.bottom, 'Align bottom edges'],
    ];
    const g = group(...hows.map(([how, icon, title]) => iconBtn(icon, `${title} (as the ${VIEWS[st.activeView].label} view sees it)`, () => align(st, how, to))));
    g.classList.add('ds-align');
    return g;
  };

  function renderCtx() {
    const kids: HTMLElement[] = [];
    const feats = st.sels.filter((id) => id !== 'stock');
    const view = VIEWS[st.activeView].label;
    const fmt = (mm: number) => fmtLen(mm, st.p);
    if (st.tool === 'edge') {
      kids.push(label(st.edges.length ? `${st.edges.length} edge${st.edges.length > 1 ? 's' : ''}` : 'Edges'));
      const seg = mk('div', 'ds-seg ds-small');
      for (const [v, t] of [['fillet', 'Fillet'], ['chamfer', 'Chamfer']] as const) {
        const b = mk('button', edgeMode === v ? 'active' : '', t) as HTMLButtonElement;
        b.onclick = () => { edgeMode = v; renderCtx(); };
        seg.appendChild(b);
      }
      kids.push(seg);
      const inp = mk('input', 'ds-ctx-num') as HTMLInputElement;
      inp.type = 'number'; inp.step = 'any'; inp.min = '0';
      inp.value = String(st.p.units === 'in' ? +(edgeSize / 25.4).toFixed(4) : edgeSize);
      inp.title = edgeMode === 'fillet' ? 'Radius' : 'Size';
      inp.onchange = () => { const v = parseFloat(inp.value); if (v > 0) edgeSize = st.p.units === 'in' ? v * 25.4 : v; };
      inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { inp.onchange?.(new Event('change')); applyEdges(); } };
      kids.push(inp, mk('span', 'ds-ctx-hint', st.p.units));
      const ap = mk('button', 'btn sm primary', 'Apply') as HTMLButtonElement;
      ap.disabled = !st.edges.length;
      ap.onclick = () => { inp.onchange?.(new Event('change')); applyEdges(); };
      kids.push(ap);
      kids.push(mk('span', 'ds-ctx-hint', st.edges.length ? 'Shift-click to add or drop edges' : 'Click an edge in any view'));
    } else if (st.farFace && st.tool !== 'select' && st.tool !== 'zoom' && st.tool !== 'dim') {
      kids.push(label('Hidden lines'));
      kids.push(mk('span', 'ds-ctx-hint', 'New shapes go on the far face of the part as pockets, seen through it (dashed). Press H to draw on the near face again.'));
    } else if (st.one && st.dim(st.one)) {
      kids.push(label('Dimension'));
      kids.push(mk('span', 'ds-ctx-hint', 'Double-click its number to type a new size; drag it to move it.'));
      kids.push(group(iconBtn(ICONS.trash, 'Delete (⌫)', () => st.deleteSelected())));
    } else if (st.sides) {
      kids.push(label(st.sides.sides.length === 2 ? 'Corner' : 'Side'));
      kids.push(mk('span', 'ds-ctx-hint', st.sides.sides.length === 2 ? 'Set its radius on the right.' : 'Option-Shift-click a side next to it to pick their corner.'));
    } else if (feats.length > 1 || (feats.length === 1 && st.sels.includes('stock'))) {
      const withBody = st.sels.includes('stock');
      kids.push(label(withBody ? `Body + ${feats.length} shape${feats.length > 1 ? 's' : ''}` : `${feats.length} shapes`));
      kids.push(alignGroup(withBody ? 'part' : alignTo));
      if (withBody) kids.push(mk('span', 'ds-ctx-hint', 'to the body (it stays put)'));
      else {
        const seg = mk('div', 'ds-seg ds-small');
        for (const [v, t] of [['selection', 'to each other'], ['part', 'to the body']] as const) {
          const b = mk('button', alignTo === v ? 'active' : '', t) as HTMLButtonElement;
          b.onclick = () => { alignTo = v; renderCtx(); };
          seg.appendChild(b);
        }
        kids.push(seg);
      }
      kids.push(group(
        iconBtn(ICONS.disth, 'Space the centres evenly across (3 or more)', () => distribute(st, 'h'), feats.length < 3),
        iconBtn(ICONS.distv, 'Space the centres evenly up and down (3 or more)', () => distribute(st, 'v'), feats.length < 3),
      ));
      kids.push(mk('span', 'ds-ctx-hint', `in ${view}`));
      kids.push(group(iconBtn(ICONS.trash, 'Delete (⌫)', () => st.deleteSelected())));
    } else if (feats.length === 1) {
      const f = st.feature(feats[0]);
      if (!f) { ctx.replaceChildren(); return; }
      kids.push(label(featureName(f)));
      if (isShape(f)) {
        const seg = mk('div', 'ds-seg ds-small');
        for (const [v, t] of [['add', 'Add ▲'], ['cut', 'Cut ▼']] as const) {
          const b = mk('button', f.op === v ? 'active' : '', t) as HTMLButtonElement;
          b.onclick = () => {
            if (f.op === v) return;
            st.change(() => { const dep = Math.abs(f.d1 - f.d0); f.op = v; const into = f.far ? 1 : -1; f.d1 = f.d0 + (v === 'cut' ? into : -into) * dep; });
          };
          seg.appendChild(b);
        }
        kids.push(seg);
      }
      kids.push(mk('span', 'ds-ctx-hint', 'Align to the body'));
      kids.push(alignGroup('part'));
      kids.push(mk('span', 'ds-ctx-hint', `in ${view}`));
      kids.push(group(iconBtn(ICONS.trash, 'Delete (⌫)', () => st.deleteSelected())));
    } else {
      const s = st.p.stock;
      kids.push(label('Body'));
      kids.push(mk('span', 'ds-ctx-hint', `${fmt(s.max[0] - s.min[0])} × ${fmt(s.max[1] - s.min[1])} × ${fmt(s.max[2] - s.min[2])}${st.p.units === 'mm' ? ' mm' : ''}`));
      kids.push(mk('span', 'ds-ctx-hint', st.sels.length ? 'Drag its handles to resize it. Shift-click shapes to line them up to it.' : 'Pick a tool on the left and draw on a view.'));
    }
    ctx.replaceChildren(...kids);
  }

  // ---------------------------------------------------------- keys
  window.addEventListener('keydown', (e) => {
    if (studio.page !== 'design' || isTyping()) return;
    const k = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) st.redo(); else st.undo(); return; }
    if ((e.metaKey || e.ctrlKey) && k === 'y') { e.preventDefault(); st.redo(); return; }
    if ((e.metaKey || e.ctrlKey) && (k === '=' || k === '+')) { e.preventDefault(); sheet.zoomBy(1.5); return; }
    if ((e.metaKey || e.ctrlKey) && k === '-') { e.preventDefault(); sheet.zoomBy(1 / 1.5); return; }
    if ((e.metaKey || e.ctrlKey) && k === '0') { e.preventDefault(); sheet.fit(); return; }
    if ((e.metaKey || e.ctrlKey) && k === '1') { e.preventDefault(); sheet.zoomBy(100 / sheet.zoomPct); return; }
    if ((e.metaKey || e.ctrlKey) && k === 'a') { e.preventDefault(); st.select(st.p.features.filter(isShape).map((f) => f.id)); return; }
    if ((e.metaKey || e.ctrlKey) && k === 's') { e.preventDefault(); save(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (root.querySelector('.ds-modal')) return;
    if (k === 'escape' && st.tool === 'edge' && st.edges.length) { st.edges = []; st.emit('select'); return; }
    const keys: Record<string, Tool> = { v: 'select', r: 'rect', c: 'circle', p: 'polygon', l: 'line', g: 'gear', t: 'text', e: 'edge', d: 'dim', z: 'zoom' };
    if (k === 'escape') { st.setTool('select'); st.select([]); if (st.farFace) { st.farFace = false; st.emit('tool'); } }
    else if (keys[k]) st.setTool(keys[k]);
    else if (k === 'h') toggleFar();
    else if (k === 'f') sheet.fit();
    else if (k === 'delete' || k === 'backspace') { e.preventDefault(); st.deleteSelected(); }
  });

  studio.onPage((p) => { preview.active = p === 'design'; if (p === 'design') { preview.resize(); sheet.render(); } });
  syncToolbar();
  requestBuild();
}
