// Save: where it goes. My parts (on the printer, in the Library), a
// footprint (the selected shapes, to drop on other parts), or a file on this
// computer (anywhere: the Desktop, a backup drive, an email).

export type SaveWhere = 'parts' | 'footprint' | 'file';

export interface SaveAsk {
  name: string;
  where: SaveWhere;
  /** How many shapes would make the footprint, and whether they're the selection or every shape. */
  shapes: number;
  selected: boolean;
  /** The browser shows its own Save panel (pick any folder); else the file goes to Downloads. */
  picker: boolean;
}

const WHERE_KEY = 'studio.design.saveWhere';

export function lastWhere(): SaveWhere {
  try {
    const w = localStorage.getItem(WHERE_KEY);
    if (w === 'parts' || w === 'file') return w;
  } catch { /* default */ }
  return 'parts';
}

export function openSaveDialog(host: HTMLElement, ask: SaveAsk, done: (r: { name: string; where: SaveWhere } | null) => void) {
  const box = document.createElement('div');
  box.className = 'ds-modal';
  const card = document.createElement('div');
  card.className = 'ds-dialog ds-save';
  card.innerHTML = `<h3>Save</h3>
    <label class="ds-save-name"><span>Name</span><input spellcheck="false"></label>
    <div class="ds-save-where"></div>
    <p class="ds-note ds-save-note"></p>
    <div class="ds-dialog-foot"><button class="btn sm ghost" data-k="cancel">Cancel</button><button class="btn sm primary" data-k="ok">Save</button></div>`;
  box.appendChild(card);
  host.appendChild(box);
  const input = card.querySelector('input') as HTMLInputElement;
  input.value = ask.name;
  const list = card.querySelector('.ds-save-where') as HTMLElement;
  const note = card.querySelector('.ds-save-note') as HTMLElement;
  const ok = card.querySelector('[data-k="ok"]') as HTMLButtonElement;
  let where: SaveWhere = ask.where === 'footprint' && !ask.shapes ? 'parts' : ask.where;

  const what = ask.selected ? `the ${ask.shapes} selected shape${ask.shapes === 1 ? '' : 's'}` : `all ${ask.shapes} shape${ask.shapes === 1 ? '' : 's'}`;
  const options: { k: SaveWhere; icon: string; title: string; sub: string; off?: string }[] = [
    { k: 'parts', icon: '<path d="M4 7l8-4 8 4-8 4z"/><path d="M4 7v10l8 4 8-4V7"/><path d="M12 11v10"/>', title: 'My parts', sub: 'On the printer, in the Library. Send to Prepare and SnorbCAM find it there.' },
    { k: 'footprint', icon: '<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2"/><circle cx="8.5" cy="8.5" r="1.6"/><circle cx="15.5" cy="8.5" r="1.6"/><circle cx="8.5" cy="15.5" r="1.6"/><circle cx="15.5" cy="15.5" r="1.6"/>',
      title: 'Footprints', sub: `Just ${what}, to drop on other parts from Library › Footprints.`,
      off: ask.shapes ? undefined : 'Draw some holes or shapes first: a footprint is a group of them.' },
    { k: 'file', icon: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M12 11v6M9 14l3 3 3-3"/>', title: 'A file on this computer',
      sub: ask.picker ? 'Pick any folder: the Desktop, a backup drive… Open it again with Library › Open a file…' : 'A .snorbcad file, saved where your browser saves downloads. Open it again with Library › Open a file…' },
  ];
  const render = () => {
    list.replaceChildren(...options.map((o) => {
      const b = document.createElement('button');
      b.className = `ds-save-opt${o.k === where ? ' active' : ''}`;
      b.disabled = !!o.off;
      b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">${o.icon}</svg><span><b></b><i></i></span>`;
      b.querySelector('b')!.textContent = o.title;
      b.querySelector('i')!.textContent = o.off || o.sub;
      b.onclick = () => { where = o.k; render(); input.focus(); };
      b.ondblclick = () => { where = o.k; finish(true); };
      return b;
    }));
    note.textContent = where === 'file' && !ask.picker
      ? 'Tip: to choose the folder every time (the Desktop, say), turn on Chrome › Settings › Downloads › “Ask where to save each file before downloading”.'
      : where === 'footprint' ? 'Footprints keep their sizes and depths, measured from the face they were drawn on.' : '';
    note.hidden = !note.textContent;
    ok.textContent = where === 'file' ? (ask.picker ? 'Save…' : 'Download') : 'Save';
  };
  render();

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(false); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); finish(true); }
  };
  window.addEventListener('keydown', onKey, true);
  input.addEventListener('keydown', (e) => e.stopPropagation());
  (card.querySelector('[data-k="cancel"]') as HTMLButtonElement).onclick = () => finish(false);
  ok.onclick = () => finish(true);
  box.addEventListener('pointerdown', (e) => { if (e.target === box) finish(false); });
  input.focus();
  input.select();

  function finish(go: boolean) {
    const name = input.value.trim().replace(/[\\/]/g, '-');
    if (go && !name) { input.focus(); return; }
    box.remove();
    window.removeEventListener('keydown', onKey, true);
    if (go && where !== 'footprint') { try { localStorage.setItem(WHERE_KEY, where); } catch { /* fine */ } }
    done(go ? { name, where } : null);
  }
}
