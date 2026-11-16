// SnorbCAM: the cut order. Every cut in the job, in the order it will run,
// with steps between them (pause, tool change, material change...). A run of
// cuts between two steps is a stage: one G-code file, one bit.

import { Bit, Job, SeqItem, Step, StepKind, bbox, camId, IN } from './job.js';
import { Cut, Plan, gcode, movesFor } from './toolpath.js';

export type Entry =
  | { t: 'cut'; cut: Cut; group: Group; warn?: string }
  | { t: 'step'; step: Step };

export type Group = 'hole' | 'pocket' | 'line' | 'inside' | 'outside';
export const GROUP_NAME: Record<Group, string> = { hole: 'Hole', pocket: 'Pocket', line: 'On the line', inside: 'Inside cut', outside: 'Cut out' };
const RANK: Group[] = ['hole', 'pocket', 'line', 'inside', 'outside'];

export const STEP_NAME: Record<StepKind, string> = { pause: 'Pause', toolchange: 'Tool change', material: 'Material change', custom: 'Step' };

export function newStep(kind: StepKind, name?: string): Step {
  return { id: camId('s'), kind, name: name || STEP_NAME[kind], note: '', goto: '', rezero: kind === 'toolchange' };
}

/** What sort of cut this is, for sorting: small closed inside cuts and pockets count as holes. */
export function groupOf(c: Cut): Group {
  if (c.outer || c.op.kind === 'outside') return 'outside';
  if (c.op.kind === 'on') return 'line';
  const [x0, y0, x1, y1] = bbox(c.tracks.map((t) => t.pts));
  const size = Math.max(x1 - x0, y1 - y0) + c.bit.dia;
  if (c.tracks.every((t) => t.closed) && size <= 1 * IN + 1e-6) return 'hole';
  return c.op.kind === 'pocket' ? 'pocket' : 'inside';
}

const partKey = (c: Cut) => c.key.split(':')[0];

/**
 * The automatic order. Everything that isn't cutting a part free comes first
 * (holes, then pockets, then lines, then inside cuts), bit by bit so the bit
 * changes as few times as possible (the cut-out bit's inside work last); the cut-outs come last so parts stay put.
 * Within a group the cuts keep the nearest-next order the planner gave them.
 */
export function autoOrder(job: Job, cuts: Cut[]): Cut[] {
  // bits that also do the cut-outs go last among the inside work: then no change is needed before cutting out
  const outBits = new Set(cuts.filter((c) => groupOf(c) === 'outside').map((c) => c.bit.id));
  const bitRank = new Map<string, number>();
  for (const pass of [false, true]) for (const c of cuts) if (outBits.has(c.bit.id) === pass && !bitRank.has(c.bit.id)) bitRank.set(c.bit.id, bitRank.size);
  const key = (c: Cut) => {
    const g = groupOf(c);
    return [g === 'outside' ? 1 : 0, bitRank.get(c.bit.id)!, RANK.indexOf(g)];
  };
  return cuts.map((c, i) => ({ c, i, k: key(c) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2] || a.i - b.i)
    .map((x) => x.c);
}

const autoToolChange = (bit: Bit): Step => ({ id: `auto-${bit.id}`, kind: 'toolchange', name: `Change to the ${bit.name}`, note: '', goto: '', rezero: true, auto: true });

/**
 * The job's cut order: the owner's arrangement (job.seq) if there is one,
 * brought up to date with the cuts that exist now, otherwise the automatic
 * order. A tool change always sits where the bit changes: missing ones are
 * added, and automatic ones that are no longer at a bit change are dropped.
 */
export function sequence(job: Job, plan: Plan): Entry[] {
  const byKey = new Map(plan.cuts.map((c) => [c.key, c]));
  let raw: ({ cut: Cut } | { step: Step })[] = [];
  if (job.seq && job.seq.length) {
    const used = new Set<string>();
    for (const it of job.seq) {
      if ('step' in it) raw.push({ step: it.step });
      else { const c = byKey.get(it.cut); if (c && !used.has(c.key)) { used.add(c.key); raw.push({ cut: c }); } }
    }
    // cuts added since the order was arranged: inside work goes before the first cut-out, cut-outs at the end
    const fresh = autoOrder(job, plan.cuts.filter((c) => !used.has(c.key)));
    for (const c of fresh) {
      const firstOut = raw.findIndex((r) => 'cut' in r && groupOf(r.cut) === 'outside');
      if (groupOf(c) !== 'outside' && firstOut >= 0) raw.splice(firstOut, 0, { cut: c });
      else raw.push({ cut: c });
    }
  } else raw = autoOrder(job, plan.cuts).map((c) => ({ cut: c }));

  // tool changes belong exactly where the bit changes
  const out: Entry[] = [];
  let lastBit: Bit | null = null, changed = false;   // changed: a tool change step already sits since the last cut
  let pendingAuto: Entry[] = [];
  for (const r of raw) {
    if ('step' in r) {
      if (r.step.auto) { pendingAuto.push({ t: 'step', step: r.step }); continue; }
      if (r.step.kind === 'toolchange') changed = true;
      out.push({ t: 'step', step: r.step });
      continue;
    }
    const c = r.cut;
    if (lastBit && lastBit.id !== c.bit.id && !changed) {
      // keep the owner's place for an automatic step if it sat here, else make one
      const kept = pendingAuto.find((e) => e.t === 'step' && e.step.id === `auto-${c.bit.id}`);
      out.push(kept || { t: 'step', step: autoToolChange(c.bit) });
    }
    pendingAuto = [];
    out.push({ t: 'cut', cut: c, group: groupOf(c) });
    lastBit = c.bit; changed = false;
  }
  // steps left at the very start or end with nothing to do
  while (out.length && out[0].t === 'step' && out[0].step.auto) out.shift();

  // a part cut free before its inside work is finished will move
  const freed = new Set<string>();
  for (const e of out) {
    if (e.t !== 'cut') continue;
    if (e.group === 'outside') freed.add(partKey(e.cut));
    else if (freed.has(partKey(e.cut))) e.warn = 'This part is already cut free by then, so it may move.';
  }
  return out;
}

/** The order as it is stored in the job (after the owner changes something). */
export function toSeq(entries: Entry[]): SeqItem[] {
  return entries.map((e) => (e.t === 'cut' ? { cut: e.cut.key } : { step: { ...e.step } }));
}

export interface Stage { n: number; bit: Bit; cuts: Cut[]; label: string }
export type RunItem = { t: 'stage'; stage: Stage } | { t: 'step'; step: Step };

/** The order as the machine runs it: stages of cuts (one file, one bit each) with the steps between. */
export function runList(entries: Entry[]): RunItem[] {
  const out: RunItem[] = [];
  let cur: Stage | null = null, n = 0;
  for (const e of entries) {
    if (e.t === 'step') { cur = null; out.push({ t: 'step', step: e.step }); continue; }
    if (!cur || cur.bit.id !== e.cut.bit.id) { cur = { n: ++n, bit: e.cut.bit, cuts: [], label: '' }; out.push({ t: 'stage', stage: cur }); }
    cur.cuts.push(e.cut);
  }
  // steps with no cutting after them do nothing useful at the end, but a pause at the end is harmless: keep them
  for (const it of out) {
    if (it.t !== 'stage') continue;
    const groups = [...new Set(it.stage.cuts.map((c) => GROUP_NAME[groupOf(c)]))];
    it.stage.label = `${groups.length === 1 ? plural(groups[0], it.stage.cuts.length) : `${it.stage.cuts.length} cuts`} (${it.stage.bit.name})`;
  }
  return out;
}

function plural(name: string, n: number): string {
  if (n === 1) return name;
  const many: Record<string, string> = { Hole: 'holes', Pocket: 'pockets', 'On the line': 'line cuts', 'Inside cut': 'inside cuts', 'Cut out': 'cut-outs' };
  return `${n} ${many[name] || name}`;
}

/**
 * The whole job as one text for SnorbCut, which runs it stage by stage:
 * "#stage|label" then that stage's G-code; "#step|kind|name|goto|rezero|note".
 */
export function planText(job: Job, run: RunItem[]): string {
  const clean = (t: string) => String(t ?? '').replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const L: string[] = ['SNORBPLAN 1', `name: ${clean(job.name)}`];
  for (const r of run) {
    if (r.t === 'stage') { L.push(`#stage|${clean(r.stage.label)}`); L.push(gcode(job, movesFor(job, r.stage.cuts), r.stage.bit).trimEnd()); }
    else L.push(`#step|${r.step.kind}|${clean(r.step.name)}|${clean(r.step.goto)}|${r.step.rezero ? 1 : 0}|${clean(r.step.note)}`);
  }
  return L.join('\n') + '\n';
}

/** What a step does, in a few words. */
export function describeStep(s: Step): string {
  const parts: string[] = [];
  if (s.goto === 'machine') parts.push('head to Machine Home');
  else if (s.goto === 'project') parts.push('head to Project Home');
  else if (s.goto) parts.push(`head to ${s.goto}`);
  if (s.rezero) parts.push('new Z zero');
  parts.push('wait for Continue');
  return parts.join(', then ');
}
