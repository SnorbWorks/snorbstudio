// SnorbCAM: pass plans, offsets, pockets, tabs, ramps, the ShopBot G-code, imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { newJob, newOp, IN, signedArea, pathLength } from './build/cam/job.mjs';
import { passLevels, planJob, movesFor, gcode, offset, byBit, runTime } from './build/cam/toolpath.mjs';
import { importSvg, importDxf, importCad, pathPoints } from './build/cam/importers.mjs';
import { newProject } from './build/model.mjs';
import { holeFromTable } from './build/holes.mjs';

const close = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} != ${b} (±${tol})`);
const bit = () => newJob().bits[0];
const square = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const job1 = (contours) => {
  const j = newJob();
  j.parts = [{ id: 'p', name: 'part', source: 'svg', contours }];
  j.placed = [{ id: 'a', part: 'p', x: 10, y: 10, rot: 0 }];
  return j;
};
const k = (pts, op, closed = true) => ({ id: Math.random().toString(36).slice(2), pts, closed, op });

test('passes: Easel-style equal passes', () => {
  const op = newOp('outside', 0.8 * IN);
  const lv = passLevels(op, bit());
  assert.equal(lv.length, 4);
  lv.forEach((z, i) => close(z, -0.2 * IN * (i + 1), 1e-9));
});

test('passes: a first pass and a finishing pass', () => {
  const op = { ...newOp('outside', 0.75 * IN), first: 0.1 * IN, finish: 0.05 * IN };
  const lv = passLevels(op, bit());
  close(lv[0], -0.1 * IN, 1e-9);
  close(lv[lv.length - 2], -0.7 * IN, 1e-9);
  close(lv[lv.length - 1], -0.75 * IN, 1e-9);
  // middle passes are equal and no deeper than the bit's pass depth
  const mids = lv.slice(1, -1).map((z, i) => (i ? lv.slice(1, -1)[i - 1] : lv[0]) - z);
  mids.forEach((d) => { close(d, mids[0], 1e-9); assert.ok(d <= 0.2 * IN + 1e-9); });
});

test('passes: a cut that starts below the top (stepped part)', () => {
  const op = { ...newOp('pocket', 5), z0: -3 };
  const lv = passLevels(op, bit());
  close(lv[lv.length - 1], -8, 1e-9);
  assert.ok(lv[0] < -3);
});

test('outside profile sits a bit radius outside, inside one a radius inside', () => {
  const o = offset([square(0, 0, 100)], 3.175);
  close(Math.max(...o[0].map((p) => p[0])), 103.175, 0.01);
  const i = offset([square(0, 0, 100)], -3.175);
  close(Math.max(...i[0].map((p) => p[0])), 96.825, 0.01);
});

test('climb cutting: outside clockwise, inside anticlockwise', () => {
  const j = job1([k(square(0, 0, 100), newOp('outside', 6)), k(square(30, 30, 20), newOp('inside', 6))]);
  const plan = planJob(j);
  const out = plan.cuts.find((c) => c.outer), ins = plan.cuts.find((c) => !c.outer);
  assert.ok(signedArea(out.tracks[0].pts) < 0);
  assert.ok(signedArea(ins.tracks[0].pts) > 0);
  // the inside cut comes first
  assert.equal(plan.cuts[0], ins);
});

test('an inside cut too small for the bit is skipped with a warning', () => {
  const plan = planJob(job1([k(square(0, 0, 5), newOp('inside', 6))]));
  assert.equal(plan.cuts.length, 0);
  assert.match(plan.warnings[0], /too big/);
});

test('moves: ramp in, reach every pass depth, end at home', () => {
  const j = job1([k(square(0, 0, 100), newOp('outside', 0.8 * IN))]);
  const plan = planJob(j);
  const mv = movesFor(j, plan.cuts);
  const zs = [...new Set(mv.filter((m) => m.kind === 'cut').map((m) => +m.z.toFixed(4)))];
  for (const z of passLevels(plan.cuts[0].op, plan.cuts[0].bit)) assert.ok(zs.includes(+z.toFixed(4)), `pass at ${z}`);
  // the first descent into the material is a ramp: going down while moving sideways
  const ramp = mv.find((m, i) => i && m.kind === 'plunge' && m.z < 0 && (m.x !== mv[i - 1].x || m.y !== mv[i - 1].y));
  assert.ok(ramp, 'a ramped move');
  assert.equal(mv[mv.length - 1].z, j.homeZ);
  // never below the bottom
  assert.ok(Math.min(...mv.map((m) => m.z)) >= -0.8 * IN - 1e-9);
});

test('tabs hold the part: the bit rides up to the tab height over each tab', () => {
  const op = { ...newOp('outside', 0.75 * IN), tabs: [0.125, 0.625], tabThick: 0.125 * IN, tabWidth: 0.375 * IN };
  const j = job1([k(square(0, 0, 200), op)]);
  const plan = planJob(j);
  const mv = movesFor(j, plan.cuts);
  const tabZ = -0.75 * IN + 0.125 * IN;
  const atTab = mv.filter((m) => Math.abs(m.z - tabZ) < 1e-6);
  assert.ok(atTab.length >= 2, 'moves at the tab height');
  // on the last pass, distance travelled at tab height ≈ 2 tabs × (tab width + bit Ø)
  const last = mv.slice(mv.findLastIndex((m) => m.kind === 'rapid' && m.z > 0) - 0);
  let run = 0;
  for (let i = 1; i < mv.length; i++) if (Math.abs(mv[i].z - tabZ) < 1e-6 && Math.abs(mv[i - 1].z - tabZ) < 1e-6) run += Math.hypot(mv[i].x - mv[i - 1].x, mv[i].y - mv[i - 1].y);
  const passesUnderTab = plan.cuts[0].levels.filter((z) => z < tabZ - 1e-9).length;
  close(run, passesUnderTab * 2 * (0.375 * IN + 6.35), 2.5);
  assert.ok(last.length);
});

test('pocket: offset rings innermost first, linked at depth, wall last', () => {
  const j = job1([k(square(0, 0, 60), newOp('pocket', 6))]);
  const plan = planJob(j);
  const c = plan.cuts[0];
  assert.ok(c.tracks.length >= 4);
  const areas = c.tracks.map((t) => Math.abs(signedArea(t.pts)));
  for (let i = 1; i < areas.length; i++) assert.ok(areas[i] >= areas[i - 1] - 1e-6);
  assert.ok(c.linkAtDepth.slice(1).some(Boolean), 'some rings linked without lifting');
  close(Math.max(...c.tracks.at(-1).pts.map((p) => p[0])), 10 + 60 - 3.175, 0.02);
});

test('pocket: back-and-forth rows clipped to the pocket, then the wall', () => {
  const op = { ...newOp('pocket', 3), fill: 'horizontal' };
  const plan = planJob(job1([k(square(0, 0, 50), op)]));
  const rows = plan.cuts[0].tracks.filter((t) => !t.closed);
  assert.ok(rows.length >= 8);
  for (const r of rows) for (const p of r.pts) { assert.ok(p[0] >= 10 + 3.17 && p[0] <= 60 - 3.17); }
  assert.ok(plan.cuts[0].tracks.at(-1).closed);
});

test('pocket around an island leaves it standing', () => {
  const plan = planJob(job1([k(square(0, 0, 80), newOp('pocket', 3)), k(square(30, 30, 20), newOp('none', 0))]));
  const c = plan.cuts[0];
  for (const t of c.tracks) for (const p of t.pts) {
    const dx = Math.max(40 - p[0], 0, p[0] - 60), dy = Math.max(40 - p[1], 0, p[1] - 60);
    assert.ok(Math.hypot(dx, dy) >= 3.175 - 0.02, `bit centre ${p} cuts into the island`);
  }
});

test('G-code matches the Easel/ShopBot format', () => {
  const j = job1([k(square(0, 0, 100), newOp('outside', 0.4 * IN))]);
  const plan = planJob(j);
  const g = byBit(j, plan)[0];
  const nc = gcode(j, movesFor(j, g.cuts), g.bit).trim().split('\n');
  assert.deepEqual(nc.slice(0, 3), ['G20', 'G90', 'G1 Z2.00000 F9.0']);
  assert.match(nc[3], /^G0 X\d+\.\d{5} Y\d+\.\d{5}$/);
  assert.equal(nc[4], 'G1 Z0.00000 F60.0');
  assert.deepEqual(nc.slice(-3), ['G0 Z2.00000', 'G0 X0.00000 Y0.00000', 'G4 P0.1']);
  for (const l of nc) assert.match(l, /^(G20|G90|G4 P0\.1|G0( [XYZ]-?\d+\.\d{5})+|G1( [XYZ]-?\d+\.\d{5})+ F\d+\.\d)$/, l);
  assert.ok(nc.some((l) => / F160\.0$/.test(l)));
  assert.ok(runTime(j, movesFor(j, g.cuts), g.bit) > 10);
});

test('the reference Easel file uses the same vocabulary', { skip: !existsSync('/Users/shawn/Downloads/rack final.nc') }, () => {
  const ref = readFileSync('/Users/shawn/Downloads/rack final.nc', 'utf8').trim().split(/\r?\n/);
  const words = (l) => l.split(' ').map((w) => w[0] === 'G' ? w : w[0]).join(' ');
  const mine = new Set(['G20', 'G90', 'G4 P0.1', 'G1 Z F', 'G0 X Y', 'G1 X Y Z F', 'G1 X Y F', 'G0 Z', 'G1 Z']);
  for (const l of ref) assert.ok(mine.has(words(l)) || l === 'G4 P0.1', `unexpected line shape: ${l}`);
});

test('order by depth: every outline gets its first pass before any second pass', () => {
  const j = job1([k(square(0, 0, 50), newOp('outside', 0.4 * IN)), k(square(100, 0, 50), newOp('outside', 0.4 * IN))]);
  j.order = 'depth';
  const mv = movesFor(j, planJob(j).cuts);
  const deep = mv.findIndex((m) => m.z < -0.2 * IN - 1e-6);
  const xsBefore = mv.slice(0, deep).filter((m) => m.kind === 'cut').map((m) => m.x);
  assert.ok(Math.max(...xsBefore) > 100 && Math.min(...xsBefore) < 70, 'both outlines cut once before going deeper');
});

test('SVG: Illustrator points, a rect, a circle and a path with an arc', () => {
  const svg = `<?xml version="1.0"?><!-- Generator: Adobe Illustrator 27 -->
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 360">
    <g transform="translate(36 0)"><rect x="0" y="0" width="144" height="72"/></g>
    <circle cx="300" cy="100" r="36"/>
    <path d="M400 100 h72 a36 36 0 0 1 0 72 h-72 z"/>
  </svg>`;
  const p = importSvg(svg, 't');
  assert.equal(p.contours.length, 3);
  const rect = p.contours.find((c) => c.pts.length === 4);
  const xs = rect.pts.map((q) => q[0]), ys = rect.pts.map((q) => q[1]);
  close(Math.min(...xs), 0.5 * IN, 1e-6); close(Math.max(...xs) - Math.min(...xs), 2 * IN, 1e-6);
  close(Math.max(...ys) - Math.min(...ys), 1 * IN, 1e-6);
  assert.ok(Math.max(...ys) <= 0, 'flipped to Y up');
  const circ = p.contours.find((c) => c.pts.length > 20 && Math.abs(Math.abs(signedArea(c.pts)) - Math.PI * (0.5 * IN) ** 2) < 5);
  assert.ok(circ, 'a 1" circle');
});

test('SVG path commands: relative, smooth curves, implicit lines', () => {
  const sub = pathPoints('m0 0 10 0 0 10 -10 0 z M20 0 C20 10 30 10 30 0 S40 -10 40 0 Q45 5 50 0 T60 0');
  assert.equal(sub.length, 2);
  assert.equal(sub[0].closed, true); assert.equal(sub[0].pts.length, 4);
  const end = sub[1].pts.at(-1);
  close(end[0], 60, 1e-9); close(end[1], 0, 1e-9);
});

test('DXF: lines and an arc join into one closed outline; bulged polyline; inches', () => {
  const g = (pairs) => pairs.map(([c, v]) => `${c}\n${v}`).join('\n');
  const dxf = g([[0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 1], [0, 'ENDSEC'], [0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'LINE'], [10, 0], [20, 0], [11, 2], [21, 0],
    [0, 'ARC'], [10, 2], [20, 1], [40, 1], [50, 270], [51, 90],
    [0, 'LINE'], [10, 2], [20, 2], [11, 0], [21, 2],
    [0, 'LINE'], [10, 0], [20, 2], [11, 0], [21, 0],
    [0, 'LWPOLYLINE'], [90, 2], [70, 1], [10, 5], [20, 0], [42, 1], [10, 7], [20, 0], [42, 1],
    [0, 'ENDSEC'], [0, 'EOF']]);
  const p = importDxf(dxf, 'd');
  assert.equal(p.contours.length, 2);
  for (const c of p.contours) assert.ok(c.closed);
  const areas = p.contours.map((c) => Math.abs(signedArea(c.pts)) / (IN * IN)).sort((a, b) => a - b);
  close(areas[0], Math.PI, 0.01);          // the bulged polyline: a 2" circle
  close(areas[1], 4 + Math.PI / 2, 0.01);  // 2x2 square with a half-round end
});

test('SnorbCAD part: body cut out, through holes, a blind pocket, a counterbore', () => {
  const p = newProject();
  p.stock = { min: [0, 0, 0], max: [100, 60, 18] };
  const f = (o) => ({ id: Math.random().toString(36), view: 'top', cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, d0: 18, d1: 18, op: 'cut', through: false, ...o });
  p.fit = 0;
  p.features = [
    f({ type: 'hole', cu: 10, cv: 10, r: 1.7, hole: holeFromTable('M3', 'clear'), through: true }),
    f({ type: 'rect', cu: 50, cv: 30, w: 30, h: 20, d1: 12 }),
    f({ type: 'hole', cu: 90, cv: 50, r: 1.7, hole: holeFromTable('M3', 'cbore'), through: true }),
    f({ type: 'rect', view: 'front', cu: 50, cv: 9, w: 5, h: 5, d0: 0, d1: 5 }),
  ];
  const { part, notes } = importCad(p);
  const kinds = part.contours.map((c) => c.op.kind);
  assert.deepEqual(kinds, ['outside', 'inside', 'pocket', 'pocket', 'inside']);
  close(part.contours[0].op.depth, 18, 1e-9);
  close(part.contours[2].op.depth, 6, 1e-9);
  const head = part.contours[3], bore = part.contours[4];
  close(head.op.depth, 3.2, 1e-9);
  close(bore.op.z0, -3.2, 1e-9); close(bore.op.depth, 18 - 3.2, 1e-9);
  assert.ok(notes.some((n) => /front/.test(n)));
});
