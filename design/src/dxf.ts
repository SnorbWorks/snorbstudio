// DXF of one view: the lines the sheet draws, as a flat drawing for a laser,
// the router (SnorbCAM, VCarve, Fusion) or anyone's CAD. Plain R12 so every
// program reads it: polylines in mm, seen lines on layer OUTLINE, hidden
// lines (when asked for) dashed on layer HIDDEN.
import type { ViewEdges, Line } from './geometry.js';

const TOL = 0.001;

/** Join pieces that meet end to end, so an outline comes out as one closed polyline. */
export function joinLines(lines: Line[]): Line[] {
  const pend = lines.filter((l) => l.length >= 4).map((l) => l.slice());
  const out: Line[] = [];
  const same = (a: number[], i: number, b: number[], j: number) => Math.abs(a[i] - b[j]) < TOL && Math.abs(a[i + 1] - b[j + 1]) < TOL;
  const rev = (l: Line) => { const r: number[] = []; for (let i = l.length - 2; i >= 0; i -= 2) r.push(l[i], l[i + 1]); return r; };
  while (pend.length) {
    let cur = pend.pop()!;
    let grew = true;
    while (grew && !same(cur, 0, cur, cur.length - 2)) {
      grew = false;
      for (let k = 0; k < pend.length; k++) {
        const l = pend[k], e = cur.length - 2, le = l.length - 2;
        let add: Line | null = null, front = false;
        if (same(cur, e, l, 0)) add = l;
        else if (same(cur, e, l, le)) add = rev(l);
        else if (same(cur, 0, l, le)) { add = l; front = true; }
        else if (same(cur, 0, l, 0)) { add = rev(l); front = true; }
        if (!add) continue;
        cur = front ? [...add.slice(0, -2), ...cur] : [...cur, ...add.slice(2)];
        pend.splice(k, 1);
        grew = true;
        break;
      }
    }
    out.push(cur);
  }
  return out;
}

const num = (v: number) => (Math.abs(v) < 1e-9 ? 0 : +v.toFixed(5)).toString();

function polyline(l: Line, layer: string): string {
  const closed = l.length >= 8 && Math.abs(l[0] - l[l.length - 2]) < TOL && Math.abs(l[1] - l[l.length - 1]) < TOL;
  const pts = closed ? l.slice(0, -2) : l;
  let s = `0\nPOLYLINE\n8\n${layer}\n66\n1\n10\n0\n20\n0\n30\n0\n70\n${closed ? 1 : 0}\n`;
  for (let i = 0; i < pts.length; i += 2) s += `0\nVERTEX\n8\n${layer}\n10\n${num(pts[i])}\n20\n${num(pts[i + 1])}\n30\n0\n`;
  return s + `0\nSEQEND\n8\n${layer}\n`;
}

/** The DXF text for a view's lines (coordinates are the view's across/up, in mm). */
export function viewDxf(edges: ViewEdges, opts: { hidden?: boolean } = {}): string {
  const seen = joinLines(edges.visible);
  const hid = opts.hidden ? joinLines(edges.hidden) : [];
  const all = [...seen, ...hid].flat();
  const xs = all.filter((_, i) => i % 2 === 0), ys = all.filter((_, i) => i % 2 === 1);
  const lo = xs.length ? [Math.min(...xs), Math.min(...ys)] : [0, 0], hi = xs.length ? [Math.max(...xs), Math.max(...ys)] : [0, 0];
  const header = '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n9\n$INSUNITS\n70\n4\n'
    + `9\n$EXTMIN\n10\n${num(lo[0])}\n20\n${num(lo[1])}\n30\n0\n9\n$EXTMAX\n10\n${num(hi[0])}\n20\n${num(hi[1])}\n30\n0\n0\nENDSEC\n`;
  const ltype = (name: string, desc: string, parts: number[]) =>
    `0\nLTYPE\n2\n${name}\n70\n0\n3\n${desc}\n72\n65\n73\n${parts.length}\n40\n${num(parts.reduce((a, b) => a + Math.abs(b), 0))}\n`
    + parts.map((p) => `49\n${num(p)}\n`).join('');
  const layer = (name: string, color: number, lt: string) => `0\nLAYER\n2\n${name}\n70\n0\n62\n${color}\n6\n${lt}\n`;
  const tables = '0\nSECTION\n2\nTABLES\n'
    + '0\nTABLE\n2\nLTYPE\n70\n2\n' + ltype('CONTINUOUS', 'Solid line', []) + ltype('DASHED', '__ __ __', [3, -1.5]) + '0\nENDTAB\n'
    + '0\nTABLE\n2\nLAYER\n70\n2\n' + layer('OUTLINE', 7, 'CONTINUOUS') + layer('HIDDEN', 8, 'DASHED') + '0\nENDTAB\n'
    + '0\nENDSEC\n';
  const ents = '0\nSECTION\n2\nENTITIES\n' + seen.map((l) => polyline(l, 'OUTLINE')).join('') + hid.map((l) => polyline(l, 'HIDDEN')).join('') + '0\nENDSEC\n';
  return header + tables + ents + '0\nEOF\n';
}
