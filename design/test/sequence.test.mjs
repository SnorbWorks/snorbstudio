// SnorbCAM: the cut order (automatic sorting, hand arrangement, tool changes, stages).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newJob, newOp, IN } from './build/cam/job.mjs';
import { planJob, movesFor, gcode } from './build/cam/toolpath.mjs';
import { sequence, runList, toSeq, newStep, groupOf, describeStep } from './build/cam/sequence.mjs';

const square = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const circle = (cx, cy, r, n = 24) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)]);
const k = (id, pts, op) => ({ id, pts, closed: true, op });
// a plate: cut out round the outside, a big window, a pocket, and two small holes
function plate(bitForHoles) {
  const j = newJob();
  const hole = () => ({ ...newOp('inside', 20), bit: bitForHoles });
  j.parts = [{ id: 'p', name: 'plate', source: 'svg', contours: [
    k('out', square(0, 0, 300), newOp('outside', 20)),
    k('win', square(40, 40, 80), newOp('inside', 20)),
    k('h1', circle(200, 60, 8), hole()),
    k('poc', square(150, 150, 90), newOp('pocket', 6)),
    k('h2', circle(250, 60, 8), hole()),
  ] }];
  j.placed = [{ id: 'a', part: 'p', x: 50, y: 50, rot: 0 }];
  return j;
}
const cutsOf = (es) => es.filter((e) => e.t === 'cut').map((e) => e.cut.key.split(':')[1]);

test('automatic order: holes, then pockets, then inside cuts, the cut-out last', () => {
  const j = plate();
  const es = sequence(j, planJob(j));
  const order = cutsOf(es);
  assert.equal(order.length, 5);
  assert.deepEqual(order.slice(0, 2).sort(), ['h1', 'h2']);
  assert.equal(order[2], 'poc');
  assert.equal(order[3], 'win');
  assert.equal(order[4], 'out');
  assert.equal(es.filter((e) => e.t === 'step').length, 0, 'one bit: no tool change');
  assert.equal(groupOf(es[0].cut), 'hole');
});

test('a second bit: one automatic tool change, exactly where the bit changes', () => {
  const j = plate('s125');
  assert.ok(j.bits.find((b) => b.id === 's125') || j.bits.push({ ...j.bits[0], id: 's125', name: '1/8" bit', dia: 3.175 }));
  const es = sequence(j, planJob(j));
  const steps = es.filter((e) => e.t === 'step');
  assert.equal(steps.length, 1, 'the 1/8" holes first, then everything the cut-out bit does');
  assert.ok(steps.every((s) => s.step.kind === 'toolchange' && s.step.auto && s.step.rezero));
  const run = runList(es);
  assert.deepEqual(run.map((r) => r.t), ['stage', 'step', 'stage']);
  assert.deepEqual(cutsOf(es).slice(0, 2).sort(), ['h1', 'h2']);
  assert.ok(run.filter((r) => r.t === 'stage').every((r) => new Set(r.stage.cuts.map((c) => c.bit.id)).size === 1), 'one bit per stage');
  assert.equal(cutsOf(es).at(-1), 'out');
});

test('arranging by hand: the order is kept, steps stay put, new cuts are slotted in', () => {
  const j = plate();
  let es = sequence(j, planJob(j));
  // move the window to the front and put a pause after it
  const win = es.findIndex((e) => e.t === 'cut' && e.cut.key.endsWith(':win'));
  const list = [...es]; const [it] = list.splice(win, 1); list.unshift(it);
  const pause = newStep('pause', 'Clear the chips'); pause.goto = 'Load Material';
  list.splice(1, 0, { t: 'step', step: pause });
  j.seq = toSeq(list);
  es = sequence(j, planJob(j));
  assert.equal(cutsOf(es)[0], 'win');
  assert.equal(es[1].t, 'step');
  assert.equal(es[1].step.name, 'Clear the chips');
  assert.match(describeStep(es[1].step), /head to Load Material, then wait for Continue/);
  assert.equal(runList(es).filter((r) => r.t === 'stage').length, 2, 'the pause splits the job into two files');
  // a new outline added later goes in before the cut-out
  j.parts[0].contours.push(k('h3', circle(100, 250, 8), newOp('inside', 20)));
  es = sequence(j, planJob(j));
  const order = cutsOf(es);
  assert.equal(order.length, 6);
  assert.ok(order.indexOf('h3') < order.indexOf('out'));
  // an outline that is no longer cut drops out
  j.parts[0].contours.find((c) => c.id === 'poc').op.kind = 'none';
  assert.ok(!cutsOf(sequence(j, planJob(j))).includes('poc'));
});

test('cutting a part free too early is flagged', () => {
  const j = plate();
  const es = sequence(j, planJob(j));
  const list = [...es]; const out = list.pop(); list.unshift(out);
  j.seq = toSeq(list);
  const again = sequence(j, planJob(j));
  assert.equal(cutsOf(again)[0], 'out');
  assert.ok(again.filter((e) => e.t === 'cut' && e.warn).length === 4);
});

test('every stage makes valid G-code', () => {
  const j = plate();
  const es = sequence(j, planJob(j));
  const list = [...es]; list.splice(2, 0, { t: 'step', step: newStep('material') });
  j.seq = toSeq(list);
  const run = runList(sequence(j, planJob(j)));
  const stages = run.filter((r) => r.t === 'stage');
  assert.equal(stages.length, 2);
  for (const r of stages) {
    const nc = gcode(j, movesFor(j, r.stage.cuts), r.stage.bit);
    assert.match(nc, /^G20\nG90\n/);
    assert.ok(nc.split('\n').length > 10);
    assert.ok(r.stage.label.length > 0);
  }
});
