// Big imports build fast: dense outlines are thinned, back-to-back cuts go in one boolean.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import opencascade from 'replicad-opencascadejs';
import { setOC, measureVolume } from 'replicad';
import { build, buildSolid } from './build/geometry.mjs';
import { newProject } from './build/model.mjs';

before(async () => {
  const OC = await opencascade({ locateFile: () => new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url).pathname });
  setOC(OC);
});

const feat = (o) => ({ id: o.id || 'a', type: 'rect', view: 'top', cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, d0: 20, d1: 20, op: 'add', through: false, ...o });
const cube = (features) => ({ ...newProject(), features });
const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) < tol * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test('five pockets in a row are cut together, same result as one at a time', () => {
  const pockets = [-8, -4, 0, 4, 8].map((u, k) => feat({ id: 'p' + k, cu: u, w: 2, h: 2, d0: 0, d1: 5, op: 'cut' }));
  const air = feat({ id: 'air', cu: 30, w: 2, h: 2, d0: 0, d1: 5, op: 'cut' });
  const r = build(cube([...pockets, air]));
  near(r.volume, 8000 - 5 * 4 * 5);
  for (let k = 0; k < 5; k++) assert.equal(r.effect['p' + k], true);
  assert.equal(r.effect.air, false);
  assert.deepEqual(r.errors, {});
});

test('overlapping cuts still come out right', () => {
  const a = [0, 1, 2, 3, 4].map((k) => feat({ id: 'o' + k, cu: k * 0.5, w: 2, h: 2, d0: 0, d1: 5, op: 'cut' }));
  const r = build(cube(a));
  near(r.volume, 8000 - 4 * 2 * 5);
});

test('a circle traced in 400 points builds with far fewer faces, same size', () => {
  const pts = Array.from({ length: 400 }, (_, k) => [6 * Math.cos((2 * Math.PI * k) / 400), 6 * Math.sin((2 * Math.PI * k) / 400)]);
  const { solid } = buildSolid(cube([feat({ id: 'c', type: 'poly', pts, d0: 0, d1: 5, op: 'cut' })]));
  assert.ok(solid.faces.length < 120, `${solid.faces.length} faces`);
  near(measureVolume(solid), 8000 - Math.PI * 36 * 5, 2e-3);
});
