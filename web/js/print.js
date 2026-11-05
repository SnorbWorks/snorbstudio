// Print page: job progress, pause/resume/cancel, live first-layer (Z) offset,
// speed/flow/fan, skipping objects, pause-at-layer, the print queue and the
// temperature chart.

import { mr } from './moonraker.js';
import { $, $$, el, toast, attempt, confirmBox, fmtDuration, fmtFilament, fmtDate } from './ui.js';
import * as fil from './filaments.js';

let app;
let meta = null, metaFile = null;
let lastState = null;

export function initPrint(theApp) {
  app = theApp;
  const chart = new TempChart($('#temp-chart'));
  mr.on('status', update);
  mr.on('klippy', (s) => { if (s === 'ready') loadHistory(chart); update(); });
  mr.on('queue', loadQueue);
  mr.on('connection', (up) => { if (up && app.page === 'print') { loadRecent(); loadQueue(); } });
  mr.on('files', () => { if (!mr.busy) loadRecent(); });
  app.onPage((p) => { chart.visible = p === 'print'; if (chart.visible) { update(); chart.draw(); loadRecent(); loadQueue(); } });
  setInterval(() => {
    const p = mr.printer;
    if (p.extruder) chart.push(p.extruder, p.heater_bed);
    if (mr.busy) update();
  }, 1000);

  $('#job-pause').onclick = () => attempt(() => mr.call('printer.print.pause'));
  $('#job-resume').onclick = () => attempt(() => mr.call('printer.print.resume'));
  $('#job-cancel').onclick = async () => {
    if (await confirmBox('Cancel this print?', 'The print stops for good and the nozzle moves away. This can\'t be resumed.', 'Cancel print', true)) {
      attempt(() => mr.call('printer.print.cancel'));
    }
  };
  $$('[data-z]').forEach((b) => b.onclick = () =>
    attempt(() => mr.gcode(`SET_GCODE_OFFSET Z_ADJUST=${b.dataset.z} MOVE=1`)));
  $('#z-save').onclick = saveZOffset;
  $('#job-3d').onclick = () => {
    const f = mr.printer.print_stats?.filename;
    if (f) app.prepare.previewFile(f);
  };
  const filTemp = () => Math.max(mr.printer.extruder?.target || 0, 210);
  $('#p-unload').onclick = () => attempt(() => mr.gcode(`UNLOAD_FILAMENT TEMP=${filTemp()}`));
  $('#p-load').onclick = () => attempt(() => mr.gcode(`LOAD_FILAMENT TEMP=${filTemp()}`));
  slider('#speed-factor', '#speed-val', (v) => mr.gcode(`M220 S${v}`));
  slider('#flow-factor', '#flow-val', (v) => mr.gcode(`M221 S${v}`));
  slider('#fan-print', '#fan-print-val', (v) => mr.gcode(`M106 S${Math.round(v * 2.55)}`));

  // Pause at a layer (e.g. to swap filament colour).
  const pal = el('div', { class: 'row' },
    el('span', { class: 'small' }, 'Pause at layer'),
    el('input', { type: 'number', id: 'pause-layer', min: 1, placeholder: '#' }),
    el('button', { class: 'btn sm', onclick: () => {
      const n = +$('#pause-layer').value;
      if (n > 0) attempt(() => mr.gcode(`SET_PAUSE_AT_LAYER ENABLE=1 LAYER=${n}`), `The print will pause at layer ${n}.`);
    } }, 'Set'),
    el('button', { class: 'btn sm ghost', onclick: () => attempt(() => mr.gcode('SET_PAUSE_AT_LAYER ENABLE=0'), 'Pause-at-layer cleared') }, 'Clear'));
  $('#objects-box').before(el('div', { class: 'panel-h' }, 'Filament change'),
    el('p', { class: 'muted small' }, 'Pause at the start of a layer to swap colours, then press Resume.'), pal);

  // Queue lives under the idle file list.
  $('#idle-files').append(el('div', { class: 'panel-h', id: 'queue-h' }, 'Print queue'),
    el('div', { id: 'queue-list' }),
    el('div', { class: 'row' },
      el('button', { class: 'btn sm', id: 'queue-start', onclick: () => attempt(() => mr.call('server.job_queue.start'), 'Starting the next queued print') }, 'Start next in queue'),
      el('span', { class: 'muted small' }, 'Clear the bed before starting each queued print.')));
}

function slider(sel, label, send) {
  const s = $(sel);
  s.oninput = () => { $(label).textContent = `${s.value}%`; s.dataset.touched = Date.now(); };
  s.onchange = () => attempt(() => send(+s.value));
}

async function saveZOffset() {
  const z = mr.printer.gcode_move?.homing_origin?.[2] || 0;
  const act = fil.activeFilament();
  // A non-PLA print: the adjustment belongs to that filament's squish.
  // Saving it is just a variable, so it works mid-print with no restart.
  if (act.material && act.material !== 'pla') {
    const name = (await fil.materials())[act.material]?.label || act.material;
    if (Math.abs(z - act.squish) < 0.001) return toast(`No adjustment to save – ${name} is already at ${fil.fmtSquish(z)}.`);
    if (Math.abs(z) > 0.3) return toast('That is more than 0.3 mm away from PLA – re-check the PLA Z offset instead.', 'err', 8000);
    if (!await confirmBox(`Save the ${name} first layer?`,
      `${name} prints will start at ${fil.fmtSquish(z)} from now on (was ${fil.fmtSquish(act.squish)}). The PLA Z offset doesn't change.`, 'Save')) return;
    await attempt(async () => {
      await mr.gcode(`SAVE_VARIABLE VARIABLE=squish_${act.material} VALUE=${z.toFixed(3)}`);
      await mr.gcode(`SET_GCODE_VARIABLE MACRO=_STUDIO_FILAMENT VARIABLE=squish VALUE=${z.toFixed(3)}`);
    }, `${name} first layer saved`);
    return;
  }
  if (Math.abs(z) < 0.001) return toast('No adjustment to save.');
  if (mr.busy) return toast('Save it after the print finishes – saving restarts the printer.', 'err');
  if (!await confirmBox('Save the Z offset?', `Make the ${z > 0 ? '+' : ''}${z.toFixed(3)} mm adjustment permanent. Klipper will restart.`, 'Save')) return;
  await attempt(async () => {
    await mr.gcode('Z_OFFSET_APPLY_PROBE');
    await mr.gcode('SAVE_CONFIG');
  }, 'Z offset saved');
}

async function loadMeta(file) {
  metaFile = file;
  meta = null;
  $('#job-thumb').removeAttribute('src');
  if (!file) return;
  try {
    meta = await mr.call('server.files.metadata', { filename: file });
    const th = bestThumb(meta.thumbnails);
    if (th) $('#job-thumb').src = mr.fileUrl('gcodes', dirOf(file) + th.relative_path);
  } catch (e) { /* file may be gone */ }
  update();
}

export const dirOf = (f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : '');
export const bestThumb = (ths) => (ths || []).slice().sort((a, b) => b.width - a.width)[0];

function update() {
  const p = mr.printer;
  const ps = p.print_stats || {};
  const state = ps.state || 'standby';
  if (ps.filename !== metaFile) loadMeta(ps.filename || null);
  notifyTransition(state, ps.filename);

  const active = state === 'printing' || state === 'paused';
  const progress = p.display_status?.progress ?? p.virtual_sdcard?.progress ?? 0;
  $('#job-state').textContent = {
    printing: 'Printing', paused: 'Paused', complete: 'Finished', cancelled: 'Cancelled',
    error: 'Stopped with an error', standby: 'Idle' }[state] || state;
  $('#job-file').textContent = ps.filename || 'Nothing printing';
  const pct = Math.round(progress * 100);
  $('#job-pct').textContent = `${state === 'complete' ? 100 : pct}%`;
  $('#ring-fill').style.strokeDashoffset = 326.7 * (1 - (state === 'complete' ? 1 : progress));

  const dur = ps.print_duration || 0;
  const est = meta?.estimated_time;
  let rem = null;
  if (active) {
    const fileRem = progress > 0.02 ? dur / progress - dur : null;
    const slicerRem = est ? Math.max(0, est - dur) : null;
    rem = slicerRem != null && fileRem != null && progress > 0.1 ? (slicerRem + fileRem) / 2 : (slicerRem ?? fileRem);
  }
  $('#job-elapsed').textContent = ps.filename ? fmtDuration(ps.total_duration) : '–';
  $('#job-remaining').textContent = active ? fmtDuration(rem) : '–';
  $('#job-eta').textContent = active && rem != null
    ? new Date(Date.now() + rem * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '–';
  const info = ps.info || {};
  $('#job-layer').textContent = info.total_layer ? `${info.current_layer || 0} / ${info.total_layer}` : '–';
  $('#job-z').textContent = active ? `${(p.gcode_move?.gcode_position?.[2] ?? 0).toFixed(2)} mm` : '–';
  $('#job-fil').textContent = ps.filename ? `${fmtFilament(ps.filament_used)}${meta?.filament_total ? ` / ${fmtFilament(meta.filament_total)}` : ''}` : '–';
  $('#job-meta').textContent = meta ? [
    meta.estimated_time && `Slicer estimate ${fmtDuration(meta.estimated_time)}`,
    meta.layer_height && `${meta.layer_height} mm layers`,
    meta.filament_weight_total && `${meta.filament_weight_total.toFixed(0)} g`,
  ].filter(Boolean).join(' · ') : '';
  if (ps.message) $('#job-meta').textContent += ` · ${ps.message}`;

  $('#job-pause').classList.toggle('hidden', state !== 'printing');
  $('#job-resume').classList.toggle('hidden', state !== 'paused');
  $('#job-cancel').classList.toggle('hidden', !active);
  $('#job-3d').classList.toggle('hidden', !active);
  $('#paused-fil').classList.toggle('hidden', state !== 'paused');
  $('#idle-files').classList.toggle('hidden', active);
  const act = fil.activeFilament();
  const perFil = !!act.material && act.material !== 'pla';
  $('#z-save').disabled = active && !perFil;
  $('#z-save').textContent = perFil ? 'Save for this filament' : 'Save as new Z offset';
  $('#z-filament').classList.toggle('hidden', !perFil);
  if (perFil) {
    $('#z-filament').textContent = `This print's filament started at ${fil.fmtSquish(act.squish)} – the number above includes it. Saving updates that filament only.`;
  }

  const gm = p.gcode_move || {};
  $('#z-adjust').textContent = `${(gm.homing_origin?.[2] ?? 0) >= 0 ? '+' : ''}${(gm.homing_origin?.[2] ?? 0).toFixed(3)} mm`;
  setSlider('#speed-factor', '#speed-val', Math.round((gm.speed_factor ?? 1) * 100));
  setSlider('#flow-factor', '#flow-val', Math.round((gm.extrude_factor ?? 1) * 100));
  setSlider('#fan-print', '#fan-print-val', Math.round((p.fan?.speed ?? 0) * 100));

  const ex = p.exclude_object || {};
  const objs = ex.objects || [];
  $('#objects-box').classList.toggle('hidden', !(active && objs.length > 1));
  if (active && objs.length > 1) {
    const exd = new Set(ex.excluded_objects || []);
    $('#objects-list').replaceChildren(...objs.map((o) => el('div', {
      class: `obj ${o.name === ex.current_object ? 'cur' : ''} ${exd.has(o.name) ? 'ex' : ''}` },
    el('span', {}, o.name.replace(/_stl$|_3mf$|_obj$/i, '')),
    exd.has(o.name) ? el('span', { class: 'muted small' }, 'skipped') : el('button', {
      class: 'btn sm ghost danger',
      onclick: async () => {
        if (await confirmBox('Skip this part?', `Stop printing "${o.name}" and carry on with the rest.`, 'Skip it', true)) {
          attempt(() => mr.gcode(`EXCLUDE_OBJECT NAME=${o.name}`));
        }
      } }, 'Skip'))));
  }
}

function setSlider(sel, label, v) {
  const s = $(sel);
  if (Date.now() - (+s.dataset.touched || 0) < 3000) return;   // user is dragging it
  s.value = v;
  $(label).textContent = `${v}%`;
}

// Desktop notification when a print ends.
function notifyTransition(state, file) {
  if (lastState && lastState !== state && ['printing', 'paused'].includes(lastState)) {
    const text = { complete: 'Print finished', cancelled: 'Print cancelled', error: 'Print stopped with an error' }[state];
    if (text) {
      toast(`${text}: ${file}`, state === 'complete' ? 'ok' : 'err', 15000);
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(text, { body: file || '' });
      }
    }
  }
  lastState = state;
}

async function loadRecent() {
  const box = $('#recent-files');
  try {
    const files = (await mr.call('server.files.list', { root: 'gcodes' }))
      .sort((a, b) => b.modified - a.modified).slice(0, 6);
    if (!files.length) {
      box.replaceChildren(el('p', { class: 'muted' }, 'No print files yet – slice something on the Prepare tab.'));
      return;
    }
    box.replaceChildren(...files.map((f) => app.fileCard(f, { compact: true })));
  } catch (e) { /* not connected */ }
}

async function loadQueue() {
  const list = $('#queue-list');
  if (!list) return;
  let q;
  try { q = await mr.call('server.job_queue.status'); } catch (e) {
    $('#queue-h').classList.add('hidden'); list.replaceChildren(); $('#queue-start').parentElement.classList.add('hidden');
    return;
  }
  const jobs = q.queued_jobs || [];
  $('#queue-h').classList.remove('hidden');
  $('#queue-start').parentElement.classList.toggle('hidden', !jobs.length);
  list.replaceChildren(...(jobs.length ? jobs.map((j, i) => el('div', { class: 'queue-item' },
    el('b', {}, `${i + 1}.`), el('span', { class: 'nm' }, j.filename),
    el('button', { class: 'btn sm ghost danger', onclick: () => attempt(() => mr.call('server.job_queue.delete_job', { job_ids: [j.job_id] })) }, 'Remove')))
    : [el('p', { class: 'muted small' }, 'Nothing queued. Use "Queue" on a file to line up several prints.')]));
}

async function loadHistory(chart) {
  try {
    const store = await mr.call('server.temperature_store');
    chart.load(store);
  } catch (e) { /* ignore */ }
}

// --------------------------------------------------------------- chart

class TempChart {
  constructor(canvas) {
    this.c = canvas;
    this.n = []; this.nt = []; this.b = []; this.bt = [];
    this.max = 1200;
    this.visible = false;
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  load(store) {
    const e = store.extruder || {}, h = store.heater_bed || {};
    this.n = (e.temperatures || []).slice(-this.max);
    this.nt = (e.targets || []).slice(-this.max);
    this.b = (h.temperatures || []).slice(-this.max);
    this.bt = (h.targets || []).slice(-this.max);
    this.draw();
  }

  push(ex, bed) {
    for (const [arr, v] of [[this.n, ex.temperature], [this.nt, ex.target], [this.b, bed?.temperature], [this.bt, bed?.target]]) {
      arr.push(v ?? 0);
      if (arr.length > this.max) arr.shift();
    }
    if (this.visible) this.draw();
  }

  draw() {
    const c = this.c, dpr = devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w) return;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    const L = 36, B = 18, W = w - L - 8, H = h - B - 6;
    const top = Math.max(60, ...this.n, ...this.nt, ...this.b, ...this.bt) * 1.08;
    const ymax = Math.ceil(top / 50) * 50;
    g.font = '11px -apple-system, sans-serif';
    g.fillStyle = '#8d959e';
    g.strokeStyle = '#2a3036';
    g.lineWidth = 1;
    for (let v = 0; v <= ymax; v += 50) {
      const y = 6 + H - (v / ymax) * H;
      g.beginPath(); g.moveTo(L, y); g.lineTo(L + W, y); g.stroke();
      g.fillText(`${v}°`, 4, y + 4);
    }
    g.fillText('20 min ago', L, h - 4);
    g.fillText('now', L + W - 22, h - 4);
    const line = (arr, color, dash) => {
      if (!arr.length) return;
      g.strokeStyle = color; g.lineWidth = dash ? 1.2 : 2;
      g.setLineDash(dash ? [5, 4] : []);
      g.beginPath();
      const off = this.max - arr.length;
      arr.forEach((v, i) => {
        const x = L + ((off + i) / (this.max - 1)) * W, y = 6 + H - (v / ymax) * H;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.stroke();
    };
    line(this.bt, '#42a5f5', true); line(this.nt, '#ff7043', true);
    line(this.b, '#42a5f5'); line(this.n, '#ff7043');
    g.setLineDash([]);
  }
}
