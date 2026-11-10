// The Design tab: an orthographic drafting sheet that builds a printable
// solid. Studio loads this module the first time the tab is opened.

import type { Project } from './model.js';
import { newProject } from './model.js';
import { State } from './state.js';
import { Sheet, isTyping } from './sheet.js';
import { Panel } from './panel.js';
import { Preview3D } from './preview3d.js';

interface Studio {
  prepare: { addFiles(files: { name: string; buffer: ArrayBuffer }[]): Promise<void> };
  show(page: string): void;
  onPage(fn: (p: string) => void): void;
  page: string;
}

const html = `
<div class="ds-tools">
  <div class="ds-seg" id="ds-tool">
    <button data-tool="select" title="Select and drag (V)">Select</button>
    <button data-tool="rect" title="Rectangle (R)">Rectangle</button>
    <button data-tool="circle" title="Circle (C), drag from the centre">Circle</button>
  </div>
  <div class="ds-seg">
    <button id="ds-undo" title="Undo (⌘Z)">Undo</button>
    <button id="ds-redo" title="Redo (⇧⌘Z)">Redo</button>
  </div>
  <button class="btn sm ghost" id="ds-fit" title="Fit the sheet (F)">Fit</button>
  <span class="spacer"></span>
  <span class="ds-busy hidden" id="ds-busy">Building…</span>
  <input class="ds-name" id="ds-name" title="Part name" spellcheck="false">
  <button class="btn sm ghost" id="ds-new" title="Start a new part">New</button>
  <button class="btn sm ghost" id="ds-stl" title="Download the STL">STL</button>
  <button class="btn sm primary" id="ds-send" title="Put it on the plate in Prepare">Send to Prepare</button>
</div>
<div class="ds-body">
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
    if (w === 'view') sheet.relayout();
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
  }

  // ---------------------------------------------------------- keys
  window.addEventListener('keydown', (e) => {
    if (studio.page !== 'design' || isTyping()) return;
    const k = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) st.redo(); else st.undo(); return; }
    if ((e.metaKey || e.ctrlKey) && k === 'y') { e.preventDefault(); st.redo(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (k === 'v' || k === 'escape') { st.setTool('select'); if (k === 'escape') st.select(null); }
    else if (k === 'r') st.setTool('rect');
    else if (k === 'c') st.setTool('circle');
    else if (k === 'f') sheet.fit();
    else if ((k === 'delete' || k === 'backspace') && st.sel && st.sel !== 'stock') {
      const id = st.sel;
      st.change((p) => { p.features = p.features.filter((f) => f.id !== id); });
      st.select(null);
    }
  });

  studio.onPage((p) => { preview.active = p === 'design'; if (p === 'design') { preview.resize(); sheet.render(); } });
  syncToolbar();
  requestBuild();
}
