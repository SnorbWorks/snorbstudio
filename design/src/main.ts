// The Design tab: an orthographic drafting sheet that builds a printable
// solid. Studio loads this module the first time the tab is opened.

import type { Project } from './model.js';
import { newProject } from './model.js';
import { State, align, distribute, type AlignHow } from './state.js';
import { VIEWS } from './views.js';
import { fmtLen } from './sheet.js';
import { Sheet, isTyping } from './sheet.js';
import { Panel } from './panel.js';
import { Preview3D } from './preview3d.js';

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
  <button class="btn sm ghost" id="ds-stl" title="Download the STL">STL</button>
  <button class="btn sm primary" id="ds-send" title="Put it on the plate in Prepare">Send to Prepare</button>
</div>
<div class="ds-body">
  <nav class="ds-toolbox" id="ds-tool">
    <button data-tool="select" title="Select (V)&#10;Shift-click or drag a box to select several.&#10;Option-click a side of a rectangle.">${ICONS.select}</button>
    <button data-tool="rect" title="Rectangle (R)">${ICONS.rect}</button>
    <button data-tool="circle" title="Circle (C): drag out from the centre">${ICONS.circle}</button>
  </nav>
  <div class="ds-sheet-wrap" id="ds-sheet"><div class="ds-loading" id="ds-loading">Loading the CAD engine…</div></div>
  <aside class="ds-side">
    <div class="ds-3d" id="ds-3d"></div>
    <div class="ds-panel" id="ds-panel"></div>
  </aside>
</div>
<div class="ds-status" id="ds-status"></div>`;

export function mount(root: HTMLElement, studio: Studio) {
  root.innerHTML = html;
  const $ = (s: string) => root.querySelector(s) as HTMLElement;
  const st = new State();
  const sheet = new Sheet($('#ds-sheet'), st);
  new Panel($('#ds-panel'), st);
  const preview = new Preview3D($('#ds-3d'));
  (window as any).__design = { st, sheet };     // for poking at from the console
  sheet.onStatus = (t) => { $('#ds-status').textContent = t; };

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
        $('#ds-loading').classList.add('hidden');
        preview.setMesh(r.mesh);
        sheet.relayout();
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
    sheet.render();
    syncToolbar();
  });

  // ---------------------------------------------------------- toolbar
  root.querySelectorAll<HTMLButtonElement>('#ds-tool button').forEach((b) => { b.onclick = () => st.setTool(b.dataset.tool as any); });
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
    root.querySelectorAll<HTMLButtonElement>('#ds-tool button').forEach((b) => b.classList.toggle('active', b.dataset.tool === st.tool));
    ($('#ds-undo') as HTMLButtonElement).disabled = !st.canUndo;
    ($('#ds-redo') as HTMLButtonElement).disabled = !st.canRedo;
    if (document.activeElement !== name) name.value = st.p.name;
    renderCtx();
  }

  // ---------------------------------------------------------- the bar that follows the selection
  let alignTo: 'selection' | 'part' = 'selection';
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
    if (st.sides) {
      kids.push(label(st.sides.sides.length === 2 ? 'Corner of a rectangle' : 'Side of a rectangle'));
      kids.push(mk('span', 'ds-ctx-hint', st.sides.sides.length === 2 ? 'Set its radius on the right.' : 'Option-Shift-click a side next to it to pick their corner.'));
    } else if (feats.length > 1) {
      kids.push(label(`${feats.length} shapes`));
      kids.push(alignGroup(alignTo));
      const seg = mk('div', 'ds-seg ds-small');
      for (const [v, t] of [['selection', 'to each other'], ['part', 'to the part']] as const) {
        const b = mk('button', alignTo === v ? 'active' : '', t) as HTMLButtonElement;
        b.onclick = () => { alignTo = v; renderCtx(); };
        seg.appendChild(b);
      }
      kids.push(seg);
      kids.push(group(
        iconBtn(ICONS.disth, 'Space the centres evenly across (3 or more)', () => distribute(st, 'h'), feats.length < 3),
        iconBtn(ICONS.distv, 'Space the centres evenly up and down (3 or more)', () => distribute(st, 'v'), feats.length < 3),
      ));
      kids.push(mk('span', 'ds-ctx-hint', `in ${view}`));
      kids.push(group(iconBtn(ICONS.trash, 'Delete (⌫)', () => st.deleteSelected())));
    } else if (feats.length === 1) {
      const f = st.feature(feats[0])!;
      kids.push(label(f.type === 'circle' ? 'Circle' : 'Rectangle'));
      const seg = mk('div', 'ds-seg ds-small');
      for (const [v, t] of [['add', 'Add ▲'], ['cut', 'Cut ▼']] as const) {
        const b = mk('button', f.op === v ? 'active' : '', t) as HTMLButtonElement;
        b.onclick = () => { if (f.op === v) return; st.change(() => { const dep = Math.abs(f.d1 - f.d0); f.op = v; f.d1 = v === 'add' ? f.d0 + dep : f.d0 - dep; }); };
        seg.appendChild(b);
      }
      kids.push(seg);
      kids.push(mk('span', 'ds-ctx-hint', 'Align to the part'));
      kids.push(alignGroup('part'));
      kids.push(mk('span', 'ds-ctx-hint', `in ${view}`));
      kids.push(group(iconBtn(ICONS.trash, 'Delete (⌫)', () => st.deleteSelected())));
    } else {
      const s = st.p.stock;
      kids.push(label(st.sels[0] === 'stock' ? 'Stock block' : 'Part'));
      kids.push(mk('span', 'ds-ctx-hint', `${fmt(s.max[0] - s.min[0])} × ${fmt(s.max[1] - s.min[1])} × ${fmt(s.max[2] - s.min[2])}${st.p.units === 'mm' ? ' mm' : ''}`));
      kids.push(mk('span', 'ds-ctx-hint', st.sels.length ? 'Drag its handles to resize it.' : 'Pick a tool on the left and draw on a view.'));
    }
    ctx.replaceChildren(...kids);
  }

  // ---------------------------------------------------------- keys
  window.addEventListener('keydown', (e) => {
    if (studio.page !== 'design' || isTyping()) return;
    const k = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) st.redo(); else st.undo(); return; }
    if ((e.metaKey || e.ctrlKey) && k === 'y') { e.preventDefault(); st.redo(); return; }
    if ((e.metaKey || e.ctrlKey) && k === 'a') { e.preventDefault(); st.select(st.p.features.map((f) => f.id)); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (k === 'v' || k === 'escape') { st.setTool('select'); if (k === 'escape') st.select([]); }
    else if (k === 'r') st.setTool('rect');
    else if (k === 'c') st.setTool('circle');
    else if (k === 'f') sheet.fit();
    else if (k === 'delete' || k === 'backspace') { e.preventDefault(); st.deleteSelected(); }
  });

  studio.onPage((p) => { preview.active = p === 'design'; if (p === 'design') { preview.resize(); sheet.render(); } });
  syncToolbar();
  requestBuild();
}
