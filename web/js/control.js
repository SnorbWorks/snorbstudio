// Control page: homing and jogging, heaters, filament, fan, macros, console.

import { mr } from './moonraker.js';
import { $, $$, el, toast, attempt, confirmBox } from './ui.js';
import * as fil from './filaments.js';

let mats = {};
const HIDDEN_MACROS = new Set(['PRINT_START', 'PRINT_END', 'CANCEL_PRINT', 'PAUSE', 'RESUME',
  'SET_PAUSE_NEXT_LAYER', 'SET_PAUSE_AT_LAYER', 'SET_PRINT_STATS_INFO', 'LOAD_FILAMENT', 'UNLOAD_FILAMENT']);
let step = 10;

export function initControl(app) {
  // ---- motion
  $$('#jog-step button').forEach((b) => b.onclick = () => {
    step = +b.dataset.step;
    $$('#jog-step button').forEach((x) => x.classList.toggle('active', x === b));
  });
  $$('[data-jog]').forEach((b) => b.onclick = () => jog(b.dataset.jog));
  $$('[data-home]').forEach((b) => b.onclick = () => home(b.dataset.home));
  $('#motors-off').onclick = () => guard() && attempt(() => mr.gcode('M84'), 'Motors off – the axes can be moved by hand');

  // ---- heat
  $$('[data-set]').forEach((b) => b.onclick = () => {
    const input = b.dataset.set === 'extruder' ? '#t-noz' : '#t-bed';
    const v = +$(input).value;
    if ($(input).value === '' || v < 0) return;
    attempt(() => mr.gcode(`SET_HEATER_TEMPERATURE HEATER=${b.dataset.set} TARGET=${v}`));
  });
  for (const id of ['#t-noz', '#t-bed']) {
    $(id).onkeydown = (e) => { if (e.key === 'Enter') $(id).nextElementSibling.click(); };
  }
  $$('[data-preheat]').forEach((b) => b.onclick = () =>
    attempt(() => mr.gcode('TURN_OFF_HEATERS'), 'Heaters off'));
  // One filament list, shared with the Prepare page.
  const pick = $('#preheat-mat');
  const temps = () => {
    const m = mats[pick.value];
    $('#preheat-temps').textContent = m ? `${m.temp} / ${m.bed}` : '';
  };
  fil.materials().then((m) => {
    mats = m;
    pick.replaceChildren(...Object.entries(mats).map(([k, v]) => el('option', { value: k }, v.label)));
    pick.value = mats[fil.selectedMaterial()] ? fil.selectedMaterial() : 'pla';
    temps();
  });
  pick.onchange = temps;
  app.onPage?.((p) => { if (p === 'control' && mats[fil.selectedMaterial()]) { pick.value = fil.selectedMaterial(); temps(); } });
  $('#preheat-btn').onclick = () => {
    const m = mats[pick.value];
    if (!m) return toast('Filament list not loaded – is the slicing helper running?', 'err');
    attempt(() => mr.gcode(`SET_HEATER_TEMPERATURE HEATER=extruder TARGET=${m.temp}\nSET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=${m.bed}`),
      `Heating for ${m.label}: ${m.temp} / ${m.bed} °C`);
  };

  // ---- filament
  // Always the picked filament's temperature: a leftover target (e.g. 210
  // from unloading PLA) mustn't decide how hot PETG gets loaded.
  const filTemp = () => mats[pick.value]?.temp || 210;
  $('#load-fil').onclick = async () => {
    if (!guardFilament()) return;
    if (await confirmBox('Load filament', `Heats the nozzle to ${filTemp()} °C, then feeds about 39 cm of filament through the tube. Push the new filament into the extruder until the gears grab it before pressing Start.`, 'Start')) {
      attempt(() => mr.gcode(`LOAD_FILAMENT TEMP=${filTemp()}`));
    }
  };
  $('#unload-fil').onclick = async () => {
    if (!guardFilament()) return;
    if (await confirmBox('Unload filament', `Heats the nozzle to ${filTemp()} °C and pulls the filament back out of the tube.`, 'Start')) {
      attempt(() => mr.gcode(`UNLOAD_FILAMENT TEMP=${filTemp()}`));
    }
  };
  $$('[data-extrude]').forEach((b) => b.onclick = () => {
    if (!guardFilament()) return;
    if ((mr.printer.extruder?.temperature || 0) < 175) return toast('Heat the nozzle first (at least 180 °C).', 'err');
    attempt(() => mr.gcode(`M83\nG1 E${b.dataset.extrude} F300`));
  });
  const fan = $('#fan');
  fan.oninput = () => { $('#fan-val').textContent = `${fan.value}%`; fan.dataset.touched = Date.now(); };
  fan.onchange = () => attempt(() => mr.gcode(`M106 S${Math.round(fan.value * 2.55)}`));

  // ---- macros
  const card = el('div', { class: 'card' }, el('div', { class: 'panel-h' }, 'Macros'),
    el('p', { class: 'muted small' }, 'Shortcuts defined in the printer config.'),
    el('div', { class: 'macro-grid', id: 'macro-grid' }));
  $('#page-control .console-card').before(card);
  mr.on('klippy', (s) => { if (s === 'ready') renderMacros(); });

  // ---- console
  initConsole();
  mr.on('status', update);
}

// Filament can be swapped while a print is paused (colour changes).
export function guardFilament() {
  if (!mr.ready) { toast('The printer isn\'t ready.', 'err'); return false; }
  if (mr.printState === 'printing') { toast('Pause the print first.', 'err'); return false; }
  return true;
}

function guard() {
  if (!mr.ready) { toast('The printer isn\'t ready.', 'err'); return false; }
  if (mr.busy) { toast('Not while a print is running.', 'err'); return false; }
  return true;
}

function jog(dir) {
  if (!guard()) return;
  const axis = dir[0], sign = dir[1] === '+' ? 1 : -1;
  const homed = mr.printer.toolhead?.homed_axes || '';
  if (!homed.includes(axis.toLowerCase())) return toast(`Home ${axis} first so the printer knows where it is.`, 'err');
  const f = axis === 'Z' ? 600 : 6000;
  attempt(() => mr.gcode(`G91\nG1 ${axis}${sign * step} F${f}\nG90`));
}

function home(what) {
  if (!guard()) return;
  const cmd = { ALL: 'G28', XY: 'G28 X Y', Z: 'G28 Z' }[what];
  attempt(() => mr.gcode(cmd));
}

function renderMacros() {
  const grid = $('#macro-grid');
  const list = (mr.macros || []).filter((m) => !HIDDEN_MACROS.has(m.toUpperCase()));
  grid.replaceChildren(...(list.length ? list.map((m) => el('button', {
    class: 'btn sm',
    onclick: async () => {
      if (await confirmBox(`Run ${m}?`, 'This runs the macro on the printer now.', 'Run')) attempt(() => mr.gcode(m));
    } }, m)) : [el('span', { class: 'muted small' }, 'No extra macros defined.')]));
}

function update() {
  const p = mr.printer;
  const pos = p.gcode_move?.gcode_position || p.toolhead?.position;
  const homed = p.toolhead?.homed_axes || '';
  if (pos) {
    $('#pos-readout').textContent = `X ${pos[0].toFixed(1)}  Y ${pos[1].toFixed(1)}  Z ${pos[2].toFixed(2)}` +
      (homed.length === 3 ? '' : `  ·  homed: ${homed ? homed.toUpperCase() : 'none'}`);
  }
  $('#jog-note').textContent = mr.busy ? 'Moving is disabled while printing.' :
    homed.length < 3 ? 'Home the printer before moving it with the arrows.' : '';
  for (const [id, key] of [['#c-noz', 'extruder'], ['#c-bed', 'heater_bed']]) {
    const h = p[key];
    if (h) $(id).textContent = `${h.temperature.toFixed(0)}°${h.target ? ` → ${h.target.toFixed(0)}°` : ''}`;
  }
  const fan = $('#fan');
  if (p.fan && Date.now() - (+fan.dataset.touched || 0) > 3000) {
    fan.value = Math.round(p.fan.speed * 100);
    $('#fan-val').textContent = `${fan.value}%`;
  }
}

// ------------------------------------------------------------- console

function initConsole() {
  const box = $('#console');
  const history = [];
  let hi = 0;
  const add = (text, cls = '', time = Date.now() / 1000) => {
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    const t = new Date(time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    box.append(el('div', { class: cls }, el('span', { class: 't' }, t), text));
    while (box.childElementCount > 1000) box.firstChild.remove();
    if (stick) box.scrollTop = box.scrollHeight;
  };
  const classify = (m) => (m.startsWith('!!') || m.startsWith('// Error') ? 'err' : '');
  mr.on('gcode', (m) => add(m, classify(m)));
  mr.on('klippy', async (s) => {
    if (s !== 'ready' || box.dataset.loaded) return;
    box.dataset.loaded = 1;
    try {
      const st = await mr.call('server.gcode_store', { count: 150 });
      box.replaceChildren();
      for (const e of st.gcode_store) add(e.message, e.type === 'command' ? 'cmd' : classify(e.message), e.time);
    } catch (e) { /* ignore */ }
  });
  const send = (cmd) => {
    cmd = cmd.trim();
    if (!cmd) return;
    history.push(cmd); hi = history.length;
    add(cmd, 'cmd');
    mr.gcode(cmd).catch((e) => add(e.message, 'err'));
  };
  $('#console-form').onsubmit = (e) => { e.preventDefault(); send($('#console-cmd').value); $('#console-cmd').value = ''; };
  $('#console-cmd').onkeydown = (e) => {
    if (e.key === 'ArrowUp' && hi > 0) { $('#console-cmd').value = history[--hi]; e.preventDefault(); }
    if (e.key === 'ArrowDown') { hi = Math.min(history.length, hi + 1); $('#console-cmd').value = history[hi] || ''; e.preventDefault(); }
  };
  $$('#console-chips [data-cmd]').forEach((b) => b.onclick = () => send(b.dataset.cmd));
}
