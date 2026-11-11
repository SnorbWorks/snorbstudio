// The starting shape: a block, an upright cylinder, or none.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { build } from './build/geometry.mjs';
import { newProject, bodyShape, setBodyShape, bodyOutline, makeLid } from './build/model.mjs';
import { applyFormulas } from './build/sizes.mjs';

before(async () => {
  const OC = await opencascade({ locateFile: () => new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url).pathname });
  setOC(OC);
});

const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

test('a new part starts from a block; a cylinder takes its narrower side', () => {
  const p = newProject();
  assert.equal(bodyShape(p), 'block');
  p.stock = { min: [-15, -10, 0], max: [15, 10, 20] };
  setBodyShape(p, 'cylinder');
  assert.equal(bodyShape(p), 'cylinder');
  assert.deepEqual([p.stock.min, p.stock.max], [[-10, -10, 0], [10, 10, 20]]);
  near(build(p, [], false, false).volume, Math.PI * 100 * 20);
  setBodyShape(p, 'none');
  assert.equal(bodyShape(p), 'none');
  setBodyShape(p, 'block');
  assert.equal(bodyShape(p), 'block');
  near(build(p, [], false, false).volume, 20 * 20 * 20);
});

test('a hollow cylinder is a cup, and its lid is round', () => {
  const p = newProject();
  p.stock = { min: [-20, -20, 0], max: [20, 20, 30] };
  setBodyShape(p, 'cylinder');
  p.shell = { wall: 2, open: 'front' };
  setBodyShape(p, 'cylinder');            // a side opening makes no sense on a cylinder: it opens at the top
  assert.equal(p.shell.open, 'top');
  near(build(p, [], false, false).volume, Math.PI * (400 * 30 - 18 * 18 * 28));
  const lid = makeLid(p);
  assert.equal(lid.stock.shape, 'cylinder');
  assert.ok(lid.features.every((f) => f.type === 'circle'));
  const r = build(lid, [], false, false);
  assert.ok(Object.keys(r.errors).length === 0, JSON.stringify(r.errors));
});

test('a cylinder outline is a circle; a formula for its diameter keeps it round', () => {
  const p = newProject();
  setBodyShape(p, 'cylinder');
  const o = bodyOutline(p, 16);
  assert.equal(o.length, 16);
  for (const [x, y] of o) near(Math.hypot(x, y), 10, 1e-9);
  p.sizes = [{ name: 'd', expr: '30' }];
  p.exprs = { 'stock.dia': 'd' };
  applyFormulas(p, (v) => v);
  assert.deepEqual([p.stock.min[0], p.stock.max[0], p.stock.min[1], p.stock.max[1]], [-15, 15, -15, 15]);
});
