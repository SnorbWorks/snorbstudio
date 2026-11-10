// The gear box: type, pitch (module or DP), teeth, pressure angle, bore,
// set screw and hub, and an offer to mesh with a gear already on the sheet.

import type { GearSpec } from './gears.js';
import { pitchRadius, outerRadius, centreDistance, meshRotation } from './gears.js';
import type { ViewName } from './model.js';

export interface MeshCandidate {
  id: string; label: string; gear: GearSpec; view: ViewName;
  cu: number; cv: number; rot: number; d0: number; d1: number;
}

export interface GearDialogOpts {
  gear: GearSpec;
  thickness: number;
  units: 'mm' | 'in';
  isNew: boolean;
  others: MeshCandidate[];
  apply(r: { gear: GearSpec; thickness: number; place: { cu: number; cv: number; rot: number; d0: number; d1: number } | null }): void;
  cancel(): void;
}

export function openGearDialog(root: HTMLElement, o: GearDialogOpts) {
  const g: GearSpec = JSON.parse(JSON.stringify(o.gear));
  let thickness = o.thickness;
  // a new gear offers to mesh with the first one already there
  let meshWith = o.isNew && o.others.length ? o.others[0].id : '';
  if (meshWith) matchTo(o.others[0].gear);

  const inch = o.units === 'in';
  const toU = (mm: number) => (inch ? mm / 25.4 : mm);
  const fromU = (v: number) => (inch ? v * 25.4 : v);
  const unit = inch ? 'in' : 'mm';

  const box = document.createElement('div');
  box.className = 'ds-modal';
  const card = document.createElement('div');
  card.className = 'ds-dialog ds-gear-dialog';
  box.appendChild(card);
  root.appendChild(box);

  function matchTo(other: GearSpec) {
    g.module = other.module; g.pitch = other.pitch; g.pa = other.pa;
    if (other.kind === 'helical' && (g.kind === 'spur' || g.kind === 'helical')) { g.kind = 'helical'; g.helix = -other.helix; }
  }

  const close = () => { box.remove(); window.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); o.cancel(); }
    else if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName !== 'BUTTON') {
      e.preventDefault(); e.stopImmediatePropagation();
      // a number being typed: take it first
      const t = e.target as HTMLInputElement;
      if (t?.tagName === 'INPUT') t.dispatchEvent(new Event('change'));
      ok();
    }
  };
  window.addEventListener('keydown', onKey, true);

  const ok = () => {
    let place: { cu: number; cv: number; rot: number; d0: number; d1: number } | null = null;
    const other = o.others.find((x) => x.id === meshWith);
    if (other && (g.kind === 'spur' || g.kind === 'helical')) {
      // beside it, to the right as the drawing view sees it, teeth in its gaps
      const a = centreDistance(g.module, other.gear.teeth, g.teeth);
      place = { cu: other.cu + a, cv: other.cv, rot: meshRotation(other.rot, other.gear.teeth, g.teeth, 0), d0: other.d0, d1: other.d1 };
      thickness = Math.abs(other.d1 - other.d0);
    }
    close();
    o.apply({ gear: g, thickness, place });
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
  const num = (value: number, set: (v: number) => void, opts: { step?: number; min?: number } = {}) => {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = opts.step ? String(opts.step) : 'any';
    inp.value = String(+value.toFixed(4));
    inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (Number.isFinite(v) && v >= (opts.min ?? -Infinity)) { set(v); render(); } });
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    return inp;
  };
  const seg = (options: [string, string][], value: string, set: (v: string) => void) => {
    const d = document.createElement('div');
    d.className = 'ds-seg ds-small';
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
  const h = (t: string) => { const d = document.createElement('div'); d.className = 'ds-h'; d.textContent = t; return d; };

  function render() {
    const kids: HTMLElement[] = [];
    const title = document.createElement('h3');
    title.textContent = o.isNew ? 'New gear' : 'Gear';
    kids.push(title);
    kids.push(field('Type', seg([['spur', 'Spur'], ['helical', 'Helical'], ['ring', 'Ring'], ['rack', 'Rack']], g.kind, (v) => { g.kind = v as GearSpec['kind']; })));

    const meshable = (g.kind === 'spur' || g.kind === 'helical') && o.others.length > 0;
    if (meshable) {
      const sel = document.createElement('select');
      sel.innerHTML = `<option value="">Don't mesh</option>` + o.others.map((x) => `<option value="${x.id}">Mesh with ${x.label.replace(/</g, '&lt;')}</option>`).join('');
      sel.value = meshWith;
      sel.onchange = () => { meshWith = sel.value; const x = o.others.find((q) => q.id === meshWith); if (x) matchTo(x.gear); render(); };
      kids.push(field('Mesh', sel));
      if (meshWith) kids.push(note('Same module and pressure angle as that gear; this one goes beside it, teeth in its gaps, at the same thickness.'));
    }

    kids.push(field('Pitch by', seg([['module', 'Module'], ['dp', 'Diametral pitch']], g.pitch, (v) => { g.pitch = v as GearSpec['pitch']; })));
    if (g.pitch === 'module') kids.push(field('Module', num(g.module, (v) => { g.module = v; }, { min: 0.05 }), 'mm'));
    else kids.push(field('DP', num(25.4 / g.module, (v) => { g.module = 25.4 / v; }, { min: 1 }), 'teeth/in'));
    kids.push(field(g.kind === 'rack' ? 'Teeth (length)' : 'Teeth', num(g.teeth, (v) => { g.teeth = Math.max(g.kind === 'rack' ? 1 : 5, Math.round(v)); }, { step: 1, min: 1 })));
    kids.push(field('Pressure angle', seg([['14.5', '14.5°'], ['20', '20°'], ['25', '25°']], String(g.pa), (v) => { g.pa = +v; })));
    if (g.kind === 'helical') kids.push(field('Helix angle', num(g.helix, (v) => { g.helix = Math.max(-45, Math.min(45, v)); }), '°'));
    if (g.kind === 'ring') kids.push(field('Rim', num(toU(g.rim), (v) => { g.rim = fromU(v); }, { min: 0.2 }), unit));
    if (g.kind === 'rack') kids.push(field('Backing', num(toU(g.rim), (v) => { g.rim = fromU(v); }, { min: 0.2 }), unit));
    kids.push(field('Thickness', num(toU(thickness), (v) => { thickness = fromU(v); }, { min: 0.1 }), unit));
    kids.push(field('Backlash', num(toU(g.backlash), (v) => { g.backlash = fromU(Math.max(0, v)); }), unit));

    if (g.kind !== 'rack') {
      kids.push(h('Bore'));
      kids.push(field('Bore', seg([['none', 'None'], ['round', 'Round'], ['d', 'D-shaft']], g.bore, (v) => { g.bore = v as GearSpec['bore']; })));
      if (g.bore !== 'none') {
        kids.push(field('Bore Ø', num(toU(g.boreD), (v) => { g.boreD = fromU(v); }, { min: 0.1 }), unit));
        if (g.bore === 'd') kids.push(field('Across the flat', num(toU(g.flat), (v) => { g.flat = fromU(v); }, { min: 0.1 }), unit));
        kids.push(field('Set screw Ø', num(toU(g.screw), (v) => { g.screw = fromU(Math.max(0, v)); }), unit));
        kids.push(field('Hub Ø', num(toU(g.hubD), (v) => { g.hubD = fromU(Math.max(0, v)); }), unit));
        kids.push(field('Hub length', num(toU(g.hubLen), (v) => { g.hubLen = fromU(Math.max(0, v)); }), unit));
        if (g.screw > 0 && !(g.hubD > 0 && g.hubLen > 0)) kids.push(note('The set screw goes through the hub: give it a hub, or it goes through the gear body.'));
      }
    }

    const f = (mm: number) => `${toU(mm).toFixed(inch ? 3 : 2)} ${unit}`;
    const sum = g.kind === 'rack'
      ? `Rack ${f(g.teeth * Math.PI * g.module)} long`
      : `Pitch Ø ${f(2 * pitchRadius(g))} · outside Ø ${f(2 * outerRadius(g))}`;
    kids.push(note(sum + (g.teeth < 13 && g.kind !== 'rack' && g.kind !== 'ring' ? ' · Under 13 teeth the roots get undercut; fine for printing, a little weaker.' : '')));

    const foot = document.createElement('div');
    foot.className = 'ds-dialog-foot';
    const cancel = document.createElement('button');
    cancel.className = 'btn sm ghost';
    cancel.textContent = o.isNew ? 'Cancel' : 'Close';
    cancel.onclick = () => { close(); o.cancel(); };
    const done = document.createElement('button');
    done.className = 'btn sm primary';
    done.textContent = o.isNew ? 'Add gear' : 'Apply';
    done.onclick = ok;
    foot.append(cancel, done);
    kids.push(foot);
    card.replaceChildren(...kids);
  }
  render();
}
