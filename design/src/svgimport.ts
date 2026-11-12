// SVG import, the parts that don't need a browser: what size the file says
// it is (and in what units), which outlines sit inside others (holes), and
// turning the outlines into shapes on a view. The sampling of the drawing
// itself happens in svgdialog.ts, where the browser can measure paths.
import type { Feature, P2, Project, ViewName } from './model.js';
import { newId, nearDepth } from './model.js';
import { VIEWS } from './views.js';

/** How long one of each unit is, in mm. px: CSS pixels, 96 to the inch. */
export const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, px72: 25.4 / 72 };
export const UNIT_NAMES: Record<string, string> = {
  mm: 'millimetres', cm: 'centimetres', in: 'inches', pt: 'points (72 to the inch)', pc: 'picas', px: 'pixels, 96 to the inch (Inkscape, browsers)', px72: 'pixels, 72 to the inch (Illustrator)',
};

export interface SvgSize {
  unit: string;           // the unit the file's sizes are in (a key of UNIT_MM)
  stated: boolean;        // true: width/height carry a real unit (mm, in…); false: a guess
  mmPerUser: number;      // one drawing unit (the numbers in the paths) in mm
  why: string;            // a sentence for the dialog
}

const lenRe = /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*([a-z%]*)\s*$/i;

/**
 * Work out the file's real size: width/height with a unit (100mm) win; else
 * pixels, 72 to the inch when Illustrator made it, 96 otherwise.
 */
export function svgSize(attrs: { width?: string | null; height?: string | null; viewBox?: string | null; generator?: string }): SvgSize {
  const vb = (attrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
  const vbW = vb.length === 4 && vb[2] > 0 ? vb[2] : null;
  const m = lenRe.exec(attrs.width || '');
  const illustrator = /illustrator/i.test(attrs.generator || '');
  const pxUnit = illustrator ? 'px72' : 'px';
  if (m && m[2] && m[2] !== 'px' && m[2] !== '%' && UNIT_MM[m[2].toLowerCase()]) {
    const unit = m[2].toLowerCase();
    const widthMm = parseFloat(m[1]) * UNIT_MM[unit];
    return { unit, stated: true, mmPerUser: vbW ? widthMm / vbW : UNIT_MM.px, why: `The file says its width is ${m[1]} ${unit}.` };
  }
  const why = illustrator
    ? 'The file gives no real units, only pixels. Illustrator made it, so 72 pixels to the inch.'
    : 'The file gives no real units, only pixels: read at 96 to the inch (Inkscape and browsers). Check the size below.';
  if (m && vbW && m[2] !== '%') return { unit: pxUnit, stated: false, mmPerUser: (parseFloat(m[1]) / vbW) * UNIT_MM[pxUnit], why };
  return { unit: pxUnit, stated: false, mmPerUser: UNIT_MM[pxUnit], why };
}

/** Is a point inside a closed outline? */
export function inside(pt: P2, poly: P2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** How many other outlines each one sits inside: even adds, odd is a hole. */
export function nesting(loops: P2[][]): number[] {
  return loops.map((l, i) => loops.reduce((n, o, j) => n + (j !== i && o.length > 2 && inside(l[0], o) ? 1 : 0), 0));
}

/** Fewer points, same shape: drop points within tol of the line through their neighbours (Ramer–Douglas–Peucker). */
export function simplify(pts: P2[], tol: number): P2[] {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    let far = -1, fd = tol;
    for (let k = a + 1; k < b; k++) {
      const [px, py] = pts[k];
      const d = L < 1e-12 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * px - dx * py + bx * ay - by * ax) / L;
      if (d > fd) { fd = d; far = k; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, k) => keep[k]);
}

/** Outline area (signed; + anticlockwise). */
export function area(poly: P2[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return s / 2;
}

export interface ImportOpts {
  view: ViewName;
  scale: number;          // mm per drawing unit
  depth: number;          // 0: flat sketches; more: shapes this tall (holes cut as deep)
  holes: boolean;         // outlines inside others cut (else everything adds)
}

/**
 * The outlines (drawing units, y down as SVG has it) as shapes on a view:
 * scaled to mm, flipped so up is up, centred on the part (or the origin),
 * standing on the view's near face. Specks under 0.05 mm² are dropped.
 */
export function svgFeatures(loops: P2[][], p: Project, o: ImportOpts): Feature[] {
  const mm = loops.map((l) => simplify(l.map(([x, y]) => [x * o.scale, -y * o.scale] as P2), 0.005))
    .map((l) => (l.length > 1 && Math.hypot(l[0][0] - l[l.length - 1][0], l[0][1] - l[l.length - 1][1]) < 1e-6 ? l.slice(0, -1) : l))
    .filter((l) => l.length >= 3 && Math.abs(area(l)) >= 0.05);
  if (!mm.length) return [];
  const xs = mm.flat().map((q) => q[0]), ys = mm.flat().map((q) => q[1]);
  const mid: P2 = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const depthOf = nesting(mm);
  const top = nearDepth(o.view, p);
  // centred on the body as seen in that view (the origin when there's none)
  const V = VIEWS[o.view], s = p.stock;
  const at = s.off || p.base ? [0, 0] : V.toView([(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2, (s.min[2] + s.max[2]) / 2]);
  const out = mm.map((l, i) => {
    const us = l.map((q) => q[0] - mid[0] + at[0]), vs = l.map((q) => q[1] - mid[1] + at[1]);
    const cu = (Math.min(...us) + Math.max(...us)) / 2, cv = (Math.min(...vs) + Math.max(...vs)) / 2;
    const hole = o.holes && depthOf[i] % 2 === 1;
    const f: Feature = {
      id: newId(), type: 'poly', view: o.view, cu: +cu.toFixed(4), cv: +cv.toFixed(4), w: 0, h: 0, r: 0, corner: 0,
      pts: l.map(([u, v]) => [+(u - mid[0] + at[0] - cu).toFixed(4), +(v - mid[1] + at[1] - cv).toFixed(4)] as P2),
      d0: top, d1: top, op: hole ? 'cut' : 'add', through: false,
    };
    if (o.depth > 0) {
      // an added shape stands up out of the face; a hole goes down through it as far
      if (hole) { f.d0 = top + o.depth; f.d1 = top; } else f.d1 = top + o.depth;
    }
    return f;
  });
  // what adds goes first, so the holes have something to cut
  return [...out.filter((f) => f.op === 'add'), ...out.filter((f) => f.op === 'cut')];
}
