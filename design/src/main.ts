// The Design tab: an orthographic drafting sheet that builds a printable
// solid. Studio loads this module the first time the tab is opened.

import type { Feature, Project, ViewName } from './model.js';
import { newProject, newId, isShape, findRef, profile, type P2 } from './model.js';
import { FOOTPRINTS, placeFootprint } from './footprints.js';
import { State, align, distribute, rememberFit, type AlignHow, type Tool } from './state.js';
import { VIEWS, parallel } from './views.js';
import { fmtLen } from './sheet.js';
import { Sheet, isTyping } from './sheet.js';
import { Panel, featureName } from './panel.js';
import { Preview3D } from './preview3d.js';
import { openGearDialog } from './geardialog.js';
import { openHoleDialog } from './holedialog.js';
import { openRotateDialog } from './rotatedialog.js';
import { axisOf } from './views.js';
import { viewDxf } from './dxf.js';
import { checkPrint, type Issue } from './check.js';
import { openCheckDialog } from './checkdialog.js';
import { openFitDialog } from './fitdialog.js';
import { takesFit, fitPlate } from './model.js';

interface Studio {
  prepare: { addFiles(files: { name: string; buffer: ArrayBuffer }[]): Promise<void> };
  show(page: string): void;
  sendToCam?(project: unknown, name: string): Promise<void>;
  onPage(fn: (p: string) => void): void;
  page: string;
}

const ico = (body: string) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;
const ICONS = {
  select: ico('<path d="M6 3.5l12.5 8.2-6 1.2-3 5.6z" fill="currentColor" stroke-width="1.2"/>'),
  rotate: ico('<path d="M5 13a7 7 0 1 0 2.6-5.5"/><path d="M7.5 3.5v4.2h4.2"/><rect x="9.5" y="10.5" width="5" height="5" transform="rotate(20 12 13)"/>'),
  measure: ico('<path d="M3.5 16.5l13-13 4 4-13 13z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>'),
  rect: ico('<rect x="4" y="6" width="16" height="12" rx="0.5"/>'),
  slot: ico('<rect x="3" y="8" width="18" height="8" rx="4"/>'),
  hole: ico('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" stroke-width="1.2"/>'),
  circle: ico('<circle cx="12" cy="12" r="8"/>'),
  zoom: ico('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5l5 5M7.5 10.5h6M10.5 7.5v6"/>'),
  polygon: ico('<path d="M8 4.5h8l4 7.5-4 7.5H8l-4-7.5z"/>'),
  line: ico('<path d="M4 19l4-11 6 6 6-10"/><circle cx="4" cy="19" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="14" cy="14" r="1.3" fill="currentColor"/><circle cx="20" cy="4" r="1.3" fill="currentColor"/>'),
  gear: ico('<circle cx="12" cy="12" r="3"/><path d="M10.6 3h2.8l.5 2.6 2 .9 2.2-1.5 2 2-1.5 2.2.9 2 2.6.5v2.8l-2.6.5-.9 2 1.5 2.2-2 2-2.2-1.5-2 .9-.5 2.6h-2.8l-.5-2.6-2-.9-2.2 1.5-2-2 1.5-2.2-.9-2L3 13.4v-2.8l2.6-.5.9-2L5 5.9l2-2 2.2 1.5 2-.9z"/>'),
  text: ico('<path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6"/>'),
  edge: ico('<path d="M4 20V12a8 8 0 0 1 8-8h8"/><path d="M4 20h16V4" stroke-dasharray="2 2.5"/>'),
  section: ico('<path d="M4 12h3M10 12h4M17 12h3" stroke-width="2"/><path d="M5 12V6M19 12V6"/><path d="M3 8l2-3 2 3M17 8l2-3 2 3"/><path d="M9 15l3 4 3-4" opacity=".55"/>'),
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

/** Tools that share one toolbox button (hold it, or click its corner, for the others). */
const SHAPES: { tool: Tool; name: string; key: string; tip: string }[] = [
  { tool: 'rect', name: 'Rectangle', key: 'R', tip: 'Drag corner to corner' },
  { tool: 'slot', name: 'Slot', key: 'S', tip: 'Drag out its length and width; the ends are round' },
  { tool: 'circle', name: 'Circle', key: 'C', tip: 'Drag out from the centre' },
  { tool: 'polygon', name: 'Polygon', key: 'P', tip: 'Drag out from the centre; set the sides on the right' },
];
const PICKERS: typeof SHAPES = [
  { tool: 'select', name: 'Select', key: 'V', tip: 'Click or drag a box to select; Shift-click for more; drag just outside a corner to turn' },
  { tool: 'rotate', name: 'Rotate', key: '⇧R', tip: 'Click the shapes to turn, then set the angle and the point to turn about' },
];
const MEASURES: typeof SHAPES = [
  { tool: 'dim', name: 'Dimension', key: 'D', tip: "Click a shape near the side to dimension it; double-click a dimension's number to type a new size" },
  { tool: 'measure', name: 'Measure', key: 'M', tip: 'Drag from one point to another: snaps to corners and centres' },
  { tool: 'section', name: 'Section', key: 'X', tip: 'Drag a cutting line across a view (level or plumb): the view it looks into shows SECTION A–A, the cut faces hatched' },
];
const GROUPS: Record<string, typeof SHAPES> = { shapes: SHAPES, pick: PICKERS, measure: MEASURES };

function toolGroup(name: string, list: typeof SHAPES): string {
  const first = list[0];
  const items = list.map((t) => `<button data-tool="${t.tool}" title="${t.tip}">${(ICONS as any)[t.tool]}<span>${t.name}</span><kbd>${t.key}</kbd></button>`).join('');
  return `<div class="ds-tgroup" data-group="${name}">
    <button class="ds-tgroup-main" data-tool="${first.tool}" title="${first.name} (${first.key})&#10;Hold for the others">${(ICONS as any)[first.tool]}<i class="ds-tgroup-more"></i></button>
    <div class="ds-flyout hidden">${items}</div>
  </div>`;
}

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
  <button class="btn sm ghost" id="ds-close" title="Close this part (asks to save it first) and start a blank one">Close</button>
  <button class="btn sm ghost" id="ds-open" title="Your saved parts (with pictures), the printer's models, and footprints to drop on: Pi, servo, bearing, LED…">Library…</button>
  <button class="btn sm ghost" id="ds-save" title="Save this part on the printer (⌘S)">Save</button>
  <span class="ds-export"><button class="btn sm ghost" id="ds-stl" title="Download the STL, or a DXF drawing of a view">Export ▾</button><div class="ds-menu hidden" id="ds-export-menu"></div></span>
  <button class="btn sm ghost" id="ds-check" title="Will it print? Looks for thin walls, steep overhangs, holes on their side and bits too small (it also runs on Send to Prepare / Library)">Check</button>
  <button class="btn sm ghost" id="ds-cam" title="Cut it on the ShopBot: lay it on a sheet in SnorbCAM">Send to SnorbCAM</button>
  <button class="btn sm ghost" id="ds-lib" title="Keep the STL in the model library on the Pi (Files tab)">Send to Library</button>
  <button class="btn sm primary" id="ds-send" title="Put it on the plate in Prepare">Send to Prepare</button>
</div>
<div class="ds-body">
  <nav class="ds-toolbox" id="ds-tool">
    ${toolGroup('pick', PICKERS)}
    ${toolGroup('shapes', SHAPES)}
    <button data-tool="line" title="Line (L): click each corner of an outline,&#10;click the first one (or press Return) to close it.&#10;Shift keeps a side level or plumb.&#10;Then drag the ◆ in the middle of a side to bow it into an arc.">${ICONS.line}</button>
    <span class="ds-tool-sep"></span>
    <button data-tool="hole" title="Hole (O): click where a screw goes (or drag out roughly its size),&#10;then pick the screw and the kind of hole in the box that opens.">${ICONS.hole}</button>
    <button data-tool="gear" title="Gear (G): drag out roughly how big,&#10;then set it up in the box that opens.">${ICONS.gear}</button>
    <button data-tool="text" title="Text (T): click where it goes">${ICONS.text}</button>
    <span class="ds-tool-sep"></span>
    <button data-toggle="far" title="Hidden lines (H): draw on the far face of the part,&#10;seen through it. New shapes go on the back as pockets.">${ICONS.far}</button>
    <span class="ds-tool-sep"></span>
    <button data-tool="edge" title="Edges (E): click edges in any view to fillet or chamfer them.&#10;Shift-click for more.">${ICONS.edge}</button>
    ${toolGroup('measure', MEASURES)}
    <span class="ds-tool-sep"></span>
    <button data-tool="zoom" title="Zoom (Z)&#10;Click to zoom in, Option-click to zoom out,&#10;drag a box to zoom to it.">${ICONS.zoom}</button>
  </nav>
  <div class="ds-sheet-wrap" id="ds-sheet"><div class="ds-doctabs" id="ds-doctabs"></div><div class="ds-loading" id="ds-loading">Loading the CAD engine…</div></div>
  <div class="ds-splitter" id="ds-splitter" title="Drag to resize the panel (double-click to reset)"></div>
  <aside class="ds-side" id="ds-side">
    <div class="ds-3d" id="ds-3d"></div>
    <div class="ds-tabs" id="ds-tabs"><button data-tab="props" class="active">Properties</button><button data-tab="views">Views</button></div>
    <div class="ds-panel" id="ds-panel"></div>
    <div class="ds-panel ds-views-pane hidden" id="ds-views"></div>
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
  // the other part tab (two parts open at once), kept here while this one is shown
  const docs: { other: null | { p: Project; undo: string[]; redo: string[]; sels: string[]; savedAs: string | null; cleanSig: string | null; first: boolean } } = { other: null };
  const sheet = new Sheet($('#ds-sheet'), st);
  new Panel($('#ds-panel'), st, {
    gear: (id) => editGear(id, false),
    hole: (id) => editHole(id, false),
    dimValue: (dm) => sheet.dimGeom(dm)?.value ?? null,
    dimSize: (dm, size) => sheet.resizeTo(dm, size),
    repick: (id) => repick(id),
    unbase: () => st.change((p) => { delete p.base; p.stock.off = false; }),
    lid: (lid) => {
      if (docs.other) { flash('Close the other part tab first: the lid opens there.'); return; }
      newTab(lid);
      flash(`“${lid.name}”: lip down, it slips into the opening. Save it, then send both to Prepare.`);
    },
    fitTest: () => openFitDialog(document.body, {
      current: st.p.fit ?? 0,
      pick: (fit) => {
        st.change((p) => { p.fit = fit; });
        rememberFit(fit);
        flash(`Printer fit set to ${fit} mm: holes and cut slots are made that much bigger across, here and in every new part.`);
      },
      openPlate: () => {
        if (docs.other) { flash('Close the other part tab first: the test plate opens there.'); return; }
        newTab(fitPlate());
        flash('The M3 fit test plate. Send it to Prepare and print it, then Sheet › Fit test… to pick the hole that fits.');
      },
    }),
  });
  // the side panel's tabs: the selection's properties, or how the views are drawn
  const showTab = (t: string) => {
    root.querySelectorAll<HTMLButtonElement>('#ds-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    $('#ds-panel').classList.toggle('hidden', t !== 'props');
    $('#ds-views').classList.toggle('hidden', t !== 'views');
    if (t === 'views') renderViews();
  };
  root.querySelectorAll<HTMLButtonElement>('#ds-tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab!); });
  function renderViews() {
    const el = $('#ds-views');
    const kids: HTMLElement[] = [];
    const h = (t: string, cls = 'ds-h') => { const d = document.createElement('div'); d.className = cls; d.textContent = t; return d; };
    const check = (label: string, on: boolean, set: (v: boolean) => void, title = '') => {
      const l = document.createElement('label');
      l.className = 'ds-check';
      if (title) l.title = title;
      const c = document.createElement('input');
      c.type = 'checkbox'; c.checked = on;
      c.onchange = () => set(c.checked);
      l.append(c, document.createTextNode(` ${label}`));
      return l;
    };
    kids.push(h('Drawing'));
    kids.push(check('Projection lines for the selection', st.viewOpts.projLines, (v) => st.setViewOpt('projLines', v),
      'Faint lines carrying the selected shapes’ edges across to the views in line with it'));
    kids.push(check('Hidden lines (dashed)', st.viewOpts.hidden, (v) => st.setViewOpt('hidden', v)));
    kids.push(h('Views'));
    kids.push(h('Third-angle: top above the front, right to its right. Hidden views show as small + boxes on the sheet.', 'ds-note'));
    for (const v of ['top', 'front', 'right', 'left', 'back', 'bottom'] as const) {
      const on = st.p.views.includes(v);
      kids.push(check(VIEWS[v].label, on, (want) => {
        if (!want && st.p.views.length <= 1) { renderViews(); return; }
        st.change((p) => { p.views = want ? [...p.views, v] : p.views.filter((w) => w !== v); });
        st.emit('view');
      }));
    }
    el.replaceChildren(...kids);
  }
  const preview = new Preview3D($('#ds-3d'));
  (window as any).__design = { st, sheet, checkPrint };     // for poking at from the console
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
  sheet.onHole = (id) => editHole(id, true);

  /**
   * The hole box. On a new hole, Cancel takes it away again. With several
   * holes selected, Apply sets them all alike (each keeps its place).
   */
  function editHole(id: string, isNew: boolean) {
    const f = st.feature(id);
    if (!f || !f.hole) return;
    const group = isNew ? [f] : st.sels.map((x) => st.feature(x)).filter((q): q is Feature => !!q && q.type === 'hole');
    if (!group.includes(f)) group.unshift(f);
    openHoleDialog(root, {
      hole: f.hole, through: f.through, depth: Math.abs(f.d1 - f.d0) || 5, fit: takesFit(f), partFit: st.p.fit ?? 0,
      units: st.p.units, isNew, count: group.length,
      apply: (r) => {
        st.change(() => {
          for (const q of group) {
            q.hole = { ...r.hole };
            q.r = r.hole.d / 2;
            q.op = 'cut';
            q.through = r.through;
            if (!r.through) q.d1 = q.d0 + (q.far ? 1 : -1) * r.depth;
            q.fit = r.fit ? undefined : false;
          }
        }, !isNew);
        st.rememberHole(r.hole);
        if (isNew) st.save();
      },
      cancel: () => { if (isNew) { st.undo(); st.select([]); } },
    });
  }
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
    // re-picking a fillet's edges: show the part without it, so its edges are there to click
    if (st.repick) project.features = project.features.filter((f) => f.id !== st.repick);
    try {
      const r = await call({ type: 'build', project, views: ['top', 'front', 'right', 'left', 'back', 'bottom'], edges: st.tool === 'edge' });
      if (r) {
        st.built = r;
        st.buildError = '';
        followFillets(r);
        if (r.baseBox && st.p.base) {
          const [a, b] = r.baseBox as [number[], number[]];
          const s = st.p.stock;
          if ([0, 1, 2].some((i) => Math.abs(s.min[i] - a[i]) > 1e-4 || Math.abs(s.max[i] - b[i]) > 1e-4)) {
            s.min = [a[0], a[1], a[2]]; s.max = [b[0], b[1], b[2]]; s.off = false; st.save();
            st.emit('select');      // the panel and bar show the model's size
          }
        }
        if (r.errors?.base) $('#ds-status').textContent = `The body didn't load: ${r.errors.base}`;
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

  /** Fillets follow their edges: keep each edge's last known spot and reference up to date (not an undo step). */
  function followFillets(r: any) {
    let touched = false;
    st.p.features.forEach((f, idx) => {
      const fl = f.fillet;
      const now = r.fillets?.[f.id] as ([number, number, number] | null)[] | undefined;
      if (!fl) return;
      if (!fl.refs || fl.refs.length !== fl.edges.length) { fl.refs = fl.edges.map((pt) => findRef(pt, st.p, idx)); touched = true; }
      if (!now) return;
      now.forEach((pt, i) => {
        if (!pt) return;
        const old = fl.edges[i];
        if (Math.hypot(pt[0] - old[0], pt[1] - old[1], pt[2] - old[2]) > 1e-6) {
          fl.edges[i] = pt;
          fl.refs![i] = findRef(pt, st.p, idx);
          touched = true;
        }
      });
    });
    if (touched) st.save();
  }

  let wasRepick = false;
  st.on((w) => {
    if (w === 'model') { requestBuild(); sheet.relayout(); }
    if (w === 'view') { sheet.fit(); if (!$('#ds-views').classList.contains('hidden')) renderViews(); }
    if (w === 'tool') {
      sheet.cancelLine();
      if (st.tool !== 'measure') sheet.measure = null;
      if (st.tool === 'rotate' && st.sels.some((id) => id !== 'stock')) queueMicrotask(editRotate);
      if (st.tool === 'edge' && st.built && !st.built.edges.length) requestBuild();
      // leaving a re-pick without applying: the part with its fillet again
      if (st.tool !== 'edge' && wasRepick) requestBuild();
      wasRepick = !!st.repick;
    }
    sheet.render();
    syncToolbar();
    renderTabs();
  });

  // ---------------------------------------------------------- toolbar
  root.querySelectorAll<HTMLButtonElement>('#ds-tool > button[data-tool]').forEach((b) => { b.onclick = () => st.setTool(b.dataset.tool as Tool); });
  // tool groups: click uses the one shown; hold (or click the corner) opens the others
  const GROUP_KEY = 'studio.design.groups';
  let groupPick: Record<string, Tool> = {};
  try { groupPick = JSON.parse(localStorage.getItem(GROUP_KEY) || '{}'); } catch { /* defaults */ }
  const closeFlyouts = () => root.querySelectorAll('.ds-flyout').forEach((f) => f.classList.add('hidden'));
  root.querySelectorAll<HTMLElement>('.ds-tgroup').forEach((g) => {
    const name = g.dataset.group!;
    const main = g.querySelector('.ds-tgroup-main') as HTMLButtonElement;
    const fly = g.querySelector('.ds-flyout') as HTMLElement;
    let held: number | undefined, opened = false;
    const open = () => { closeFlyouts(); fly.classList.remove('hidden'); opened = true; };
    main.addEventListener('pointerdown', (e) => {
      opened = false;
      const r = main.getBoundingClientRect();
      if (e.clientX > r.right - 11 && e.clientY > r.bottom - 11) { open(); return; }   // the little corner
      held = window.setTimeout(open, 350);
    });
    main.addEventListener('pointerup', () => { clearTimeout(held); });
    main.addEventListener('pointerleave', () => { clearTimeout(held); });
    main.onclick = () => { if (!opened) st.setTool((groupPick[name] || GROUPS[name][0].tool) as Tool); };
    fly.querySelectorAll<HTMLButtonElement>('button[data-tool]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const t = b.dataset.tool as Tool;
        groupPick[name] = t;
        try { localStorage.setItem(GROUP_KEY, JSON.stringify(groupPick)); } catch { /* private mode */ }
        closeFlyouts();
        st.setTool(t);
      };
    });
  });
  document.addEventListener('pointerdown', (e) => { if (!(e.target as HTMLElement).closest?.('.ds-tgroup')) closeFlyouts(); });
  const toggleFar = () => {
    st.farFace = !st.farFace;
    // the hidden-line toggle goes with drawing, so pick a drawing tool if none is
    if (st.farFace && !['rect', 'slot', 'circle', 'polygon', 'line', 'hole', 'text'].includes(st.tool)) st.setTool('rect'); else st.emit('tool');
  };
  ($('#ds-tool button[data-toggle="far"]') as HTMLButtonElement).onclick = toggleFar;
  $('#ds-undo').onclick = () => st.undo();
  $('#ds-redo').onclick = () => st.redo();
  $('#ds-fit').onclick = () => sheet.fit();
  // the name this part was opened or last saved under (kept across reloads):
  // saving under it again is replacing this part, not taking another's name
  const SAVED_KEY = 'studio.design.savedAs';
  let savedAs: string | null = null;
  try { savedAs = localStorage.getItem(SAVED_KEY); } catch { /* private mode */ }
  const setSavedAs = (v: string | null) => {
    savedAs = v;
    try { if (v) localStorage.setItem(SAVED_KEY, v); else localStorage.removeItem(SAVED_KEY); } catch { /* private mode */ }
    markClean();
  };

  // ---------------------------------------------------------- unsaved changes
  // What the part looked like when it was last opened, saved or started.
  // Leaves out what the app keeps up to date by itself (fillet edges following
  // their shapes, a library body's size), so only real edits count.
  const CLEAN_KEY = 'studio.design.cleanSig';
  const sig = (p: typeof st.p) => JSON.stringify(p.base ? { ...p, stock: null } : p, (k, v) => (k === 'refs' || k === 'edges' ? undefined : v));
  let cleanSig: string | null = null;
  try { cleanSig = localStorage.getItem(CLEAN_KEY); } catch { /* private mode */ }
  function markClean() {
    cleanSig = sig(st.p);
    try { localStorage.setItem(CLEAN_KEY, cleanSig); } catch { /* too big or private mode */ }
  }
  const blank = (p: typeof st.p) => !p.features.length && !p.base;
  const unsaved = () => !blank(st.p) && sig(st.p) !== cleanSig;

  /** Ask before the current part is put away: save it, drop it, or stay. */
  const askSave = () => new Promise<'save' | 'discard' | 'cancel'>((done) => {
    const box = document.createElement('div');
    box.className = 'ds-modal';
    const card = document.createElement('div');
    card.className = 'ds-dialog';
    const nm = (name.value.trim() || st.p.name || 'part');
    card.innerHTML = `<h3></h3><p class="ds-note">If you don't save, the changes are dropped (Undo can still bring them back for now).</p>`;
    card.querySelector('h3')!.textContent = `Would you like to save “${nm}”?`;
    const foot = document.createElement('div');
    foot.className = 'ds-dialog-foot';
    const btn = (t: string, cls: string, v: 'save' | 'discard' | 'cancel') => {
      const b = document.createElement('button');
      b.className = `btn sm ${cls}`;
      b.textContent = t;
      b.onclick = () => finish(v);
      return b;
    };
    const yes = btn('Save', 'primary', 'save');
    foot.append(btn('Cancel', 'ghost', 'cancel'), btn("Don't save", 'ghost', 'discard'), yes);
    card.appendChild(foot);
    box.appendChild(card);
    box.onclick = (e) => { if (e.target === box) finish('cancel'); };
    root.appendChild(box);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish('cancel'); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); finish('save'); }
    };
    window.addEventListener('keydown', onKey, true);
    yes.focus();
    function finish(v: 'save' | 'discard' | 'cancel') { box.remove(); window.removeEventListener('keydown', onKey, true); done(v); }
  });

  /** true when it's fine to put the current part away (saved, dropped on purpose, or nothing to lose). */
  async function okToLeave() {
    commitName();
    if (!unsaved()) return true;
    const a = await askSave();
    if (a === 'cancel') return false;
    if (a === 'discard') return true;
    return await save();
  }

  const name = $('#ds-name') as HTMLInputElement;
  // the name being typed counts straight away: Save (button or ⌘S) and Send to Library use it
  const commitName = () => {
    const v = name.value.trim().replace(/[\\/]/g, '-') || 'part';
    if (v !== st.p.name) st.change((p) => { p.name = v; });
  };
  name.onchange = commitName;
  name.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') name.blur();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  };
  const startBlank = async (msg: string) => {
    if (!await okToLeave()) return;
    st.load(newProject());
    setSavedAs(null);
    name.classList.remove('ds-name-taken');
    sheet.fit();
    flash(msg);
  };
  // ---------------------------------------------------------- two part tabs
  const OTHER_KEY = 'studio.design.other';
  try {
    const o = JSON.parse(localStorage.getItem(OTHER_KEY) || 'null');
    if (o?.p) docs.other = { ...o, undo: [], redo: [], sels: [] };
  } catch { /* none */ }
  const keepOther = () => {
    const o = docs.other;
    try {
      if (o) localStorage.setItem(OTHER_KEY, JSON.stringify({ p: o.p, savedAs: o.savedAs, cleanSig: o.cleanSig, first: o.first }));
      else localStorage.removeItem(OTHER_KEY);
    } catch { /* too big or private mode */ }
  };
  /** This part's saved name and clean state (kept across reloads). */
  const setDocMarks = (sa: string | null, cs: string | null) => {
    savedAs = sa; cleanSig = cs;
    try {
      if (sa) localStorage.setItem(SAVED_KEY, sa); else localStorage.removeItem(SAVED_KEY);
      if (cs) localStorage.setItem(CLEAN_KEY, cs); else localStorage.removeItem(CLEAN_KEY);
    } catch { /* private mode */ }
  };
  function switchDoc() {
    const o = docs.other;
    if (!o) return;
    commitName();
    const mine = { savedAs, cleanSig };
    const cur = st.swap({ p: o.p, undo: o.undo, redo: o.redo, sels: o.sels });
    setDocMarks(o.savedAs, o.cleanSig);
    docs.other = { ...cur, savedAs: mine.savedAs, cleanSig: mine.cleanSig, first: !o.first };
    keepOther();
    name.classList.remove('ds-name-taken');
    sheet.fit();
  }
  function newTab(start?: Project) {
    if (docs.other) { switchDoc(); return; }
    commitName();
    const mine = { savedAs, cleanSig };
    const cur = st.swap({ p: start || newProject(), undo: [], redo: [], sels: [] });
    docs.other = { ...cur, savedAs: mine.savedAs, cleanSig: mine.cleanSig, first: true };
    keepOther();
    setSavedAs(null);
    if (start) cleanSig = null;      // a made lid counts as unsaved
    sheet.fit();
    if (!start) flash('A second part. ⌘C in one and ⌘V in the other copies shapes across; click a tab to switch.');
  }
  async function closeTab(active: boolean) {
    if (!active) switchDoc();
    if (!await okToLeave()) { renderTabs(); return; }
    const o = docs.other;
    if (!o) { startBlank('Closed. Here is a blank part.'); return; }
    st.swap({ p: o.p, undo: o.undo, redo: o.redo, sels: o.sels });
    setDocMarks(o.savedAs, o.cleanSig);
    docs.other = null;
    keepOther();
    sheet.fit();
  }
  function renderTabs() {
    const bar = root.querySelector('#ds-doctabs') as HTMLElement | null;
    if (!bar) return;
    let dirty = false;
    try { dirty = unsaved(); } catch { /* not set up yet */ }
    const o = docs.other;
    const tab = (label: string, active: boolean, changed: boolean) => {
      const t = document.createElement('div');
      t.className = `ds-doctab${active ? ' active' : ''}`;
      const b = document.createElement('button');
      b.textContent = `${label}${changed ? ' •' : ''}`;
      b.title = active ? 'This part' : 'Switch to this part';
      b.onclick = () => { if (!active) switchDoc(); };
      const x = document.createElement('button');
      x.className = 'ds-doctab-x'; x.textContent = '×'; x.title = 'Close this part (asks to save it first)';
      x.onclick = (e) => { e.stopPropagation(); closeTab(active); };
      t.append(b, x);
      return t;
    };
    const kids: HTMLElement[] = [];
    if (o) {
      const otherSig = (() => { try { return o.cleanSig !== sig(o.p) && !blank(o.p); } catch { return false; } })();
      const a = tab(st.p.name || 'part', true, dirty), b = tab(o.p.name || 'part', false, otherSig);
      kids.push(...(o.first ? [b, a] : [a, b]));
    } else {
      const plus = document.createElement('button');
      plus.className = 'ds-doctab-new'; plus.textContent = '+ Part';
      plus.title = 'Open a second part beside this one, to copy and paste between them';
      plus.onclick = () => newTab();
      kids.push(plus);
    }
    bar.replaceChildren(...kids);
  }
  renderTabs();
  $('#ds-new').onclick = () => startBlank('A new part.');
  $('#ds-close').onclick = () => startBlank('Closed. Here is a blank part.');
  // ---------------------------------------------------------- library
  // ---------------------------------------------------------------- printability
  /** Wait for the part to finish building (so the check sees what's drawn now). */
  const builtNow = () => new Promise<void>((res) => {
    if (!inFlight && !pending && st.built) return res();
    const t0 = Date.now();
    const poll = () => (!inFlight && !pending && st.built) || Date.now() - t0 > 20000 ? res() : setTimeout(poll, 100);
    poll();
  });
  let printAnyway = '';           // the part as it was when Print anyway was picked: don't ask again for that
  let checking = false;
  /** Run the check. Manual: show what it found. Sending: true to go ahead. */
  async function runCheck(sending?: string): Promise<boolean> {
    if (checking) return false;
    checking = true;
    try {
      await builtNow();
      const now = JSON.stringify(st.p);
      if (sending && printAnyway === now) return true;
      const t0 = performance.now();
      let issues: Issue[];
      try { issues = checkPrint(st.p, st.built?.mesh ?? null); } catch (e: any) { flash(`The check didn't finish (${e.message}).`); return !!sending; }
      const ms = Math.round(performance.now() - t0);
      if (!issues.length) {
        if (!sending) flash(`Looks printable: no thin walls, steep overhangs, sideways holes or tiny bits (checked in ${ms} ms).`);
        return true;
      }
      const r = await new Promise<boolean | 'again'>((res) => openCheckDialog(document.body, {
        issues, sending,
        show: (it) => {
          preview.highlight(it.tris ?? null);
          if (it.feature) st.select([it.feature]); else st.select([]);
          flash(it.tris ? `${it.title}: shown in red in the 3D view.` : it.title);
        },
        fix: (it) => {
          if (it.fix === 'teardrop' && it.feature) {
            const f = st.feature(it.feature);
            if (f) { st.change(() => { f.teardrop = true; }); flash('Made it a teardrop: the point is straight up.'); }
          }
        },
        done: (go) => {
          preview.highlight(null);
          if (go === true) printAnyway = JSON.stringify(st.p);
          res(go);
        },
      }));
      if (r !== 'again') return r;
    } finally { checking = false; }
    return runCheck(sending);      // a fix changed the part: look again at the new one
  }
  $('#ds-check').onclick = () => { runCheck(); };

  $('#ds-lib').onclick = async () => {
    const b = $('#ds-lib') as HTMLButtonElement;
    commitName();
    if (!await nameFree()) return;
    if (!await runCheck('Send to Library')) return;
    b.disabled = true;
    try {
      const buf = await getSTL();
      const name = fileName();
      const r = await fetch(`/studio-api/models/${encodeURIComponent(name)}?replace=1`, { method: 'PUT', body: buf });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      // keep the design too, under the same name, so Send to SnorbCAD brings back every shape
      await save(true, true);
      $('#ds-status').textContent = `“${name}” is in the model library (Files tab), with its design saved alongside.`;
    } catch (e: any) { $('#ds-status').textContent = `Couldn't send it to the library: ${e.message}`; }
    finally { b.disabled = false; }
  };

  /** Open a library model: its saved design if there is one (every shape editable), else the STL as the body. */
  async function openModel(name: string) {
    if (!await okToLeave()) return;
    const stem = name.replace(/\.(stl|3mf|obj)$/i, '');
    try {
      const r = await fetch(`${API}${encodeURIComponent(stem)}.json`);
      if (r.ok) { st.load(await r.json()); setSavedAs(stem); st.select([]); sheet.fit(); flash(`Opened the design of “${name}”: every shape can be changed.`); return; }
    } catch { /* no saved design */ }
    const p = newProject();
    p.name = stem;
    p.base = { model: name };
    p.views = ['top', 'front', 'right'];
    st.load(p);
    setSavedAs(stem);          // the same part as the library STL: saving under its name is fine
    st.select([]);
    sheet.fit();
    flash(`“${name}” is the body. Add or cut shapes on it, round its edges; its own walls keep their size (an STL has no shapes to change).`);
  }

  // ---------------------------------------------------------- save / open on the printer
  const API = '/studio-api/designs/';
  const flash = (t: string) => { $('#ds-status').textContent = t; };
  /**
   * One name, one part: a name already used on the printer (a saved part or a
   * library model) can't be reused by a different part. Saving again under
   * the name it was opened or saved as is fine. Pressing Save a second time
   * on the warning replaces the other one on purpose.
   */
  let replaceArmed: string | null = null;
  const nameFree = async () => {
    const nm = (st.p.name || 'part').trim();
    if (nm === savedAs) return true;
    if (replaceArmed === nm) { replaceArmed = null; return true; }
    let taken = false;
    try {
      const [d, m] = await Promise.all([fetch(API.slice(0, -1)).then((r) => r.json()), fetch('/studio-api/models').then((r) => r.json())]);
      taken = (d.designs || []).some((x: any) => x.name === nm) ||
        (m.models || []).some((x: any) => x.name.replace(/\.(stl|3mf|obj)$/i, '') === nm);
    } catch { /* can't tell: the printer refuses a taken name anyway */ }
    if (!taken) return true;
    replaceArmed = nm;
    flash(`“${nm}” is already the name of another part on the printer. Give this one a different name, or press it again to replace that one.`);
    name.classList.add('ds-name-taken');
    name.focus();
    name.select();
    return false;
  };
  name.addEventListener('input', () => { name.classList.remove('ds-name-taken'); replaceArmed = null; });
  let saving = false;
  async function save(quiet = false, checked = false): Promise<boolean> {
    if (saving && !quiet) return false;    // ⌘S can arrive twice (field + page)
    saving = true;
    try { return await saveNow(quiet, checked); } finally { saving = false; }
  }
  const saveNow = async (quiet: boolean, checked: boolean): Promise<boolean> => {
    commitName();
    if (!checked && !await nameFree()) { if (quiet) throw new Error('that name is taken'); return false; }
    const nm = (st.p.name || 'part').trim();
    try {
      // a small picture of the part goes in the saved file, for the library
      const thumb = preview.snapshot();
      const r = await fetch(`${API}${encodeURIComponent(nm)}.json?replace=1`, { method: 'PUT', body: JSON.stringify(thumb ? { ...st.p, thumb } : st.p), headers: { 'Content-Type': 'application/json' } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      setSavedAs(nm);
      name.classList.remove('ds-name-taken');
      if (!quiet) flash(`Saved “${nm}” on the printer.`);
      return true;
    } catch (e: any) { flash(`Couldn't save: ${e.message}`); if (quiet) throw e; return false; }
  };
  $('#ds-save').onclick = () => save();
  // ---------------------------------------------------------- the library
  // Three shelves: parts saved on the printer (with a picture of each),
  // models from the printer's library (STL), and footprints to drop on.
  const LIB_SHELF = 'studio.design.libShelf';
  $('#ds-open').onclick = async () => {
    let list: { name: string; modified: number; thumb?: string }[] = [];
    let lib: { name: string; size: number }[] = [];
    let listErr = '';
    try { list = (await (await fetch(API.slice(0, -1))).json()).designs || []; } catch (e: any) { listErr = `Couldn't reach the printer for saved parts (${e.message}).`; }
    try { lib = ((await (await fetch('/studio-api/models')).json()).models || []).filter((m: any) => /\.stl$/i.test(m.name)); } catch { /* no library */ }
    const designs = new Set(list.map((d) => d.name));
    const libOnly = lib.filter((m) => !designs.has(m.name.replace(/\.stl$/i, '')));
    let shelf = 'parts';
    try { shelf = localStorage.getItem(LIB_SHELF) || 'parts'; } catch { /* default */ }

    const box = document.createElement('div');
    box.className = 'ds-modal';
    const card = document.createElement('div');
    card.className = 'ds-dialog ds-lib';
    card.innerHTML = `<h3>Library</h3><div class="ds-seg ds-lib-tabs"></div><div class="ds-lib-body"></div>
      <div class="ds-dialog-foot"><button class="btn sm ghost" id="ds-lib-cancel">Close</button></div>`;
    box.appendChild(card);
    root.appendChild(box);
    const close = () => { box.remove(); window.removeEventListener('keydown', onKey, true); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    (card.querySelector('#ds-lib-cancel') as HTMLButtonElement).onclick = close;
    box.addEventListener('pointerdown', (e) => { if (e.target === box) close(); });
    const tabs = card.querySelector('.ds-lib-tabs') as HTMLElement, body = card.querySelector('.ds-lib-body') as HTMLElement;
    const shelves: [string, string][] = [['parts', `My parts (${list.length})`], ['models', `Models (${libOnly.length})`], ['footprints', 'Footprints']];

    const tile = (title: string, sub: string, pic: string, open: () => void, extra?: HTMLElement) => {
      const t = document.createElement('div');
      t.className = 'ds-tile';
      const b = document.createElement('button');
      b.className = 'ds-tile-main';
      b.innerHTML = `<div class="ds-tile-pic">${pic}</div><b></b><span></span>`;
      b.querySelector('b')!.textContent = title;
      b.querySelector('span')!.textContent = sub;
      b.onclick = open;
      t.appendChild(b);
      if (extra) t.appendChild(extra);
      return t;
    };
    const show = (which: string) => {
      shelf = which;
      try { localStorage.setItem(LIB_SHELF, which); } catch { /* fine */ }
      tabs.replaceChildren(...shelves.map(([k, label]) => {
        const b = document.createElement('button');
        b.textContent = label; b.classList.toggle('active', k === which);
        b.onclick = () => show(k);
        return b;
      }));
      const grid = document.createElement('div');
      grid.className = 'ds-tiles';
      let note = '';
      if (which === 'parts') {
        note = listErr || (list.length ? 'Click one to open it.' : 'Nothing saved on the printer yet: Save puts the part here.');
        for (const d of list) {
          const del = document.createElement('button');
          del.className = 'ds-tile-del'; del.textContent = '×'; del.title = 'Delete this saved part from the printer';
          let armed = false;
          del.onclick = async () => {
            // two clicks to delete: no browser dialogs
            if (!armed) { armed = true; del.textContent = 'Delete?'; del.classList.add('armed'); return; }
            await fetch(`${API}${encodeURIComponent(d.name)}.json`, { method: 'DELETE' });
            list = list.filter((x) => x !== d);
            show('parts');
          };
          const pic = d.thumb ? `<img src="${d.thumb}" alt="">` : '<i class="ds-tile-none">no picture yet<br>(saved before pictures)</i>';
          grid.appendChild(tile(d.name, new Date(d.modified * 1000).toLocaleDateString(), pic, async () => {
            close();
            if (!await okToLeave()) return;
            try {
              const p = await (await fetch(`${API}${encodeURIComponent(d.name)}.json`)).json();
              st.load(p);
              setSavedAs(d.name);
              sheet.fit();
              flash(`Opened “${d.name}”.`);
            } catch (e: any) { flash(`Couldn't open it: ${e.message}`); }
          }, del));
        }
      } else if (which === 'models') {
        note = libOnly.length ? 'STL models from the printer’s library: one opens as the body, to add and cut shapes on.' : 'No other models in the printer’s library.';
        for (const m of libOnly) grid.appendChild(tile(m.name, `${Math.round(m.size / 1024)} KB`, '<i class="ds-tile-none">STL</i>', () => { close(); openModel(m.name); }));
      } else {
        note = 'Click one to drop it on the middle of this part (on the floor of a hollow box), then drag it where it goes. They are ordinary shapes: change or delete any of them. Sizes are the usual ones: check against your part.';
        for (const fp of FOOTPRINTS) {
          grid.appendChild(tile(fp.name, fp.note, footprintSvg(fp), () => {
            close();
            const feats = placeFootprint(fp, st.p);
            st.change((p) => { p.features.push(...feats); });
            st.setTool('select');
            st.select(feats.map((f) => f.id));
            st.activeView = 'top';
            flash(`${fp.name}: drag it into place (the group moves together).`);
          }));
        }
      }
      const n = document.createElement('p'); n.className = 'ds-note'; n.textContent = note;
      body.replaceChildren(n, grid);
    };
    show(shelves.some(([k]) => k === shelf) ? shelf : 'parts');
  };

  /** A footprint drawn small: its outlines from the top, cuts dark, standoffs light. */
  function footprintSvg(fp: (typeof FOOTPRINTS)[number]): string {
    const feats = fp.make();
    const polys = feats.map((f) => ({ pts: profile(f, 32), add: f.op === 'add' }));
    const all = polys.flatMap((q) => q.pts);
    if (!all.length) return '';
    const xs = all.map((q) => q[0]), ys = all.map((q) => q[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = Math.max(x1 - x0, y1 - y0) * 0.12 + 1;
    const d = (pts: P2[]) => `M${pts.map(([x, y]) => `${x.toFixed(2)} ${(-y).toFixed(2)}`).join('L')}Z`;
    return `<svg viewBox="${x0 - pad} ${-y1 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}" preserveAspectRatio="xMidYMid meet">`
      + polys.sort((a, b) => Number(b.add) - Number(a.add)).map((q) => `<path d="${d(q.pts)}" class="${q.add ? 'add' : 'cut'}"/>`).join('') + '</svg>';
  }

  const fileName = () => `${(st.p.name || 'part').replace(/\.stl$/i, '')}.stl`;
  const getSTL = async (): Promise<ArrayBuffer> => call({ type: 'stl', project: JSON.parse(JSON.stringify(st.p)) });
  const download = (data: BlobPart, type: string, name: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  // Export: the STL, or a flat DXF of one view (what the sheet draws there)
  const exportMenu = $('#ds-export-menu');
  const closeExport = () => { exportMenu.classList.add('hidden'); window.removeEventListener('pointerdown', outsideExport, true); };
  const outsideExport = (e: Event) => { if (!(e.target as HTMLElement).closest('.ds-export')) closeExport(); };
  const dxfOf = (view: ViewName, hidden: boolean) => {
    const edges = st.built?.views[view];
    if (!edges) { flash('The drawing is still being worked out: try again in a moment.'); return; }
    const stem = (st.p.name || 'part').replace(/\.stl$/i, '');
    download(viewDxf(edges, { hidden }), 'application/dxf', `${stem} ${VIEWS[view].label.toLowerCase()}.dxf`);
    flash(`${VIEWS[view].label} view saved as a DXF in mm${hidden ? ', hidden lines dashed on their own layer' : ''}.`);
  };
  $('#ds-stl').onclick = () => {
    if (!exportMenu.classList.contains('hidden')) { closeExport(); return; }
    const v = st.activeView, label = VIEWS[v].label;
    exportMenu.innerHTML = '';
    const item = (text: string, sub: string, run: () => void) => {
      const b = document.createElement('button');
      b.innerHTML = `<b>${text}</b><small>${sub}</small>`;
      b.onclick = () => { closeExport(); run(); };
      exportMenu.appendChild(b);
    };
    item('STL', 'The 3D part, for any slicer', async () => download(await getSTL(), 'model/stl', fileName()));
    item(`DXF of the ${label} view`, 'Its outlines, flat, in mm: for a laser, the router or other CAD', () => dxfOf(v, false));
    item(`DXF of the ${label} view + hidden lines`, 'Hidden lines dashed on their own layer', () => dxfOf(v, true));
    const other = document.createElement('label');
    other.className = 'ds-menu-row';
    other.innerHTML = `<span>Another view</span><select class="ds-select">${(['top', 'front', 'right', 'left', 'back', 'bottom'] as ViewName[]).map((n) => `<option value="${n}" ${n === v ? 'selected' : ''}>${VIEWS[n].label}</option>`).join('')}</select>`;
    (other.querySelector('select') as HTMLSelectElement).onchange = (e) => { closeExport(); dxfOf((e.target as HTMLSelectElement).value as ViewName, false); };
    exportMenu.appendChild(other);
    exportMenu.classList.remove('hidden');
    window.addEventListener('pointerdown', outsideExport, true);
  };
  $('#ds-send').onclick = async () => {
    const b = $('#ds-send') as HTMLButtonElement;
    if (!await runCheck('Send to Prepare')) return;
    b.disabled = true;
    try {
      const buf = await getSTL();
      studio.show('prepare');
      await studio.prepare.addFiles([{ name: fileName(), buffer: buf }]);
      // pick how it sits on the bed; Prepare shows it and can be changed there
      (document.querySelector('#auto-orient') as HTMLButtonElement | null)?.click();
    } finally { b.disabled = false; }
  };

  $('#ds-cam').onclick = () => studio.sendToCam?.(JSON.parse(JSON.stringify(st.p)), st.p.name || 'part');

  function syncToolbar() {
    root.querySelectorAll<HTMLButtonElement>('#ds-tool > button[data-tool], .ds-flyout button[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === st.tool));
    // a group's button shows the tool in use (or the last one picked from it)
    root.querySelectorAll<HTMLElement>('.ds-tgroup').forEach((g) => {
      const name = g.dataset.group!, list = GROUPS[name];
      const inUse = list.find((t) => t.tool === st.tool);
      if (inUse) groupPick[name] = inUse.tool;
      const shown = list.find((t) => t.tool === groupPick[name]) || list[0];
      const main = g.querySelector('.ds-tgroup-main') as HTMLButtonElement;
      if (main.dataset.tool !== shown.tool) {
        main.dataset.tool = shown.tool;
        main.innerHTML = `${(ICONS as any)[shown.tool]}<i class="ds-tgroup-more"></i>`;
        main.title = `${shown.name} (${shown.key})\n${shown.tip}\nHold for the others`;
      }
      main.classList.toggle('active', !!inUse);
    });
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
    const again = st.repick ? st.feature(st.repick) : undefined;
    if (again?.fillet) {
      // re-picked: the same fillet, its edges replaced
      const idx = st.p.features.indexOf(again);
      st.change(() => {
        again.fillet!.edges = st.edges.map((e) => [...e] as [number, number, number]);
        again.fillet!.refs = again.fillet!.edges.map((pt) => findRef(pt, st.p, idx));
        again.fillet!.mode = edgeMode; again.fillet!.size = edgeSize;
      });
      st.edges = [];
      st.setTool('select');
      st.select([again.id]);
      requestBuild();
      return;
    }
    const f: Feature = {
      id: newId(), type: 'fillet', view: st.activeView, cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, d0: 0, d1: 0, op: 'add', through: false,
      fillet: { mode: edgeMode, size: edgeSize, edges: st.edges.map((e) => [...e] as [number, number, number]) },
    };
    f.fillet!.refs = f.fillet!.edges.map((pt) => findRef(pt, st.p));
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

  /** Fillets with edges that are gone, and how many. */
  function lostFillets() {
    const out: { id: string; n: number }[] = [];
    for (const f of st.p.features) {
      const now = st.built?.fillets?.[f.id];
      const n = now ? now.filter((q) => !q).length : 0;
      if (f.fillet && n) out.push({ id: f.id, n });
    }
    return out;
  }

  /** Pick a fillet's edges again: the edge tool, starting from the ones still there. */
  function repick(id: string) {
    const f = st.feature(id);
    if (!f?.fillet) return;
    edgeMode = f.fillet.mode; edgeSize = f.fillet.size;
    st.setTool('edge');
    st.repick = id;
    wasRepick = true;
    requestBuild();
    st.edges = (st.built?.fillets?.[id] || []).filter((q): q is [number, number, number] => !!q).map((q) => [...q] as [number, number, number]);
    st.emit('select');
  }

  function renderCtx() {
    const kids: HTMLElement[] = [];
    const feats = st.sels.filter((id) => id !== 'stock');
    const view = VIEWS[st.activeView].label;
    const fmt = (mm: number) => fmtLen(mm, st.p);
    if (st.tool === 'edge') {
      kids.push(label(`${st.repick ? 'Re-pick: ' : ''}${st.edges.length ? `${st.edges.length} edge${st.edges.length > 1 ? 's' : ''}` : 'Edges'}`));
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
      if (f.type === 'hole') {
        const b = mk('button', 'btn sm ghost', 'Edit hole…') as HTMLButtonElement;
        b.onclick = () => editHole(f.id, false);
        kids.push(b);
      } else if (isShape(f)) {
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
    } else if (!st.sels.length && lostFillets().length) {
      const lost = lostFillets();
      const n = lost.reduce((a, x) => a + x.n, 0);
      kids.push(mk('span', 'ds-ctx-label ds-lost', `${lost.length === 1 ? 'A fillet' : `${lost.length} fillets`} lost ${n} edge${n > 1 ? 's' : ''}`));
      kids.push(mk('span', 'ds-ctx-hint', 'Those edges are no longer on the part.'));
      const b = mk('button', 'btn sm primary', 'Re-pick') as HTMLButtonElement;
      b.onclick = () => repick(lost[0].id);
      kids.push(b);
    } else {
      const s = st.p.stock;
      kids.push(label(st.p.base ? `Body: ${st.p.base.model}` : s.off ? 'No block' : 'Body'));
      if (s.off && !st.p.base) kids.push(mk('span', 'ds-ctx-hint', 'The shapes stand on their own.'));
      else kids.push(mk('span', 'ds-ctx-hint', `${fmt(s.max[0] - s.min[0])} × ${fmt(s.max[1] - s.min[1])} × ${fmt(s.max[2] - s.min[2])}${st.p.units === 'mm' ? ' mm' : ''}`));
      kids.push(mk('span', 'ds-ctx-hint', st.sels.length ? 'Drag its handles to resize it. Shift-click shapes to line them up to it.' : 'Pick a tool on the left and draw on a view.'));
    }
    ctx.replaceChildren(...kids);
  }

  // ---------------------------------------------------------- rotate
  const ROT_KEY = 'studio.design.lastRotate';
  let rotating = false;
  function editRotate() {
    if (rotating || root.querySelector('.ds-modal')) return;
    const view = st.activeView;
    const b = sheet.selBox(view);
    if (!b) return;
    const V = VIEWS[view];
    const [ua, us] = axisOf(V.uDir), [va, vs] = axisOf(V.vDir);
    const orig = JSON.stringify(st.p);
    const restore = () => { st.p = JSON.parse(orig); st.changed(); };
    let last = 90;
    try { last = parseFloat(localStorage.getItem(ROT_KEY) || '90') || 90; } catch { /* default */ }
    const ids = st.sels.filter((id) => id !== 'stock');
    rotating = true;
    openRotateDialog(root, {
      box: b, axes: ['XYZ'[ua], 'XYZ'[va]], signs: [us, vs], units: st.p.units, count: ids.length, last,
      preview(deg, pu, pv) { st.p = JSON.parse(orig); st.sels = ids; st.rotateSelected(deg, V.toWorld(pu, pv, 0), V.eye, false); },
      apply(deg, pu, pv, copy) {
        rotating = false;
        st.p = JSON.parse(orig);
        st.sels = ids;
        try { localStorage.setItem(ROT_KEY, String(deg)); } catch { /* fine */ }
        if (copy) { st.duplicate(view, 0); st.rotateSelected(deg, V.toWorld(pu, pv, 0), V.eye, false); }
        else {
          const skipped = st.rotateSelected(deg, V.toWorld(pu, pv, 0), V.eye);
          if (skipped) flash(`${skipped} shape${skipped > 1 ? 's' : ''} drawn on another face didn't turn (they turn in a view that looks at them square on)`);
        }
        sheet.relayout();
      },
      cancel() { rotating = false; restore(); },
    });
  }
  sheet.onRotate = editRotate;

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
    if ((e.metaKey || e.ctrlKey) && k === 'c') { if (st.copy()) { e.preventDefault(); flash('Copied: ⌘V pastes here or in the other part tab'); } return; }
    if ((e.metaKey || e.ctrlKey) && k === 'x') { if (st.copy()) { e.preventDefault(); st.deleteSelected(); } return; }
    if ((e.metaKey || e.ctrlKey) && k === 'v') { e.preventDefault(); if (st.paste(st.activeView)) sheet.relayout(); return; }
    if ((e.metaKey || e.ctrlKey) && k === 'd') { e.preventDefault(); if (st.duplicate(st.activeView)) sheet.relayout(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (root.querySelector('.ds-modal')) return;
    if (k === 'escape' && st.tool === 'edge' && st.edges.length) { st.edges = []; st.emit('select'); return; }
    if (k === 'r' && e.shiftKey) { e.preventDefault(); st.setTool('rotate'); return; }
    const keys: Record<string, Tool> = { v: 'select', m: 'measure', x: 'section', r: 'rect', s: 'slot', c: 'circle', p: 'polygon', l: 'line', o: 'hole', g: 'gear', t: 'text', e: 'edge', d: 'dim', z: 'zoom' };
    if (k === 'escape') { st.setTool('select'); st.select([]); if (st.farFace) { st.farFace = false; st.emit('tool'); } }
    else if (keys[k]) st.setTool(keys[k]);
    else if (k === 'h') toggleFar();
    else if (k === 'f') sheet.fit();
    else if (k === 'delete' || k === 'backspace') { e.preventDefault(); st.deleteSelected(); }
  });

  studio.onPage((p) => { preview.active = p === 'design'; if (p === 'design') { preview.resize(); sheet.render(); } });
  syncToolbar();
  requestBuild();
  return { openModel };
}
