// The hole box: which screw, what kind of hole, how tight, how deep, with a
// cut-away drawing of the hole so the kind is obvious at a glance.

import { type HoleSpec, type HoleKind, type HoleFit, SCREWS, SCREW_ORDER, KIND_LABEL, holeFromTable } from './holes.js';

export interface HoleDialogOpts {
  hole: HoleSpec;
  through: boolean;
  depth: number;          // when not through
  fit: boolean;           // takes the part's printer fit
  partFit: number;        // the part's printer fit (mm)
  units: 'mm' | 'in';
  isNew: boolean;
  count: number;          // how many holes this edits (several selected)
  apply(r: { hole: HoleSpec; through: boolean; depth: number; fit: boolean }): void;
  cancel(): void;
}

const KINDS: HoleKind[] = ['clear', 'tap', 'insert', 'cbore', 'csk', 'nut'];
const KIND_HINT: Record<HoleKind, string> = {
  clear: 'The screw passes through freely.',
  tap: 'Smaller than the screw: it cuts its own thread in the plastic.',
  insert: 'Sized for a heat-set brass insert, as deep as the insert.',
  cbore: 'A socket-head screw sinks in flush.',
  csk: 'A flat-head (90°) screw sinks in flush.',
  nut: 'A hex pocket on the far end holds a nut.',
};

export function openHoleDialog(root: HTMLElement, o: HoleDialogOpts) {
  let h: HoleSpec = { ...o.hole };
  let through = o.through, depth = o.depth, fit = o.fit;
  const inch = o.units === 'in';
  const toU = (mm: number) => (inch ? mm / 25.4 : mm);
  const fromU = (v: number) => (inch ? v * 25.4 : v);
  const unit = inch ? 'in' : 'mm';

  const box = document.createElement('div');
  box.className = 'ds-modal';
  const card = document.createElement('div');
  card.className = 'ds-dialog ds-hole-dialog';
  box.appendChild(card);
  root.appendChild(box);

  const close = () => { box.remove(); window.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); o.cancel(); }
    else if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName !== 'BUTTON') {
      e.preventDefault(); e.stopImmediatePropagation();
      const t = e.target as HTMLInputElement;
      if (t?.tagName === 'INPUT') t.dispatchEvent(new Event('change'));
      ok();
    }
  };
  window.addEventListener('keydown', onKey, true);
  const ok = () => { close(); o.apply({ hole: h, through, depth, fit }); };

  /** Pick a screw or kind: sizes come from the table again (a custom size keeps its own). */
  const retable = (size: string, kind: HoleKind, f: HoleFit) => {
    const was = h;
    h = holeFromTable(size, kind, f, was);
    if (kind === 'insert' && kind !== was.kind) { through = false; depth = h.insertLen + 0.5; }
    if (kind !== 'insert' && was.kind === 'insert') through = true;
  };

  const field = (label: string, input: HTMLElement, hint = '') => {
    const w = document.createElement('label');
    w.className = 'ds-field';
    const s = document.createElement('span');
    s.textContent = label;
    const i = document.createElement('i');
    i.textContent = hint;
    w.append(s, input, i);
    return w;
  };
  const num = (value: number, set: (v: number) => void, min = 0) => {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = 'any';
    inp.value = String(+toU(value).toFixed(inch ? 4 : 2));
    inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (Number.isFinite(v) && fromU(v) >= min) { set(fromU(v)); render(); } });
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    return inp;
  };
  const seg = (options: [string, string][], value: string, set: (v: string) => void, cls = 'ds-seg ds-small') => {
    const d = document.createElement('div');
    d.className = cls;
    for (const [v, t] of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t;
      b.className = v === value ? 'active' : '';
      b.onclick = () => { set(v); render(); };
      d.appendChild(b);
    }
    return d;
  };
  const note = (t: string) => { const p = document.createElement('p'); p.className = 'ds-note'; p.textContent = t; return p; };
  const head = (t: string) => { const d = document.createElement('div'); d.className = 'ds-h'; d.textContent = t; return d; };

  function render() {
    const kids: HTMLElement[] = [];
    const title = document.createElement('h3');
    title.textContent = o.isNew ? 'New hole' : o.count > 1 ? `${o.count} holes` : 'Hole';
    kids.push(title);

    // screw size: a dropdown of the table plus Custom
    const sel = document.createElement('select');
    sel.innerHTML = SCREW_ORDER.map((k) => `<option value="${k}">${SCREWS[k].label}${k.startsWith('n') || k === 'q20' ? '' : ' metric'}</option>`).join('') + '<option value="custom">Custom size</option>';
    sel.value = SCREWS[h.size] ? h.size : 'custom';
    sel.onchange = () => { retable(sel.value, h.kind, h.fit); render(); };
    kids.push(field('Screw', sel));

    // the kind, as picture buttons
    const kinds = document.createElement('div');
    kinds.className = 'ds-hole-kinds';
    for (const k of KINDS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = k === h.kind ? 'active' : '';
      b.title = KIND_HINT[k];
      b.innerHTML = `${kindIcon(k)}<span>${KIND_LABEL[k]}</span>`;
      b.onclick = () => { retable(h.size, k, h.fit); render(); };
      kinds.appendChild(b);
    }
    kids.push(kinds);
    kids.push(note(KIND_HINT[h.kind]));

    if (h.kind === 'clear' || h.kind === 'cbore' || h.kind === 'csk' || h.kind === 'nut') {
      kids.push(field('Fit', seg([['close', 'Close'], ['normal', 'Normal'], ['loose', 'Loose']], h.fit, (v) => retable(h.size, h.kind, v as HoleFit))));
    }

    kids.push(head('Depth'));
    kids.push(field('Goes', seg([['through', 'Through'], ['blind', 'To a depth']], through ? 'through' : 'blind', (v) => {
      through = v === 'through';
      if (!through && !(depth > 0)) depth = h.kind === 'insert' ? h.insertLen + 0.5 : 5;
    })));
    if (!through) kids.push(field('Depth', num(depth, (v) => { depth = v; }, 0.1), unit));

    kids.push(head('Sizes'));
    kids.push(field('Hole Ø', num(h.d, (v) => { h = { ...h, d: v, size: 'custom' }; }, 0.1), unit));
    if (h.kind === 'cbore') {
      kids.push(field('Counterbore Ø', num(h.headD, (v) => { h = { ...h, headD: v }; }, 0.1), unit));
      kids.push(field('Counterbore depth', num(h.headDepth, (v) => { h = { ...h, headDepth: v }; }, 0.1), unit));
    }
    if (h.kind === 'csk') kids.push(field('Countersink Ø', num(h.headD, (v) => { h = { ...h, headD: v }; }, 0.1), unit));
    if (h.kind === 'nut') {
      kids.push(field('Nut across flats', num(h.nutAF, (v) => { h = { ...h, nutAF: v }; }, 0.1), unit));
      kids.push(field('Pocket depth', num(h.nutDepth, (v) => { h = { ...h, nutDepth: v }; }, 0.1), unit));
      const rot = document.createElement('input');
      rot.type = 'number'; rot.step = 'any'; rot.value = String(h.nutRot);
      rot.addEventListener('change', () => { const v = parseFloat(rot.value); if (Number.isFinite(v)) { h = { ...h, nutRot: v }; render(); } });
      rot.addEventListener('keydown', (e) => e.stopPropagation());
      kids.push(field('Nut turned', rot, '°'));
    }
    if (h.kind === 'insert') kids.push(field('Insert length', num(h.insertLen, (v) => { h = { ...h, insertLen: v }; if (!through) depth = v + 0.5; }, 0.1), unit));

    const fitBox = document.createElement('label');
    fitBox.className = 'ds-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = fit;
    cb.onchange = () => { fit = cb.checked; render(); };
    fitBox.append(cb, document.createTextNode(` Add printer fit (+${toU(o.partFit).toFixed(inch ? 3 : 2)} ${unit})`));
    kids.push(fitBox);

    const g = fit ? o.partFit : 0;
    kids.push(note(`Made Ø ${toU(h.d + g).toFixed(inch ? 3 : 2)} ${unit}${g ? ` (Ø ${toU(h.d).toFixed(inch ? 3 : 2)} + printer fit)` : ''}.`));

    const pic = document.createElement('div');
    pic.className = 'ds-hole-pic';
    pic.innerHTML = sectionSvg(h, through);
    kids.push(pic);

    const foot = document.createElement('div');
    foot.className = 'ds-dialog-foot';
    const cancel = document.createElement('button');
    cancel.className = 'btn sm ghost';
    cancel.textContent = o.isNew ? 'Cancel' : 'Close';
    cancel.onclick = () => { close(); o.cancel(); };
    const done = document.createElement('button');
    done.className = 'btn sm primary';
    done.textContent = o.isNew ? 'Add hole' : 'Apply';
    done.onclick = ok;
    foot.append(cancel, done);
    kids.push(foot);
    card.replaceChildren(...kids);
  }
  render();
}

/** A small cut-away icon for each kind. */
function kindIcon(k: HoleKind): string {
  const wall = '<rect x="2" y="6" width="24" height="16" fill="currentColor" opacity=".18"/>';
  const shapes: Record<HoleKind, string> = {
    clear: '<rect x="11" y="6" width="6" height="16"/>',
    tap: '<rect x="12" y="6" width="4" height="16"/><path d="M12 9h4M12 12h4M12 15h4M12 18h4" stroke-width=".8"/>',
    insert: '<rect x="10" y="6" width="8" height="10"/><path d="M10 9h8M10 12h8" stroke-width=".8"/>',
    cbore: '<path d="M8 6v5h3v11h6V11h3V6z"/>',
    csk: '<path d="M7 6l4 5v11h6V11l4-5z"/>',
    nut: '<path d="M11 6h6v11h3v5H8v-5h3z"/>',
  };
  return `<svg viewBox="0 0 28 28" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">${wall}<g fill="var(--bg2)">${shapes[k]}</g></svg>`;
}

/** The hole cut in half, to scale, with its sizes. */
function sectionSvg(h: HoleSpec, through: boolean): string {
  const T = 14;                                    // a 14 mm plate, for the drawing
  const W = Math.max(h.headD, h.nutAF / Math.cos(Math.PI / 6), h.d) * 2.6 + 6;
  const sx = 200 / W, sy = 90 / T, k = Math.min(sx, sy);
  const cx = 130, top = 12;
  const X = (mm: number) => cx + mm * k, Y = (mm: number) => top + mm * k;
  const r = h.d / 2;
  const depth = through ? T : Math.min(T - 1, h.kind === 'insert' ? h.insertLen + 0.5 : T * 0.6);
  // the hole's outline, right half, top to bottom
  const right: [number, number][] = [];
  if (h.kind === 'cbore') right.push([h.headD / 2, 0], [h.headD / 2, h.headDepth], [r, h.headDepth]);
  else if (h.kind === 'csk') right.push([h.headD / 2, 0], [r, h.headD / 2 - r]);
  else right.push([r, 0]);
  if (h.kind === 'nut' && through) { const R = h.nutAF / 2; right.push([r, T - h.nutDepth], [R, T - h.nutDepth], [R, T]); }
  else right.push([r, depth]);
  const pts = [...right, ...[...right].reverse().map(([x, y]) => [-x, y] as [number, number])];
  const path = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)} ${Y(y).toFixed(1)}`).join('') + 'Z';
  const plate = `<rect x="${X(-W / 2)}" y="${Y(0)}" width="${W * k}" height="${T * k}" fill="url(#hatch)" stroke="currentColor" stroke-width="1"/>`;
  const axis = `<path d="M${cx} ${Y(-1.5)}V${Y(T + 1.5)}" stroke="currentColor" stroke-width=".6" stroke-dasharray="6 2 1 2" opacity=".6"/>`;
  return `<svg viewBox="0 0 260 ${Math.ceil(Y(T) + 14)}" width="100%" height="${Math.ceil(Y(T) + 14)}">
    <defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--card)"/><path d="M0 0v6" stroke="currentColor" stroke-width=".7" opacity=".45"/></pattern></defs>
    ${plate}<path d="${path}" fill="var(--bg2)" stroke="var(--accent)" stroke-width="1.4"/>${axis}
    <text x="${cx}" y="${Y(T) + 11}" text-anchor="middle" font-size="9" fill="currentColor" opacity=".7">cut away · ${through ? 'through' : 'blind'}</text>
  </svg>`;
}
