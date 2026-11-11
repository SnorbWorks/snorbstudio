// SnorbCAM imports: outlines from an SVG (Illustrator, Inkscape...), a DXF,
// or a SnorbCAD part. Everything comes out as mm, Y up, curves flattened to
// short straight lines (fine enough for a router: 0.02 mm off the curve).
import { Contour, P2, Part, camId, guessOps, newOp, signedArea } from './job.js';
import { Feature, Project, applyOps, depthRange, fitOf, instances, isShape, profile } from '../model.js';
import { VIEWS } from '../views.js';

const TOL = 0.02;

// ------------------------------------------------------------ SVG

type M = [number, number, number, number, number, number]; // a b c d e f
const I: M = [1, 0, 0, 1, 0, 0];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const app = (m: M, [x, y]: P2): P2 => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function parseTransform(s: string | undefined): M {
  let m = I;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(s))) {
    const a = (r[2].match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) || []).map(Number);
    let n: M = I;
    switch (r[1]) {
      case 'matrix': n = [a[0], a[1], a[2], a[3], a[4], a[5]]; break;
      case 'translate': n = [1, 0, 0, 1, a[0] || 0, a[1] || 0]; break;
      case 'scale': n = [a[0], 0, 0, a[1] ?? a[0], 0, 0]; break;
      case 'rotate': {
        const t = ((a[0] || 0) * Math.PI) / 180, c = Math.cos(t), sn = Math.sin(t);
        n = [c, sn, -sn, c, 0, 0];
        if (a.length > 2) n = mul(mul([1, 0, 0, 1, a[1], a[2]], n), [1, 0, 0, 1, -a[1], -a[2]]);
        break;
      }
      case 'skewX': n = [1, 0, Math.tan(((a[0] || 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': n = [1, Math.tan(((a[0] || 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, n);
  }
  return m;
}

interface El { tag: string; attr: Record<string, string>; kids: El[] }

/** A small XML reader: enough for SVG files (no DTDs, entities beyond the basic five). */
function parseXml(src: string): El {
  const root: El = { tag: '#root', attr: {}, kids: [] };
  const stack = [root];
  src = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?(\[[\s\S]*?\])?>/gi, '');
  const re = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(src))) {
    const [, close, tag, attrs, self] = r;
    if (close) { while (stack.length > 1 && stack.pop()!.tag !== tag) { /* unwind */ } continue; }
    const attr: Record<string, string> = {};
    const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    while ((a = ar.exec(attrs))) attr[a[1]] = (a[2] ?? a[3]).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const el: El = { tag: tag.replace(/^svg:/, ''), attr, kids: [] };
    stack[stack.length - 1].kids.push(el);
    if (!self) stack.push(el);
  }
  return root;
}

/** Length in user units → mm, from an SVG length with units. */
function lengthMm(v: string | undefined, pxPerIn: number): number | null {
  if (!v) return null;
  const m = /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*(mm|cm|in|pt|pc|px)?\s*$/i.exec(v);
  if (!m) return null;
  const n = +m[1];
  switch ((m[2] || 'px').toLowerCase()) {
    case 'mm': return n;
    case 'cm': return n * 10;
    case 'in': return n * 25.4;
    case 'pt': return (n * 25.4) / 72;
    case 'pc': return (n * 25.4) / 6;
    default: return (n * 25.4) / pxPerIn;
  }
}

function flatQuad(p0: P2, p1: P2, p2: P2, out: P2[]) {
  const d = Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]);
  const n = Math.max(1, Math.min(200, Math.ceil(Math.sqrt(d / (4 * TOL)))));
  for (let k = 1; k <= n; k++) {
    const t = k / n, u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
}

function flatCubic(p0: P2, p1: P2, p2: P2, p3: P2, out: P2[]) {
  const d = Math.max(
    Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]),
    Math.hypot(p1[0] - 2 * p2[0] + p3[0], p1[1] - 2 * p2[1] + p3[1]),
  );
  const n = Math.max(1, Math.min(300, Math.ceil(Math.sqrt((3 * d) / (4 * TOL)))));
  for (let k = 1; k <= n; k++) {
    const t = k / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1]]);
  }
}

/** An elliptical arc (SVG endpoint form) as points after p0. */
function flatArc(p0: P2, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, p1: P2, out: P2[], scale: number) {
  if (rx === 0 || ry === 0) { out.push(p1); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180, c = Math.cos(phi), s = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1 = c * dx + s * dy, y1 = -s * dx + c * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  let k = Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  if (large === sweep) k = -k;
  const cx1 = (k * rx * y1) / ry, cy1 = (-k * ry * x1) / rx;
  const cx = c * cx1 - s * cy1 + (p0[0] + p1[0]) / 2, cy = s * cx1 + c * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const R = Math.max(rx, ry) * scale;
  const step = 2 * Math.acos(Math.max(-1, 1 - TOL / Math.max(R, TOL)));
  const n = Math.max(2, Math.min(720, Math.ceil(Math.abs(dt) / step)));
  for (let i = 1; i <= n; i++) {
    const t = t1 + (dt * i) / n;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    out.push(i === n ? p1 : [c * ex - s * ey + cx, s * ex + c * ey + cy]);
  }
}

/** An SVG path's d as subpaths of points (user units). */
export function pathPoints(d: string, scale = 1): { pts: P2[]; closed: boolean }[] {
  const tok = d.match(/[a-df-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) || [];
  const out: { pts: P2[]; closed: boolean }[] = [];
  let i = 0, cmd = '', cur: P2 = [0, 0], start: P2 = [0, 0];
  let pts: P2[] | null = null;
  let lastC: P2 | null = null, lastQ: P2 | null = null;
  const num = () => +tok[i++];
  const isNum = () => i < tok.length && !/^[a-z]$/i.test(tok[i]);
  const flush = (closed: boolean) => { if (pts && pts.length > 1) out.push({ pts, closed }); pts = null; };
  while (i < tok.length) {
    if (/^[a-z]$/i.test(tok[i])) cmd = tok[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const pt = (): P2 => { const x = num(), y = num(); return rel ? [cur[0] + x, cur[1] + y] : [x, y]; };
    if (C === 'Z') {
      if (pts) {
        const f = pts[0], l = pts[pts.length - 1];
        if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-9) pts.pop();
        flush(true);
      }
      cur = start; lastC = lastQ = null;
      continue;
    }
    if (!isNum()) continue;
    if (C === 'M') {
      flush(false);
      cur = pt(); start = cur; pts = [cur];
      cmd = rel ? 'l' : 'L';
      lastC = lastQ = null;
      continue;
    }
    if (!pts) pts = [cur];
    if (C === 'L') { cur = pt(); pts.push(cur); lastC = lastQ = null; }
    else if (C === 'H') { const x = num(); cur = [rel ? cur[0] + x : x, cur[1]]; pts.push(cur); lastC = lastQ = null; }
    else if (C === 'V') { const y = num(); cur = [cur[0], rel ? cur[1] + y : y]; pts.push(cur); lastC = lastQ = null; }
    else if (C === 'C') { const a = pt(), b = pt(), e = pt(); flatCubic(cur, a, b, e, pts); lastC = b; lastQ = null; cur = e; }
    else if (C === 'S') {
      const a: P2 = lastC ? [2 * cur[0] - lastC[0], 2 * cur[1] - lastC[1]] : cur;
      const b = pt(), e = pt(); flatCubic(cur, a, b, e, pts); lastC = b; lastQ = null; cur = e;
    } else if (C === 'Q') { const a = pt(), e = pt(); flatQuad(cur, a, e, pts); lastQ = a; lastC = null; cur = e; }
    else if (C === 'T') {
      const a: P2 = lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : cur;
      const e = pt(); flatQuad(cur, a, e, pts); lastQ = a; lastC = null; cur = e;
    } else if (C === 'A') {
      const rx = num(), ry = num(), rot = num(), la = num(), sw = num();
      const e = pt(); flatArc(cur, rx, ry, rot, !!la, !!sw, e, pts, scale); cur = e; lastC = lastQ = null;
    } else i++;
  }
  flush(false);
  return out;
}

function ellipsePts(cx: number, cy: number, rx: number, ry: number, scale: number): P2[] {
  const R = Math.max(rx, ry) * scale;
  const n = Math.max(12, Math.min(720, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - TOL / Math.max(R, TOL))))));
  return Array.from({ length: n }, (_, k) => [cx + rx * Math.cos((2 * Math.PI * k) / n), cy + ry * Math.sin((2 * Math.PI * k) / n)] as P2);
}

function rectPts(a: Record<string, string>, scale: number): { pts: P2[]; closed: boolean }[] {
  const x = +(a.x || 0), y = +(a.y || 0), w = +(a.width || 0), h = +(a.height || 0);
  let rx = a.rx !== undefined ? +a.rx : a.ry !== undefined ? +a.ry : 0;
  let ry = a.ry !== undefined ? +a.ry : rx;
  rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
  if (!(w > 0 && h > 0)) return [];
  if (rx <= 0 || ry <= 0) return [{ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }];
  const d = `M${x + rx},${y} H${x + w - rx} A${rx},${ry} 0 0 1 ${x + w},${y + ry} V${y + h - ry} A${rx},${ry} 0 0 1 ${x + w - rx},${y + h} H${x + rx} A${rx},${ry} 0 0 1 ${x},${y + h - ry} V${y + ry} A${rx},${ry} 0 0 1 ${x + rx},${y} Z`;
  return pathPoints(d, scale);
}

/** Outlines from an SVG file, in mm with Y up. Illustrator's px are 1/72", everyone else's 1/96". */
export function importSvg(src: string, name = 'svg'): Part {
  const root = parseXml(src);
  const svg = findTag(root, 'svg');
  if (!svg) throw new Error('not an SVG file');
  const ai = /Illustrator/i.test(src.slice(0, 2000));
  const pxPerIn = ai ? 72 : 96;
  const vb = (svg.attr.viewBox || '').split(/[\s,]+/).map(Number);
  let m: M = [25.4 / pxPerIn, 0, 0, 25.4 / pxPerIn, 0, 0];
  const wmm = lengthMm(svg.attr.width, pxPerIn), hmm = lengthMm(svg.attr.height, pxPerIn);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    const sx = wmm ? wmm / vb[2] : 25.4 / pxPerIn, sy = hmm ? hmm / vb[3] : sx;
    m = [sx, 0, 0, sy, -vb[0] * sx, -vb[1] * sy];
  }
  const lines: { pts: P2[]; closed: boolean }[] = [];
  const walk = (el: El, t: M) => {
    if (['defs', 'clipPath', 'mask', 'symbol', 'marker', 'pattern', 'title', 'desc', 'metadata', 'style', 'text'].includes(el.tag)) return;
    if (el.attr.display === 'none' || /display\s*:\s*none/.test(el.attr.style || '')) return;
    const mt = mul(t, parseTransform(el.attr.transform));
    const scale = Math.sqrt(Math.abs(mt[0] * mt[3] - mt[1] * mt[2]));
    const a = el.attr;
    let got: { pts: P2[]; closed: boolean }[] = [];
    switch (el.tag) {
      case 'path': got = pathPoints(a.d || '', scale); break;
      case 'rect': got = rectPts(a, scale); break;
      case 'circle': if (+a.r > 0) got = [{ pts: ellipsePts(+(a.cx || 0), +(a.cy || 0), +a.r, +a.r, scale), closed: true }]; break;
      case 'ellipse': if (+a.rx > 0 && +a.ry > 0) got = [{ pts: ellipsePts(+(a.cx || 0), +(a.cy || 0), +a.rx, +a.ry, scale), closed: true }]; break;
      case 'line': got = [{ pts: [[+(a.x1 || 0), +(a.y1 || 0)], [+(a.x2 || 0), +(a.y2 || 0)]], closed: false }]; break;
      case 'polyline': case 'polygon': {
        const n = (a.points || '').match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi)?.map(Number) || [];
        const pts: P2[] = [];
        for (let k = 0; k + 1 < n.length; k += 2) pts.push([n[k], n[k + 1]]);
        if (pts.length > 1) got = [{ pts, closed: el.tag === 'polygon' }];
        break;
      }
    }
    for (const g of got) lines.push({ pts: g.pts.map((p) => app(mt, p)), closed: g.closed });
    for (const k of el.kids) walk(k, mt);
  };
  for (const k of svg.kids) walk(k, m);
  // SVG runs Y down: flip
  const flipped = lines.map((l) => ({ pts: l.pts.map(([x, y]) => [x, -y] as P2), closed: l.closed }));
  return makePart(name, 'svg', joinOpen(flipped));
}

function findTag(el: El, tag: string): El | null {
  if (el.tag === tag) return el;
  for (const k of el.kids) { const f = findTag(k, tag); if (f) return f; }
  return null;
}

// ------------------------------------------------------------ DXF

const DXF_UNITS: Record<number, number> = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 0: 1 };

/** Outlines from a DXF (R12 and later): lines, polylines with arcs, arcs, circles, ellipses, splines. */
export function importDxf(src: string, name = 'dxf', unitsIfUnset: 'mm' | 'in' = 'mm'): Part {
  const raw = src.split(/\r?\n/);
  const pairs: [number, string][] = [];
  for (let k = 0; k + 1 < raw.length; k += 2) pairs.push([parseInt(raw[k].trim(), 10), raw[k + 1].trim()]);
  let unit = unitsIfUnset === 'in' ? 25.4 : 1;
  for (let k = 0; k < pairs.length; k++) {
    if (pairs[k][0] === 9 && pairs[k][1] === '$INSUNITS') {
      const v = +pairs[k + 1]?.[1];
      if (v in DXF_UNITS && v !== 0) unit = DXF_UNITS[v];
    }
  }
  // the ENTITIES section (blocks are not expanded)
  let at = pairs.findIndex((p, k) => p[0] === 2 && p[1] === 'ENTITIES' && pairs[k - 1]?.[1] === 'SECTION');
  if (at < 0) at = 0;
  const ents: { type: string; g: [number, string][] }[] = [];
  for (let k = at + 1; k < pairs.length; k++) {
    const [c, v] = pairs[k];
    if (c === 0) {
      if (v === 'ENDSEC' || v === 'EOF') break;
      ents.push({ type: v, g: [] });
    } else ents[ents.length - 1]?.g.push([c, v]);
  }
  const lines: { pts: P2[]; closed: boolean }[] = [];
  const all = (g: [number, string][], c: number) => g.filter((p) => p[0] === c).map((p) => +p[1]);
  const one = (g: [number, string][], c: number, d = 0) => { const p = g.find((q) => q[0] === c); return p ? +p[1] : d; };
  for (let k = 0; k < ents.length; k++) {
    const { type, g } = ents[k];
    if (type === 'LINE') lines.push({ pts: [[one(g, 10), one(g, 20)], [one(g, 11), one(g, 21)]], closed: false });
    else if (type === 'CIRCLE') lines.push({ pts: ellipsePts(one(g, 10), one(g, 20), one(g, 40), one(g, 40), unit), closed: true });
    else if (type === 'ARC') {
      const cx = one(g, 10), cy = one(g, 20), r = one(g, 40);
      let a0 = one(g, 50), a1 = one(g, 51);
      if (a1 <= a0) a1 += 360;
      lines.push({ pts: arcPts(cx, cy, r, a0, a1, unit), closed: false });
    } else if (type === 'LWPOLYLINE') {
      const xs = all(g, 10), ys = all(g, 20);
      const bul: number[] = [];
      // bulges (42) belong to the vertex before them
      let vi = -1;
      for (const [c, v] of g) { if (c === 10) { vi++; bul[vi] = 0; } else if (c === 42 && vi >= 0) bul[vi] = +v; }
      const closed = (one(g, 70) & 1) === 1;
      lines.push(bulgePoly(xs.map((x, i) => [x, ys[i]] as P2), bul, closed, unit));
    } else if (type === 'POLYLINE') {
      const closed = (one(g, 70) & 1) === 1;
      const vs: P2[] = [], bul: number[] = [];
      while (ents[k + 1]?.type === 'VERTEX') { k++; vs.push([one(ents[k].g, 10), one(ents[k].g, 20)]); bul.push(one(ents[k].g, 42)); }
      if (ents[k + 1]?.type === 'SEQEND') k++;
      lines.push(bulgePoly(vs, bul, closed, unit));
    } else if (type === 'ELLIPSE') {
      const cx = one(g, 10), cy = one(g, 20), mx = one(g, 11), my = one(g, 21), ratio = one(g, 40, 1);
      let t0 = one(g, 41, 0), t1 = one(g, 42, 2 * Math.PI);
      if (t1 <= t0) t1 += 2 * Math.PI;
      const a = Math.hypot(mx, my), rot = Math.atan2(my, mx), b = a * ratio;
      const full = Math.abs(t1 - t0 - 2 * Math.PI) < 1e-6;
      const n = Math.max(16, Math.ceil(((t1 - t0) / (2 * Math.PI)) * 180));
      const pts: P2[] = [];
      for (let i = 0; i <= (full ? n - 1 : n); i++) {
        const t = t0 + ((t1 - t0) * i) / n, ex = a * Math.cos(t), ey = b * Math.sin(t);
        pts.push([cx + ex * Math.cos(rot) - ey * Math.sin(rot), cy + ex * Math.sin(rot) + ey * Math.cos(rot)]);
      }
      lines.push({ pts, closed: full });
    } else if (type === 'SPLINE') {
      const deg = one(g, 71, 3), closed = (one(g, 70) & 1) === 1;
      const knots = all(g, 40), cx = all(g, 10), cy = all(g, 20), w = all(g, 41);
      const fx = all(g, 11), fy = all(g, 21);
      if (cx.length > deg && knots.length === cx.length + deg + 1) {
        lines.push({ pts: bspline(deg, cx.map((x, i) => [x, cy[i]] as P2), knots, w.length === cx.length ? w : null), closed });
      } else if (fx.length > 1) lines.push({ pts: fx.map((x, i) => [x, fy[i]] as P2), closed });
    }
  }
  const mm = lines.map((l) => ({ pts: l.pts.map(([x, y]) => [x * unit, y * unit] as P2), closed: l.closed }))
    .map((l) => (l.closed && l.pts.length > 2 && same(l.pts[0], l.pts[l.pts.length - 1]) ? { pts: l.pts.slice(0, -1), closed: true } : l));
  return makePart(name, 'dxf', joinOpen(mm));
}

function arcPts(cx: number, cy: number, r: number, a0: number, a1: number, scale: number): P2[] {
  const R = r * scale;
  const step = 2 * Math.acos(Math.max(-1, 1 - TOL / Math.max(R, TOL)));
  const sweep = ((a1 - a0) * Math.PI) / 180;
  const n = Math.max(2, Math.min(720, Math.ceil(sweep / step)));
  return Array.from({ length: n + 1 }, (_, i) => { const t = (a0 * Math.PI) / 180 + (sweep * i) / n; return [cx + r * Math.cos(t), cy + r * Math.sin(t)] as P2; });
}

/** A polyline whose sides may bulge into arcs (DXF bulge = tan(sweep/4), positive anticlockwise). */
function bulgePoly(vs: P2[], bul: number[], closed: boolean, scale: number): { pts: P2[]; closed: boolean } {
  const pts: P2[] = [];
  const n = vs.length;
  for (let i = 0; i < n; i++) {
    pts.push(vs[i]);
    if (i === n - 1 && !closed) break;
    const b = bul[i] || 0;
    if (Math.abs(b) < 1e-9) continue;
    const a = vs[i], e = vs[(i + 1) % n];
    const sweep = 4 * Math.atan(b);
    const L = Math.hypot(e[0] - a[0], e[1] - a[1]);
    if (L < 1e-12) continue;
    const r = L / (2 * Math.sin(Math.abs(sweep) / 2));
    // centre: from the chord's middle, along its left normal (for b > 0)
    const mx = (a[0] + e[0]) / 2, my = (a[1] + e[1]) / 2;
    const h = r * Math.cos(Math.abs(sweep) / 2) * (Math.abs(sweep) > Math.PI ? -1 : 1);
    const nx = -(e[1] - a[1]) / L, ny = (e[0] - a[0]) / L;
    const sgn = b > 0 ? 1 : -1;
    const cx = mx + nx * h * sgn, cy = my + ny * h * sgn;
    const t0 = Math.atan2(a[1] - cy, a[0] - cx);
    const step = 2 * Math.acos(Math.max(-1, 1 - TOL / Math.max(r * scale, TOL)));
    const k = Math.max(2, Math.min(720, Math.ceil(Math.abs(sweep) / step)));
    for (let j = 1; j < k; j++) { const t = t0 + (sweep * j) / k; pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  }
  return { pts, closed };
}

function bspline(p: number, ctrl: P2[], U: number[], w: number[] | null): P2[] {
  const n = ctrl.length - 1;
  const lo = U[p], hi = U[n + 1];
  const N = Math.max(16, ctrl.length * 12);
  const out: P2[] = [];
  for (let s = 0; s <= N; s++) {
    const u = s === N ? hi - 1e-9 * (hi - lo) : lo + ((hi - lo) * s) / N;
    let k = p;
    while (k < n && U[k + 1] <= u) k++;
    // de Boor, homogeneous coordinates
    const d = Array.from({ length: p + 1 }, (_, j) => {
      const c = ctrl[j + k - p], ww = w ? w[j + k - p] : 1;
      return [c[0] * ww, c[1] * ww, ww];
    });
    for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
      const i = j + k - p, den = U[i + p - r + 1] - U[i];
      const a = den === 0 ? 0 : (u - U[i]) / den;
      d[j] = [0, 1, 2].map((q) => (1 - a) * d[j - 1][q] + a * d[j][q]);
    }
    out.push([d[p][0] / d[p][2], d[p][1] / d[p][2]]);
  }
  return out;
}

// ------------------------------------------------------------ joining loose pieces

const same = (a: P2, b: P2, tol = 0.01) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;

/** Join open lines that meet end to end (DXFs come as separate lines and arcs); close any that come back to their start. */
export function joinOpen(lines: { pts: P2[]; closed: boolean }[], tol = 0.01): { pts: P2[]; closed: boolean }[] {
  const done = lines.filter((l) => l.closed);
  const open = lines.filter((l) => !l.closed && l.pts.length > 1).map((l) => [...l.pts]);
  while (open.length) {
    let cur = open.pop()!;
    let grew = true;
    while (grew) {
      grew = false;
      for (let k = 0; k < open.length; k++) {
        const o = open[k], a = cur[0], b = cur[cur.length - 1];
        if (same(b, o[0], tol)) cur = [...cur, ...o.slice(1)];
        else if (same(b, o[o.length - 1], tol)) cur = [...cur, ...[...o].reverse().slice(1)];
        else if (same(a, o[o.length - 1], tol)) cur = [...o, ...cur.slice(1)];
        else if (same(a, o[0], tol)) cur = [...[...o].reverse(), ...cur.slice(1)];
        else continue;
        open.splice(k, 1); grew = true; break;
      }
    }
    if (cur.length > 2 && same(cur[0], cur[cur.length - 1], tol)) done.push({ pts: cur.slice(0, -1), closed: true });
    else done.push({ pts: cur, closed: false });
  }
  return done;
}

function makePart(name: string, source: Part['source'], lines: { pts: P2[]; closed: boolean }[]): Part {
  const contours: Contour[] = lines
    .map((l) => ({ pts: dedupe(l.pts), closed: l.closed }))
    .filter((l) => l.pts.length > 1 && !(l.closed && Math.abs(signedArea(l.pts)) < 1e-6))
    .map((l) => ({ id: camId('k'), pts: l.pts, closed: l.closed, op: newOp('none', 0) }));
  if (!contours.length) throw new Error('no outlines found in the file');
  guessOps(contours, 19.05);
  return { id: camId('p'), name, source, contours };
}

function dedupe(pts: P2[]): P2[] {
  const out: P2[] = [];
  for (const p of pts) if (!out.length || !same(out[out.length - 1], p, 1e-4)) out.push(p);
  return out;
}

// ------------------------------------------------------------ SnorbCAD parts

/**
 * A SnorbCAD part as router cuts, seen from the top: the body's outline is
 * cut out, cuts drawn on the top go through (inside cuts) or to their depth
 * (pockets), counterbores become a pocket over the hole. Each cut's Z comes
 * from where it starts in the part, so stepped parts come out stepped. Shapes
 * drawn on other faces can't be cut from the top and are listed in notes.
 */
export function importCad(p: Project, name = p.name): { part: Part; notes: string[] } {
  const notes: string[] = [];
  const top = VIEWS.top;
  const zTop = p.stock.off ? Math.max(...p.features.filter((f) => f.op === 'add').map((f) => Math.max(f.d0, f.d1)), 0) : p.stock.max[2];
  const zBot = p.stock.min[2];
  const T = zTop - zBot;
  const contours: Contour[] = [];
  const push = (pts: P2[], kind: 'outside' | 'inside' | 'pocket', z0: number, depth: number, note: string) => {
    if (pts.length < 3) return;
    const op = newOp(kind, depth);
    op.z0 = z0;
    contours.push({ id: camId('k'), pts, closed: true, op, note });
  };
  if (!p.stock.off) {
    const [x0, y0] = [p.stock.min[0], p.stock.min[1]], [x1, y1] = [p.stock.max[0], p.stock.max[1]];
    push([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], 'outside', 0, T, 'body outline');
  }
  for (const f of p.features) {
    if (!isShape(f)) continue;
    if (f.type === 'text') { notes.push(`Text "${f.text?.s ?? ''}" isn't cut yet — export the view as a DXF for engraving`); continue; }
    if (f.view !== 'top' && f.view !== 'bottom') { notes.push(`${nameOf(f)} is drawn on the ${f.view} face — not cut (a router cuts from the top)`); continue; }
    if (f.view === 'bottom' || f.far) {
      if (f.op === 'cut' && f.through) { /* a through cut is the same from either side */ }
      else { notes.push(`${nameOf(f)} is on the bottom face — flip the part and cut it as a second job`); continue; }
    }
    const grow = fitOf(f, p);
    for (const ops of instances(f)) {
      let pts = outline(f, grow).map(([u, v]) => {
        const w = applyOps(VIEWS[f.view].toWorld(u, v, 0), ops);
        return [w[0], w[1]] as P2;
      });
      if (f.op === 'add') {
        if (p.stock.off) push(pts, 'outside', 0, T, nameOf(f));
        else notes.push(`${nameOf(f)} adds to the top — a router can't add material; cut the block from thicker stock and pocket around it`);
        continue;
      }
      const [lo, hi] = depthRange(f, p);
      // depth along the top view's eye (+Z); the bottom view looks the other way
      const zs = f.view === 'top' ? [lo, hi] : [-hi, -lo];
      const cutTop = Math.min(zTop, zs[1]), cutBot = Math.max(zBot, zs[0]);
      if (cutTop - cutBot <= 1e-6) continue;
      const through = cutBot <= zBot + 1e-6;
      let start = cutTop;
      if (f.type === 'hole' && f.hole && (f.hole.kind === 'cbore' || f.hole.kind === 'csk')) {
        const h = f.hole;
        const head = circle(applyOps(top.toWorld(f.cu, f.cv, 0), ops), (h.headD + grow) / 2);
        const hd = h.kind === 'cbore' ? h.headDepth : (h.headD - h.d) / 2;
        push(head, 'pocket', cutTop - zTop, hd, `${nameOf(f)} (head)`);
        start = cutTop - hd;
        if (h.kind === 'csk') notes.push(`${nameOf(f)}: the countersink is cut as a flat counterbore — use a V-bit for a true cone`);
      }
      if (f.type === 'hole' && f.hole?.kind === 'nut') notes.push(`${nameOf(f)}: the nut trap is on the bottom — not cut`);
      if (f.view === 'bottom') pts = [...pts].reverse();
      push(pts, through ? 'inside' : 'pocket', start - zTop, start - cutBot, nameOf(f));
    }
  }
  const all = contours.flatMap((c) => c.pts);
  if (!all.length) throw new Error('nothing in this part can be cut from the top');
  return { part: { id: camId('p'), name, source: 'cad', contours }, notes };
}

function outline(f: Feature, grow: number): P2[] {
  if (grow > 0 && (f.type === 'hole' || f.type === 'circle')) {
    const r = (f.type === 'hole' && f.hole ? f.hole.d / 2 : f.r) + grow / 2;
    return circleUV(f.cu, f.cv, r);
  }
  if (f.type === 'hole' && f.hole) return circleUV(f.cu, f.cv, f.hole.d / 2 + grow / 2);
  return profile(f, 96);
}

function circleUV(cu: number, cv: number, r: number): P2[] {
  const n = Math.max(24, Math.min(360, Math.ceil(Math.PI / Math.acos(1 - TOL / Math.max(r, TOL)))));
  return Array.from({ length: n }, (_, k) => [cu + r * Math.cos((2 * Math.PI * k) / n), cv + r * Math.sin((2 * Math.PI * k) / n)] as P2);
}

function circle(c: [number, number, number], r: number): P2[] { return circleUV(c[0], c[1], r); }

function nameOf(f: Feature): string {
  if (f.type === 'hole' && f.hole) return `${f.hole.size.replace('_', '.')} hole`;
  return ({ rect: 'Rectangle', circle: 'Circle', polygon: 'Polygon', poly: 'Outline', gear: 'Gear', text: 'Text', slot: 'Slot' } as Record<string, string>)[f.type] || f.type;
}
