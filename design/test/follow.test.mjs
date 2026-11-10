// Fillets that follow their edges, and library STLs as the body.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { build, bases, importMesh } from './build/geometry.mjs';
import { newProject, findRef } from './build/model.mjs';

before(async () => {
  const OC = await opencascade({ locateFile: () => new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url).pathname });
  setOC(OC);
});

const feat = (o) => ({ id: o.id || 'a', type: 'rect', view: 'top', cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, d0: 20, d1: 20, op: 'add', through: false, ...o });
const fillet = (p, pts, size = 2, idx = p.features.length) => ({
  id: 'f', type: 'fillet', view: 'top', cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, d0: 0, d1: 0, op: 'add', through: false,
  fillet: { mode: 'fillet', size, edges: pts, refs: pts.map((pt) => findRef(pt, p, idx)) },
});
const filletLoss = (size, len) => size * size * (1 - Math.PI / 4) * len;

test('a fillet on the body follows it when the body gets wider', () => {
  const p = { ...newProject(), features: [] };
  const edge = [10, 0, 20];                                 // top edge on the +X side
  p.features.push(fillet(p, [edge]));
  const r0 = build(p);
  assert.equal(r0.effect.f, true);
  // the body grows to 30 wide (left side stays): that edge is now at x = 20
  p.stock.max[0] = 20;
  const r1 = build(p);
  assert.equal(r1.effect.f, true, 'still rounded');
  assert.deepEqual(r1.fillets.f[0].map((x) => +x.toFixed(4)), [20, 0, 20]);
  assert.ok(Math.abs(r1.volume - (30 * 20 * 20 - filletLoss(2, 20))) < 0.5);
});

test('a fillet on a hole rim follows the hole when it gets bigger', () => {
  const p = { ...newProject(), features: [feat({ id: 'h', type: 'circle', r: 3, op: 'cut', through: true })] };
  p.features.push(fillet(p, [[-3, 0, 20]], 1));
  const ref = p.features[1].fillet.refs[0];
  assert.equal(ref.owner, 'h', 'the edge belongs to the hole, not the body');
  assert.equal(build(p).effect.f, true);
  p.features[0].r = 5;
  const r = build(p);
  assert.equal(r.effect.f, true, 'the bigger rim is still rounded');
  assert.ok(Math.abs(r.fillets.f[0][0] + 5) < 1e-3, `rim now at x -5, got ${r.fillets.f[0]}`);
});

test('a fillet on a copy in a pattern follows that copy', () => {
  const pat = { kind: 'linear', count: 2, step: [8, 0, 0], center: [0, 0, 0], axis: [0, 0, 1], angle: 360 };
  const p = { ...newProject(), features: [feat({ id: 'h', type: 'circle', r: 2, cu: -4, op: 'cut', through: true, pattern: pat })] };
  p.features.push(fillet(p, [[2, 0, 20]], 0.5));           // the second hole's rim (centre x 4, r 2)
  assert.equal(p.features[1].fillet.refs[0].inst, 1);
  pat.step[0] = 10;                                        // copies further apart: second hole centre x 6
  const r = build(p);
  assert.equal(r.effect.f, true);
  assert.ok(Math.abs(r.fillets.f[0][0] - 4) < 1e-3, `${r.fillets.f[0]}`);
});

test('an edge that is really gone is reported, not silently dropped', () => {
  const p = { ...newProject(), features: [feat({ id: 'h', type: 'circle', r: 3, op: 'cut', through: true })] };
  p.features.push(fillet(p, [[-3, 0, 20], [10, 0, 20]], 1));
  p.features[0].op = 'add';                                // the hole becomes a boss inside the body: rim gone
  p.features[0].through = false; p.features[0].d1 = 20;
  const r = build(p);
  assert.equal(r.fillets.f[0], null, 'the rim edge is lost');
  assert.ok(r.fillets.f[1], 'the body edge is still there');
  assert.equal(r.effect.f, true);
});

test('a library STL (the Pi 5 tray) as the body, with a hole cut and an edge rounded', () => {
  const name = 'pi5_case_tray.stl';
  bases[name] = importMesh(new Uint8Array(readFileSync(new URL('../../../models/' + name, import.meta.url))));
  const p = { ...newProject(), base: { model: name }, features: [] };
  const r0 = build(p, ['top', 'front']);
  assert.ok(Math.abs(r0.volume - 19004) < 2, `${r0.volume}`);
  const [mn, mx] = r0.baseBox;
  assert.ok(r0.views.top.visible.length > 20 && r0.views.front.hidden.length > 0);
  // a 4 mm hole through the floor, in the middle
  const cx = (mn[0] + mx[0]) / 2 + 20, cy = (mn[1] + mx[1]) / 2;
  p.features.push(feat({ id: 'h', type: 'circle', cu: cx, cv: cy, r: 2, d0: 2, d1: 2, op: 'cut', through: true }));
  p.stock = { min: mn, max: mx };
  const r1 = build(p, ['top']);
  assert.equal(r1.effect.h, true);
  assert.ok(Math.abs(r0.volume - r1.volume - Math.PI * 4 * 2) < 1, `${r0.volume - r1.volume}`);
  // round the bottom edge along the front (y min, z 0), half way along x
  p.features.push(fillet(p, [[(mn[0] + mx[0]) / 2, mn[1], 0]], 1));
  assert.equal(p.features[1].fillet.refs[0].owner, 'stock');
  const r2 = build(p, ['top']);
  assert.equal(r2.errors.f, undefined, r2.errors.f);
  assert.equal(r2.effect.f, true);
});

test('an STL that is too detailed is refused with a reason', () => {
  const n = 70000, buf = new Uint8Array(84 + 50 * n);
  new DataView(buf.buffer).setUint32(80, n, true);
  assert.throws(() => importMesh(buf), /70,000 triangles/);
});
