// Ender Studio: tabs, the always-visible header (state, temps, STOP),
// the Klipper-not-ready banner and starting prints.

import { mr } from './moonraker.js';
import { $, $$, el, toast, attempt, confirmBox, fmtDuration } from './ui.js';
import { initPrepare } from './prepare.js';
import { initPrint, bestThumb, dirOf } from './print.js';
import { initControl } from './control.js';
import { initFiles } from './files.js';
import { initMaint, restartFirmware, restartService } from './maint.js';

const pageListeners = [];
const app = {
  page: 'prepare',
  onPage(fn) { pageListeners.push(fn); },
  show(page) {
    app.page = page;
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
    $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
    try { localStorage.setItem('studio.page', page); } catch (e) { /* ignore */ }
    if (location.hash.slice(1) !== page) history.replaceState(null, '', `#${page}`);
    for (const fn of pageListeners) fn(page);
  },
  startPrint,
};

async function startPrint(file) {
  if (!mr.ready) return toast('The printer isn\'t ready – check the banner at the top.', 'err');
  let meta = {};
  try { meta = await mr.call('server.files.metadata', { filename: file }); } catch (e) { /* ignore */ }
  const th = bestThumb(meta.thumbnails);
  const body = el('div', {},
    th ? el('img', { src: mr.fileUrl('gcodes', dirOf(file) + th.relative_path), style: 'width:140px;float:right;margin-left:12px;border-radius:8px;background:#15181b' }) : null,
    el('p', {}, el('b', {}, file)),
    el('p', { class: 'muted small' }, [meta.estimated_time && `About ${fmtDuration(meta.estimated_time)}`,
      meta.filament_weight_total && `${meta.filament_weight_total.toFixed(0)} g of filament`].filter(Boolean).join(' · ')),
    el('p', { class: 'small' }, 'Before starting: the bed is clear, filament is loaded and the nozzle is clean. The printer heats up, homes, loads the bed map and draws a purge line first.'));
  if (mr.busy) {
    if (await confirmBox('A print is already running', el('div', {}, body, el('p', {}, 'Add this file to the queue to print next?')), 'Add to queue')) {
      attempt(() => mr.call('server.job_queue.post_job', { filenames: [file] }), 'Added to the queue');
    }
    return;
  }
  if (!await confirmBox('Start printing?', body, 'Start print')) return;
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  const ok = await attempt(() => mr.call('printer.print.start', { filename: file }));
  if (ok !== undefined) app.show('print');
}

// --------------------------------------------------------------- header

function updateHeader() {
  const p = mr.printer;
  const pill = $('#state-pill');
  let text, cls;
  if (!mr.connected) { text = 'Pi offline'; cls = 'error'; }
  else if (mr.klippy !== 'ready') { text = mr.klippy === 'shutdown' ? 'Stopped' : mr.klippy === 'startup' ? 'Starting…' : 'Printer offline'; cls = 'error'; }
  else {
    const st = p.print_stats?.state;
    const pct = Math.round((p.display_status?.progress ?? p.virtual_sdcard?.progress ?? 0) * 100);
    if (st === 'printing') { text = `Printing ${pct}%`; cls = 'printing'; }
    else if (st === 'paused') { text = `Paused ${pct}%`; cls = 'paused'; }
    else if (p.idle_timeout?.state === 'Printing') { text = 'Busy'; cls = 'printing'; }
    else { text = 'Ready'; cls = 'ready'; }
  }
  pill.textContent = text;
  pill.className = `pill ${cls}`;
  const t = (h) => (h ? `${h.temperature.toFixed(0)}°${h.target ? `/${h.target.toFixed(0)}°` : ''}` : '--');
  $('#hdr-noz').textContent = t(p.extruder);
  $('#hdr-bed').textContent = t(p.heater_bed);
  const busy = mr.busy;
  const printTab = $('#tabs [data-page="print"]');
  printTab.innerHTML = busy ? 'Print <span class="badge">●</span>' : 'Print';
  document.title = busy ? `${text} · Ender Studio` : 'Ender Studio';
}

function updateBanner() {
  const b = $('#klippy-banner');
  const show = mr.connected && mr.klippy !== 'ready';
  b.classList.toggle('hidden', !show && mr.connected);
  // designing doesn't need the printer: no banner taking up room on the Design tab
  if (app.page === 'design') { b.classList.add('hidden'); return; }
  if (!mr.connected) {
    $('#kb-title').textContent = 'Can\'t reach the Pi';
    $('#kb-msg').textContent = 'Reconnecting…';
    b.querySelector('.row').classList.add('hidden');
    return;
  }
  b.querySelector('.row').classList.remove('hidden');
  $('#kb-title').textContent = mr.klippy === 'shutdown' ? 'The printer stopped' : 'Printer not ready';
  $('#kb-msg').textContent = friendlyKlippy();
}

// Klipper's state message, in plain words where we know what it means.
export function friendlyKlippy() {
  const msg = (mr.klippyMessage || '').split('\n')[0];
  if (/Unable to connect|Lost communication|mcu .* not connected/i.test(msg)) {
    return 'The printer board isn\'t answering. Is the printer switched on? Then press "Restart printer board".';
  }
  if (/Z guard/i.test(msg)) return 'The Z crash guard stopped the printer. Check nothing is jammed, then press "Restart Klipper service".';
  if (/emergency stop/i.test(msg)) return 'Emergency stop. Press "Restart printer board" to carry on.';
  if (mr.klippy === 'disconnected' && !msg) return 'Klipper is not connected.';
  return msg;
}

// --------------------------------------------------------------- start

function init() {
  $$('#tabs button').forEach((b) => b.onclick = () => app.show(b.dataset.page));
  $('#estop').onclick = () => {
    mr.call('printer.emergency_stop').catch(() => {});
    toast('EMERGENCY STOP sent – motors and heaters are off. Restart the printer board to continue.', 'err', 12000);
  };
  $('#kb-fw').onclick = restartFirmware;
  $('#kb-svc').onclick = restartService;

  app.prepare = initPrepare(app);
  initPrint(app);
  initControl(app);
  const files = initFiles(app);
  app.fileCard = files.fileCard;
  initMaint(app);

  app.onPage(updateBanner);

  // Design (the CAD sheet) loads on first visit: it brings a 22 MB engine.
  let design = null;
  app.onPage((p) => {
    if (p !== 'design' || design) return;
    design = import('../design/design.js')
      .then((m) => m.mount($('#design-root'), app))
      .catch((e) => { design = null; toast(`The Design tab failed to load: ${e.message}`, 'err', 10000); });
  });

  mr.on('status', updateHeader);
  mr.on('klippy', () => { updateHeader(); updateBanner(); });
  mr.on('connection', () => { updateHeader(); updateBanner(); });
  setInterval(updateHeader, 2000);

  let start = location.hash.slice(1);
  try { start ||= localStorage.getItem('studio.page'); } catch (e) { /* ignore */ }
  app.show(['design', 'prepare', 'print', 'control', 'files', 'maint'].includes(start) ? start : 'prepare');
  window.addEventListener('hashchange', () => {
    const p = location.hash.slice(1);
    if (p && p !== app.page) app.show(p);
  });
}

init();
