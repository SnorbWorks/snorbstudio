// The pen and direct-selection tools: outlines with Bézier sides.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { build } from './build/geometry.mjs';
import { newProject, profile, bounds2d } from './build/model.mjs';
import { toOutline, splitSide, deletePoint, toggleSmooth, moveHandle, movePoint, anchors, sideAt } from './build/pathedit.mjs';

before(async () => {
  const OC = await opencascade({ locateFile: () => new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url).pathname });
  setOC(OC);
});

const feat = (o) => ({ id: 'a', type: 'rect', view: 'top', cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, d0: 20, d1: 25, op: 'add', through: false, ...o });
const close = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const area = (pts) => { let s = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]); return Math.abs(s / 2); };

test('shapes become outlines that look the same', () => {
  for (const f of [feat({ w: 20, h: 10 }), feat({ w: 20, h: 10, corner: 3 }), feat({ type: 'circle', r: 7 }), feat({ type: 'slot', w: 30, h: 8 }), feat({ type: 'polygon', r: 9, sides: 6 })]) {
    const before = area(profile(f, 96)), bb = bounds2d(f);
    const g = JSON.parse(JSON.stringify(f));
    assert.ok(toOutline(g), f.type);
    assert.equal(g.type, 'poly');
    close(area(profile(g, 96)), before, before * 0.01);
    bounds2d(g).forEach((x, i) => close(x, bb[i], 0.05));
  }
});

test('a circle outline builds as a smooth solid of the right volume', () => {
  const f = feat({ type: 'circle', r: 5, d0: 0, d1: 10 });
  toOutline(f);
  const r = build({ ...newProject(), stock: { ...newProject().stock, off: true }, features: [f] });
  close(r.volume, Math.PI * 25 * 10, 2);
});

test('adding a point on a side keeps the shape; deleting it gives the side back', () => {
  const f = feat({ type: 'circle', r: 6 });
  toOutline(f);
  const a0 = area(profile(f, 96));
  const i = splitSide(f, 0, 0.5);
  assert.equal(f.pts.length, 5);
  close(area(profile(f, 96)), a0, a0 * 0.005);
  const m = anchors(f)[i].p;
  close(Math.hypot(m[0], m[1]), 6, 0.01);           // the new point is on the circle
  assert.ok(deletePoint(f, i));
  assert.equal(f.pts.length, 4);
  close(area(profile(f, 96)), a0, a0 * 0.06);       // the joined side keeps the outer handles: near, not exact
});

test('splitting an arc side keeps it round', () => {
  const f = feat({ type: 'slot', w: 30, h: 10 });
  toOutline(f);
  const a0 = area(profile(f, 96));
  const k = f.bulges.findIndex((b) => Math.abs(b) > 0);
  splitSide(f, k, 0.5);
  close(area(profile(f, 96)), a0, a0 * 0.005);
});

test('a corner made smooth gets handles; dragging one turns the other', () => {
  const f = feat({ w: 20, h: 20 });
  toOutline(f);
  toggleSmooth(f, 1);
  let an = anchors(f)[1];
  assert.ok(an.inH && an.outH && an.smooth);
  moveHandle(f, 1, 'out', [an.p[0] + 3, an.p[1] + 6]);
  an = anchors(f)[1];
  // the in handle is in line, the other way
  const ux = an.outH[0] - an.p[0], uy = an.outH[1] - an.p[1], vx = an.inH[0] - an.p[0], vy = an.inH[1] - an.p[1];
  close(ux * vy - uy * vx, 0, 1e-3);
  assert.ok(ux * vx + uy * vy < 0);
  toggleSmooth(f, 1);
  assert.equal(f.curves, undefined);
});

test('moving a point carries its handles; the nearest side is found', () => {
  const f = feat({ type: 'circle', r: 6 });
  toOutline(f);
  const before = anchors(f)[0];
  movePoint(f, 0, [before.p[0] + 2, before.p[1]]);
  const after = anchors(f)[0];
  close(after.outH[0] - after.p[0], before.outH[0] - before.p[0]);
  assert.equal(sideAt(f, [-4.3, -4.3], 0.2)?.k, 2);
});
