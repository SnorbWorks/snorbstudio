// Named sizes: `wall = 2`, `m3 = 3.4`, `lid = wall*2 + 0.4`. Any size box takes
// a number, a name or a sum; the main boxes remember their formula, so
// changing `wall` changes every shape that used it. Values are in the part's
// units (what the boxes show); nothing here touches the DOM.
import type { Feature, Project } from './model.js';
import { VIEWS, axisOf } from './views.js';

export interface NamedSize { name: string; expr: string }

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const validName = (s: string) => NAME.test(s) && !['pi'].includes(s.toLowerCase());

/** Work out a sum: numbers, names, + - * / ( ), and pi. Throws with a plain message. */
export function evalExpr(src: string, vars: Record<string, number>): number {
  const t = src.match(/\d*\.\d+|\d+\.?|[A-Za-z_][A-Za-z0-9_]*|[-+*/()]|\S/g) || [];
  let i = 0;
  const peek = () => t[i];
  const expr = (): number => {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = t[i++]; const r = term(); v = op === '+' ? v + r : v - r; }
    return v;
  };
  const term = (): number => {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = t[i++]; const r = factor();
      if (op === '/' && r === 0) throw new Error('divides by 0');
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const factor = (): number => {
    const k = t[i++];
    if (k === undefined) throw new Error('unfinished');
    if (k === '-') return -factor();
    if (k === '+') return factor();
    if (k === '(') { const v = expr(); if (t[i++] !== ')') throw new Error('a ( without its )'); return v; }
    if (/^\d|^\./.test(k)) return parseFloat(k);
    if (NAME.test(k)) {
      if (k.toLowerCase() === 'pi') return Math.PI;
      if (!(k in vars)) throw new Error(`no size called “${k}”`);
      return vars[k];
    }
    throw new Error(`“${k}” isn't part of a sum`);
  };
  const v = expr();
  if (i < t.length) throw new Error(`“${t[i]}” is left over`);
  if (!Number.isFinite(v)) throw new Error('not a number');
  return v;
}

/** Every named size's value, in order (a size can use the ones above it). Bad ones are left out. */
export function sizeValues(p: Project): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of p.sizes || []) {
    try { out[s.name] = evalExpr(s.expr, out); } catch { /* shown as an error by the panel */ }
  }
  return out;
}

/** Is this text a formula (not just a plain number)? */
export const isFormula = (s: string) => !/^\s*[-+]?(\d+\.?\d*|\.\d+)\s*$/.test(s);

// ------------------------------------------------------------ bound boxes
// A box that remembers its formula is "bound" to one property. The value is
// in the part's units; these write it (as mm) into the project.

type Setter = (p: Project, f: Feature | null, mm: number) => void;

const featSign = (f: Feature, which: 'u' | 'v') => axisOf(which === 'u' ? VIEWS[f.view].uDir : VIEWS[f.view].vDir)[1];

export const BINDS: Record<string, Setter> = {
  w: (_p, f, v) => { if (f) f.w = Math.max(0, v); },
  h: (_p, f, v) => { if (f) f.h = Math.max(0, v); },
  dia: (_p, f, v) => { if (f) f.r = Math.max(0, v / 2); },
  corner: (_p, f, v) => { if (f) { f.corner = Math.max(0, v); delete f.corners; } },
  cu: (_p, f, v) => { if (f) f.cu = featSign(f, 'u') * v; },
  cv: (_p, f, v) => { if (f) f.cv = featSign(f, 'v') * v; },
  depth: (_p, f, v) => { if (f) { const dir = f.d1 >= f.d0 ? 1 : -1; f.d1 = f.d0 + dir * Math.max(0, v); } },
  'stock.x': (p, _f, v) => { const s = p.stock; const c = (s.min[0] + s.max[0]) / 2; s.min[0] = c - v / 2; s.max[0] = c + v / 2; },
  'stock.y': (p, _f, v) => { const s = p.stock; const c = (s.min[1] + s.max[1]) / 2; s.min[1] = c - v / 2; s.max[1] = c + v / 2; },
  'stock.dia': (p, _f, v) => { const s = p.stock; for (const i of [0, 1]) { const c = (s.min[i] + s.max[i]) / 2; s.min[i] = c - v / 2; s.max[i] = c + v / 2; } },
  'stock.z': (p, _f, v) => { p.stock.max[2] = p.stock.min[2] + Math.max(0.1, v); },
  'shell.wall': (p, _f, v) => { if (p.shell) p.shell.wall = Math.max(0.2, v); },
};

/**
 * Put every remembered formula's value back into the project (after a named
 * size changed). toMM turns the part's units into mm. Returns the boxes whose
 * formula no longer works (a size was renamed or removed).
 */
export function applyFormulas(p: Project, toMM: (v: number) => number): string[] {
  const vars = sizeValues(p);
  const broken: string[] = [];
  const run = (exprs: Record<string, string> | undefined, f: Feature | null, owner: string) => {
    for (const [k, e] of Object.entries(exprs || {})) {
      const set = BINDS[k];
      if (!set) continue;
      try { set(p, f, +toMM(evalExpr(e, vars)).toFixed(9)); } catch { broken.push(`${owner} ${k}`); }
    }
  };
  run(p.exprs, null, 'body');
  for (const f of p.features) run(f.exprs, f, f.id);
  return broken;
}
