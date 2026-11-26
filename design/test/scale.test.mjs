// The scale tool: shapes grow and shrink about a point, evenly or stretched one way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newProject, scaleFeature, bounds2d } from './build/model.mjs';
import { svgFeatures } from './build/svgimport.mjs';

const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) < t, `${a} vs ${b}`);
const shape = (o) => ({ id: 'a', view: 'front', cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, d0: 10, d1: 5, op: 'add', through: false, ...o });

test('a rectangle doubles about its corner; that corner stays put, depth stays', () => {
  const f = shape({ type: 'rect', cu: 5, cv: 5, w: 10, h: 10, corner: 1 });
  assert.equal(scaleFeature(f, [0, 0, 0], 'front', 2, 2), 'scaled');
  assert.deepEqual(bounds2d(f), [0, 0, 20, 20]);
  near(f.corner, 2);
  assert.equal(f.d0, 10); assert.equal(f.d1, 5);
});

test('unlocked: a rectangle stretches across only; corners keep the smaller scale', () => {
  const f = shape({ type: 'rect', w: 10, h: 4, corner: 1 });
  scaleFeature(f, [0, 0, 0], 'front', 3, 1);
  near(f.w, 30); near(f.h, 4); near(f.corner, 1);
});

test('a circle stretched one way becomes an ellipse outline', () => {
  const f = shape({ type: 'circle', cu: 10, cv: 0, r: 5 });
  scaleFeature(f, [0, 0, 0], 'front', 2, 1);
  assert.equal(f.type, 'poly');
  const [u0, v0, u1, v1] = bounds2d(f);
  near(u0, 10, 1e-6); near(u1, 30, 1e-6); near(v0, -5, 0.01); near(v1, 5, 0.01);
});

test('a line outline with curves scales every point and handle', () => {
  const f = shape({ type: 'poly', pts: [[0, 0], [10, 0], [0, 10]], curves: [[[2, -2], [8, -2]], null, null] });
  scaleFeature(f, [0, 0, 0], 'front', 0.5, 0.5);
  assert.deepEqual(f.pts, [[0, 0], [5, 0], [0, 5]]);
  assert.deepEqual(f.curves[0], [[1, -1], [4, -1]]);
});

test('holes keep their size and only move; other faces are left alone', () => {
  const h = shape({ type: 'hole', cu: 10, cv: 0, r: 1.5, hole: { d: 3 } });
  assert.equal(scaleFeature(h, [0, 0, 0], 'front', 2, 2), 'moved');
  near(h.cu, 20); near(h.r, 1.5);
  const t = shape({ type: 'rect', view: 'top', w: 4, h: 4 });
  assert.equal(scaleFeature(t, [0, 0, 0], 'front', 2, 2), 'skipped');
  near(t.w, 4);
});

test('a side view turned: across and up follow the view it was scaled in', () => {
  // a front-view rectangle scaled from the back view (same faces, u flipped)
  const f = shape({ type: 'rect', w: 10, h: 10 });
  scaleFeature(f, [0, 0, 0], 'back', 2, 1);
  near(f.w, 20); near(f.h, 10);
});

test('SVG import: width and height can be scaled separately', () => {
  const p = newProject();
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const [f] = svgFeatures([sq], p, { view: 'front', scale: 2, scaleY: 0.5, depth: 0, holes: true });
  const [u0, v0, u1, v1] = bounds2d(f);
  near(u1 - u0, 20); near(v1 - v0, 5);
});

test('SVG import: a path holding many outlines splits into one per outline', async () => {
  const { splitSubpaths } = await import('./build/svgimport.mjs');
  assert.deepEqual(splitSubpaths('M0 0L10 0L10 10Z M20 20 L30 20 L30 30 Z'), ['M0 0 L10 0 L10 10 Z', 'M20 20 L30 20 L30 30 Z']);
  // a relative move after a close starts from the first outline's start
  assert.deepEqual(splitSubpaths('m5 5 l10 0 l0 10 z m20 0 h5 v5 z'), ['M5 5 l10 0 l0 10 Z', 'M25 5 h5 v5 Z']);
  // extra pairs after a relative move are relative lines
  assert.deepEqual(splitSubpaths('m1 1 2 0 0 2z'), ['M1 1 l2 0 l0 2 Z']);
  assert.deepEqual(splitSubpaths('M0 0 a5 5 0 011 1'), ['M0 0 a5 5 0 011 1']);
});
