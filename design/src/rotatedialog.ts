// The rotate box: how far to turn the selected shapes, and about which
// point (a corner, a side's middle or the centre of the selection, or any
// point typed in). Turns show on the sheet while the box is open.

export interface RotateDialogOpts {
  box: [number, number, number, number];   // the selection in the view (u0, v0, u1, v1)
  axes: [string, string];                  // the view's across and up axes ("X", "Y")
  signs: [number, number];                 // world = sign × view coordinate, per axis
  units: 'mm' | 'in';
  count: number;
  last: number;                            // the angle used last time
  preview(deg: number, pu: number, pv: number): void;
  apply(deg: number, pu: number, pv: number, copy: boolean): void;
  cancel(): void;
}

export function openRotateDialog(root: HTMLElement, o: RotateDialogOpts) {
  const [u0, v0, u1, v1] = o.box;
  const inch = o.units === 'in';
  const toU = (mm: number) => +(inch ? mm / 25.4 : mm).toFixed(4);
  const fromU = (v: number) => (inch ? v * 25.4 : v);
  const unit = inch ? 'in' : 'mm';
  let deg = o.last || 90;
  let pick = 4;                                  // the 3×3 grid: 0 top-left … 4 centre … 8 bottom-right; -1 typed point
  let pu = (u0 + u1) / 2, pv = (v0 + v1) / 2;

  const box = document.createElement('div');
  box.className = 'ds-modal ds-modal-clear';
  const card = document.createElement('div');
  card.className = 'ds-dialog ds-rot-dialog';
  box.appendChild(card);
  root.appendChild(box);

  card.innerHTML = `
    <h3>Rotate ${o.count > 1 ? `${o.count} shapes` : ''}</h3>
    <label class="ds-field"><span>Angle</span><input type="number" step="any" id="rd-deg"><i>° ↺</i></label>
    <div class="ds-rot-quick"></div>
    <div class="ds-h">Turn about</div>
    <div class="ds-rot-pivot">
      <div class="ds-rot-grid"></div>
      <div class="ds-rot-pt">
        <label class="ds-field"><span>${o.axes[0]}</span><input type="number" step="any" id="rd-pu"><i>${unit}</i></label>
        <label class="ds-field"><span>${o.axes[1]}</span><input type="number" step="any" id="rd-pv"><i>${unit}</i></label>
      </div>
    </div>
    <p class="ds-note">Anticlockwise is positive. Pick a point of the selection, or type any point.</p>
    <div class="ds-dialog-foot">
      <button class="btn sm ghost" id="rd-cancel">Cancel</button>
      <button class="btn sm ghost" id="rd-copy" title="Leave the originals and turn a copy">Copy</button>
      <button class="btn sm primary" id="rd-ok">Rotate</button>
    </div>`;
  const $ = <T extends HTMLElement>(s: string) => card.querySelector(s) as T;
  const degIn = $<HTMLInputElement>('#rd-deg'), puIn = $<HTMLInputElement>('#rd-pu'), pvIn = $<HTMLInputElement>('#rd-pv');

  const quick = $('.ds-rot-quick');
  for (const a of [-90, -45, 45, 90, 180]) {
    const b = document.createElement('button');
    b.className = 'btn sm ghost'; b.textContent = `${a > 0 ? '+' : ''}${a}°`;
    b.onclick = () => { deg = a; sync(); };
    quick.appendChild(b);
  }
  const grid = $('.ds-rot-grid');
  const cells: HTMLButtonElement[] = [];
  for (let k = 0; k < 9; k++) {
    const b = document.createElement('button');
    b.className = 'ds-rot-cell';
    b.title = ['Top left', 'Top middle', 'Top right', 'Left middle', 'Centre', 'Right middle', 'Bottom left', 'Bottom middle', 'Bottom right'][k];
    b.onclick = () => { pick = k; const [a, c] = cellPoint(k); pu = a; pv = c; sync(); };
    grid.appendChild(b); cells.push(b);
  }
  function cellPoint(k: number): [number, number] {
    const col = k % 3, row = Math.floor(k / 3);
    return [u0 + ((u1 - u0) * col) / 2, v1 - ((v1 - v0) * row) / 2];
  }

  function sync() {
    degIn.value = String(+deg.toFixed(4));
    puIn.value = String(toU(pu * o.signs[0]));
    pvIn.value = String(toU(pv * o.signs[1]));
    cells.forEach((c, k) => c.classList.toggle('active', k === pick));
    o.preview(deg, pu, pv);
  }
  degIn.onchange = () => { const v = parseFloat(degIn.value); if (Number.isFinite(v)) deg = v; sync(); };
  degIn.oninput = () => { const v = parseFloat(degIn.value); if (Number.isFinite(v)) { deg = v; o.preview(deg, pu, pv); } };
  puIn.onchange = () => { const v = parseFloat(puIn.value); if (Number.isFinite(v)) { pu = fromU(v) * o.signs[0]; pick = -1; } sync(); };
  pvIn.onchange = () => { const v = parseFloat(pvIn.value); if (Number.isFinite(v)) { pv = fromU(v) * o.signs[1]; pick = -1; } sync(); };

  const close = () => { box.remove(); window.removeEventListener('keydown', onKey, true); };
  const done = (copy: boolean) => { close(); o.apply(deg, pu, pv, copy); };
  const cancel = () => { close(); o.cancel(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel(); }
    else if (e.key === 'Enter') {
      e.preventDefault(); e.stopImmediatePropagation();
      (e.target as HTMLElement)?.dispatchEvent?.(new Event('change'));
      done(false);
    }
  };
  window.addEventListener('keydown', onKey, true);
  $('#rd-cancel').onclick = cancel;
  $('#rd-copy').onclick = () => done(true);
  $('#rd-ok').onclick = () => done(false);
  box.onclick = (e) => { if (e.target === box) cancel(); };
  sync();
  degIn.focus(); degIn.select();
}
