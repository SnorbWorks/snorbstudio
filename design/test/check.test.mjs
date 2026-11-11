// Printability check.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { build } from './build/geometry.mjs';
import { newProject, profile } from './build/model.mjs';
import { checkPrint } from './build/check.mjs';
import { holeFromTable } from './build/holes.mjs';

before(async () => {
  const OC = await opencascade({ locateFile: () => new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url).pathname });
  setOC(OC);
});

const feat = (o) => ({ id: o.id || 'f' + Math.random().toString(36).slice(2, 7), type: 'rect', view: 'top', cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, d0: 0, d1: 0, op: 'cut', through: false, ...o });
const run = (p) => checkPrint(p, build(p, [], true, false).mesh);
const kinds = (is) => is.map((i) => i.kind);

test('a plain block is fine', () => {
  const p = newProject();
  assert.deepEqual(run(p), []);
});

test('a 0.6 mm wall is thin; 2 mm is not', () => {
  const p = newProject();
  p.stock = { min: [-10, -10, 0], max: [10, 10, 10] };
  // a pocket from the top leaving a 0.6 mm wall on the +X side
  p.features.push(feat({ w: 15.4 - 0, h: 16, cu: 1.7, cv: 0, d0: 10, d1: 2 }));
  let is = run(p);
  const thin = is.find((i) => i.kind === 'thin');
  assert.ok(thin, `expected thin, got ${kinds(is)}`);
  assert.match(thin.title, /0\.6 mm/);
  p.features[0].cu = 0.3; p.features[0].w = 14.6;   // walls 2.4 / 2.4... (10-7.6)
  is = run(p);
  assert.ok(!is.some((i) => i.kind === 'thin'), `still thin: ${is.map((i) => i.title)}`);
});

test('a sideways hole is flagged with a teardrop fix; a teardrop is not', () => {
  const p = newProject();
  p.features.push(feat({ id: 'h', type: 'hole', view: 'front', cu: 0, cv: 10, r: 2.5, hole: holeFromTable('M5', 'clear'), d0: 10, d1: -10, through: true }));
  let is = run(p);
  const s = is.find((i) => i.kind === 'sideways');
  assert.ok(s && s.fix === 'teardrop' && s.feature === 'h');
  assert.ok(!is.some((i) => i.kind === 'overhang'), 'the hole top is not reported twice');
  p.features[0].teardrop = true;
  is = run(p);
  assert.deepEqual(kinds(is), [], is.map((i) => i.title).join('; '));
  // the teardrop's point is straight up, √2 × the radius above the centre
  const pts = profile(p.features[0]);
  const top = pts.reduce((a, b) => (b[1] > a[1] ? b : a));
  assert.ok(Math.abs(top[0]) < 1e-9 && Math.abs(top[1] - (10 + 2.75 * Math.SQRT2)) < 0.3, String(top));
});

test('an overhanging ledge is flagged, a short bridge is not', () => {
  const p = newProject();
  p.stock = { min: [-10, -10, 0], max: [10, 10, 20] };
  // cut a notch under one side, from the front, leaving a 15 mm wide flat roof 12 mm deep: needs support
  p.features.push(feat({ view: 'front', w: 14, h: 10, cu: 3, cv: 5, d0: 10, d1: -10, through: true }));
  let is = run(p);
  assert.ok(is.some((i) => i.kind === 'overhang'), kinds(is).join());
  // a 6 mm tunnel through the middle: its roof is a short bridge
  p.features[0] = feat({ view: 'front', w: 6, h: 6, cu: 0, cv: 8, d0: 10, d1: -10, through: true });
  is = run(p);
  assert.ok(!is.some((i) => i.kind === 'overhang'), is.map((i) => i.title).join('; '));
});

test('small text and tiny posts are flagged', () => {
  const p = newProject();
  p.features.push(feat({ type: 'circle', r: 0.25, op: 'add', d0: 20, d1: 22 }));
  const is = checkPrint(p, null);
  assert.deepEqual(kinds(is), ['tiny']);
});
