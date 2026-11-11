// The fit test: a picture of the test plate. Print the plate, push an M3
// screw through each hole, then click the hole it slid through snugly: that
// becomes the printer fit (for this part and every new one).
import { FIT_STEPS } from './model.js';

export interface FitDialogOpts {
  current: number;
  pick(fit: number): void;
  openPlate(): void;
}

export function openFitDialog(root: HTMLElement, o: FitDialogOpts) {
  const box = document.createElement('div');
  box.className = 'ds-modal';
  const card = document.createElement('div');
  card.className = 'ds-dialog ds-fit-dialog';
  box.appendChild(card);
  root.appendChild(box);
  const n = FIT_STEPS.length, pitch = 60;
  const W = pitch * n + 20, H = 96;
  const holes = FIT_STEPS.map((f, i) => {
    const x = 10 + pitch / 2 + i * pitch, r = 13 + f * 18;
    const lab = f === 0 ? '0' : `.${Math.round(f * 10)}`;
    const on = Math.abs(f - o.current) < 1e-6;
    return `<g class="ds-fit-hole${on ? ' on' : ''}" data-fit="${f}" tabindex="0"><title>Holes print ${f} mm small: use this</title>`
      + `<rect x="${x - pitch / 2 + 3}" y="6" width="${pitch - 6}" height="${H - 12}" rx="8" class="ds-fit-hit"/>`
      + `<circle cx="${x}" cy="36" r="${r}"/><text x="${x}" y="80">${lab}</text></g>`;
  }).join('');
  card.innerHTML = `
    <h3>Fit test</h3>
    <p class="ds-note">Printed holes come out a little small. To find by how much on this printer:</p>
    <ol class="ds-fit-steps">
      <li><b>Open the plate</b> and print it (any settings you normally use).</li>
      <li>Push an M3 screw through each hole.</li>
      <li>Click the hole it slides through <b>snugly</b>: not loose, no forcing.</li>
    </ol>
    <svg class="ds-fit-plate" viewBox="0 0 ${W} ${H}"><rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="10" class="ds-fit-body"/>${holes}</svg>
    <p class="ds-note">Now: holes grow by <b>${o.current} mm</b>. The one you click is used for this part and every new part.</p>
    <div class="ds-dialog-foot">
      <button class="btn sm ghost" id="fd-open">Open the plate</button>
      <button class="btn sm primary" id="fd-close">Close</button>
    </div>`;
  const close = () => { box.remove(); window.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
  window.addEventListener('keydown', onKey, true);
  card.querySelectorAll<SVGGElement>('.ds-fit-hole').forEach((g) => {
    const go = () => { close(); o.pick(parseFloat(g.dataset.fit!)); };
    g.addEventListener('click', go);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
  (card.querySelector('#fd-open') as HTMLButtonElement).onclick = () => { close(); o.openPlate(); };
  (card.querySelector('#fd-close') as HTMLButtonElement).onclick = close;
  box.onclick = (e) => { if (e.target === box) close(); };
}
