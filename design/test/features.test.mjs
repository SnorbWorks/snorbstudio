// Steps 4-7: polygons, outlines, far-face pockets, pattern/mirror, fillets, gears.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { build } from './build/geometry.mjs';
import { newProject, profile } from './build/model.mjs';
import { defaultGear, gearOutline, gearPath, place, centreDistance, meshRotation } from './build/gears.mjs';

before(async () => {
  const OC = await opencascade({ locateFile: () => new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url).pathname });
  setOC(OC);
});

const feat = (o) => ({ id: o.id || 'a', type: 'rect', view: 'top', cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, d0: 20, d1: 20, op: 'add', through: false, ...o });
const cube = (features, extra = {}) => ({ ...newProject(), features, ...extra });
const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (±${tol})`);
const BLOCK = 8000;

test('a hexagon cut right through', () => {
  const r = build(cube([feat({ type: 'polygon', sides: 6, r: 5, op: 'cut', through: true })]));
  close(r.volume, BLOCK - ((3 * Math.sqrt(3)) / 2) * 25 * 20, 0.5);
  assert.equal(r.effect.a, true);
});

test('an L-shaped outline drawn with the line tool, added on top', () => {
  const pts = [[-5, -5], [5, -5], [5, -2], [-2, -2], [-2, 5], [-5, 5]];
  const r = build(cube([feat({ type: 'poly', pts, d1: 25 })]));
  // L area: 10x3 + 3x7 = 51, 5 mm tall
  close(r.volume, BLOCK + 51 * 5, 0.5);
});

test('a pocket in the far face shows dashed from the top, solid from the bottom', () => {
  const r = build(cube([feat({ w: 10, h: 10, far: true, d0: 0, d1: 5, op: 'cut' })]));
  close(r.volume, BLOCK - 500, 0.5);
  assert.equal(r.effect.a, true);
  assert.ok(r.views.top.hidden.length >= 4, 'hidden outline in the top view');
  assert.equal(r.views.bottom.hidden.length, 0);
  assert.ok(r.views.bottom.visible.length >= 8);
});

test('a far-face through cut goes all the way', () => {
  const r = build(cube([feat({ type: 'circle', r: 3, far: true, d0: 0, d1: 0, op: 'cut', through: true })]));
  close(r.volume, BLOCK - Math.PI * 9 * 20, 0.5);
});

test('a row of three through holes (pattern)', () => {
  const r = build(cube([feat({ type: 'circle', r: 1, cu: -5, op: 'cut', through: true, pattern: { kind: 'linear', count: 3, step: [5, 0, 0], center: [0, 0, 0], axis: [0, 0, 1], angle: 360 } })]));
  close(r.volume, BLOCK - 3 * Math.PI * 20, 0.5);
});

test('four holes round the middle (circular pattern)', () => {
  const r = build(cube([feat({ type: 'circle', r: 1, cu: 6, op: 'cut', through: true, pattern: { kind: 'circular', count: 4, step: [0, 0, 0], center: [0, 0, 20], axis: [0, 0, 1], angle: 360 } })]));
  close(r.volume, BLOCK - 4 * Math.PI * 20, 0.5);
  // one of them lands at y = +6 (90° round)
  const ys = r.views.top.visible.flatMap((l) => l.filter((_, i) => i % 2 === 1));
  assert.ok(ys.some((y) => Math.abs(y - 7) < 0.05), 'a hole reaching y 7');
});

test('a mirrored pocket', () => {
  const r = build(cube([feat({ w: 2, h: 2, cu: 5, d1: 18, op: 'cut', mirror: { axis: 0, at: 0 } })]));
  close(r.volume, BLOCK - 2 * 8, 0.05);
  const xs = r.views.top.visible.flatMap((l) => l.filter((_, i) => i % 2 === 0));
  assert.ok(xs.some((x) => Math.abs(x + 6) < 1e-6) && xs.some((x) => Math.abs(x - 6) < 1e-6));
});

test('spec part: cube with a through hole and filleted top edges', () => {
  const hole = feat({ id: 'h', type: 'circle', r: 3, op: 'cut', through: true });
  const plain = build(cube([hole])).volume;
  const edges = [[0, -10, 20], [10, 0, 20], [0, 10, 20], [-10, 0, 20]];
  const fil = { id: 'f', type: 'fillet', view: 'top', cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, d0: 0, d1: 0, op: 'add', through: false, fillet: { mode: 'fillet', size: 2, edges } };
  const r = build(cube([hole, fil]));
  assert.equal(r.errors.f, undefined, r.errors.f);
  assert.equal(r.effect.f, true);
  // each edge loses r²(1 − π/4) × 20 mm, less a little where the rounds meet at the corners
  const each = 4 * (1 - Math.PI / 4) * 20;
  assert.ok(r.volume < plain - 3.5 * each && r.volume > plain - 4.2 * each, `${plain} → ${r.volume}`);
  // a chamfer takes off r²/2 per mm instead
  const ch = build(cube([hole, { ...fil, fillet: { mode: 'chamfer', size: 2, edges } }]));
  assert.ok(ch.volume < r.volume, 'a chamfer removes more than a fillet of the same size');
});

test('a fillet on edges that are no longer there does nothing (and does not break the part)', () => {
  const fil = { id: 'f', type: 'fillet', view: 'top', cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, d0: 0, d1: 0, op: 'add', through: false, fillet: { mode: 'fillet', size: 1, edges: [[50, 50, 50]] } };
  const r = build(cube([fil]));
  close(r.volume, BLOCK, 0.01);
  assert.equal(r.effect.f, false);
});

// ------------------------------------------------------------ gears

const gearFeat = (id, g, cu = 0, rot = 0) => feat({ id, type: 'gear', gear: { ...defaultGear(), ...g }, cu, rot, d0: 0, d1: 5 });

function inside(poly, [x, y]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const minDist = (a, b) => Math.min(...a.map((p) => Math.min(...b.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])))));

test('spec part: a 20T spur gear meshing with a 10T', () => {
  const m = 1.5, a = centreDistance(m, 20, 10);
  const rot2 = meshRotation(0, 20, 10, 0);
  const g1 = place(gearOutline(m, 20, 20, 1, 1.25, 0.1, 16), 0, 0, 0);
  const g2 = place(gearOutline(m, 10, 20, 1, 1.25, 0.1, 16), a, 0, rot2);
  // in mesh: no tooth inside the other gear, yet they come within the backlash of touching
  assert.ok(!g2.some((p) => inside(g1, p)) && !g1.some((p) => inside(g2, p)), 'teeth collide');
  assert.ok(minDist(g1, g2) < 0.25, `gap ${minDist(g1, g2)}`);
  // turned half a tooth, the same pair collides: the check means something
  const bad = place(gearOutline(m, 10, 20, 1, 1.25, 0.1, 16), a, 0, rot2 + 18);
  assert.ok(bad.some((p) => inside(g1, p)));

  // and as solids, with no block: two separate gears, 5 mm thick
  const r = build(cube([gearFeat('g1', { module: m, teeth: 20 }), gearFeat('g2', { module: m, teeth: 10 }, a, rot2)], { stock: { ...newProject().stock, off: true } }));
  const area = (pts) => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
  const p1 = profile({ ...gearFeat('g1', { module: m, teeth: 20 }) }), p2 = profile({ ...gearFeat('g2', { module: m, teeth: 10 }, a, rot2) });
  close(r.volume, 5 * (area(p1) + area(p2)), 5 * (area(p1) + area(p2)) * 0.01);
  assert.equal(r.effect.g1, true);
  assert.equal(r.effect.g2, true);
});

test('pressure angle and DP: a 14.5° gear has thinner tips than a 25° one', () => {
  const tipWidth = (pa) => {
    const pts = gearOutline(2, 20, pa, 1, 1.25, 0, 32);
    const ra = 2 * 10 + 2;
    const tips = pts.filter((p) => Math.hypot(p[0], p[1]) > ra - 0.3 && Math.abs(Math.atan2(p[1], p[0])) < 0.2);
    const ang = tips.map((p) => Math.atan2(p[1], p[0]));
    return Math.max(...ang) - Math.min(...ang);
  };
  assert.ok(tipWidth(14.5) > tipWidth(25), 'higher pressure angle = pointier teeth');
  // DP 24 is module 25.4/24
  const g = { ...defaultGear(), pitch: 'dp', module: 25.4 / 24, teeth: 24 };
  close(g.module * g.teeth, 25.4, 1e-9);
});

test('helical, ring and rack gears all build', () => {
  const off = { stock: { ...newProject().stock, off: true } };
  const spur = build(cube([gearFeat('g', { teeth: 16 })], off)).volume;
  const hel = build(cube([gearFeat('g', { teeth: 16, kind: 'helical', helix: 20 })], off));
  assert.equal(hel.errors.g, undefined, hel.errors.g);
  close(hel.volume, spur, spur * 0.02);
  const ring = build(cube([gearFeat('g', { teeth: 40, kind: 'ring', rim: 3 })], off));
  assert.equal(ring.errors.g, undefined, ring.errors.g);
  assert.ok(ring.volume > 0);
  const rack = build(cube([gearFeat('g', { teeth: 10, kind: 'rack', rim: 3 })], off));
  assert.equal(rack.errors.g, undefined, rack.errors.g);
  assert.ok(rack.volume > 0);
});

test('a D-shaft bore with a hub and set screw', () => {
  const off = { stock: { ...newProject().stock, off: true } };
  const plain = build(cube([gearFeat('g', { teeth: 20, module: 1.5 })], off)).volume;
  const hub = build(cube([gearFeat('g', { teeth: 20, module: 1.5, hubD: 12, hubLen: 6 })], off)).volume;
  close(hub - plain, Math.PI * 36 * 6, 1);
  const bored = build(cube([gearFeat('g', { teeth: 20, module: 1.5, hubD: 12, hubLen: 6, bore: 'd', boreD: 5, flat: 4.5, screw: 3 })], off));
  assert.equal(bored.errors.g, undefined, bored.errors.g);
  // a round 5 mm bore through 11 mm would take ~216 mm³; the D (and screw hole) a bit different
  assert.ok(bored.volume < hub - 150 && bored.volume > hub - 320, `${hub} → ${bored.volume}`);
});

test('each Bézier flank stays on the true involute (within 0.5% of the module)', () => {
  for (const [m, z, pa] of [[1, 20, 20], [2, 10, 14.5], [1.5, 40, 25], [0.8, 8, 20]]) {
    const rp = (m * z) / 2, rb = rp * Math.cos((pa * Math.PI) / 180);
    const inv = (a) => Math.tan(a) - a;
    const psiB = Math.PI / (2 * z) + inv((pa * Math.PI) / 180);
    const { start, segs } = gearPath(m, z, pa);
    let from = start, worst = 0;
    for (const g of segs) {
      if (g.t === 'C') {
        for (let i = 1; i < 10; i++) {
          const t = i / 10, u = 1 - t;
          const x = u ** 3 * from[0] + 3 * u * u * t * g.c1[0] + 3 * u * t * t * g.c2[0] + t ** 3 * g.p[0];
          const y = u ** 3 * from[1] + 3 * u * u * t * g.c1[1] + 3 * u * t * t * g.c2[1] + t ** 3 * g.p[1];
          const r = Math.hypot(x, y);
          const half = psiB - inv(Math.acos(Math.min(1, rb / r)));
          // nearest tooth centre, then how far off the flank this point sits (as arc length)
          const a = Math.atan2(y, x), k = Math.round((a * z) / (2 * Math.PI)), c = (2 * Math.PI * k) / z;
          const off = Math.abs(Math.abs(((a - c + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) - half) * r;
          worst = Math.max(worst, off);
        }
      }
      from = g.p;
    }
    assert.ok(worst < 0.005 * m, `m${m} z${z} ${pa}°: ${worst.toFixed(5)} mm off`);
  }
});
