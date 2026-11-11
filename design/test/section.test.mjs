// Section views.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { build } from './build/geometry.mjs';
import { newProject } from './build/model.mjs';
import { sectionFor, flipSection, cuttingLine, cutPlane } from './build/section.mjs';

before(async () => {
  const OC = await opencascade({ locateFile: () => new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url).pathname });
  setOC(OC);
});

const area = (l) => { let a = 0; for (let i = 0; i + 3 < l.length; i += 2) a += l[i] * l[i + 3] - l[i + 2] * l[i + 1]; return Math.abs(a) / 2; };
const part = () => {
  const p = newProject();
  p.stock = { min: [-20, -15, 0], max: [20, 15, 20] };
  p.features.push({ id: 'h', type: 'circle', view: 'top', cu: 0, cv: 0, w: 0, h: 0, r: 5, corner: 0, d0: 20, d1: 0, op: 'cut', through: true });
  return p;
};

test('a level line on the top view is a front section; flipping looks from the back', () => {
  const p = part();
  const s = sectionFor(p, 'top', 'u', 3, 0);
  assert.equal(s.view, 'front'); assert.equal(s.label, 'A');
  assert.deepEqual(cutPlane(s), { axis: 1, at: 0 });
  const f = flipSection({ id: 'x', ...s });
  assert.equal(f.view, 'back'); assert.deepEqual(cutPlane(f), { axis: 1, at: 0 });
  // the line on the top view runs along X at Y 0, looking toward +Y (up the top view)
  const cl = cuttingLine({ id: 'x', ...s }, [-25, -20], [25, 20]);
  assert.deepEqual(cl.a, [-25, 0]); assert.deepEqual(cl.b, [25, 0]);
  assert.deepEqual(cl.look, [0, 1]);
  const pl = sectionFor(p, 'top', 'v', 7, 0);
  assert.equal(pl.view, 'right'); assert.deepEqual(cutPlane({ id: 'y', ...pl }), { axis: 0, at: 7 });
});

test('the section through the hole hatches the two sides of it', () => {
  const p = part();
  p.sections = [{ id: 's', ...sectionFor(p, 'top', 'u', 0, 0) }];
  const r = build(p, ['top', 'front'], false, false);
  assert.ok(!Object.keys(r.errors).length, JSON.stringify(r.errors));
  const h = r.hatch.front;
  assert.equal(h.length, 2);
  const total = h.reduce((a, l) => a + area(l), 0);
  assert.ok(Math.abs(total - 600) < 0.5, String(total));
  // the hole shows as plain lines in the section (its walls), not hidden
  assert.ok(r.views.front.visible.length > 4);
});

test('a cut off to one side hatches the whole face, holes and all', () => {
  const p = part();
  p.sections = [{ id: 's', ...sectionFor(p, 'front', 'u', 0, 10) }];   // level line on the front at Z 10: a top section
  assert.equal(p.sections[0].view, 'top');
  const r = build(p, ['top', 'front'], false, false);
  const h = r.hatch.top;
  // 40 x 30 with a 10 mm hole in it: the outline and the hole as two loops
  assert.equal(h.length, 2);
  const [big, small] = h.map(area).sort((a, b) => b - a);
  assert.ok(Math.abs(big - 1200) < 0.5 && Math.abs(small - Math.PI * 25) < 0.5, `${big} ${small}`);
});
