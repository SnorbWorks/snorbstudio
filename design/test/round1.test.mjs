// Round 1: holes (every kind), printer fit, slots, outlines with arcs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { build } from './build/geometry.mjs';
import { newProject, profile, bounds2d } from './build/model.mjs';
import { holeFromTable } from './build/holes.mjs';

before(async () => {
  const OC = await opencascade({ locateFile: () => new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url).pathname });
  setOC(OC);
});

const feat = (o) => ({ id: o.id || 'a', type: 'rect', view: 'top', cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, d0: 20, d1: 20, op: 'add', through: false, ...o });
const cube = (features, extra = {}) => ({ ...newProject(), features, ...extra });
const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (±${tol})`);
const BLOCK = 8000;
const disc = (d) => Math.PI * (d / 2) ** 2;
const hole = (spec, o = {}) => feat({ type: 'hole', hole: spec, r: spec.d / 2, op: 'cut', through: true, ...o });

test('M3 clearance hole, through, no fit', () => {
  const h = holeFromTable('M3', 'clear', 'normal');
  assert.equal(h.d, 3.4);
  const r = build(cube([hole(h)], { fit: 0 }));
  close(r.volume, BLOCK - disc(3.4) * 20, 0.3);
  assert.equal(r.effect.a, true);
});

test('printer fit makes the hole bigger across', () => {
  const r = build(cube([hole(holeFromTable('M3', 'clear', 'normal'))], { fit: 0.2 }));
  close(r.volume, BLOCK - disc(3.6) * 20, 0.3);
});

test('fit can be turned off for one hole', () => {
  const r = build(cube([hole(holeFromTable('M3', 'clear', 'normal'), { fit: false })], { fit: 0.2 }));
  close(r.volume, BLOCK - disc(3.4) * 20, 0.3);
});

test('a counterbore at the top face', () => {
  const h = holeFromTable('M3', 'cbore', 'normal');
  const r = build(cube([hole(h)], { fit: 0 }));
  close(r.volume, BLOCK - disc(h.d) * 20 - (disc(h.headD) - disc(h.d)) * h.headDepth, 0.5);
});

test('a 90° countersink', () => {
  const h = holeFromTable('M3', 'csk', 'normal');
  const r = build(cube([hole(h)], { fit: 0 }));
  const R1 = h.headD / 2, R2 = h.d / 2, depth = R1 - R2;
  const frustum = (Math.PI * depth / 3) * (R1 * R1 + R1 * R2 + R2 * R2);
  close(r.volume, BLOCK - disc(h.d) * 20 - (frustum - disc(h.d) * depth), 0.5);
});

test('a nut trap on the bottom', () => {
  const h = holeFromTable('M3', 'nut', 'normal');
  const r = build(cube([hole(h)], { fit: 0 }));
  const hexA = (Math.sqrt(3) / 2) * h.nutAF ** 2;
  close(r.volume, BLOCK - disc(h.d) * 20 - (hexA - disc(h.d)) * h.nutDepth, 0.5);
  // the hex shows from the bottom, hidden from the top
  assert.ok(r.views.bottom.visible.length >= 7, 'hex seen from the bottom');
});

test('a blind heat-set insert hole', () => {
  const h = holeFromTable('M3', 'insert');
  assert.equal(h.d, 4.0);
  const depth = h.insertLen + 0.5;
  const r = build(cube([hole(h, { through: false, d1: 20 - depth })], { fit: 0.2 }));
  close(r.volume, BLOCK - disc(4.2) * depth, 0.5);
});

test('a slot cut through takes the fit on its length and width', () => {
  const r = build(cube([feat({ type: 'slot', w: 10, h: 4, op: 'cut', through: true })], { fit: 0.2 }));
  const L = 10.2, W = 4.2;
  close(r.volume, BLOCK - ((L - W) * W + disc(W)) * 20, 0.5);
});

test('a slot turned 90° and an added slot (no fit)', () => {
  const s = feat({ type: 'slot', w: 10, h: 4, rot: 90, d1: 25 });
  const [u0, v0, u1, v1] = bounds2d(s);
  close(u1 - u0, 4, 0.05); close(v1 - v0, 10, 0.05);
  const r = build(cube([s], { fit: 0.2 }));
  close(r.volume, BLOCK + (6 * 4 + disc(4)) * 5, 0.5);
});

test('an outline with one side bowed out', () => {
  // a 10 x 10 square, its right side (corner 1 to 2) bowed 2 mm outward
  const pts = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
  const f = feat({ type: 'poly', pts, bulges: [0, 2, 0, 0], d1: 25 });
  const R = (25 + 4) / 4, s = 2;
  const seg = R * R * Math.acos((R - s) / R) - (R - s) * Math.sqrt(2 * R * s - s * s);
  const r = build(cube([f]));
  close(r.volume, BLOCK + 5 * (100 + seg), 0.5);
  const [, , u1] = bounds2d(f);
  close(u1, 7, 0.05);
  // the same outline drawn the other way round still bows outward
  const back = feat({ type: 'poly', pts: [...pts].reverse(), bulges: [0, 0, -2, 0], d1: 25 });
  close(build(cube([back])).volume, BLOCK + 5 * (100 + seg), 0.5);
  assert.ok(profile(f).length >= 19, "the arc is drawn as many points");
});
