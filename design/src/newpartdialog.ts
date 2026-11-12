// New part: pick the units and the drawing area (the printer bed, a sheet of
// stock, or none) before the first line. Both stay editable under Sheet.
import { AREA_PRESETS, type Area } from './model.js';

export interface NewPart { units: 'mm' | 'in'; area: Area | null }

const KEY = 'studio.design.newpart';

/** What the last new part used (the dialog starts there). */
export function lastNewPart(): NewPart {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (j && (j.units === 'mm' || j.units === 'in')) return { units: j.units, area: j.area ?? null };
  } catch { /* none yet, or private mode */ }
  return { units: 'mm', area: AREA_PRESETS[0].area };
}

/** The preset an area matches, else 'custom' (or 'none'). */
export function presetOf(a: Area | null | undefined): string {
  if (!a) return 'none';
  const hit = AREA_PRESETS.find((x) => x.area && Math.abs(x.area.w - a.w) < 1e-6 && Math.abs(x.area.d - a.d) < 1e-6 && Math.abs(x.area.h - a.h) < 1e-6);
  return hit ? hit.id : 'custom';
}

export function openNewPartDialog(root: HTMLElement, done: (np: NewPart | null) => void) {
  const start = lastNewPart();
  let units = start.units;
  let area: Area = start.area ? { ...start.area } : { ...AREA_PRESETS[0].area! };
  let preset = presetOf(start.area);

  const box = document.createElement('div');
  box.className = 'ds-modal';
  const card = document.createElement('div');
  card.className = 'ds-dialog ds-newpart-dialog';
  box.appendChild(card);
  root.appendChild(box);

  const toU = (mm: number) => +(units === 'in' ? mm / 25.4 : mm).toFixed(units === 'in' ? 3 : 2);
  const render = () => {
    const opts = [...AREA_PRESETS.map((x) => [x.id, x.name]), ['custom', 'Custom size']]
      .map(([id, name]) => `<option value="${id}" ${id === preset ? 'selected' : ''}>${name}</option>`).join('');
    const field = (k: keyof Area, label: string) =>
      `<label class="ds-field"><span>${label}</span><input type="number" step="any" min="0" data-k="${k}" value="${toU(area[k])}"><i>${units}</i></label>`;
    card.innerHTML = `
      <h3>New part</h3>
      <div class="ds-field"><span>Units</span><div class="ds-seg" id="np-units">
        <button class="${units === 'mm' ? 'active' : ''}" data-u="mm">mm</button><button class="${units === 'in' ? 'active' : ''}" data-u="in">inch</button></div></div>
      <div class="ds-field ds-field-wide"><span>Drawing area</span><select class="ds-select" id="np-area">${opts}</select></div>
      ${preset === 'none' ? '<p class="ds-note">No frame: the sheet just fits whatever you draw.</p>'
        : field('w', 'Width (X)') + field('d', 'Depth (Y)') + field('h', 'Height (Z)')
          + '<p class="ds-note">A faint frame on every view: the space the part has to fit in. Change it later under Sheet.</p>'}
      <div class="ds-dialog-foot">
        <button class="btn sm ghost" id="np-cancel">Cancel</button>
        <button class="btn sm primary" id="np-ok">Create</button>
      </div>`;
    card.querySelectorAll<HTMLButtonElement>('#np-units button').forEach((b) => { b.onclick = () => { units = b.dataset.u as 'mm' | 'in'; render(); }; });
    const sel = card.querySelector('#np-area') as HTMLSelectElement;
    sel.onchange = () => {
      preset = sel.value;
      const pr = AREA_PRESETS.find((x) => x.id === preset);
      if (pr?.area) area = { ...pr.area };
      render();
    };
    card.querySelectorAll<HTMLInputElement>('input[data-k]').forEach((inp) => {
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') ok(); });
      inp.onchange = () => {
        const v = parseFloat(inp.value);
        if (!(v > 0)) { inp.value = String(toU(area[inp.dataset.k as keyof Area])); return; }
        area[inp.dataset.k as keyof Area] = units === 'in' ? v * 25.4 : v;
        preset = presetOf(area);
        (card.querySelector('#np-area') as HTMLSelectElement).value = preset;
      };
    });
    (card.querySelector('#np-cancel') as HTMLButtonElement).onclick = () => close(null);
    (card.querySelector('#np-ok') as HTMLButtonElement).onclick = ok;
  };
  const ok = () => {
    // a size still being typed counts
    card.querySelectorAll<HTMLInputElement>('input[data-k]').forEach((inp) => { const v = parseFloat(inp.value); if (v > 0) area[inp.dataset.k as keyof Area] = units === 'in' ? v * 25.4 : v; });
    const np: NewPart = { units, area: preset === 'none' ? null : { ...area } };
    try { localStorage.setItem(KEY, JSON.stringify(np)); } catch { /* private mode */ }
    close(np);
  };
  const close = (np: NewPart | null) => { box.remove(); window.removeEventListener('keydown', onKey, true); done(np); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(null); }
    else if (e.key === 'Enter' && !(e.target as HTMLElement).closest?.('select')) { e.preventDefault(); e.stopImmediatePropagation(); ok(); }
  };
  window.addEventListener('keydown', onKey, true);
  box.onclick = (e) => { if (e.target === box) close(null); };
  render();
}
