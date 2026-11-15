// Components: linked copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newProject, nearDepth } from './build/model.mjs';
import { makeComponent, linkCopy, insertCopy, differs, defFromCopy, updateCopies, copiesOf, members, detach } from './build/components.mjs';

const hole = (id, cu, cv, top) => ({ id, type: 'circle', view: 'top', cu, cv, w: 0, h: 0, r: 2, corner: 0, d0: top, d1: top - 4, op: 'cut', through: false });

function setup() {
  const p = newProject();
  const top = nearDepth('top', p);
  p.features = [hole('a', -5, 0, top), hole('b', 5, 0, top)];
  const { def } = makeComponent(p, p.features, 'pair');
  linkCopy(p, p.features, def);
  const more = insertCopy(p, def);
  p.features.push(...more);
  return { p, def, first: p.features[0].comp.inst, second: more[0].comp.inst };
}

test('saving shapes as a component makes them its first copy; inserting makes another', () => {
  const { p, first, second } = setup();
  assert.notEqual(first, second);
  assert.equal(copiesOf(p, 'pair').length, 2);
  assert.equal(differs(p, first), false);
  assert.equal(differs(p, second), false);
});

test('moving a copy is not a change; resizing one is', () => {
  const { p, first } = setup();
  for (const f of members(p, first)) { f.cu += 30; f.cv -= 7; }
  assert.equal(differs(p, first), false);
  members(p, first)[1].r = 3.5;
  assert.equal(differs(p, first), true);
});

test('Update every copy: the others take the change where they sit', () => {
  const { p, first, second } = setup();
  for (const f of members(p, second)) f.cu += 40;           // the second copy moved away
  const at = members(p, second).map((f) => [f.cu, f.cv]);
  members(p, first)[1].r = 3.5;
  const def = defFromCopy(p, first);
  assert.equal(updateCopies(p, def), 2);
  assert.equal(members(p, second)[1].r, 3.5);
  assert.deepEqual(members(p, second).map((f) => [f.cu, f.cv]), at);
  assert.equal(differs(p, first), false);
  assert.equal(differs(p, second), false);
});

test('reset puts one copy back; detach unlinks it', () => {
  const { p, def, first, second } = setup();
  members(p, first)[0].r = 9;
  updateCopies(p, def, first);
  assert.equal(members(p, first)[0].r, 2);
  detach(p, second);
  assert.equal(copiesOf(p, 'pair').length, 1);
  assert.equal(p.features.length, 4);
});

test('a copy on another face stays a copy (not "changed") and updates there', async () => {
  const { insertCopy: ins } = await import('./build/components.mjs');
  const { p, def, first } = setup();
  const side = ins(p, def, 'front');
  p.features.push(...side);
  const inst = side[0].comp.inst;
  assert.equal(side[0].view, 'front');
  assert.equal(side[0].d0, nearDepth('front', p));
  assert.equal(differs(p, inst), false);
  members(p, first)[0].r = 3;
  updateCopies(p, defFromCopy(p, first));
  assert.equal(members(p, inst)[0].r, 3);
  assert.equal(members(p, inst)[0].view, 'front');
});
