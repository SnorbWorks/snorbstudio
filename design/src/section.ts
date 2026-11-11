// Section views, drafting style: a cutting line across one view (level or
// plumb) slices the part, and the view that looks along the line's arrows
// shows what's beyond the cut, labelled SECTION A–A, the cut faces hatched.
// A section stands in for one of the six views, so it stays lined up with
// the others. No DOM here.
import type { P2, Project, ViewName } from './model.js';
import { VIEWS, axisOf } from './views.js';

export interface Section {
  id: string;
  label: string;        // "A": the view is SECTION A–A
  from: ViewName;       // the view the cutting line is drawn on
  view: ViewName;       // the view that shows the section (it looks along the arrows)
  d: number;            // where the cut is: depth toward that view's viewer (mm)
}

const PREFER: ViewName[] = ['front', 'top', 'right', 'left', 'back', 'bottom'];

/**
 * The section for a cutting line on `from`, level (along u) or plumb (along
 * v), through view point (u, v). It looks the usual way: into the front,
 * down from the top, in from the right.
 */
export function sectionFor(p: Project, from: ViewName, dir: 'u' | 'v', u: number, v: number): Omit<Section, 'id'> {
  const F = VIEWS[from];
  // the cut plane's normal: the in-view axis across the line
  const across = dir === 'u' ? F.vDir : F.uDir;
  const [ax] = axisOf(across);
  const view = PREFER.find((n) => axisOf(VIEWS[n].eye)[0] === ax)!;
  const world = F.toWorld(u, v, 0);
  return { label: nextLabel(p), from, view, d: +(world[ax] * VIEWS[view].eye[ax]).toFixed(9) || 0 };
}

/** The same cut, looking the other way. */
export function flipSection(s: Section): Section {
  const V = VIEWS[s.view];
  const [ax] = axisOf(V.eye);
  const other = (Object.keys(VIEWS) as ViewName[]).find((n) => n !== s.view && axisOf(VIEWS[n].eye)[0] === ax)!;
  // the same plane: world coordinate stays, depth sign follows the eye
  return { ...s, view: other, d: -s.d || 0 };
}

/** The world axis the cut runs across and where along it (mm). */
export function cutPlane(s: Section): { axis: 0 | 1 | 2; at: number } {
  const e = VIEWS[s.view].eye;
  const [ax] = axisOf(e);
  return { axis: ax as 0 | 1 | 2, at: s.d * e[ax] || 0 };
}

/**
 * The cutting line on its view: the two ends (view u, v, across the given
 * range) and the arrows' direction in that view (which way it looks).
 */
export function cuttingLine(s: Section, lo: P2, hi: P2): { a: P2; b: P2; look: P2 } | null {
  const F = VIEWS[s.from];
  const { axis, at } = cutPlane(s);
  const [ua, us] = axisOf(F.uDir), [va, vs] = axisOf(F.vDir);
  const L = VIEWS[s.view].eye.map((x) => -x);           // looking along -eye
  const look: P2 = [L[0] * F.uDir[0] + L[1] * F.uDir[1] + L[2] * F.uDir[2], L[0] * F.vDir[0] + L[1] * F.vDir[1] + L[2] * F.vDir[2]];
  if (ua === axis) { const u = at * us; return { a: [u, lo[1]], b: [u, hi[1]], look }; }
  if (va === axis) { const v = at * vs; return { a: [lo[0], v], b: [hi[0], v], look }; }
  return null;                                          // drawn on a view the cut doesn't cross
}

/** The next free letter (drafting skips I, O, Q). */
export function nextLabel(p: Project): string {
  const used = new Set((p.sections || []).map((s) => s.label));
  for (const c of 'ABCDEFGHJKLMNPRSTUVWXYZ') if (!used.has(c)) return c;
  return `S${(p.sections || []).length + 1}`;
}

/** The section shown in a view, if any. */
export const sectionIn = (p: Project, view: ViewName) => (p.sections || []).find((s) => s.view === view) || null;
