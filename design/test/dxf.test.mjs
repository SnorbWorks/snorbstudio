// DXF export of a view: what comes out reads back in (SnorbCAM's importer) at the same size.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { build } from './build/geometry.mjs';
import { newProject } from './build/model.mjs';
import { viewDxf, joinLines } from './build/dxf.mjs';
import { importDxf } from './build/cam/importers.mjs';

before(async () => {
  const OC = await opencascade({ locateFile: () => new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url).pathname });
  setOC(OC);
});

test('joinLines makes one closed loop from four pieces, any direction', () => {
  const out = joinLines([[0, 0, 10, 0], [10, 10, 10, 0], [10, 10, 0, 10], [0, 0, 0, 10]]);
  assert.equal(out.length, 1);
  const l = out[0];
  assert.equal(l.length, 10);
  assert.deepEqual([l[0], l[1]], [l[8], l[9]]);
});

test('top view of a 40 x 30 plate with a 10 mm hole round-trips through DXF', () => {
  const p = newProject();
  p.stock = { min: [-20, -15, 0], max: [20, 15, 5] };
  p.features.push({ id: 'h', type: 'circle', view: 'top', cu: 5, cv: 0, w: 0, h: 0, r: 5, corner: 0, d0: 5, d1: -1, op: 'cut', through: true });
  const r = build(p, ['top'], false, true);
  const dxf = viewDxf(r.views.top);
  assert.match(dxf, /AC1009/);
  assert.match(dxf, /\$INSUNITS\n70\n4/);
  const part = importDxf(dxf, 't');
  assert.equal(part.contours.length, 2, 'outline + hole');
  const box = (c) => { const xs = c.pts.map((q) => q[0]), ys = c.pts.map((q) => q[1]); return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]; };
  const sizes = part.contours.map(box).sort((a, b) => b[0] - a[0]);
  assert.ok(Math.abs(sizes[0][0] - 40) < 0.01 && Math.abs(sizes[0][1] - 30) < 0.01, `outline ${sizes[0]}`);
  assert.ok(Math.abs(sizes[1][0] - 10) < 0.05 && Math.abs(sizes[1][1] - 10) < 0.05, `hole ${sizes[1]}`);
  assert.ok(part.contours.every((c) => c.closed), 'both closed');
});
