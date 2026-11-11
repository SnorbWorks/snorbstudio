// The printability card: what the check found, each with Show (lights it up
// in 3D and picks the shape) and a fix where there is one. Opened by the
// Check button, and before Send to Prepare / Library, where Print anyway
// always goes ahead.
import type { Issue } from './check.js';

export interface CheckDialogOpts {
  issues: Issue[];
  sending?: string;                       // "Send to Prepare": show Print anyway
  show(i: Issue): void;
  fix(i: Issue): void;
  done(go: boolean | 'again'): void;      // go: print anyway; 'again': a fix changed the part, check it again
}

const ICON: Record<Issue['kind'], string> = { thin: '▮', gap: '⇹', overhang: '⌒', sideways: '◯', tiny: '·' };

export function openCheckDialog(root: HTMLElement, o: CheckDialogOpts) {
  const box = document.createElement('div');
  box.className = 'ds-modal ds-modal-clear';
  const card = document.createElement('div');
  card.className = 'ds-dialog ds-check-dialog';
  box.appendChild(card);
  root.appendChild(box);
  const issues = o.issues;

  const close = (go: boolean | 'again') => { box.remove(); window.removeEventListener('keydown', onKey, true); o.done(go); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(false); } };
  window.addEventListener('keydown', onKey, true);

  function render() {
    card.innerHTML = `
      <h3>${issues.length ? `${issues.length} thing${issues.length > 1 ? 's' : ''} to look at` : 'Looks printable'}</h3>
      <p class="ds-note">Checked as drawn, standing on its bottom face${o.sending === 'Send to Prepare' ? ' (Prepare may turn it another way up)' : ''}.</p>
      <div class="ds-check-list"></div>
      <div class="ds-dialog-foot">
        ${o.sending ? `<button class="btn sm ghost" id="ck-back">Fix it first</button><button class="btn sm primary" id="ck-go">${issues.length ? 'Print anyway' : o.sending}</button>`
        : '<button class="btn sm primary" id="ck-close">Close</button>'}
      </div>`;
    const list = card.querySelector('.ds-check-list')!;
    issues.forEach((it) => {
      const row = document.createElement('div');
      row.className = `ds-check-item ds-check-${it.kind}`;
      row.innerHTML = `<span class="ds-check-ic">${ICON[it.kind]}</span><div><b>${it.title}</b><small>${it.text}</small><div class="ds-check-acts"></div></div>`;
      const acts = row.querySelector('.ds-check-acts')!;
      const btn = (t: string, run: () => void, primary = false) => {
        const b = document.createElement('button');
        b.className = `btn sm ${primary ? '' : 'ghost'}`; b.textContent = t; b.onclick = run;
        acts.appendChild(b);
      };
      btn('Show', () => {
        card.querySelectorAll('.ds-check-item').forEach((r) => r.classList.remove('on'));
        row.classList.add('on');
        o.show(it);
      });
      if (it.fix === 'teardrop') btn('Make it a teardrop', () => { o.fix(it); close('again'); }, true);
      list.appendChild(row);
    });
    const q = (s: string) => card.querySelector(s) as HTMLButtonElement | null;
    if (q('#ck-close')) q('#ck-close')!.onclick = () => close(false);
    if (q('#ck-back')) q('#ck-back')!.onclick = () => close(false);
    if (q('#ck-go')) q('#ck-go')!.onclick = () => close(true);
  }
  render();
}
