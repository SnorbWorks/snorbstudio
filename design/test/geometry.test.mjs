// The spec's test parts, built from feature lists the way the app saves them.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { build } from './build/geometry.mjs';
import { newProject } from './build/model.mjs';

before(async () => {
  const OC = await opencascade({ locateFile: () => new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url).pathname });
  setOC(OC);
});

const feat = (o) => ({ id: o.id || 'a', type: 'rect', view: 'top', cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, d0: 20, d1: 20, op: 'add', through: false, ...o });
const cube = (features) => ({ ...newProject(), features });
const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) < tol * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const xs = (lines) => lines.flatMap((l) => l.filter((_, i) => i % 2 === 0));

test('a stock cube is 20 mm, its hidden edges all under visible ones', () => {
  const r = build(cube([]));
  near(r.volume, 8000);
  for (const v of ['top', 'front', 'right', 'left', 'back', 'bottom']) {
    assert.equal(r.views[v].hidden.length, 0, `${v} has hidden lines`);
    assert.ok(r.views[v].visible.length >= 4);
  }
});

test('cube with a centred pocket: dashed in front, solid from the top', () => {
  const r = build(cube([feat({ w: 10, h: 10, d1: 12, op: 'cut' })]));
  near(r.volume, 8000 - 10 * 10 * 8);
  assert.equal(r.effect.a, true);
  // top: the pocket outline is visible
  assert.ok(r.views.top.visible.length >= 8);
  assert.equal(r.views.top.hidden.length, 0);
  // front: the pocket's walls are hidden lines at x = ±5 down to z = 12
  const hid = r.views.front.hidden;
  assert.ok(hid.length > 0);
  const hx = xs(hid);
  assert.ok(hx.some((x) => Math.abs(x - 5) < 1e-6) && hx.some((x) => Math.abs(x + 5) < 1e-6));
  const hz = hid.flatMap((l) => l.filter((_, i) => i % 2 === 1));
  assert.ok(hz.some((z) => Math.abs(z - 12) < 1e-6), 'pocket floor at z 12');
  // the floor's front and back edges land on one line: drawn once, so the dashes stay dashes
  const floors = hid.filter((l) => l.length === 4 && l[1] === 12 && l[3] === 12);
  assert.equal(floors.length, 1);
  // bottom: the pocket shows dashed, seen through the base
  assert.equal(r.views.bottom.hidden.length, 4);
});

test('cube with a through hole', () => {
  const r = build(cube([feat({ type: 'circle', r: 3, d1: 20, op: 'cut', through: true })]));
  near(r.volume, 8000 - Math.PI * 9 * 20, 1e-3);
  assert.equal(r.effect.a, true);
  // the hole shows as a circle in the bottom view too, solid
  assert.ok(r.views.bottom.visible.length >= 5);
  // front: two hidden lines at x = ±3 the full height
  const hid = r.views.front.hidden;
  const vert = hid.filter((l) => l.length === 4 && Math.abs(l[0] - l[2]) < 1e-9 && Math.abs(Math.abs(l[0]) - 3) < 1e-6);
  assert.equal(vert.length, 2);
});

test('a boss on top is solid in the front view; a buried block does nothing', () => {
  const r = build(cube([
    feat({ id: 'boss', type: 'circle', r: 4, d0: 20, d1: 25 }),
    feat({ id: 'buried', w: 4, h: 4, d0: 5, d1: 10 }),
    feat({ id: 'sketch', w: 4, h: 4 }),
  ]));
  near(r.volume, 8000 + Math.PI * 16 * 5);
  assert.equal(r.effect.boss, true);
  assert.equal(r.effect.buried, false);
  assert.equal(r.effect.sketch, false);
  near(r.bbox[1][2], 25);
});

test('a hole drawn in the front view goes along Y', () => {
  const r = build(cube([feat({ view: 'front', type: 'circle', cu: 0, cv: 10, r: 2, d0: 10, d1: 10, op: 'cut', through: true })]));
  near(r.volume, 8000 - Math.PI * 4 * 20, 1e-3);
  // seen from the top it's two hidden lines along y at x = ±2
  const hid = r.views.top.hidden.filter((l) => l.length === 4 && Math.abs(l[0] - l[2]) < 1e-9);
  assert.equal(hid.length, 2);
});
