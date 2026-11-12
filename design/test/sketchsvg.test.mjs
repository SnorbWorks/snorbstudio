// Line tool squaring, sketches for the 3D preview, the drawing area, SVG import maths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newProject, squareTo, sketchLoops, areaBox, isSketch } from './build/model.mjs';
import { svgSize, nesting, simplify, svgFeatures, UNIT_MM } from './build/svgimport.mjs';

const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) < t, `${a} vs ${b}`);

test('Shift keeps a side level, plumb or at 45°', () => {
  assert.deepEqual(squareTo([0, 0], [10, 1]), [10, 0]);
  assert.deepEqual(squareTo([0, 0], [-1, -7]), [0, -7]);
  const d = squareTo([0, 0], [9, 11]);
  near(d[0], d[1]); near(d[0], 10);
  // with a grid, a 45° side ends on a grid point
  const g = squareTo([0, 0], [9.3, 10.1], 1);
  near(g[0], 10); near(g[1], 10);
  assert.deepEqual(squareTo([5, 5], [5.4, 12.6], 1), [5, 13]);
});

test('a flat sketch is drawn in 3D where it sits; a shape with depth is not', () => {
  const p = newProject();
  p.features.push({ id: 'a', type: 'poly', view: 'top', cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, pts: [[0, 0], [10, 0], [0, 10]], d0: 20, d1: 20, op: 'add', through: false });
  p.features.push({ id: 'b', type: 'rect', view: 'front', cu: 0, cv: 5, w: 4, h: 4, r: 0, corner: 0, d0: 10, d1: 5, op: 'cut', through: false });
  assert.ok(isSketch(p.features[0]) && !isSketch(p.features[1]));
  const L = sketchLoops(p);
  assert.equal(L.length, 1);
  assert.deepEqual(L[0].pts.map((q) => q[2]), [20, 20, 20]);
  assert.equal(L[0].cut, false);
});

test('the drawing area is a box standing on the bed, centred', () => {
  const p = newProject();
  assert.equal(areaBox(p), null);
  p.area = { w: 220, d: 200, h: 250 };
  assert.deepEqual(areaBox(p), [[-110, -100, 0], [110, 100, 250]]);
});

test('SVG units: stated mm, inches, Inkscape pixels, Illustrator pixels', () => {
  let s = svgSize({ width: '100mm', height: '50mm', viewBox: '0 0 400 200' });
  assert.equal(s.unit, 'mm'); assert.ok(s.stated); near(s.mmPerUser, 0.25);
  s = svgSize({ width: '2in', viewBox: '0 0 2 1' });
  assert.equal(s.unit, 'in'); near(s.mmPerUser, 25.4);
  s = svgSize({ width: '96', viewBox: '0 0 96 96' });
  assert.equal(s.unit, 'px'); assert.ok(!s.stated); near(s.mmPerUser, 25.4 / 96);
  s = svgSize({ width: '72px', viewBox: '0 0 72 72', generator: 'Generator: Adobe Illustrator 27' });
  assert.equal(s.unit, 'px72'); near(s.mmPerUser * 72, 25.4);
  s = svgSize({});
  near(s.mmPerUser, UNIT_MM.px);
});

test('outlines inside others are holes, cut after the shapes they sit in', () => {
  const sq = (a, b) => [[a, a], [b, a], [b, b], [a, b]];
  const loops = [sq(4, 6), sq(0, 10), sq(20, 30)];
  assert.deepEqual(nesting(loops), [1, 0, 0]);
  const p = newProject();
  p.stock.off = true;
  const fs = svgFeatures(loops, p, { view: 'top', scale: 1, depth: 3, holes: true });
  assert.deepEqual(fs.map((f) => f.op), ['add', 'add', 'cut']);
  const cut = fs[2];
  assert.deepEqual([cut.d0, cut.d1], [3, 0]);
  assert.deepEqual([fs[0].d0, fs[0].d1], [0, 3]);
  // SVG y runs down: the drawing comes out the right way up, centred on the origin
  const ys = fs.flatMap((f) => f.pts.map((q) => q[1] + f.cv));
  near(Math.min(...ys), -15); near(Math.max(...ys), 15);
  // depth 0: flat sketches
  assert.ok(svgFeatures(loops, p, { view: 'top', scale: 1, depth: 0, holes: true }).every((f) => f.d0 === f.d1));
});

test('simplify keeps the corners of a finely sampled square', () => {
  const pts = [];
  for (let i = 0; i <= 100; i++) pts.push([i / 10, 0]);
  for (let i = 1; i <= 100; i++) pts.push([10, i / 10]);
  const s = simplify(pts, 0.005);
  assert.deepEqual(s, [[0, 0], [10, 0], [10, 10]]);
});
