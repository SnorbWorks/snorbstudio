// Maintenance page: printer/Pi status, Z guard, bed level map, guided
// calibration (Z offset, PID, mesh), calibration prints, config editor,
// logs and Pi power.

import { mr } from './moonraker.js';
import { $, el, toast, attempt, confirmBox, fmtBytes, fmtDuration } from './ui.js';
import { BED } from './viewer.js';
import * as fil from './filaments.js';

let app;
let sysInfo = null;

export function initMaint(theApp) {
  app = theApp;
  $('#mainsail-link').href = `http://${location.hostname}:8080/`;
  $('#fw-restart').onclick = restartFirmware;
  $('#svc-restart').onclick = restartService;
  $('#mesh-run').onclick = runMesh;
  $('#zcal-start').onclick = zcalStart;
  $('#zcal-accept').onclick = zcalAccept;
  $('#zcal-abort').onclick = () => attempt(() => mr.gcode('ABORT'));
  document.querySelectorAll('[data-testz]').forEach((b) => b.onclick = () =>
    attempt(() => mr.gcode(`TESTZ Z=${b.dataset.testz}`)));
  $('#pid-hotend').onclick = () => pid('extruder', 200);
  $('#pid-bed').onclick = () => pid('heater_bed', 60);
  buildExtras();
  mr.on('status', update);
  mr.on('klippy', update);
  mr.on('procstat', (s) => { procStats = s; if (app.page === 'maint') renderSystem(); });
  app.onPage((p) => { if (p === 'maint') { loadSystem(); update(); } });
  mr.on('connection', (up) => { if (up && app.page === 'maint') { loadSystem(); loadConfigList(); } });
}

export async function restartFirmware() {
  await attempt(() => mr.call('printer.firmware_restart'), 'Restarting the printer board…');
}

export async function restartService() {
  await attempt(() => mr.call('machine.services.restart', { service: 'klipper' }), 'Restarting Klipper…');
  // After a guard stop the board itself also needs a reset once Klipper is back.
  setTimeout(() => { if (!mr.ready) mr.call('printer.firmware_restart').catch(() => {}); }, 8000);
}

const busy = () => {
  if (!mr.ready) { toast('The printer isn\'t ready.', 'err'); return true; }
  if (mr.busy) { toast('Not while a print is running.', 'err'); return true; }
  return false;
};

// --------------------------------------------------------------- status

let procStats = null;
async function loadSystem() {
  try {
    sysInfo = (await mr.call('machine.system_info')).system_info;
    procStats = await mr.call('machine.proc_stats');
  } catch (e) { /* ignore */ }
  renderSystem();
}

function renderSystem() {
  const kv = [];
  kv.push(['Klipper', mr.klippy === 'ready' ? 'ready' : `${mr.klippy}${mr.klippyMessage ? ` – ${mr.klippyMessage.split('\n')[0]}` : ''}`]);
  if (sysInfo) {
    kv.push(['Pi', sysInfo.cpu_info?.model || sysInfo.cpu_info?.processor || '–']);
    kv.push(['System', sysInfo.distribution?.name || '–']);
    const sd = sysInfo.sd_info;
    if (sd?.total_bytes) kv.push(['Storage', `${fmtBytes(sd.total_bytes - (sd.free_bytes || 0))} used of ${fmtBytes(sd.total_bytes)}`]);
  }
  if (procStats) {
    if (procStats.cpu_temp) kv.push(['Pi temperature', `${procStats.cpu_temp.toFixed(0)} °C`]);
    const mem = procStats.system_memory;
    if (mem) kv.push(['Memory', `${fmtBytes((mem.total - mem.available) * 1024)} used of ${fmtBytes(mem.total * 1024)}`]);
    if (procStats.system_uptime) kv.push(['Up for', fmtDuration(procStats.system_uptime)]);
    if (procStats.throttled_state?.flags?.length) kv.push(['Power warnings', procStats.throttled_state.flags.join(', ')]);
  }
  $('#sys-kv').replaceChildren(...kv.flatMap(([k, v]) => [el('span', {}, k), el('b', {}, v)]));
}

function update() {
  const p = mr.printer;
  const zg = p.z_guard;
  $('#zguard-kv').replaceChildren(...(zg ? [
    el('span', {}, 'Switch'), el('b', { style: `color:${zg.pressed ? '#ff8a80' : '#7fe0a6'}` }, zg.pressed ? 'PRESSED' : 'released'),
    el('span', {}, 'Armed'), el('b', {}, zg.armed ? 'yes (homing/probing now)' : 'only while homing or probing'),
  ] : [el('span', {}, 'Status'), el('b', {}, mr.ready ? 'not installed' : '–')]));
  renderMesh(p.bed_mesh);
  const mp = p.manual_probe;
  const zcal = !!mp?.is_active;
  $('#zcal-idle').classList.toggle('hidden', zcal);
  $('#zcal-active').classList.toggle('hidden', !zcal);
  if (zcal) $('#zcal-pos').textContent = `Z ${mp.z_position?.toFixed(3) ?? '?'}`;
  if (app.page === 'maint') renderSystem();
}

// --------------------------------------------------------------- mesh

function renderMesh(bm) {
  const box = $('#mesh-view');
  const pts = bm?.probed_matrix?.length ? bm.probed_matrix : bm?.profiles?.default?.points;
  if (!pts?.length || !pts[0].length) {
    box.replaceChildren(el('p', { class: 'muted small' }, 'No bed map yet.'));
    $('#mesh-range').textContent = '';
    return;
  }
  const flat = pts.flat();
  const lo = Math.min(...flat), hi = Math.max(...flat), span = Math.max(hi - lo, 0.05);
  $('#mesh-range').textContent = `spread ${(hi - lo).toFixed(2)} mm`;
  box.style.gridTemplateColumns = `repeat(${pts[0].length}, 1fr)`;
  const color = (v) => {
    // blue (low) -> green -> red (high)
    const t = (v - lo) / span;
    const h = 220 - t * 220;
    return `hsl(${h}, 70%, 62%)`;
  };
  box.replaceChildren(...pts.slice().reverse().flatMap((row) => row.map((v) =>
    el('div', { style: `background:${color(v)}` }, `${v >= 0 ? '+' : ''}${v.toFixed(2)}`))));
  renderKnobs(bm, pts);
}

// Ender 3 bed screw positions (bed coordinates) and thread pitch.
const SCREWS = [['Front-left', 32, 36], ['Front-right', 202, 36], ['Back-left', 32, 206], ['Back-right', 202, 206]];
const MM_PER_TURN = 0.7;

// Fit a flat plane through the map (ignores the bed's own dome) and say how
// far to turn each knob to remove the tilt.
function renderKnobs(bm, pts) {
  let box = $('#knob-advice');
  if (!box) {
    box = el('div', { id: 'knob-advice', class: 'knobs' });
    $('#mesh-view').after(box);
  }
  const min = bm.mesh_min || bm.profiles?.default?.mesh_params && [bm.profiles.default.mesh_params.min_x, bm.profiles.default.mesh_params.min_y];
  const max = bm.mesh_max || bm.profiles?.default?.mesh_params && [bm.profiles.default.mesh_params.max_x, bm.profiles.default.mesh_params.max_y];
  if (!min || !max) { box.replaceChildren(); return; }
  const ny = pts.length, nx = pts[0].length;
  // Least squares z = a + b*x + c*y
  let n = 0, sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = min[0] + (max[0] - min[0]) * i / (nx - 1), y = min[1] + (max[1] - min[1]) * j / (ny - 1), z = pts[j][i];
    n++; sx += x; sy += y; sz += z; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z;
  }
  const A = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]], B = [sz, sxz, syz];
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-9) return;
  const solve = (k) => det(A.map((row, r) => row.map((v, c) => (c === k ? B[r] : v)))) / D;
  const [a, b, c] = [solve(0), solve(1), solve(2)];
  const h = SCREWS.map(([name, x, y]) => [name, a + b * x + c * y]);
  const ref = h.reduce((s2, [, z]) => s2 + z, 0) / h.length;
  const tilt = Math.max(...h.map(([, z]) => z)) - Math.min(...h.map(([, z]) => z));
  const frac = (t) => {
    const eighths = Math.round(Math.abs(t) * 8);
    if (eighths === 0) return null;
    const whole = Math.floor(eighths / 8), rest = eighths % 8;
    const names = ['', '⅛', '¼', '⅜', '½', '⅝', '¾', '⅞'];
    return `${whole ? `${whole}${rest ? ' ' : ''}` : ''}${names[rest]} turn${whole > 1 || (whole === 1 && rest) ? 's' : ''}`;
  };
  const rows = h.map(([name, z]) => {
    const t = frac((z - ref) / MM_PER_TURN);
    if (!t) return el('div', {}, el('b', {}, name), el('span', { class: 'muted' }, 'leave it'));
    const up = z < ref;
    return el('div', {}, el('b', {}, name),
      el('span', {}, `${up ? 'raise' : 'lower'} ${t}`),
      el('span', { class: 'muted small' }, up ? 'push the knob\'s front edge left' : 'push the knob\'s front edge right'));
  });
  box.replaceChildren(el('div', { class: 'panel-h' }, 'Levelling assistant',
    el('span', { class: 'muted small' }, tilt < 0.1 ? 'the bed is level – no turning needed' : `tilt ${tilt.toFixed(2)} mm across the knobs`)),
  ...(tilt < 0.1 ? [] : rows),
  el('p', { class: 'muted small' }, 'Turn the knobs, then press "Measure the bed again" to check. (Assumes ~0.7 mm per turn.)'));
}

async function runMesh() {
  if (busy()) return;
  if (!await confirmBox('Measure the bed?', 'The bed heats to 60 °C, the printer homes, and the probe touches 25 points across the bed (about 4 minutes). The new map is saved and Klipper restarts. Stay near the printer.', 'Start')) return;
  toast('Measuring the bed – this takes a few minutes…', '', 8000);
  await attempt(async () => {
    await mr.gcode('M190 S60');
    await mr.gcode('G28');
    await mr.gcode('BED_MESH_CALIBRATE');
    await mr.gcode('SAVE_CONFIG');
  }, 'Bed map saved');
}

// --------------------------------------------------------------- calibration

async function zcalStart() {
  if (busy()) return;
  if (!await confirmBox('Z offset calibration', 'The nozzle heats to 150 °C, the printer homes, the probe touches the middle of the bed, then the nozzle moves over that spot. Have a sheet of printer paper ready.', 'Start')) return;
  await attempt(async () => {
    await mr.gcode('M109 S150');
    await mr.gcode('G28');
    await mr.gcode('PROBE_CALIBRATE SPEED=3');
    await mr.gcode('TESTZ Z=-4');
  });
}

async function zcalAccept() {
  await attempt(async () => {
    await mr.gcode('ACCEPT');
    await mr.gcode('G91\nG1 Z10 F300\nG90');
    await mr.gcode('M104 S0');
    await mr.gcode('SAVE_CONFIG');
  }, 'Z offset saved – Klipper is restarting');
}

async function pid(heater, temp) {
  if (busy()) return;
  const what = heater === 'extruder' ? 'nozzle' : 'bed';
  if (!await confirmBox(`Tune the ${what}?`, `The ${what} heats to ${temp} °C and cycles for ${heater === 'extruder' ? 'about 5' : 'about 10'} minutes. Nothing moves. The result is saved and Klipper restarts.`, 'Start')) return;
  toast(`Tuning the ${what}…`, '', 8000);
  await attempt(async () => {
    await mr.gcode(`PID_CALIBRATE HEATER=${heater} TARGET=${temp}`);
    await mr.gcode('SAVE_CONFIG');
  }, `${what[0].toUpperCase() + what.slice(1)} tuned and saved`);
}

// --------------------------------------------------------------- extras

function buildExtras() {
  const layout = $('#page-maint .maint-layout');

  // Calibration prints
  const cal = el('div', { class: 'card wide' },
    el('div', { class: 'panel-h' }, 'Calibration prints'),
    el('p', { class: 'muted small' }, 'Test prints that help dial the printer in. They go onto the Prepare bed (or straight to Files for the temperature tower).'),
    el('div', { class: 'calprints' },
      calPrint('First layer test', 'Five thin squares across the bed. Shows whether the Z offset and bed level are right everywhere.', firstLayerTest),
      calPrint('20 mm cube', 'Checks dimensions (should measure 20.0 mm) and general print quality.', () => boxModel('cal_cube_20mm.stl', [[0, 0, 0, 20, 20, 20]])),
      calPrint('Temperature tower', 'Prints at 220 → 190 °C in 5° steps. Pick the temperature whose block looks best.', tempTower),
      calPrint('Bridging test', 'Pillars joined by 10-50 mm bridges. Shows how well unsupported spans print.', bridgeTest)));
  layout.append(cal);
  layout.append(extruderCard());
  layout.append(squishCard());

  // Config editor
  const files = el('div', { class: 'editor-files', id: 'cfg-files' });
  const ta = el('textarea', { class: 'editor', id: 'cfg-text', spellcheck: 'false' });
  const editor = el('div', { class: 'card wide' },
    el('div', { class: 'panel-h' }, 'Printer configuration', el('span', { class: 'muted small', id: 'cfg-name' }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn sm', id: 'cfg-save', onclick: () => saveConfig(false) }, 'Save'),
      el('button', { class: 'btn sm primary', onclick: () => saveConfig(true) }, 'Save & restart')),
    el('p', { class: 'muted small' }, 'Advanced: the files that define the printer. A typo here can stop Klipper from starting – the previous version is kept as a backup when you save.'),
    el('div', { class: 'editor-wrap' }, files, ta));
  layout.append(editor);

  // Logs + power
  layout.append(el('div', { class: 'card wide' },
    el('div', { class: 'panel-h' }, 'Logs & power'),
    el('div', { class: 'row' },
      el('a', { class: 'btn sm ghost', href: '/server/files/klippy.log', download: 'klippy.log' }, 'Download Klipper log'),
      el('a', { class: 'btn sm ghost', href: '/server/files/moonraker.log', download: 'moonraker.log' }, 'Download Moonraker log'),
      el('button', { class: 'btn sm ghost', onclick: showLogTail }, 'Show recent Klipper log'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn sm ghost', onclick: () => power('reboot') }, 'Reboot Pi'),
      el('button', { class: 'btn sm ghost danger', onclick: () => power('shutdown') }, 'Shut down Pi')),
    el('pre', { class: 'console hidden', id: 'log-tail' })));

  app.onPage((p) => { if (p === 'maint' && !files.childElementCount) loadConfigList(); });
}

// Per-filament first-layer squish (relative to PLA, saved on the printer).
function squishCard() {
  const rows = el('div', { class: 'squish-rows' });
  const card = el('div', { class: 'card' },
    el('div', { class: 'panel-h' }, 'Filament first layer'),
    el('p', { class: 'muted small' }, 'How much higher (+) or lower (−) the nozzle starts for each filament, compared with PLA. PLA uses the Z offset. The easiest way to tune these is live on the Print page – "Save for this filament" lands here.'),
    rows);
  let mats = {};
  const render = () => {
    if (document.activeElement?.closest?.('.squish-rows')) return;   // don't clobber typing
    rows.replaceChildren(...Object.entries(mats).filter(([k]) => k !== 'pla').map(([k, m]) => {
      const cur = fil.squishFor(mats, k);
      const input = el('input', { type: 'number', step: '0.01', min: '-0.3', max: '0.3', value: cur.toFixed(2) });
      const save = (v) => {
        if (!mr.ready) return toast('The printer isn\'t ready.', 'err');
        v = Math.max(-0.3, Math.min(0.3, +v || 0));
        attempt(() => mr.gcode(`SAVE_VARIABLE VARIABLE=squish_${k} VALUE=${v.toFixed(3)}`), `${m.label}: ${fil.fmtSquish(v)}`);
      };
      return el('div', { class: 'squish-row' },
        el('span', {}, m.label), input, el('i', { class: 'muted small' }, 'mm'),
        el('button', { class: 'btn sm', onclick: () => save(input.value) }, 'Save'),
        el('button', { class: 'btn sm ghost', title: `Default ${fil.fmtSquish(m.squish)}`, onclick: () => save(m.squish) }, 'Default'));
    }));
  };
  fil.materials().then((m) => { mats = m; render(); });
  mr.on('status', (st) => { if (st && 'save_variables' in st) render(); });
  return card;
}

function calPrint(title, text, fn) {
  return el('div', { class: 'calprint' }, el('b', {}, title), el('p', {}, text),
    el('button', { class: 'btn sm', onclick: fn }, 'Create'));
}

// Boxes [x0,y0,z0,x1,y1,z1] -> binary STL ArrayBuffer.
function boxesSTL(boxes) {
  const tris = [];
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    const nrm = [[0, 0, -1], [0, 0, -1], [0, 0, 1], [0, 0, 1], [0, -1, 0], [0, -1, 0], [1, 0, 0], [1, 0, 0], [0, 1, 0], [0, 1, 0], [-1, 0, 0], [-1, 0, 0]];
    f.forEach((t, i) => tris.push([nrm[i], v[t[0]], v[t[1]], v[t[2]]]));
  }
  const buf = new ArrayBuffer(84 + 50 * tris.length);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) { for (const p of t) for (const c of p) { dv.setFloat32(o, c, true); o += 4; } o += 2; }
  return buf;
}

function boxModel(name, boxes) {
  app.prepare.addFiles([{ name, buffer: boxesSTL(boxes) }], { saveToLibrary: false });
  app.show('prepare');
}

function firstLayerTest() {
  // Squares under where the probe measured: near each corner and the middle.
  const s = 30, m = 25, h = 0.2;
  const xs = [m, BED.x - m - s], ys = [m, BED.y - m - s];
  const boxes = [];
  for (const x of xs) for (const y of ys) boxes.push([x, y, 0, x + s, y + s, h]);
  boxes.push([BED.x / 2 - s / 2, BED.y / 2 - s / 2, 0, BED.x / 2 + s / 2, BED.y / 2 + s / 2, h]);
  boxModel('cal_first_layer.stl', boxes);
  toast('Slice it with "Standard" quality; watch the first layer and use the live Z buttons on the Print tab to fine-tune.', '', 10000);
}

function bridgeTest() {
  const boxes = [[0, 0, 0, 120, 12, 1]];
  let x = 0;
  for (const span of [10, 20, 30, 40, 50]) {
    if (x + 6 + span + 6 > 120) break;
    boxes.push([x, 0, 1, x + 4, 12, 12], [x + 4 + span, 0, 1, x + 8 + span, 12, 12], [x, 0, 12, x + 8 + span, 12, 14]);
    x += 8 + span + 4;
  }
  boxModel('cal_bridges.stl', boxes);
}

async function tempTower() {
  if (!await confirmBox('Temperature tower', 'This slices a tower for PLA with 7 blocks from 220 °C down to 190 °C (about 1 hour to print). It appears in Files when ready.', 'Create')) return;
  toast('Slicing the temperature tower…');
  try {
    const r = await fetch('/studio-api/calibration/temp_tower', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: 220, end: 190, step: 5 }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Failed');
    for (let i = 0; i < 120; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      const st = await (await fetch(`/studio-api/jobs/${j.id}`)).json();
      if (st.state === 'done') { toast(`Ready: ${st.file}`, 'ok'); app.prepare.previewFile(st.file); return; }
      if (st.state === 'error') throw new Error(st.message);
    }
  } catch (e) { toast(e.message, 'err', 9000); }
}

// --------------------------------------------------------------- extruder

function extruderCard() {
  const step = (n, text, ...kids) => el('div', { class: 'estep' }, el('b', {}, `${n}.`), el('div', {}, el('p', { class: 'small' }, text), ...kids));
  return el('div', { class: 'card' },
    el('div', { class: 'panel-h' }, 'Extruder calibration'),
    el('p', { class: 'muted small' }, 'Checks that asking for 100 mm of filament really feeds 100 mm. Fixes thin or blobby prints across the board.'),
    step(1, 'Load filament, then heat the nozzle.', el('button', { class: 'btn sm', onclick: () => attempt(() => mr.gcode('SET_HEATER_TEMPERATURE HEATER=extruder TARGET=210'), 'Heating to 210 °C') }, 'Heat to 210 °C')),
    step(2, 'With a marker, make a mark on the filament exactly 120 mm above where it enters the extruder.'),
    step(3, 'Feed 100 mm slowly (takes about 2 minutes).', el('button', { class: 'btn sm', onclick: feed100 }, 'Extrude 100 mm')),
    step(4, 'Measure from the extruder entrance to your mark now.',
      el('div', { class: 'row' }, el('input', { type: 'number', id: 'esteps-left', step: '0.5', placeholder: 'mm left' }),
        el('button', { class: 'btn sm primary', onclick: saveRotation }, 'Calculate & save'))),
    el('p', { class: 'muted small', id: 'esteps-current' }));
}

async function feed100() {
  if (busy()) return;
  if ((mr.printer.extruder?.temperature || 0) < 190) return toast('Wait until the nozzle is at least 190 °C.', 'err');
  await attempt(() => mr.gcode('M83\nG1 E100 F60'), 'Done – now measure to your mark');
}

async function saveRotation() {
  const left = parseFloat($('#esteps-left').value);
  if (!(left >= 0 && left < 60)) return toast('Enter how many mm are left between the extruder and the mark (normally 10–30).', 'err');
  const actual = 120 - left;
  const q = await mr.call('printer.objects.query', { objects: { configfile: ['settings'] } });
  const old = q.status.configfile.settings.extruder.rotation_distance;
  const next = +(old * actual / 100).toFixed(3);
  const pct = ((actual - 100)).toFixed(1);
  if (Math.abs(actual - 100) < 0.5) return toast(`It fed ${actual.toFixed(1)} mm – already accurate. Nothing to change.`, 'ok', 8000);
  if (!await confirmBox('Save extruder calibration?', `It fed ${actual.toFixed(1)} mm instead of 100 (${pct > 0 ? '+' : ''}${pct} mm). rotation_distance changes from ${old} to ${next}. Klipper restarts.`, 'Save')) return;
  await attempt(async () => {
    const text = await (await fetch(mr.fileUrl('config', 'printer.cfg'), { cache: 'no-store' })).text();
    const lines = text.split('\n');
    let section = '', done = false;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\[([^\]]+)\]/);
      if (m) section = m[1].trim();
      if (section === 'extruder' && /^rotation_distance\s*:/.test(lines[i])) {
        lines[i] = `rotation_distance: ${next}  # calibrated ${new Date().toLocaleDateString()} (was ${old})`;
        done = true;
        break;
      }
    }
    if (!done) throw new Error('Couldn\'t find rotation_distance under [extruder] in printer.cfg');
    await mr.upload(new File([text], 'printer.cfg.bak-extruder'), 'config');
    await mr.upload(new File([lines.join('\n')], 'printer.cfg'), 'config');
    await mr.call('printer.firmware_restart');
  }, 'Extruder calibrated – Klipper is restarting');
}

// --------------------------------------------------------------- config

let cfgFile = null;
async function loadConfigList() {
  try {
    const files = (await mr.call('server.files.list', { root: 'config' }))
      .filter((f) => /\.(cfg|conf)$/.test(f.path) && !/^printer-\d{8}_\d{6}\.cfg$/.test(f.path))
      .sort((a, b) => (a.path === 'printer.cfg' ? -1 : b.path === 'printer.cfg' ? 1 : a.path.localeCompare(b.path)));
    $('#cfg-files').replaceChildren(...files.map((f) => el('button', { onclick: (e) => openConfig(f.path, e.target) }, f.path)));
    $('#cfg-files').firstChild?.click();
  } catch (e) { /* ignore */ }
}

async function openConfig(path, btn) {
  const r = await fetch(mr.fileUrl('config', path), { cache: 'no-store' });
  $('#cfg-text').value = await r.text();
  cfgFile = path;
  $('#cfg-name').textContent = path;
  document.querySelectorAll('#cfg-files button').forEach((b) => b.classList.toggle('active', b === btn));
}

async function saveConfig(restart) {
  if (!cfgFile) return;
  if (restart && mr.busy) return toast('Not while printing.', 'err');
  await attempt(async () => {
    // Keep the previous version next to it.
    const old = await (await fetch(mr.fileUrl('config', cfgFile), { cache: 'no-store' })).text();
    await mr.upload(new File([old], `${cfgFile}.bak`), 'config');
    await mr.upload(new File([$('#cfg-text').value], cfgFile), 'config');
    if (restart) {
      await mr.call(cfgFile === 'moonraker.conf' ? 'machine.services.restart' : 'printer.firmware_restart',
        cfgFile === 'moonraker.conf' ? { service: 'moonraker' } : {});
    }
  }, restart ? 'Saved – restarting' : 'Saved');
}

async function showLogTail() {
  const pre = $('#log-tail');
  pre.classList.toggle('hidden');
  if (pre.classList.contains('hidden')) return;
  pre.textContent = 'Loading…';
  try {
    const r = await fetch('/server/files/klippy.log', { headers: { Range: 'bytes=-60000' } });
    const text = await r.text();
    pre.textContent = text.split('\n').filter((l) => !l.startsWith('Stats ')).slice(-200).join('\n');
    pre.scrollTop = pre.scrollHeight;
  } catch (e) { pre.textContent = e.message; }
}

async function power(what) {
  const msg = what === 'reboot'
    ? 'The Pi restarts (about a minute). Any print in progress will stop.'
    : 'The Pi shuts down. You\'ll need to switch it off and on to bring it back.';
  if (!await confirmBox(what === 'reboot' ? 'Reboot the Pi?' : 'Shut down the Pi?', msg, what === 'reboot' ? 'Reboot' : 'Shut down', true)) return;
  attempt(() => mr.call(`machine.${what}`));
}
