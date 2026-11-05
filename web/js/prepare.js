// Prepare page: load models, place them, check overhangs, slice on the Pi,
// preview the result and start the print.

import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { Viewer, BED } from './viewer.js';
import * as T from './mesh_tools.js';
import { GcodePreview, parseGcode, FEATURES } from './gcode_preview.js';
import { mr } from './moonraker.js';
import { buildShape, shapeName, shapeForm } from './shapes.js';
import { $, $$, el, toast, attempt, confirmBox, fmtBytes, fmtDate, debounce } from './ui.js';
import * as fil from './filaments.js';

const MAX_LIVE_FACES = 150000;     // repaint overhangs while dragging below this
let viewer, preview;
let selected = null;
let lastSlice = null;              // { file, stats }
let app;
const undoStack = [];

export function initPrepare(theApp) {
  app = theApp;
  viewer = new Viewer($('#viewport'));
  preview = new GcodePreview(viewer.preview);
  wireViewer();
  wireSidebar();
  wireDrop();
  loadInfo();
  restorePlate();
  refreshList();
  refreshSelection();
  refreshForecast();
  app.onPage((p) => { viewer.active = p === 'prepare'; if (viewer.active) viewer.resize(); });
  mr.on('status', followPrint);
  return { addFiles, loadFromLibrary, previewFile };
}

const models = () => viewer.models.children;
const angle = () => +$('#overhang-angle').value;
const showOverhang = () => $('#show-overhang').checked;

// --------------------------------------------------------------- loading

async function parseModel(name, buffer) {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'stl') return T.toGeometry(new STLLoader().parse(buffer));
  if (ext === 'obj') return T.toGeometry(new OBJLoader().parse(new TextDecoder().decode(buffer)));
  if (ext === '3mf') return T.toGeometry(new ThreeMFLoader().parse(buffer));
  throw new Error(`${name}: only STL, 3MF and OBJ files can be loaded`);
}

async function addFiles(files, { saveToLibrary = true, fromLibrary = false, restore = null } = {}) {
  setMsg('Loading…');
  for (const f of files) {
    try {
      const buffer = f.buffer || await f.arrayBuffer();
      const geo = await parseModel(f.name, buffer);
      const mesh = T.makeMesh(geo, f.name);
      viewer.models.add(mesh);
      if (saveToLibrary) {
        fetch(`/studio-api/models/${encodeURIComponent(f.name)}`, { method: 'PUT', body: buffer })
          .catch(() => {});
      }
      // Library files can be reloaded later, so the plate can be restored.
      mesh.userData.lib = saveToLibrary || fromLibrary ? f.name : null;
      if (restore) {
        mesh.position.fromArray(restore.p); mesh.quaternion.fromArray(restore.q); mesh.scale.fromArray(restore.s);
      } else {
        T.dropToBed(mesh);
        checkSize(mesh);
      }
      select(mesh);
    } catch (e) {
      toast(e.message, 'err', 8000);
    }
  }
  if (restore) { /* keep saved placement */ }
  else if (models().length > 1) T.arrange(models()); else if (models()[0]) T.centerOnBed(models()[0]);
  setMsg('');
  showModelView();
  changed();
}

function checkSize(mesh) {
  const s = T.worldBox(mesh).getSize(new THREE.Vector3());
  const big = Math.max(s.x / BED.x, s.y / BED.y, s.z / BED.z);
  if (big > 1) {
    const pct = Math.floor(95 / big);
    mesh.scale.multiplyScalar(pct / 100);
    T.dropToBed(mesh);
    toast(`${mesh.userData.name} was bigger than the bed, so it was scaled to ${pct}%.`, '', 8000);
  } else if (Math.max(s.x, s.y, s.z) < 3) {
    toast(`${mesh.userData.name} is tiny (${s.x.toFixed(2)} mm wide). If it was made in inches, scale it by 2540%.`, '', 9000);
  }
}

async function loadFromLibrary(name) {
  const r = await fetch(`/studio-api/models/${encodeURIComponent(name)}`);
  if (!r.ok) return toast(`Couldn't load ${name}`, 'err');
  await addFiles([{ name, buffer: await r.arrayBuffer() }], { saveToLibrary: false, fromLibrary: true });
  app.show('prepare');
}

async function addShape() {
  const f = shapeForm();
  if (!await confirmBox('Add a shape', f.form, 'Add to bed')) return;
  const { kind, values } = f.read();
  try {
    const mesh = T.makeMesh(T.toGeometry(await buildShape(kind, values)), 'shape');
    await addFiles([{ name: shapeName(kind, values), buffer: T.toSTL(mesh) }]);
  } catch (e) {
    toast(e.message, 'err', 7000);
  }
}

// --------------------------------------------------------------- plate memory

const PLATE_KEY = 'studio.plate';
const savePlate = debounce(() => {
  const plate = models().filter((m) => m.userData.lib).map((m) => ({
    lib: m.userData.lib, p: m.position.toArray(), q: m.quaternion.toArray(), s: m.scale.toArray() }));
  try { localStorage.setItem(PLATE_KEY, JSON.stringify(plate)); } catch (e) { /* ignore */ }
}, 400);

async function restorePlate() {
  let plate = [];
  try { plate = JSON.parse(localStorage.getItem(PLATE_KEY) || '[]'); } catch (e) { return; }
  if (!plate.length) return;
  setMsg('Restoring your last plate…');
  for (const item of plate) {
    try {
      const r = await fetch(`/studio-api/models/${encodeURIComponent(item.lib)}`);
      if (!r.ok) continue;
      await addFiles([{ name: item.lib, buffer: await r.arrayBuffer() }],
        { saveToLibrary: false, fromLibrary: true, restore: item });
    } catch (e) { /* skip missing */ }
  }
  select(null);
  setMsg('');
}

function wireDrop() {
  const vp = $('#viewport');
  let depth = 0;
  document.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; vp.classList.add('dragging'); } });
  document.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; vp.classList.remove('dragging'); } });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    vp.classList.remove('dragging');
    const files = [...(e.dataTransfer?.files || [])];
    const models3d = files.filter((f) => /\.(stl|3mf|obj)$/i.test(f.name));
    const gcodes = files.filter((f) => /\.(gcode|gco|g)$/i.test(f.name));
    if (models3d.length) { app.show('prepare'); addFiles(models3d); }
    for (const g of gcodes) attempt(() => mr.upload(g), `Uploaded ${g.name} to Files`);
    if (!models3d.length && !gcodes.length && files.length) toast('Drop STL, 3MF, OBJ or G-code files', 'err');
  });
  $('#open-files').onclick = $('#add-model').onclick = () => $('#file-input').click();
  $('#file-input').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
}

// --------------------------------------------------------------- selection

function select(mesh) {
  if (selected) selected.material.emissive.setHex(0x000000);
  selected = mesh;
  if (mesh) mesh.material.emissive.setHex(0x2a1606);
  viewer.attach(mesh && !viewer.preview.visible ? mesh : null);
  refreshList();
  refreshSelection();
}

function refreshSelection() {
  const on = !!selected;
  $$('#pos-panel button, #pos-panel input').forEach((b) => {
    if (!['arrange'].includes(b.id)) b.disabled = !on;
  });
  $('#arrange').disabled = models().length === 0;
  $('#sel-name').textContent = on ? selected.userData.name : 'select a model';
  if (on) {
    const s = T.worldBox(selected).getSize(new THREE.Vector3());
    $('#dims').textContent = `${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} mm`;
    const sc = selected.scale;
    $('#scale-pct').value = Math.abs(sc.x - sc.y) < 1e-6 && Math.abs(sc.y - sc.z) < 1e-6
      ? +(sc.x * 100).toFixed(1) : '';
    const cm3 = T.volume(selected) / 1000;
    $('#model-stats').textContent = `Volume ${cm3.toFixed(1)} cm³ · about ${(cm3 * 1.24).toFixed(0)} g if printed solid PLA`;
  } else {
    $('#dims').textContent = '–';
    $('#model-stats').textContent = '';
  }
}

function refreshList() {
  const list = $('#model-list');
  list.replaceChildren(...models().map((m) => el('div', {
    class: `model-item ${m === selected ? 'sel' : ''} ${T.inBounds(m) ? '' : 'bad'}`,
    onclick: () => select(m),
    title: T.inBounds(m) ? '' : 'Partly off the bed or too tall',
  }, el('span', { class: 'nm' }, m.userData.name),
  el('span', { class: 'muted small', title: 'Triangles' }, m.userData.faces >= 1000 ? `${(m.userData.faces / 1000).toFixed(0)}k` : m.userData.faces),
  el('button', { class: 'x', title: 'Remove', onclick: (e) => { e.stopPropagation(); removeModel(m); } }, '✕'))));
  const n = models().length;
  $('#plate-count').textContent = n ? `${n} on the bed` : '';
  $('#drop-hint').classList.toggle('hidden', n > 0 || viewer.preview.visible);
  $('#slice-btn').disabled = n === 0;
  if (!$('#job-name').value && n) $('#job-name').placeholder = models()[0].userData.name.replace(/\.\w+$/, '');
}

function removeModel(m) {
  if (m === selected) select(null);
  viewer.models.remove(m);
  m.geometry.dispose();
  changed();
}

// --------------------------------------------------------------- undo

function snapshot(meshes = selected ? [selected] : []) {
  if (!meshes.length) return;
  undoStack.push(meshes.map((m) => ({ m, p: m.position.clone(), q: m.quaternion.clone(), s: m.scale.clone() })));
  if (undoStack.length > 50) undoStack.shift();
}

function undo() {
  const step = undoStack.pop();
  if (!step) return;
  for (const { m, p, q, s } of step) {
    if (m.parent !== viewer.models) continue;
    m.position.copy(p); m.quaternion.copy(q); m.scale.copy(s);
  }
  changed();
}

// --------------------------------------------------------------- viewer

function wireViewer() {
  viewer.addEventListener('pick', (e) => {
    const hit = e.detail;
    if (faceMode) {
      if (hit) { snapshot([hit.mesh]); T.layFlatOnFace(hit.mesh, hit.faceIndex); select(hit.mesh); changed(); }
      setFaceMode(false);
      return;
    }
    if (!viewer.preview.visible) select(hit ? hit.mesh : null);
  });
  viewer.addEventListener('transformstart', (e) => snapshot([e.detail]));
  viewer.addEventListener('transforming', (e) => {
    const m = e.detail;
    if (viewer.gizmo.mode !== 'translate') T.dropToBed(m);
    if (m.userData.faces < MAX_LIVE_FACES) T.paintOverhangs(m, showOverhang(), angle());
    refreshSelection();
  });
  viewer.addEventListener('transformend', () => changed());

  $$('#gizmo-mode button').forEach((b) => b.onclick = () => setGizmo(b.dataset.mode));
  $$('#view-buttons button').forEach((b) => b.onclick = () => viewer.setView(b.dataset.view));
  $$('#mode-toggle button').forEach((b) => b.onclick = () =>
    b.dataset.show === 'preview' ? showPreviewView() : showModelView());

  document.addEventListener('keydown', (e) => {
    if (!viewer.active || e.target.matches('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); undo(); return; }
    if ((e.metaKey || e.ctrlKey) && k === 'd') { e.preventDefault(); duplicate(); return; }
    if (e.metaKey || e.ctrlKey) return;
    if (k === 'w') setGizmo('translate');
    else if (k === 'e') setGizmo('rotate');
    else if (k === 'r') setGizmo('scale');
    else if (k === 'f' && selected) $('#lay-flat').click();
    else if (k === 'a') $('#arrange').click();
    else if ((k === 'delete' || k === 'backspace') && selected) removeModel(selected);
    else if (k === 'escape') { setFaceMode(false); select(null); }
    else if (viewer.preview.visible && (k === 'arrowup' || k === 'arrowdown')) {
      e.preventDefault();
      const s = $('#layer-slider');
      s.value = +s.value + (k === 'arrowup' ? 1 : -1);
      s.oninput();
    }
  });
}

function setGizmo(mode) {
  viewer.setGizmoMode(mode);
  $$('#gizmo-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
}

let faceMode = false;
function setFaceMode(on) {
  faceMode = on;
  $('#face-hint').classList.toggle('hidden', !on);
  if (on) viewer.attach(null); else viewer.attach(selected);
}

function setMsg(text) {
  $('#view-msg').textContent = text;
  $('#view-msg').classList.toggle('hidden', !text);
}

// Something about the plate changed: repaint, recheck, forget old slice.
function changed() {
  savePlate();
  for (const m of models()) T.paintOverhangs(m, showOverhang(), angle());
  refreshList();
  refreshSelection();
  refreshForecast();
  invalidateSlice();
}

const refreshForecast = debounce(() => {
  const box = $('#support-forecast');
  if (!models().length) { box.className = 'support-forecast'; box.textContent = 'Add a model to see where it will need support.'; return; }
  const total = models().reduce((s, m) => s + (m.userData.overhang || 0), 0);
  const cm2 = total / 100;
  const sup = $('#supports').value;
  box.replaceChildren();
  if (cm2 < 0.5) {
    box.className = 'support-forecast ok';
    box.append('No real overhangs – this should print without supports.');
  } else {
    box.className = 'support-forecast need';
    box.append(el('b', {}, `${cm2.toFixed(1)} cm² overhang`), ' (red areas) will sag without support.');
    if (sup === 'none') {
      box.append(el('div', { class: 'row' },
        el('button', { class: 'btn sm', onclick: () => { $('#supports').value = 'tree'; refreshForecast(); invalidateSlice(); } }, 'Use tree supports'),
        selected ? el('button', { class: 'btn sm ghost', onclick: () => $('#auto-orient').click() }, 'Try auto-orient') : null));
    }
  }
}, 120);

// --------------------------------------------------------------- sidebar

function wireSidebar() {
  const need = (fn) => () => { if (selected) { snapshot(); fn(selected); changed(); } };
  $('#lay-flat').onclick = need((m) => { T.layFlat(m); });
  $('#pick-face').onclick = () => setFaceMode(true);
  $('#face-cancel').onclick = (e) => { e.preventDefault(); setFaceMode(false); };
  $('#auto-orient').onclick = () => {
    if (!selected) return;
    snapshot();
    setMsg('Finding the best orientation…');
    setTimeout(() => {
      const r = T.autoOrient(selected, angle());
      setMsg('');
      changed();
      const b = r.before / 100, a = r.after / 100;
      toast(a < b - 0.05
        ? `Turned it to cut overhangs from ${b.toFixed(1)} to ${a.toFixed(1)} cm².`
        : `This orientation is already the best (${a.toFixed(1)} cm² of overhang).`, 'ok');
    }, 30);
  };
  $('#arrange').onclick = () => {
    snapshot(models().slice());
    if (!T.arrange(models())) toast("Everything doesn't fit on the bed at once – remove or scale something.", 'err', 7000);
    changed();
  };
  $$('[data-rot]').forEach((b) => b.onclick = need((m) => T.rotate90(m, b.dataset.rot)));
  $('#reset-rot').onclick = need((m) => { m.quaternion.identity(); T.dropToBed(m); });
  $('#scale-pct').onchange = need((m) => {
    const v = +$('#scale-pct').value;
    if (v > 0) { m.scale.setScalar(v / 100); T.dropToBed(m); checkFit(m); }
  });
  $('#center-model').onclick = need((m) => T.centerOnBed(m));
  $$('[data-turn]').forEach((b) => b.onclick = need((m) => T.rotateBy(m, b.dataset.turn, +$('#rot-angle').value || 0)));
  $$('[data-mirror]').forEach((b) => b.onclick = need((m) => T.mirror(m, b.dataset.mirror)));
  $('#inch-mm').onclick = need((m) => { m.scale.multiplyScalar(25.4); T.dropToBed(m); checkSize(m); checkFit(m); });
  $('#make-copies').onclick = () => {
    if (!selected) return;
    const n = Math.max(2, Math.min(50, +$('#copies').value || 2));
    for (let i = 1; i < n; i++) duplicate(false);
    if (!T.arrange(models())) toast(`${n} copies don't all fit on the bed – try fewer.`, 'err', 7000);
    changed();
  };
  $('#dup-model').onclick = () => duplicate();
  $('#del-model').onclick = () => selected && removeModel(selected);
  $('#clear-plate').onclick = async () => {
    if (models().length && await confirmBox('Clear the bed?', 'Remove every model from the plate. (They stay in your library.)', 'Clear', true)) {
      select(null);
      for (const m of [...models()]) removeModel(m);
    }
  };
  $('#from-library').onclick = () => app.show('files');
  $('#add-shape').onclick = addShape;

  $('#show-overhang').onchange = changed;
  $('#overhang-angle').oninput = () => {
    $('#overhang-val').textContent = `${angle()}°`;
    for (const m of models()) T.paintOverhangs(m, showOverhang(), angle());
    refreshForecast();
  };
  $('#overhang-angle').onchange = invalidateSlice;
  $('#infill').oninput = () => { $('#infill-val').textContent = `${$('#infill').value}%`; };
  for (const id of ['#supports', '#quality', '#material', '#brim', '#infill']) {
    $(id).addEventListener('change', () => { invalidateSlice(); refreshForecast(); saveSettings(); });
  }
  $('#material').addEventListener('change', materialInfo);
  mr.on('status', (st) => { if (st && ('save_variables' in st)) materialInfo(); });
  wireAdvanced();
  $('#slice-btn').onclick = slice;
  $('#slice-cancel').onclick = () => currentJob && fetch(`/studio-api/jobs/${currentJob}/cancel`, { method: 'POST' });
  $('#print-now').onclick = () => lastSlice && app.startPrint(lastSlice.file);
  $('#show-preview').onclick = () => lastSlice && previewFile(lastSlice.file);
  $('#layer-slider').oninput = () => {
    preview.setLayer(+$('#layer-slider').value - 1, $('#layer-single').checked);
    layerLabel();
  };
  $('#layer-single').onchange = $('#layer-slider').oninput;
}

// --------------------------------------------------------------- advanced

function advancedValues() {
  const out = {};
  for (const f of $$('[data-adv]')) {
    if (f.type === 'checkbox') { if (f.checked) out[f.dataset.adv] = 1; }
    else if (f.value !== '') out[f.dataset.adv] = f.value;
  }
  return out;
}

function advCount() {
  const n = Object.keys(advancedValues()).length;
  $('#adv-count').textContent = n ? `${n} changed` : '';
}

function wireAdvanced() {
  for (const f of $$('[data-adv]')) {
    f.addEventListener('change', () => { advCount(); invalidateSlice(); saveSettings(); });
  }
  $('#adv-reset').onclick = () => {
    for (const f of $$('[data-adv]')) f.type === 'checkbox' ? (f.checked = false) : (f.value = '');
    advCount(); invalidateSlice(); saveSettings();
  };
}

function checkFit(m) {
  if (!T.inBounds(m)) toast(`${m.userData.name} doesn't fit where it is – move it or press Arrange all.`, 'err');
}

function duplicate(arrangeNow = true) {
  if (!selected) return;
  const m = T.makeMesh(selected.geometry.clone(), selected.userData.name);
  m.position.copy(selected.position);
  m.quaternion.copy(selected.quaternion);
  m.scale.copy(selected.scale);
  viewer.models.add(m);
  if (arrangeNow === false) return;
  if (!T.arrange(models())) toast('The copies no longer all fit on the bed.', 'err');
  select(m);
  changed();
}

const SETTINGS_KEY = 'studio.printSettings';
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      quality: $('#quality').value, material: $('#material').value, supports: $('#supports').value,
      brim: $('#brim').value, infill: $('#infill').value, angle: $('#overhang-angle').value,
      advanced: advancedValues() }));
  } catch (e) { /* private mode */ }
}

async function loadInfo() {
  let info;
  try { info = await fil.loadInfo(); } catch (e) {
    toast('The slicing helper on the Pi is not running.', 'err', 8000);
    return;
  }
  const fill = (sel, opts) => $(sel).replaceChildren(...Object.entries(opts).map(([v, l]) => el('option', { value: v }, l)));
  fill('#quality', info.quality); fill('#material', info.material); fill('#supports', info.supports);
  $('#quality').value = 'standard';
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    for (const k of ['quality', 'material', 'supports', 'brim', 'infill']) if (s[k] != null) $(`#${k}`).value = s[k];
    if (s.angle) $('#overhang-angle').value = s.angle;
    for (const [k, v] of Object.entries(s.advanced || {})) {
      const f = $(`[data-adv="${k}"]`);
      if (f) f.type === 'checkbox' ? (f.checked = !!v) : (f.value = v);
    }
    advCount();
  } catch (e) { /* ignore */ }
  $('#infill-val').textContent = `${$('#infill').value}%`;
  $('#overhang-val').textContent = `${angle()}°`;
  materials = info.materials || {};
  materialInfo();
  if (!info.slicer) toast('PrusaSlicer is not installed on the Pi, so slicing won\'t work.', 'err', 10000);
  refreshForecast();
}

// What the chosen filament changes, so it's not a mystery.
let materials = {};
function materialInfo() {
  const key = $('#material').value;
  const m = materials[key];
  const box = $('#material-info');
  if (!m) return box.replaceChildren();
  const sq = fil.squishFor(materials, key);
  const saved = key !== 'pla' && fil.savedSquish(key) != null;
  box.replaceChildren(
    el('div', { class: 'mat-chips' },
      el('span', {}, `${m.temp} °C nozzle`), el('span', {}, `${m.bed} °C bed`),
      el('span', { title: 'First-layer nozzle height compared with PLA. Tune it from the Print page while a print runs.' },
        `First layer ${fil.fmtSquish(sq)}${saved ? ' · tuned' : ''}`),
      el('span', {}, `Speed ${m.speed_pct}%`), el('span', {}, `Fan ${m.fan}%`),
      el('span', {}, `Retraction ${m.retract} mm`)),
    el('div', { class: 'muted small' }, m.note));
}

// --------------------------------------------------------------- slicing

let currentJob = null;

function invalidateSlice() {
  lastSlice = null;
  $('#slice-result').classList.add('hidden');
  $('#preview-btn').disabled = true;
  if (viewer.preview.visible) showModelView();
}

async function slice() {
  const ms = models();
  const off = ms.filter((m) => !T.inBounds(m));
  if (off.length) return toast(`${off.map((m) => m.userData.name).join(', ')} is off the bed or too tall. Move it, scale it or press Arrange all.`, 'err', 8000);
  const name = ($('#job-name').value.trim() || $('#job-name').placeholder || 'model').replace(/[\\/]/g, '_');
  const bufs = ms.map((m) => T.toSTL(m));
  const opts = {
    name, quality: $('#quality').value, material: $('#material').value,
    supports: $('#supports').value, overhang: angle(), infill: +$('#infill').value,
    brim: +$('#brim').value, thumbnail: viewer.snapshot(300), advanced: advancedValues(),
    parts: ms.map((m, i) => ({ name: m.userData.name, bytes: bufs[i].byteLength })),
  };
  const head = new TextEncoder().encode(JSON.stringify(opts));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, head.length);
  const body = new Blob([len, head, ...bufs]);

  const prog = $('#slice-progress');
  prog.classList.remove('hidden');
  $('#slice-result').classList.add('hidden');
  $('#slice-btn').disabled = true;
  setProgress(1, `Sending ${fmtBytes(body.size)} to the Pi…`);
  try {
    const r = await fetch('/studio-api/slice', { method: 'POST', body });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Slicing failed');
    currentJob = j.id;
    while (true) {
      await new Promise((res) => setTimeout(res, 600));
      const st = await (await fetch(`/studio-api/jobs/${currentJob}`)).json();
      setProgress(st.progress, st.message);
      if (st.state === 'done') { sliceDone(st); break; }
      if (st.state === 'error') throw new Error(`Slicing failed:\n${st.message}`);
      if (st.state === 'cancelled') { toast('Slicing cancelled'); break; }
    }
  } catch (e) {
    toast(e.message, 'err', 10000);
  } finally {
    currentJob = null;
    prog.classList.add('hidden');
    $('#slice-btn').disabled = models().length === 0;
  }
}

function setProgress(pct, msg) {
  $('#slice-progress .bar i').style.width = `${pct}%`;
  $('#slice-progress span').textContent = msg || '';
}

function sliceDone(st) {
  lastSlice = { file: st.file, stats: st.stats };
  const s = st.stats || {};
  $('#slice-stats').replaceChildren(
    el('div', {}, el('span', {}, 'Print time'), el('b', {}, s.time || '–')),
    el('div', {}, el('span', {}, 'Filament'), el('b', {}, s.filament_g ? `${(+s.filament_g).toFixed(0)} g · ${s.filament_m} m` : '–')));
  $('#slice-file').textContent = st.file;
  $('#slice-result').classList.remove('hidden');
  $('#preview-btn').disabled = false;
  toast(`Sliced: ${st.file}`, 'ok');
  previewFile(st.file);
}

// --------------------------------------------------------------- preview

let previewName = null;

// While the previewed file is printing, keep the slider on the current layer.
function followPrint() {
  const ps = mr.printer.print_stats;
  const live = mr.busy && previewName && ps?.filename === previewName && preview.p;
  $('#follow-wrap').classList.toggle('hidden', !live);
  if (!live || !$('#follow-print').checked || !viewer.preview.visible) return;
  const z = mr.printer.gcode_move?.gcode_position?.[2];
  if (z == null) return;
  const zs = preview.p.layerZ;
  let i = zs.findIndex((lz) => lz >= z - 0.01);
  if (i < 0) i = zs.length - 1;
  if (i !== preview.layer) {
    $('#layer-slider').value = i + 1;
    preview.setLayer(i, $('#layer-single').checked);
    layerLabel();
  }
}

async function previewFile(file, { keepLayer = false } = {}) {
  previewName = file;
  app.show('prepare');
  setMsg('Loading toolpaths…');
  try {
    const r = await fetch(mr.fileUrl('gcodes', file));
    if (!r.ok) throw new Error(`Couldn't read ${file}`);
    const parsed = parseGcode(await r.text());
    if (!parsed.layerZ.length) throw new Error('No printable moves found in that file');
    const keep = keepLayer ? preview.layer : null;
    preview.load(parsed);
    $('#layer-slider').max = preview.layers;
    const start = keep ?? preview.layers - 1;
    $('#layer-slider').value = start + 1;
    preview.setLayer(start, $('#layer-single').checked);
    buildLegend();
    $('#preview-btn').disabled = false;
    showPreviewView();
    $('#view-msg').classList.add('hidden');
    setMsg('');
  } catch (e) {
    setMsg('');
    toast(e.message, 'err');
  }
}

function buildLegend() {
  $('#legend').replaceChildren(...preview.usedTypes().map((t) => el('span', {
    class: preview.hiddenTypes.has(t) ? 'off' : '',
    title: 'Click to hide/show',
    onclick: () => { preview.toggleType(t); buildLegend(); layerLabel(); },
  }, el('i', { style: `background:${FEATURES[t] || '#9e9e9e'}` }), t)));
  layerLabel();
}

function layerLabel() {
  const i = preview.layer;
  const z = preview.p.layerZ[i];
  $('#layer-label').textContent = `Layer ${i + 1} / ${preview.layers} · Z ${z.toFixed(2)} mm`;
  const changes = preview.p.colorZ;
  const here = changes.some((c) => Math.abs(c - z) < 1e-3);
  const btn = $('#color-change');
  btn.textContent = here ? '− Remove colour change' : '+ Colour change here';
  btn.disabled = i === 0;
  btn.onclick = () => setColorChanges(here ? changes.filter((c) => Math.abs(c - z) >= 1e-3) : [...changes, z]);
  $('#color-list').replaceChildren(...(changes.length ? ['Colour changes at: ', ...changes.map((c) => {
    const li = preview.p.layerZ.findIndex((lz) => Math.abs(lz - c) < 1e-3);
    return el('a', { href: '#', style: 'margin-right:8px', title: 'Jump to this layer', onclick: (e) => {
      e.preventDefault();
      if (li >= 0) { $('#layer-slider').value = li + 1; $('#layer-slider').oninput(); }
    } }, `layer ${li + 1}`);
  })] : []));
}

async function setColorChanges(zs) {
  if (!previewName) return;
  if (mr.busy && mr.printer.print_stats?.filename === previewName) {
    return toast('This file is printing – use "Pause at layer" on the Print tab instead.', 'err');
  }
  try {
    const r = await fetch('/studio-api/gcode/color_changes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: previewName, z: zs }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Failed');
    toast(j.changes ? `${previewName} now pauses for ${j.changes} colour change${j.changes > 1 ? 's' : ''}. When it pauses: Unload, load the new colour, Resume.` : 'Colour changes removed', 'ok', 8000);
    await previewFile(previewName, { keepLayer: true });
  } catch (e) { toast(e.message, 'err'); }
}

function showPreviewView() {
  if (!preview.p) return;
  viewer.showPreview(true);
  $('#layer-bar').classList.remove('hidden');
  $('#drop-hint').classList.add('hidden');
  $$('#mode-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.show === 'preview'));
}

function showModelView() {
  viewer.showPreview(false);
  viewer.attach(selected);
  $('#layer-bar').classList.add('hidden');
  $$('#mode-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.show === 'model'));
  $('#drop-hint').classList.toggle('hidden', models().length > 0);
}

