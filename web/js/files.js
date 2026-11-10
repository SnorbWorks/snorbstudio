// Files page: sliced print files (with thumbnails and estimates), print
// history with totals, and the model library kept by the studio helper.

import { mr } from './moonraker.js';
import { $, el, toast, attempt, confirmBox, fmtDuration, fmtBytes, fmtDate, fmtFilament } from './ui.js';
import { bestThumb, dirOf } from './print.js';

let app;
const metaCache = new Map();

export function initFiles(theApp) {
  app = theApp;
  // History sits between print files and the model library.
  $('#model-lib').parentElement.before(el('div', { class: 'card wide' },
    el('div', { class: 'panel-h' }, 'Print history'),
    el('div', { class: 'totals', id: 'hist-totals' }),
    el('div', { style: 'max-height:340px;overflow-y:auto' },
      el('table', { class: 'hist' }, el('thead', {}, el('tr', {},
        ...['File', 'Started', 'Time', 'Filament', 'Result', ''].map((h) => el('th', {}, h)))),
      el('tbody', { id: 'hist-body' })))));

  $('#file-search').oninput = renderGcodes;
  $('#file-sort').onchange = renderGcodes;
  $('#gcode-upload').onchange = async (e) => {
    for (const f of e.target.files) await attempt(() => mr.upload(f), `Uploaded ${f.name}`);
    e.target.value = '';
  };
  mr.on('files', () => { if (app.page === 'files') loadGcodes(); });
  mr.on('history', () => { if (app.page === 'files') loadHistory(); });
  app.onPage((p) => { if (p === 'files') refresh(); });
  mr.on('connection', (up) => { if (up && app.page === 'files') refresh(); });
  return { fileCard };
}

function refresh() { loadGcodes(); loadHistory(); loadModels(); }

async function metadata(f) {
  const key = `${f.path}:${f.modified}`;
  if (!metaCache.has(key)) {
    metaCache.set(key, mr.call('server.files.metadata', { filename: f.path }).catch(() => ({})));
  }
  return metaCache.get(key);
}

export function fileCard(f, { compact = false } = {}) {
  const img = el('div', { class: 'ft' }, '▦');
  const info = el('div', { class: 'fm' }, fmtDate(f.modified));
  const card = el('div', { class: 'file-card' }, img, el('div', { class: 'fb' },
    el('div', { class: 'fn', title: f.path }, f.path.replace(/\.gcode$/i, '')), info,
    el('div', { class: 'fa' },
      el('button', { class: 'btn sm primary', onclick: () => app.startPrint(f.path) }, 'Print'),
      el('button', { class: 'btn sm ghost', onclick: () => app.prepare.previewFile(f.path) }, 'Preview'),
      compact ? null : el('button', { class: 'btn sm ghost', title: 'Add to the print queue', onclick: () => queue(f.path) }, 'Queue'),
      compact ? null : el('a', { class: 'btn sm ghost', href: mr.fileUrl('gcodes', f.path), download: f.path.split('/').pop() }, '⤓'),
      compact ? null : el('button', { class: 'btn sm ghost danger', title: 'Delete', onclick: () => del(f.path) }, '✕'))));
  metadata(f).then((m) => {
    const th = bestThumb(m.thumbnails);
    if (th) img.replaceChildren(el('img', { src: mr.fileUrl('gcodes', dirOf(f.path) + th.relative_path), loading: 'lazy', alt: '' }));
    const bits = [m.estimated_time && fmtDuration(m.estimated_time),
      m.filament_weight_total && `${m.filament_weight_total.toFixed(0)} g`,
      m.layer_height && `${m.layer_height} mm`].filter(Boolean);
    if (bits.length) info.textContent = `${bits.join(' · ')} · ${fmtDate(f.modified)}`;
  });
  return card;
}

let allFiles = [];
async function loadGcodes() {
  try {
    allFiles = await mr.call('server.files.list', { root: 'gcodes' });
  } catch (e) {
    $('#gcode-files').replaceChildren(el('p', { class: 'muted' }, `Can't list files: ${e.message}`));
    return;
  }
  renderGcodes();
}

function renderGcodes() {
  const grid = $('#gcode-files');
  {
    const q = $('#file-search').value.trim().toLowerCase();
    const sort = $('#file-sort').value;
    const files = allFiles.filter((f) => !q || f.path.toLowerCase().includes(q)).sort((a, b) =>
      sort === 'name' ? a.path.localeCompare(b.path) : sort === 'size' ? b.size - a.size : b.modified - a.modified);
    grid.replaceChildren(...(files.length ? files.map((f) => fileCard(f))
      : [el('p', { class: 'muted' }, allFiles.length ? 'No files match.' : 'No print files yet. Slice a model on the Prepare tab, or drop a .gcode file anywhere on this page.')]));
  }
}

async function del(path) {
  if (!await confirmBox('Delete print file?', `Delete ${path}? This can't be undone.`, 'Delete', true)) return;
  attempt(() => mr.call('server.files.delete_file', { path: `gcodes/${path}` }));
}

async function queue(path) {
  await attempt(() => mr.call('server.job_queue.post_job', { filenames: [path] }), `Queued ${path}`);
}

async function loadHistory() {
  try {
    const [h, t] = await Promise.all([
      mr.call('server.history.list', { limit: 100, order: 'desc' }),
      mr.call('server.history.totals')]);
    const tot = t.job_totals || {};
    $('#hist-totals').replaceChildren(
      ...[['Prints', tot.total_jobs ?? 0], ['Printing time', fmtDuration(tot.total_print_time)],
        ['Filament used', fmtFilament(tot.total_filament_used)], ['Longest print', fmtDuration(tot.longest_print)]]
        .map(([k, v]) => el('div', {}, el('span', {}, k), el('b', {}, v))));
    $('#hist-body').replaceChildren(...(h.jobs.length ? h.jobs.map((j) => el('tr', {},
      el('td', {}, j.filename),
      el('td', {}, fmtDate(j.start_time)),
      el('td', {}, fmtDuration(j.print_duration)),
      el('td', {}, fmtFilament(j.filament_used)),
      el('td', { class: `st-${j.status}` }, j.status.replace('klippy_', 'printer ').replace('_', ' ')),
      el('td', {}, j.exists ? el('button', { class: 'btn sm ghost', onclick: () => app.startPrint(j.filename) }, 'Reprint') : '')))
      : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'No prints yet.'))]));
  } catch (e) { /* history component off */ }
}

async function loadModels() {
  const box = $('#model-lib');
  try {
    const { models } = await (await fetch('/studio-api/models')).json();
    box.replaceChildren(...(models.length ? models.map((m) => el('div', { class: 'lib-row' },
      el('span', { class: 'nm' }, m.name),
      el('span', { class: 'sz' }, `${fmtBytes(m.size)} · ${fmtDate(m.modified)}`),
      el('button', { class: 'btn sm primary', onclick: () => app.prepare.loadFromLibrary(m.name) }, 'Put on bed'),
      /\.stl$/i.test(m.name) ? el('button', { class: 'btn sm ghost', title: 'Open it in the Design tab to change it', onclick: () => app.openInDesign(m.name) }, 'Send to Design') : '',
      el('a', { class: 'btn sm ghost', href: `/studio-api/models/${encodeURIComponent(m.name)}`, download: m.name }, '⤓'),
      el('button', { class: 'btn sm ghost danger', onclick: async () => {
        if (await confirmBox('Delete model?', `Remove ${m.name} from the library?`, 'Delete', true)) {
          await fetch(`/studio-api/models/${encodeURIComponent(m.name)}`, { method: 'DELETE' });
          loadModels();
        }
      } }, '✕')))
      : [el('p', { class: 'muted' }, 'Models you add on the Prepare tab are kept here.')]));
  } catch (e) {
    box.replaceChildren(el('p', { class: 'muted' }, 'The model library helper is not running on the Pi.'));
  }
}
