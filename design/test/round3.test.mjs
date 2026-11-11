// Round 3: hollow bodies, lids, named sizes.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { build } from './build/geometry.mjs';
import { newProject, makeLid, shellCavity } from './build/model.mjs';
import { evalExpr, sizeValues, applyFormulas } from './build/sizes.mjs';

before(async () => {
  const OC = await opencascade({ locateFile: () => new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url).pathname });
  setOC(OC);
});
const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (±${tol})`);
const box = (extra = {}) => ({ ...newProject(), stock: { min: [-30, -20, 0], max: [30, 20, 25] }, ...extra });

test('a body hollowed with 2 mm walls, open at the top', () => {
  const r = build(box({ shell: { wall: 2, open: 'top' } }));
  close(r.volume, 60 * 40 * 25 - 56 * 36 * 23, 1);
});

test('a closed hollow box', () => {
  const r = build(box({ shell: { wall: 2, open: 'none' } }));
  close(r.volume, 60 * 40 * 25 - 56 * 36 * 21, 1);
});

test('open at the front', () => {
  const p = box({ shell: { wall: 3, open: 'front' } });
  const [mn, mx] = shellCavity(p);
  assert.ok(mn[1] < -20);
  close(build(p).volume, 60 * 40 * 25 - 54 * 37 * 19, 1);
});

test('the lid: a plate as big as the box, a lip that fits inside with play', () => {
  const p = box({ shell: { wall: 2, open: 'top' }, fit: 0.2 });
  const lid = makeLid(p);
  assert.equal(lid.stock.max[0] - lid.stock.min[0], 60);
  assert.equal(lid.stock.max[2], 2);
  const lip = lid.features[0];
  close(lip.w, 56 - 2 * 0.2, 1e-9);           // 0.1 printer fit + 0.1 play each side
  const r = build(lid);
  const ow = 56 - 0.4, oh = 36 - 0.4, lipH = lip.d1, lw = 2;
  close(r.volume, 60 * 40 * 2 + (ow * oh - (ow - 2 * lw) * (oh - 2 * lw)) * lipH, 1);
});

test('sums with named sizes', () => {
  assert.equal(evalExpr('wall*2+1', { wall: 2 }), 5);
  assert.equal(evalExpr('-(3 - 1) / 4', {}), -0.5);
  assert.throws(() => evalExpr('wal*2', { wall: 2 }), /no size called/);
  assert.throws(() => evalExpr('2 +', {}), /unfinished/);
  const p = { ...newProject(), sizes: [{ name: 'wall', expr: '2' }, { name: 'inner', expr: 'wall*10' }] };
  assert.deepEqual(sizeValues(p), { wall: 2, inner: 20 });
});

test('changing a size changes every box that used it', () => {
  const p = box({ sizes: [{ name: 'wall', expr: '2' }], shell: { wall: 2, open: 'top' }, exprs: { 'shell.wall': 'wall', 'stock.z': 'wall*10' } });
  p.features = [{ id: 'a', type: 'rect', view: 'top', cu: 0, cv: 0, w: 4, h: 4, r: 0, corner: 0, d0: 25, d1: 20, op: 'cut', through: false, exprs: { w: 'wall*3', depth: 'wall + 1' } }];
  p.sizes[0].expr = '3';
  assert.deepEqual(applyFormulas(p, (v) => v), []);
  assert.equal(p.shell.wall, 3);
  assert.equal(p.stock.max[2], 30);
  assert.equal(p.features[0].w, 9);
  assert.equal(p.features[0].d1, 21);
  p.sizes = [];
  assert.equal(applyFormulas(p, (v) => v).length, 4);
});
