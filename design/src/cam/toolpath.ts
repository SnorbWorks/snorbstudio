// SnorbCAM toolpaths: from a job (parts placed on a sheet, each outline with
// how it's cut) to moves of the bit, in mm on the sheet. Profiles are offset
// by the bit radius, pockets cleared by offset rings or back-and-forth rows,
// depth taken in passes (a first pass, equal middle passes, a finishing pass),
// tabs lift the bit over a strip of the outline on the deepest passes, and
// each pass ramps in along the path instead of plunging straight down.
import ClipperLib from 'clipper-lib';
import { Bit, Contour, Job, Op, P2, bitOf, pathLength, placer, pointAt, pointIn, signedArea } from './job.js';

const S = 1000; // clipper works in integers: µm

type IPath = { X: number; Y: number }[];
const toI = (pts: P2[]): IPath => pts.map(([x, y]) => ({ X: Math.round(x * S), Y: Math.round(y * S) }));
const fromI = (p: IPath): P2[] => p.map((q) => [q.X / S, q.Y / S] as P2);

/** Grow (d > 0) or shrink (d < 0) closed outlines, round corners. Holes in `paths` must run the other way round. */
export function offset(paths: P2[][], d: number): P2[][] {
  const co = new ClipperLib.ClipperOffset(2, 0.01 * S);
  co.AddPaths(paths.map(toI), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out: IPath[] = [];
  co.Execute(out, d * S);
  return out.map(fromI).filter((p) => p.length > 2);
}

/** a minus b (closed outlines). */
export function difference(a: P2[][], b: P2[][]): P2[][] {
  const c = new ClipperLib.Clipper();
  c.AddPaths(a.map(toI), ClipperLib.PolyType.ptSubject, true);
  if (b.length) c.AddPaths(b.map(toI), ClipperLib.PolyType.ptClip, true);
  const out: IPath[] = [];
  c.Execute(ClipperLib.ClipType.ctDifference, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out.map(fromI).filter((p) => p.length > 2);
}

/** Open lines clipped to a region (outer outlines anticlockwise, holes clockwise). */
function clipLines(lines: P2[][], region: P2[][]): P2[][] {
  const c = new ClipperLib.Clipper();
  c.AddPaths(lines.map(toI), ClipperLib.PolyType.ptSubject, false);
  c.AddPaths(region.map(toI), ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctIntersection, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return (ClipperLib.Clipper.OpenPathsFromPolyTree(tree) as IPath[]).map(fromI).filter((p) => p.length > 1);
}

const ccw = (p: P2[]) => (signedArea(p) >= 0 ? p : [...p].reverse());
const cw = (p: P2[]) => (signedArea(p) < 0 ? p : [...p].reverse());

/** Is a point inside a region (outlines with holes, even-odd)? */
function inRegion(p: P2, region: P2[][]): boolean {
  let n = 0;
  for (const r of region) if (pointIn(p, r)) n++;
  return n % 2 === 1;
}

// ------------------------------------------------------------ the pass plan

/** The Z of the bottom of each pass, top to bottom: first pass, equal middles, finishing pass. */
export function passLevels(op: Op, bit: Bit): number[] {
  const top = op.z0, total = Math.max(0, op.depth), bottom = top - total;
  if (total <= 1e-6) return [];
  const each = Math.max(0.05, bit.pass);
  const first = Math.min(total, Math.max(0.05, op.first ?? each));
  const finish = Math.min(Math.max(0, op.finish ?? 0), total - first);
  const out = [top - first];
  const middle = total - first - finish;
  if (middle > 1e-6) {
    const n = Math.ceil(middle / each - 1e-9);
    for (let k = 1; k <= n; k++) out.push(top - first - (middle * k) / n);
  }
  if (finish > 1e-6) out.push(bottom);
  out[out.length - 1] = bottom;
  return out;
}

// ------------------------------------------------------------ cuts

/** One loop or line the bit follows at one or more depths. */
export interface Track {
  pts: P2[];             // bit centre
  closed: boolean;
  tabs: [number, number][];  // stretches (distance along the track, from..to) where the bit stays up at tabZ
}

export interface Cut {
  key: string;           // placed id + contour id
  label: string;
  bit: Bit;
  op: Op;
  outer: boolean;        // an outside profile (cut last, so parts stay put)
  levels: number[];
  tabZ: number;
  tracks: Track[];       // in the order cut at each level
  linkAtDepth: boolean[];// for track k > 0: can the bit go straight there from the end of track k-1 without lifting
}

export interface Move { x: number; y: number; z: number; kind: 'rapid' | 'plunge' | 'cut' }

export interface Plan {
  cuts: Cut[];
  warnings: string[];
}

/** Every cut in the job, sheet coordinates, in cutting order. */
export function planJob(job: Job): Plan {
  const warnings: string[] = [];
  const cuts: Cut[] = [];
  for (const pl of job.placed) {
    const part = job.parts.find((p) => p.id === pl.part);
    if (!part) continue;
    const T = placer(part, pl);
    // mirrored placing would flip the winding; placer only turns and moves, so outlines keep their sense
    const sheetPts = part.contours.map((c) => c.pts.map(T));
    part.contours.forEach((c, i) => {
      if (c.op.kind === 'none' || c.pts.length < 2) return;
      // a pocket leaves standing whatever's drawn inside it that isn't cut (or is cut round the outside)
      const islands = part.contours
        .map((o, j) => ({ o, j }))
        .filter(({ o, j }) => j !== i && o.closed && c.closed && (o.op.kind === 'none' || o.op.kind === 'outside')
          && Math.abs(signedArea(sheetPts[j])) < Math.abs(signedArea(sheetPts[i])) && pointIn(sheetPts[j][0], sheetPts[i]))
        .map(({ j }) => sheetPts[j]);
      const label = `${part.name} · ${c.note || `outline ${i + 1}`}`;
      const cut = makeCut(job, `${pl.id}:${c.id}`, label, c, sheetPts[i], islands, warnings);
      if (cut) cuts.push(cut);
    });
  }
  return { cuts: orderCuts(cuts), warnings };
}

function makeCut(job: Job, key: string, label: string, c: Contour, pts: P2[], islands: P2[][], warnings: string[]): Cut | null {
  const op = c.op, bit = bitOf(job, op), r = bit.dia / 2;
  const levels = passLevels(op, bit);
  if (!levels.length) return null;
  const bottom = levels[levels.length - 1];
  const tabZ = Math.min(op.z0, bottom + Math.max(0, op.tabThick));
  const climb = op.dir === 'climb';
  let tracks: Track[] = [];
  let outer = false;

  if (op.kind === 'on' || !c.closed) {
    const p = c.closed ? (climb ? ccw(pts) : cw(pts)) : pts;
    tracks = [{ pts: p, closed: c.closed, tabs: [] }];
  } else if (op.kind === 'outside' || op.kind === 'inside') {
    outer = op.kind === 'outside';
    const off = offset([ccw(pts)], outer ? r : -r);
    if (!off.length) { warnings.push(`${label}: the ${bit.name} bit is too big for this inside cut — skipped`); return null; }
    // climb with a router turning clockwise: outside goes clockwise, inside anticlockwise
    tracks = off.map((p) => ({ pts: outer === climb ? cw(p) : ccw(p), closed: true, tabs: [] }));
  } else if (op.kind === 'pocket') {
    const region = [ccw(pts), ...islands.map(cw)];
    const walls = offset(region, -r);
    if (!walls.length) { warnings.push(`${label}: the ${bit.name} bit is too big for this pocket — skipped`); return null; }
    const step = Math.max(0.05, bit.dia * Math.min(0.95, Math.max(0.05, bit.stepover)));
    const dirFix = (p: P2[]) => (signedArea(p) >= 0) === climb ? p : [...p].reverse();
    if (op.fill === 'offset') {
      const rings: P2[][][] = [walls];
      for (let k = 1; k < 2000; k++) {
        const next = offset(walls, -step * k);
        if (!next.length) break;
        rings.push(next);
      }
      // innermost first, out to the wall
      for (let k = rings.length - 1; k >= 0; k--) {
        const ring = [...rings[k]].sort((a, b) => Math.abs(signedArea(a)) - Math.abs(signedArea(b)));
        for (const p of ring) tracks.push({ pts: dirFix(p), closed: true, tabs: [] });
      }
    } else {
      const inner = offset(walls, -step * 0.5);
      const horiz = op.fill === 'horizontal';
      const xs = inner.flatMap((p) => p.map((q) => (horiz ? q[1] : q[0])));
      const lo = Math.min(...xs), hi = Math.max(...xs);
      const rows: P2[][] = [];
      if (Number.isFinite(lo)) {
        const n = Math.max(1, Math.ceil((hi - lo) / step));
        const a0 = Math.min(...inner.flatMap((p) => p.map((q) => (horiz ? q[0] : q[1])))) - 1;
        const a1 = Math.max(...inner.flatMap((p) => p.map((q) => (horiz ? q[0] : q[1])))) + 1;
        for (let k = 0; k <= n; k++) {
          const t = lo + ((hi - lo) * k) / n;
          rows.push(horiz ? [[a0, t], [a1, t]] : [[t, a0], [t, a1]]);
        }
      }
      const segs = clipLines(rows, inner);
      // back and forth: sort by row, then alternate the direction
      const key = (s: P2[]) => (horiz ? s[0][1] : s[0][0]);
      const along = (s: P2[]) => (horiz ? Math.min(s[0][0], s[s.length - 1][0]) : Math.min(s[0][1], s[s.length - 1][1]));
      segs.sort((a, b) => key(a) - key(b) || along(a) - along(b));
      let flip = false, lastRow = NaN;
      for (const s of segs) {
        const row = Math.round(key(s) * 1000);
        if (row !== lastRow) { flip = !flip; lastRow = row; }
        const fwd = horiz ? s[0][0] <= s[s.length - 1][0] : s[0][1] <= s[s.length - 1][1];
        tracks.push({ pts: fwd === flip ? s : [...s].reverse(), closed: false, tabs: [] });
      }
      for (const p of walls) tracks.push({ pts: dirFix(p), closed: true, tabs: [] });
    }
    // the bit may go straight from one track to the next at depth if the move stays inside the pocket
    const links = [false, ...tracks.slice(1).map((t, k) => {
      const prev = tracks[k];
      const a = prev.closed ? prev.pts[0] : prev.pts[prev.pts.length - 1];
      return linkInside(a, nearestStart(t, a), walls, bit.dia * 1.5);
    })];
    return { key, label, bit, op, outer, levels, tabZ, tracks: tracks.map((t, k) => (k && links[k] && t.closed ? startNear(t, prevEnd(tracks[k - 1])) : t)), linkAtDepth: links };
  }

  // tabs: positions round the drawn outline, found on the bit's path, the tab's width plus the bit's
  if (op.tabs.length && c.closed && tracks.length === 1 && op.kind !== 'pocket') {
    const t = tracks[0], L = pathLength(t.pts, true), w = op.tabWidth + bit.dia;
    t.tabs = op.tabs.map((f) => {
      const at = pointAt(pts, true, f);
      const s = distAlong(t.pts, at);
      return [s - w / 2, s + w / 2] as [number, number];
    }).map(([a, b]) => [((a % L) + L) % L, ((a % L) + L) % L + (b - a)] as [number, number]);
    // start the loop away from any tab
    const at = freeSpot(t.tabs, L);
    t.pts = startAt(t.pts, at);
    t.tabs = t.tabs.map(([a, b]) => { let a2 = a - at; while (a2 < 0) a2 += L; return [a2, a2 + (b - a)] as [number, number]; });
  }
  return { key, label, bit, op, outer, levels, tabZ, tracks, linkAtDepth: tracks.map(() => false) };
}

const prevEnd = (t: Track): P2 => (t.closed ? t.pts[0] : t.pts[t.pts.length - 1]);

function nearestStart(t: Track, p: P2): P2 {
  if (!t.closed) return t.pts[0];
  let best = t.pts[0], bd = Infinity;
  for (const q of t.pts) { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = q; } }
  return best;
}

function startNear(t: Track, p: P2): Track {
  let bi = 0, bd = Infinity;
  t.pts.forEach((q, i) => { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; bi = i; } });
  return { ...t, pts: [...t.pts.slice(bi), ...t.pts.slice(0, bi)] };
}

function linkInside(a: P2, b: P2, region: P2[][], maxLen: number): boolean {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L > maxLen) return false;
  const n = Math.max(2, Math.ceil(L / 0.5));
  for (let k = 1; k < n; k++) {
    const p: P2 = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
    if (!inRegion(p, offset(region, 0.05))) return false;
  }
  return true;
}

/** Distance along a closed path to the point on it nearest p. */
function distAlong(pts: P2[], p: P2): number {
  let best = Infinity, at = 0, run = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy, l = Math.sqrt(l2);
    const k = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    const d = Math.hypot(a[0] + dx * k - p[0], a[1] + dy * k - p[1]);
    if (d < best) { best = d; at = run + k * l; }
    run += l;
  }
  return at;
}

/** The middle of the longest stretch clear of tabs. */
function freeSpot(tabs: [number, number][], L: number): number {
  if (!tabs.length) return 0;
  const iv = tabs.map(([a, b]) => [a, b] as [number, number]).sort((x, y) => x[0] - y[0]);
  let best = 0, at = 0;
  for (let k = 0; k < iv.length; k++) {
    const end = iv[k][1], next = k + 1 < iv.length ? iv[k + 1][0] : iv[0][0] + L;
    if (next - end > best) { best = next - end; at = (end + next) / 2; }
  }
  return ((at % L) + L) % L;
}

/** The closed path started at distance s along it (a point is added there). */
function startAt(pts: P2[], s: number): P2[] {
  const n = pts.length;
  let run = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (run + l >= s) {
      const k = l > 0 ? (s - run) / l : 0;
      const p: P2 = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
      const rest = [...pts.slice(i + 1), ...pts.slice(0, i + 1)];
      return Math.hypot(p[0] - rest[rest.length - 1][0], p[1] - rest[rest.length - 1][1]) < 1e-9 ? rest.slice(-1).concat(rest.slice(0, -1)) : [p, ...rest];
    }
    run += l;
  }
  return pts;
}

/** A closed track started at distance s along it, its tabs moved to match. */
function restart(t: Track, s: number): Track {
  const L = pathLength(t.pts, true);
  s = ((s % L) + L) % L;
  if (s < 1e-6 || L - s < 1e-6) return t;
  return { ...t, pts: startAt(t.pts, s), tabs: t.tabs.map(([a, b]) => { let a2 = a - s; while (a2 < 0) a2 += L; return [a2, a2 + (b - a)] as [number, number]; }) };
}

/** Inside cuts and pockets first, then the outside cuts; nearest next within each group. */
function orderCuts(cuts: Cut[]): Cut[] {
  const out: Cut[] = [];
  let at: P2 = [0, 0];
  for (const group of [cuts.filter((c) => !c.outer), cuts.filter((c) => c.outer)]) {
    const left = [...group];
    while (left.length) {
      let bi = 0, bd = Infinity;
      left.forEach((c, i) => { const p = c.tracks[0].pts[0]; const d = Math.hypot(p[0] - at[0], p[1] - at[1]); if (d < bd) { bd = d; bi = i; } });
      const c = left.splice(bi, 1)[0];
      out.push(c);
      const t = c.tracks[c.tracks.length - 1];
      at = prevEnd(t);
    }
  }
  return out;
}

// ------------------------------------------------------------ moves

/**
 * The bit's moves for a list of cuts with one bit. order 'path' cuts each
 * outline to full depth before the next; 'depth' takes every outline down
 * one pass at a time (inside cuts, then the outside cuts).
 */
export function movesFor(job: Job, cuts: Cut[]): Move[] {
  const mv: Move[] = [];
  const safe = job.safeZ;
  const at = { x: 0, y: 0, z: job.homeZ };
  const go = (m: Move) => {
    if (Math.abs(m.x - at.x) < 1e-9 && Math.abs(m.y - at.y) < 1e-9 && Math.abs(m.z - at.z) < 1e-9) return;
    mv.push(m); at.x = m.x; at.y = m.y; at.z = m.z;
  };
  const here = () => at.z;
  // the tracks as they now start (a closed loop carries on from where its last pass ended)
  const live = new Map<Cut, Track[]>();

  const level = (c: Cut, li: number) => {
    const zl = c.levels[li], zPrev = li ? c.levels[li - 1] : c.op.z0;
    const tracks = live.get(c) || c.tracks.map((t) => ({ ...t }));
    live.set(c, tracks);
    tracks.forEach((t, k) => {
      const start = t.pts[0];
      const there = Math.hypot(start[0] - at.x, start[1] - at.y) < 1e-6;
      if (k > 0 && c.linkAtDepth[k]) {
        go({ x: start[0], y: start[1], z: Math.max(zl, at.z), kind: 'cut' });
      } else if (!there || at.z > zPrev + 1e-6) {
        if (!there) {
          if (at.z < safe) go({ ...at, z: safe, kind: 'rapid' });
          go({ x: start[0], y: start[1], z: at.z, kind: 'rapid' });
        }
        // down to where this pass starts, at the plunge feed (the material above it is already gone)
        go({ x: start[0], y: start[1], z: Math.max(zl, zPrev), kind: 'plunge' });
      }
      const end = rampAndCut(t, Math.max(at.z, zl), zl, c.op.ramp, c.tabZ, go, here);
      // carry on from here next pass
      if (tracks.length === 1) tracks[k] = t.closed ? restart(t, end) : { ...t, pts: [...t.pts].reverse() };
    });
  };

  if (job.order === 'depth') {
    for (const group of [cuts.filter((c) => !c.outer), cuts.filter((c) => c.outer)]) {
      const most = Math.max(0, ...group.map((c) => c.levels.length));
      for (let li = 0; li < most; li++) for (const c of group) if (li < c.levels.length) level(c, li);
    }
  } else {
    for (const c of cuts) for (let li = 0; li < c.levels.length; li++) level(c, li);
  }
  if (mv.length) go({ ...at, z: job.homeZ, kind: 'rapid' });
  return mv;
}

function sample(t: Track, s: number, L: number): P2 {
  if (!t.closed) s = Math.max(0, Math.min(L, s));
  return pointAt(t.pts, t.closed, L > 0 ? s / L : 0);
}

const inTab = (t: Track, s: number, L: number) => {
  const q = ((s % L) + L) % L;
  return t.tabs.some(([a, b]) => (q > a + 1e-6 && q < b - 1e-6) || (q + L > a + 1e-6 && q + L < b - 1e-6));
};

/** The distances where something happens along a track between s0 and s1: corners and tab edges. */
function breaks(t: Track, s0: number, s1: number, L: number): number[] {
  const marks: number[] = [];
  let run = 0;
  for (let i = 0; i < t.pts.length; i++) {
    marks.push(run);
    if (i < t.pts.length - 1 || t.closed) { const a = t.pts[i], b = t.pts[(i + 1) % t.pts.length]; run += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  }
  for (const [a, b] of t.tabs) marks.push(((a % L) + L) % L, ((b % L) + L) % L);
  const out: number[] = [];
  if (L > 0) {
    const laps = t.closed ? [Math.floor(s0 / L) - 1, Math.ceil(s1 / L) + 1] : [0, 0];
    for (let lap = laps[0]; lap <= laps[1]; lap++) for (const m of marks) { const s = m + lap * L; if (s > s0 + 1e-6 && s < s1 - 1e-6) out.push(s); }
  }
  return [s0, ...out.sort((a, b) => a - b), s1];
}

/** Cut along a track from distance s0 to s1 (Z from zAt), riding up over tabs. */
function cutAlong(t: Track, s0: number, s1: number, zAt: (s: number) => number, tabZ: number, go: (m: Move) => void, here: () => number) {
  const L = pathLength(t.pts, t.closed);
  const bs = breaks(t, s0, s1, L);
  for (let k = 1; k < bs.length; k++) {
    const a = bs[k - 1], b = bs[k], mid = (a + b) / 2;
    const up = t.tabs.length > 0 && inTab(t, mid, L);
    const za = up ? Math.max(zAt(a), tabZ) : zAt(a), zb = up ? Math.max(zAt(b), tabZ) : zAt(b);
    // stepping up onto or down off a tab happens straight up/down at its edge
    if (Math.abs(za - here()) > 1e-6) { const p = sample(t, a, L); go({ x: p[0], y: p[1], z: za, kind: za < here() ? 'plunge' : 'cut' }); }
    const p = sample(t, b, L);
    go({ x: p[0], y: p[1], z: zb, kind: zb < za - 1e-9 ? 'plunge' : 'cut' });
  }
}

/**
 * Ramp in from zTop to zl along the track, then cut the whole track at zl
 * (the ramped stretch gets cut again at full depth). Returns where along the
 * track the bit ends up.
 */
function rampAndCut(t: Track, zTop: number, zl: number, angle: number, tabZ: number, go: (m: Move) => void, here: () => number): number {
  const L = pathLength(t.pts, t.closed);
  const drop = zTop - zl;
  const flat = () => zl;
  if (!t.closed) {
    if (drop > 1e-6) go({ x: t.pts[0][0], y: t.pts[0][1], z: zl, kind: 'plunge' });
    cutAlong(t, 0, L, flat, tabZ, go, here);
    return L;
  }
  if (drop <= 1e-6 || angle <= 0.1 || L <= 0) {
    if (drop > 1e-6) go({ x: t.pts[0][0], y: t.pts[0][1], z: zl, kind: 'plunge' });
    cutAlong(t, 0, L, flat, tabZ, go, here);
    return 0;
  }
  const R = drop / Math.tan((angle * Math.PI) / 180);
  cutAlong(t, 0, R, (s) => zTop - drop * Math.min(1, s / R), tabZ, go, here);
  cutAlong(t, R, R + L, flat, tabZ, go, here);
  return R % L;
}

// ------------------------------------------------------------ G-code (ShopBot, Easel style)

const f5 = (v: number) => (Math.abs(v) < 5e-6 ? 0 : v).toFixed(5);
const f1 = (v: number) => v.toFixed(1);

/**
 * G-code the ShopBot runs as-is: inches, absolute, G0/G1 only, every G1 with
 * its feed (plunge feed for anything going down, the cut feed otherwise).
 * Starts by rising to the home height, ends there and goes back to X0 Y0.
 */
export function gcode(job: Job, moves: Move[], bit: Bit): string {
  const k = 1 / 25.4;
  const L: string[] = ['G20', 'G90', `G1 Z${f5(job.homeZ * k)} F9.0`];
  let x = 0, y = 0, z = job.homeZ;
  for (const m of moves) {
    const parts: string[] = [];
    if (Math.abs(m.x - x) > 1e-7 || Math.abs(m.y - y) > 1e-7) parts.push(`X${f5(m.x * k)}`, `Y${f5(m.y * k)}`);
    if (Math.abs(m.z - z) > 1e-7) parts.push(`Z${f5(m.z * k)}`);
    if (!parts.length) continue;
    if (m.kind === 'rapid') L.push(`G0 ${parts.join(' ')}`);
    else L.push(`G1 ${parts.join(' ')} F${f1((m.kind === 'plunge' ? bit.plunge : bit.feed) * k)}`);
    x = m.x; y = m.y; z = m.z;
  }
  L.push(`G0 X${f5(0)} Y${f5(0)}`, 'G4 P0.1');
  return L.join('\n') + '\n';
}

/** How long the moves take, seconds (feeds as given, rapids at the job's rapid rate). */
export function runTime(job: Job, moves: Move[], bit: Bit): number {
  let t = 0, x = 0, y = 0, z = job.homeZ;
  for (const m of moves) {
    const d = Math.hypot(m.x - x, m.y - y, m.z - z);
    const f = m.kind === 'rapid' ? job.rapid : m.kind === 'plunge' ? bit.plunge : bit.feed;
    t += (d / Math.max(1, f)) * 60;
    x = m.x; y = m.y; z = m.z;
  }
  return t;
}

/** The job's cuts grouped by bit (one G-code file each), in the order the bits are listed. */
export function byBit(job: Job, plan: Plan): { bit: Bit; cuts: Cut[] }[] {
  const out: { bit: Bit; cuts: Cut[] }[] = [];
  for (const c of plan.cuts) {
    let g = out.find((o) => o.bit.id === c.bit.id);
    if (!g) { g = { bit: c.bit, cuts: [] }; out.push(g); }
    g.cuts.push(c);
  }
  return out;
}
