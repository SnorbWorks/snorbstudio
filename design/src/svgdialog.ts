// Import an SVG: read the drawing's outlines (the browser measures every
// path, circle and rectangle), then ask which view it goes on, check the
// units the file claims, and confirm the size before anything is added.
import type { P2, Project, ViewName, Feature } from './model.js';
import { VIEWS, VIEW_ORDER } from './views.js';
import { svgSize, svgFeatures, splitSubpaths, nesting, UNIT_MM, UNIT_NAMES, type SvgSize } from './svgimport.js';

export interface SvgRead { loops: P2[][]; open: number; texts: number; size: SvgSize; name: string }

/** The closed outlines in an SVG file (drawing units, y down), and what was left out. */
export function readSvg(text: string, name: string): SvgRead {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) throw new Error("That file isn't an SVG drawing this can read.");
  const generator = Array.from(doc.childNodes).filter((n) => n.nodeType === 8).map((n) => n.textContent || '').join(' ') + ' ' + (root.getAttribute('xmlns:inkscape') ? 'inkscape' : '');
  const size = svgSize({ width: root.getAttribute('width'), height: root.getAttribute('height'), viewBox: root.getAttribute('viewBox'), generator });
  // measure it in the page: the drawing's own units, its transforms applied
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-10000px;top:0;width:10px;height:10px;overflow:hidden;visibility:hidden';
  const svg = document.importNode(root, true) as unknown as SVGSVGElement;
  svg.removeAttribute('viewBox'); svg.removeAttribute('width'); svg.removeAttribute('height');
  svg.removeAttribute('preserveAspectRatio');
  host.appendChild(svg);
  document.body.appendChild(host);
  try {
    const loops: P2[][] = [];
    let open = 0;
    // one path holding many outlines (a whole logo): measure each outline on its own, it's far quicker
    for (const el of Array.from(svg.querySelectorAll('path'))) {
      const parts = splitSubpaths(el.getAttribute('d') || '');
      if (parts.length < 2) continue;
      for (const d of parts) {
        const piece = el.cloneNode(false) as Element;
        piece.setAttribute('d', d);
        el.parentNode!.insertBefore(piece, el);
      }
      el.remove();
    }
    const els = Array.from(svg.querySelectorAll('path, rect, circle, ellipse, polygon, polyline, line')) as SVGGeometryElement[];
    // the overall size sets how finely to follow curves
    let diag = 0;
    for (const el of els) { try { const b = el.getBBox(); diag = Math.max(diag, Math.hypot(b.width, b.height)); } catch { /* not drawn */ } }
    const step = Math.max(diag / 4000, 1e-4);
    for (const el of els) {
      if (el.closest('defs, clipPath, mask, symbol, marker, pattern')) continue;
      let L = 0;
      try { L = el.getTotalLength(); } catch { continue; }
      if (!(L > 0)) continue;
      const m = el.getCTM();
      const n = Math.min(20000, Math.max(8, Math.ceil(L / step)));
      const at = (k: number): P2 => {
        let q: DOMPoint = el.getPointAtLength((L * k) / n);
        if (m) q = q.matrixTransform(m);
        return [q.x, q.y];
      };
      // a jump between samples is a pen lift (a new piece of the same path)
      const gap = (L / n) * 1.6 + 1e-9;
      let cur: P2[] = [at(0)];
      const flush = () => {
        if (cur.length >= 3) {
          const a = cur[0], b = cur[cur.length - 1];
          if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= gap * 2 || el.tagName === 'polygon' || el.tagName === 'rect' || el.tagName === 'circle' || el.tagName === 'ellipse') loops.push(cur);
          else open++;
        } else if (cur.length > 1) open++;
        cur = [];
      };
      const scaleCtm = m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1 : 1;
      for (let k = 1; k <= n; k++) {
        const q = at(k), last = cur[cur.length - 1];
        if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) > gap * scaleCtm) flush();
        cur.push(q);
      }
      flush();
    }
    const texts = svg.querySelectorAll('text').length;
    return { loops, open, texts, size, name };
  } finally { host.remove(); }
}

export interface SvgDialogOpts {
  read: SvgRead;
  p: Project;
  view: ViewName;                       // the view picked now (the default)
  add(features: Feature[], view: ViewName): void;
}

export function openSvgDialog(root: HTMLElement, o: SvgDialogOpts) {
  const { read, p } = o;
  const units = p.units;
  const toU = (mm: number) => (units === 'in' ? mm / 25.4 : mm);
  const fromU = (v: number) => (units === 'in' ? v * 25.4 : v);
  // drawing units per file unit: fixed by the file; what a file unit is can be changed
  const perUnit = read.size.mmPerUser / UNIT_MM[read.size.unit];
  let unit = read.size.unit;
  let scale = read.size.mmPerUser;      // mm per drawing unit, across
  let pctX = 1, pctY = 1;               // scaled from the file's own size (1 = as drawn)
  let lock = true;                      // width and height change together
  const sX = () => scale * pctX, sY = () => scale * pctY;
  let view: ViewName = o.view;
  let depth = 0, holes = true;
  const all = read.loops.flat();
  const xs = all.map((q) => q[0]), ys = all.map((q) => q[1]);
  const bw = all.length ? Math.max(...xs) - Math.min(...xs) : 0, bh = all.length ? Math.max(...ys) - Math.min(...ys) : 0;
  const nest = nesting(read.loops);
  const nHoles = nest.filter((d) => d % 2 === 1).length;

  const box = document.createElement('div');
  box.className = 'ds-modal';
  const card = document.createElement('div');
  card.className = 'ds-dialog ds-svg-dialog';
  box.appendChild(card);
  root.appendChild(box);

  // a small picture of what was found: shapes filled, holes white
  const pic = () => {
    if (!all.length) return '';
    const pad = Math.max(bw, bh) * 0.04;
    const vb = `${Math.min(...xs) - pad} ${Math.min(...ys) - pad} ${bw + 2 * pad} ${bh + 2 * pad}`;
    const d = read.loops.map((l) => `M${l.map((q) => `${q[0].toFixed(3)} ${q[1].toFixed(3)}`).join('L')}Z`).join('');
    return `<svg class="ds-svg-pic" viewBox="${vb}" preserveAspectRatio="xMidYMid meet"><path d="${d}" fill-rule="evenodd" vector-effect="non-scaling-stroke"/></svg>`;
  };
  const fmt = (mm: number) => +toU(mm).toFixed(units === 'in' ? 3 : 2);

  const render = () => {
    const unitOpts = Object.keys(UNIT_MM).map((k) => `<option value="${k}" ${k === unit ? 'selected' : ''}>${UNIT_NAMES[k]}</option>`).join('');
    const viewOpts = VIEW_ORDER.map((v) => `<option value="${v}" ${v === view ? 'selected' : ''}>${VIEWS[v].label}${p.views.includes(v) ? '' : ' (not shown yet)'}</option>`).join('');
    const skipped = [
      read.open ? `${read.open} open line${read.open > 1 ? 's' : ''} left out (only closed outlines make shapes)` : '',
      read.texts ? `${read.texts} text${read.texts > 1 ? 's' : ''} left out: turn text into paths (outlines) in your drawing program first` : '',
    ].filter(Boolean);
    card.innerHTML = `
      <h3>Import “${read.name.replace(/[<&]/g, '')}”</h3>
      ${pic()}
      <p class="ds-note">${read.loops.length} outline${read.loops.length === 1 ? '' : 's'}${nHoles ? `, ${nHoles} inside others (holes)` : ''}.${skipped.length ? ` ${skipped.join('. ')}.` : ''}</p>
      <div class="ds-field ds-field-wide"><span>Put it on the view</span><select class="ds-select" id="sv-view">${viewOpts}</select></div>
      <p class="ds-note ${read.size.stated ? '' : 'ds-warn'}">${read.size.why}</p>
      <div class="ds-field ds-field-wide"><span>Units in the file</span><select class="ds-select" id="sv-unit">${unitOpts}</select></div>
      <label class="ds-field"><span>Width</span><input type="number" step="any" min="0" id="sv-w" value="${fmt(bw * sX())}"><i>${units}</i></label>
      <label class="ds-field"><span>Height</span><input type="number" step="any" min="0" id="sv-h" value="${fmt(bh * sY())}"><i>${units}</i></label>
      ${lock
        ? `<label class="ds-field"><span>Scale</span><input type="number" step="any" min="0" id="sv-px" value="${+(pctX * 100).toFixed(3)}"><i>%</i></label>`
        : `<label class="ds-field"><span>Across</span><input type="number" step="any" min="0" id="sv-px" value="${+(pctX * 100).toFixed(3)}"><i>%</i></label>
           <label class="ds-field"><span>Up</span><input type="number" step="any" min="0" id="sv-py" value="${+(pctY * 100).toFixed(3)}"><i>%</i></label>`}
      <label class="ds-check"><input type="checkbox" id="sv-lock" ${lock ? 'checked' : ''}> Lock proportions</label>
      <p class="ds-note">${lock ? 'Is that the size you expect? Change the width, height or scale and the rest follow.' : 'Width and height change on their own: the drawing stretches.'} 100% is the size the file says.</p>
      <label class="ds-field"><span>Depth</span><input type="number" step="any" min="0" id="sv-d" value="${fmt(depth)}"><i>${units}</i></label>
      <p class="ds-note">0: flat sketches you give a depth later. More: shapes that tall, holes cut as deep.</p>
      <label class="ds-check"><input type="checkbox" id="sv-holes" ${holes ? 'checked' : ''}> Outlines inside others are holes</label>
      <div class="ds-dialog-foot">
        <button class="btn sm ghost" id="sv-cancel">Cancel</button>
        <button class="btn sm primary" id="sv-ok" ${read.loops.length ? '' : 'disabled'}>Import</button>
      </div>`;
    const q = <T extends HTMLElement>(s: string) => card.querySelector(s) as T;
    q<HTMLSelectElement>('#sv-view').onchange = (e) => { view = (e.target as HTMLSelectElement).value as ViewName; };
    q<HTMLSelectElement>('#sv-unit').onchange = (e) => { unit = (e.target as HTMLSelectElement).value; scale = perUnit * UNIT_MM[unit]; render(); };
    const sizeTo = (axis: 0 | 1, f: number) => {
      if (!(f > 0) || !Number.isFinite(f)) return;
      if (lock) pctX = pctY = f; else if (axis === 0) pctX = f; else pctY = f;
      render();
    };
    const numIn = (id: string, fn: (v: number) => void) => {
      const inp = q<HTMLInputElement>(id);
      if (!inp) return;
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      inp.onchange = () => { const v = parseFloat(inp.value); if (Number.isFinite(v)) fn(v); };
    };
    numIn('#sv-w', (v) => { if (bw > 0) sizeTo(0, fromU(v) / bw / scale); });
    numIn('#sv-h', (v) => { if (bh > 0) sizeTo(1, fromU(v) / bh / scale); });
    numIn('#sv-px', (v) => sizeTo(0, v / 100));
    numIn('#sv-py', (v) => sizeTo(1, v / 100));
    q<HTMLInputElement>('#sv-lock').onchange = (e) => { lock = (e.target as HTMLInputElement).checked; if (lock) pctY = pctX; render(); };
    const dIn = q<HTMLInputElement>('#sv-d');
    dIn.addEventListener('keydown', (e) => e.stopPropagation());
    dIn.onchange = () => { const v = fromU(parseFloat(dIn.value)); depth = v > 0 ? v : 0; };
    q<HTMLInputElement>('#sv-holes').onchange = (e) => { holes = (e.target as HTMLInputElement).checked; };
    q<HTMLButtonElement>('#sv-cancel').onclick = close;
    q<HTMLButtonElement>('#sv-ok').onclick = go;
  };
  const go = () => {
    // a number still being typed counts
    const d = fromU(parseFloat((card.querySelector('#sv-d') as HTMLInputElement).value));
    depth = d > 0 ? d : 0;
    const fs = svgFeatures(read.loops, p, { view, scale: sX(), scaleY: sY(), depth, holes });
    close();
    if (fs.length) o.add(fs, view);
  };
  const close = () => { box.remove(); window.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
  window.addEventListener('keydown', onKey, true);
  box.onclick = (e) => { if (e.target === box) close(); };
  render();
}
