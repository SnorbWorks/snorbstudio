// Round 2: turning shapes.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { build } from './build/geometry.mjs';
import { newProject, rotateFeature, bounds2d, profile } from './build/model.mjs';

before(async () => {
  const OC = await opencascade({ locateFile: () => new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url).pathname });
  setOC(OC);
});
const feat = (o) => ({ id: 'a', type: 'rect', view: 'top', cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, d0: 20, d1: 20, op: 'add', through: false, ...o });
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const Z = [0, 0, 1];

test('a rectangle turned 90° about its centre swaps width and height, corners follow', () => {
  const f = feat({ cu: 5, cv: 0, w: 10, h: 4, corners: [1, 0, 0, 0] });
  assert.ok(rotateFeature(f, [5, 0, 0], Z, 90));
  assert.equal(f.type, 'rect'); close(f.w, 4); close(f.h, 10);
  assert.deepEqual(f.corners, [0, 1, 0, 0]);   // the rounded lower-left corner is now lower-right
});

test('turned about another point, the centre swings round it', () => {
  const f = feat({ cu: 10, cv: 0, w: 2, h: 2 });
  rotateFeature(f, [0, 0, 0], Z, 90);
  close(f.cu, 0); close(f.cv, 10);
});

test('a rectangle at 30° becomes an outline of the same size', () => {
  const f = feat({ w: 10, h: 4, d1: 30 });
  rotateFeature(f, [0, 0, 0], Z, 30);
  assert.equal(f.type, 'poly');
  const p = profile(f);
  close(Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]), 10, 1e-6);
  close(Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]) * 180 / Math.PI, 30, 1e-6);
  const r = build({ ...newProject(), features: [f] });
  close(r.volume, 8000 + 40 * 10, 0.5);
});

test('seen from the bottom, the same turn goes the other way in its own view', () => {
  const f = feat({ type: 'slot', view: 'bottom', w: 10, h: 4 });
  rotateFeature(f, [0, 0, 0], Z, 30);
  close(f.rot, 330);
});

test('a shape on the front face does not turn about the top view axis', () => {
  const f = feat({ view: 'front', w: 10, h: 4 });
  assert.equal(rotateFeature(f, [0, 0, 0], Z, 30), false);
  close(f.w, 10);
});

test('polygon, outline and a linear pattern turn', () => {
  const g = feat({ type: 'polygon', sides: 6, r: 5 });
  rotateFeature(g, [0, 0, 0], Z, 15); close(g.rot, 15);
  const p = feat({ type: 'poly', pts: [[0, 0], [10, 0], [0, 5]], pattern: { kind: 'linear', count: 3, step: [20, 0, 0], center: [0, 0, 0], axis: Z, angle: 0 } });
  rotateFeature(p, [0, 0, 0], Z, 90);
  close(p.pts[1][0], 0); close(p.pts[1][1], 10);
  close(p.pattern.step[0], 0); close(p.pattern.step[1], 20);
  const [u0, , u1] = bounds2d(p); close(u1 - u0, 5);
});
