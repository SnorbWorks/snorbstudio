// Revolve: a shape spun round a centre line on its side.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { build } from './build/geometry.mjs';
import { newProject, revolveAxis, revolveCrosses, rotateFeature, featureCorners } from './build/model.mjs';

before(async () => {
  const OC = await opencascade({ locateFile: () => new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url).pathname });
  setOC(OC);
});

const rect = (o) => ({ id: 'r', type: 'rect', view: 'front', cu: 5, cv: 10, w: 10, h: 20, r: 0, corner: 0, d0: 0, d1: 0, op: 'add', through: false, ...o });

test('a rectangle spun round its left side is a cylinder', () => {
  const p = newProject();
  p.stock.off = true;
  const f = rect();
  f.revolve = { ...revolveAxis(f, 'left'), angle: 360 };
  assert.deepEqual(f.revolve.at, [-5, 0]);
  p.features.push(f);
  const r = build(p, ['top', 'front'], false, false);
  assert.ok(!r.errors.r, r.errors.r);
  assert.ok(Math.abs(r.volume - Math.PI * 100 * 20) < 5, String(r.volume));
  // its box: radius 10 every way across, 20 tall
  const cs = featureCorners(f);
  const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]), zs = cs.map((c) => c[2]);
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys), Math.min(...zs), Math.max(...zs)].map((x) => +x.toFixed(6)), [-10, 10, -10, 10, 0, 20]);
});

test('half way round is half the volume; a spun cut makes a groove', () => {
  const p = newProject();
  p.stock.off = true;
  const f = rect();
  f.revolve = { ...revolveAxis(f, 'left'), angle: 180 };
  p.features.push(f);
  let r = build(p, [], false, false);
  assert.ok(Math.abs(r.volume - Math.PI * 100 * 10) < 5, String(r.volume));
  f.revolve.angle = 360;
  // a 2 x 2 groove round it, 1 mm in from the outside... spun about the same line
  const g = rect({ id: 'g', cu: 9, cv: 10, w: 2, h: 2, op: 'cut' });
  g.revolve = { at: [-9, 0], dir: [0, 1], angle: 360 };
  p.features.push(g);
  r = build(p, [], false, false);
  const groove = Math.PI * (100 - 64) * 2;
  assert.ok(Math.abs(r.volume - (Math.PI * 100 * 20 - groove)) < 5, String(r.volume));
});

test('crossing the centre line is an error; rotating carries the line', () => {
  const f = rect();
  f.revolve = { at: [0, 0], dir: [0, 1], angle: 360 };
  assert.equal(revolveCrosses(f), true);
  const p = newProject(); p.stock.off = true; p.features.push(f);
  const r = build(p, [], false, false);
  assert.match(r.errors.r, /crosses its centre line/);
  const h = rect();
  h.revolve = { ...revolveAxis(h, 'left'), angle: 360 };
  rotateFeature(h, [0, 0, 0], [0, -1, 0], 90);   // front view looks along -Y
  assert.deepEqual(h.revolve.dir.map((x) => Math.round(x)), [-1, 0]);
  assert.equal(revolveCrosses(h), false);
});
