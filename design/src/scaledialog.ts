// The scale box: how big to make the selected shapes (a percentage, or a new
// width and height), with the proportions locked or free, about which point
// (a corner, a side's middle, the centre, or any point typed in). Changes
// show on the sheet while the box is open. Only outlines change size: depths stay.

export interface ScaleDialogOpts {
  box: [number, number, number, number];   // the selection in the view (u0, v0, u1, v1)
  axes: [string, string];                  // the view's across and up axes ("X", "Y")
  signs: [number, number];                 // world = sign × view coordinate, per axis
  units: 'mm' | 'in';
  count: number;
  lock: boolean;                           // proportions locked last time
  preview(sx: number, sy: number, pu: number, pv: number): void;
  apply(sx: number, sy: number, pu: number, pv: number, copy: boolean, lock: boolean): void;
  cancel(): void;
}

export function openScaleDialog(root: HTMLElement, o: ScaleDialogOpts) {
  const [u0, v0, u1, v1] = o.box;
  const W = u1 - u0, H = v1 - v0;
  const inch = o.units === 'in';
  const toU = (mm: number) => +(inch ? mm / 25.4 : mm).toFixed(inch ? 4 : 3);
  const fromU = (v: number) => (inch ? v * 25.4 : v);
  const unit = inch ? 'in' : 'mm';
  let sx = 1, sy = 1, lock = o.lock;
  let pick = 4;                                  // the 3×3 grid: 0 top-left … 4 centre … 8 bottom-right; -1 typed point
  let pu = (u0 + u1) / 2, pv = (v0 + v1) / 2;

  const box = document.createElement('div');
  box.className = 'ds-modal ds-modal-clear';
  const card = document.createElement('div');
  card.className = 'ds-dialog ds-rot-dialog';
  box.appendChild(card);
  root.appendChild(box);

  card.innerHTML = `
    <h3>Scale ${o.count > 1 ? `${o.count} shapes` : ''}</h3>
    <label class="ds-field"><span>Width</span><input type="number" step="any" min="0" id="sc-w"><i>${unit}</i></label>
    <label class="ds-field"><span>Height</span><input type="number" step="any" min="0" id="sc-h"><i>${unit}</i></label>
    <label class="ds-field"><span>Across</span><input type="number" step="any" min="0" id="sc-px"><i>%</i></label>
    <label class="ds-field"><span>Up</span><input type="number" step="any" min="0" id="sc-py"><i>%</i></label>
    <label class="ds-check"><input type="checkbox" id="sc-lock"> Lock proportions</label>
    <div class="ds-rot-quick"></div>
    <div class="ds-h">Scale from</div>
    <div class="ds-rot-pivot">
      <div class="ds-rot-grid"></div>
      <div class="ds-rot-pt">
        <label class="ds-field"><span>${o.axes[0]}</span><input type="number" step="any" id="sc-pu"><i>${unit}</i></label>
        <label class="ds-field"><span>${o.axes[1]}</span><input type="number" step="any" id="sc-pv"><i>${unit}</i></label>
      </div>
    </div>
    <p class="ds-note">That point stays put. Depths don't change. Holes and gears keep their real sizes and only move.</p>
    <div class="ds-dialog-foot">
      <button class="btn sm ghost" id="sc-cancel">Cancel</button>
      <button class="btn sm ghost" id="sc-copy" title="Leave the originals and scale a copy">Copy</button>
      <button class="btn sm primary" id="sc-ok">Scale</button>
    </div>`;
  const $ = <T extends HTMLElement>(s: string) => card.querySelector(s) as T;
  const wIn = $<HTMLInputElement>('#sc-w'), hIn = $<HTMLInputElement>('#sc-h');
  const pxIn = $<HTMLInputElement>('#sc-px'), pyIn = $<HTMLInputElement>('#sc-py');
  const lockIn = $<HTMLInputElement>('#sc-lock');
  const puIn = $<HTMLInputElement>('#sc-pu'), pvIn = $<HTMLInputElement>('#sc-pv');
  lockIn.checked = lock;
  // a flat line (no height or no width) can only scale along its length
  if (W < 1e-9) { wIn.disabled = true; }
  if (H < 1e-9) { hIn.disabled = true; }

  const quick = $('.ds-rot-quick');
  for (const pc of [50, 75, 125, 150, 200]) {
    const b = document.createElement('button');
    b.className = 'btn sm ghost'; b.textContent = `${pc}%`;
    b.onclick = () => { sx = sy = pc / 100; sync(); };
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
    return [u0 + (W * col) / 2, v1 - (H * row) / 2];
  }

  function sync() {
    wIn.value = String(toU(W * sx)); hIn.value = String(toU(H * sy));
    pxIn.value = String(+(sx * 100).toFixed(3)); pyIn.value = String(+(sy * 100).toFixed(3));
    puIn.value = String(toU(pu * o.signs[0]));
    pvIn.value = String(toU(pv * o.signs[1]));
    cells.forEach((c, k) => c.classList.toggle('active', k === pick));
    o.preview(sx, sy, pu, pv);
  }
  // one of the four boxes changed: set that factor, and the other too when locked
  const set = (axis: 0 | 1, f: number) => {
    if (!(f > 0) || !Number.isFinite(f)) return;
    if (axis === 0) sx = f; else sy = f;
    if (lock) sx = sy = f;
  };
  const num = (inp: HTMLInputElement, fn: (v: number) => void) => {
    inp.addEventListener('keydown', (e) => { if (e.key !== 'Enter' && e.key !== 'Escape') e.stopPropagation(); });
    inp.onchange = () => { const v = parseFloat(inp.value); if (Number.isFinite(v)) fn(v); sync(); };
  };
  num(wIn, (v) => { if (W > 1e-9) set(0, fromU(v) / W); });
  num(hIn, (v) => { if (H > 1e-9) set(1, fromU(v) / H); });
  num(pxIn, (v) => set(0, v / 100));
  num(pyIn, (v) => set(1, v / 100));
  num(puIn, (v) => { pu = fromU(v) * o.signs[0]; pick = -1; });
  num(pvIn, (v) => { pv = fromU(v) * o.signs[1]; pick = -1; });
  // locking evens them out to the across size
  lockIn.onchange = () => { lock = lockIn.checked; if (lock) sy = sx; sync(); };

  const close = () => { box.remove(); window.removeEventListener('keydown', onKey, true); };
  const done = (copy: boolean) => { close(); o.apply(sx, sy, pu, pv, copy, lock); };
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
  $('#sc-cancel').onclick = cancel;
  $('#sc-copy').onclick = () => done(true);
  $('#sc-ok').onclick = () => done(false);
  box.onclick = (e) => { if (e.target === box) cancel(); };
  sync();
  pxIn.focus(); pxIn.select();
}
