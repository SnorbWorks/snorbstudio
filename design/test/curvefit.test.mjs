// Traced outlines (SVG imports) become a few Béziers: corners stay sharp, straight runs stay straight.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import opencascade from 'replicad-opencascadejs';
import { setOC, measureVolume } from 'replicad';
import { fitOutline, curveFeature, curveProject } from './build/curvefit.mjs';
import { buildSolid } from './build/geometry.mjs';
import { newProject, polyPath } from './build/model.mjs';
import { svgFeatures } from './build/svgimport.mjs';

before(async () => {
  const OC = await opencascade({ locateFile: () => new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url).pathname });
  setOC(OC);
});

const ring = (n, r, cx = 0, cy = 0) => Array.from({ length: n }, (_, k) => [cx + r * Math.cos((2 * Math.PI * k) / n), cy + r * Math.sin((2 * Math.PI * k) / n)]);
const bez = (P, c, Q, t) => { const s = 1 - t; return [0, 1].map((i) => s * s * s * P[i] + 3 * s * s * t * c[0][i] + 3 * s * t * t * c[1][i] + t * t * t * Q[i]); };
/** Furthest any traced point sits from the fitted outline (sampled densely). */
function worst(raw, fit) {
  const n = fit.pts.length, dense = [];
  for (let k = 0; k < n; k++) {
    const P = fit.pts[k], Q = fit.pts[(k + 1) % n], c = fit.curves[k];
    for (let i = 0; i < 200; i++) { const t = i / 200; dense.push(c ? bez(P, c, Q, t) : [P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]); }
  }
  return Math.max(...raw.map((q) => Math.min(...dense.map((d) => Math.hypot(d[0] - q[0], d[1] - q[1])))));
}

test('a circle traced in 600 points comes back as a handful of smooth curves', () => {
  const raw = ring(600, 10);
  const f = fitOutline(raw);
  assert.ok(f.pts.length <= 8, `${f.pts.length} anchors`);
  assert.ok(f.curves.every((c) => c), 'all curves');
  assert.ok(f.smooth.every((s) => s), 'all smooth points');
  assert.ok(worst(raw, f) < 0.06, `off by ${worst(raw, f)}`);
});

test('a traced square keeps four sharp corners and straight sides', () => {
  const raw = [];
  const C = [[0, 0], [20, 0], [20, 20], [0, 20]];
  for (let k = 0; k < 4; k++) for (let i = 0; i < 50; i++) { const a = C[k], b = C[(k + 1) % 4]; raw.push([a[0] + (b[0] - a[0]) * i / 50, a[1] + (b[1] - a[1]) * i / 50]); }
  const f = fitOutline(raw);
  assert.equal(f.pts.length, 4);
  assert.ok(f.curves.every((c) => c === null), 'straight sides');
  assert.ok(f.smooth.every((s) => !s), 'sharp corners');
});

test('a D shape: two corners, a straight back and one curved side', () => {
  const raw = [];
  for (let i = 0; i < 80; i++) raw.push([0, 10 - i / 4]);                                    // straight down
  for (let i = 0; i < 300; i++) { const a = -Math.PI / 2 + (Math.PI * i) / 300; raw.push([10 * Math.cos(a), 10 * Math.sin(a)]); }
  const f = fitOutline(raw);
  assert.equal(f.smooth.filter((s) => !s).length, 2, 'two corners');
  assert.ok(f.curves.some((c) => c === null), 'the straight back');
  assert.ok(worst(raw, f) < 0.06);
});

test('opening an old part: dense outlines become curves, the part keeps its size', () => {
  const pts = ring(400, 6).map(([u, v]) => [+u.toFixed(4), +v.toFixed(4)]);
  const feat = { id: 'c', type: 'poly', view: 'top', cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, pts, d0: 0, d1: 5, op: 'cut', through: false };
  const p = { ...newProject(), features: [feat] };
  assert.equal(curveProject(p), 1);
  assert.ok(feat.pts.length < 10 && feat.curves.length === feat.pts.length);
  const { solid } = buildSolid(p);
  const v = measureVolume(solid), want = 8000 - Math.PI * 36 * 5;
  assert.ok(Math.abs(v - want) < 2, `${v} vs ${want}`);
  // a hand-drawn outline (few points, or curves already) is left alone
  const mine = { ...feat, id: 'm', pts: [[0, 0], [5, 0], [5, 5]], curves: undefined };
  assert.equal(curveFeature(mine), false);
});

test('an SVG import comes in as curves', () => {
  const loops = [ring(500, 50, 100, 100), ring(300, 20, 100, 100)];
  const fs = svgFeatures(loops, newProject(), { view: 'top', scale: 0.1, depth: 2, holes: true });
  assert.equal(fs.length, 2);
  for (const f of fs) { assert.ok(f.pts.length <= 10, `${f.pts.length} anchors`); assert.ok(f.curves.some((c) => c)); }
});

test('letters whose boxes overlap but shapes do not are built together, right', () => {
  // an L and a block tucked into its corner: boxes overlap, shapes are 1 mm apart
  const L = { id: 'L', type: 'poly', view: 'top', cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, pts: [[-8, -8], [8, -8], [8, -5], [-5, -5], [-5, 8], [-8, 8]], d0: 0, d1: 2, op: 'cut', through: false };
  const B = { ...L, id: 'B', pts: [[-4, -4], [0, -4], [0, 0], [-4, 0]] };
  const C = { ...L, id: 'C', pts: [[2, 2], [4, 2], [4, 4], [2, 4]] };
  const D = { ...L, id: 'D', pts: [[-4, 2], [-2, 2], [-2, 4], [-4, 4]] };
  const X = { ...L, id: 'X', pts: [[-6, -6], [-3, -6], [-3, -3], [-6, -3]] };   // overlaps the L: built on its own
  const p = { ...newProject(), features: [L, B, C, D, X] };
  const { solid, errors } = buildSolid(p);
  assert.deepEqual(errors, {});
  const Larea = 16 * 3 + 3 * 13, overlapLX = 1 * 3 + 2 * 1, Xarea = 9;
  const want = 8000 - 2 * (Larea + 16 + 4 + 4 + Xarea - overlapLX - 1);   // X also overlaps B by 1x1
  assert.ok(Math.abs(measureVolume(solid) - want) < 1e-6, `${measureVolume(solid)} vs ${want}`);
});
