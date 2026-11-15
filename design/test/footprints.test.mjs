// Save › Footprints: shapes saved from a part, dropped on another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newProject, nearDepth } from './build/model.mjs';
import { footprintFrom, savedFootprint, placeFootprint, FOOTPRINTS } from './build/footprints.mjs';

const feat = (o) => ({ id: o.id || 'a', type: 'circle', view: 'top', cu: 0, cv: 0, w: 0, h: 0, r: 2, corner: 0, d0: 0, d1: -5, op: 'cut', through: false, ...o });

test('a footprint is centred, with depths from the face it was drawn on', () => {
  const p = { ...newProject(), name: 'bracket' };
  const top = nearDepth('top', p);
  const holes = [feat({ id: 'h1', cu: 10, cv: 10, d0: top, d1: top - 4 }), feat({ id: 'h2', cu: 30, cv: 20, d0: top, d1: top - 4 })];
  const { fp, skipped } = footprintFrom(holes, p, 'two holes');
  assert.equal(skipped, 0);
  assert.equal(fp.view, 'top');
  assert.deepEqual(fp.features.map((f) => [f.cu, f.cv, f.d0, f.d1]), [[-10, -5, 0, -4], [10, 5, 0, -4]]);
  assert.match(fp.note, /2 shapes, 24 × 14 mm, from “bracket”/);
});

test('shapes on another view are left out', () => {
  const p = newProject();
  const { fp, skipped } = footprintFrom([feat({ id: 'a' }), feat({ id: 'b', view: 'front' })], p, 'x');
  assert.equal(fp.features.length, 1);
  assert.equal(skipped, 1);
});

test('a saved footprint drops on the same face of another part, new ids each time', () => {
  const src = newProject();
  const front = nearDepth('front', src);
  const { fp } = footprintFrom([feat({ id: 'a', view: 'front', cu: 5, cv: 5, d0: front, d1: front - 3 })], src, 'led');
  const dst = { ...newProject(), stock: { ...newProject().stock, min: [0, 0, 0], max: [40, 30, 20] } };
  const shelf = savedFootprint(JSON.parse(JSON.stringify(fp)));
  assert.equal(shelf.mine, true);
  const a = placeFootprint(shelf, dst), b = placeFootprint(shelf, dst);
  assert.notEqual(a[0].id, b[0].id);
  assert.equal(a[0].view, 'front');
  const d = nearDepth('front', dst);
  assert.equal(a[0].d0, d);
  assert.equal(a[0].d1, d - 3);
  assert.deepEqual([a[0].cu, a[0].cv], [20, 10]);     // the middle of the front face (x 20, z 10)
});

test('the ready-made ones still go on the top', () => {
  const p = newProject();
  const f = placeFootprint(FOOTPRINTS.find((x) => x.id === 'led5'), p);
  assert.equal(f[0].view, 'top');
  assert.equal(f[0].d0, nearDepth('top', p));
});

test('a click on one grouped shape picks the whole group', async () => {
  const { withGroups } = await import('./build/model.mjs');
  const fs = [feat({ id: 'a', group: 'g' }), feat({ id: 'b', group: 'g' }), feat({ id: 'c' })];
  assert.deepEqual(withGroups(fs, ['a']).sort(), ['a', 'b']);
  assert.deepEqual(withGroups(fs, ['c']), ['c']);
});
