// Components: linked copies. A component is a set of shapes saved once (on
// the printer, /studio-api/components); each copy put into a part carries
// `comp {name, inst, k}` on its shapes. Change one copy, then *Update every
// copy*: the component takes this copy's shapes and every copy follows (in
// this part now, in other parts when they're next opened). A copy can be
// reset to the component or detached (its shapes stay, unlinked).
//
// A copy has no stored position: its origin is worked out from where its
// shapes are, so moving it is ordinary moving.
import type { Feature, Project, ViewName } from './model.js';
import { newId } from './model.js';
import { footprintFrom, placeFootprint, type Footprint } from './footprints.js';

export interface CompDef {
  name: string;
  note: string;
  view: ViewName;
  features: Feature[];      // centred on (0, 0), depths from the view's near face
  modified: number;         // ms; the newest wins when parts are opened
}

/** The shapes of one copy, in definition order. */
export function members(p: Project, inst: string): Feature[] {
  return p.features.filter((f) => f.comp?.inst === inst).sort((a, b) => a.comp!.k - b.comp!.k);
}

/** Every copy of a component in the part. */
export function copiesOf(p: Project, name: string): string[] {
  return [...new Set(p.features.filter((f) => f.comp?.name === name).map((f) => f.comp!.inst))];
}

/** Where a copy sits: its offset from the definition (u, v, depth). */
export function origin(p: Project, inst: string): [number, number, number] | null {
  const ms = members(p, inst);
  const def = ms[0] && p.components?.[ms[0].comp!.name];
  if (!def) return null;
  const m = ms[0], d = def.features[m.comp!.k];
  if (!d) return null;
  return [m.cu - d.cu, m.cv - d.cv, m.d0 - d.d0];
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;
/** A shape as the definition holds it: relative to the copy's origin, no ids or links. */
function plain(f: Feature, o: [number, number, number]): string {
  const c: any = JSON.parse(JSON.stringify(f));
  delete c.id; delete c.comp; delete c.group; delete c.refs; delete c.view;
  c.cu = round(c.cu - o[0]); c.cv = round(c.cv - o[1]); c.d0 = round(c.d0 - o[2]); c.d1 = round(c.d1 - o[2]);
  return JSON.stringify(c, Object.keys(c).sort());
}

/** Has this copy been changed (sizes, shapes added or removed) since the component was saved? */
export function differs(p: Project, inst: string): boolean {
  const ms = members(p, inst);
  const def = ms[0] && p.components?.[ms[0].comp!.name];
  const o = origin(p, inst);
  if (!def || !o) return false;
  if (ms.length !== def.features.length || ms.some((m, i) => m.comp!.k !== i)) return true;
  return ms.some((m, i) => plain(m, o) !== plain(def.features[i], [0, 0, 0]));
}

/** The component's shapes taken from one copy (for Update every copy). */
export function defFromCopy(p: Project, inst: string): CompDef | null {
  const ms = members(p, inst);
  const old = ms[0] && p.components?.[ms[0].comp!.name];
  const o = origin(p, inst);
  if (!old || !o) return null;
  const features = ms.map((m) => ({ ...JSON.parse(plain(m, o)), view: old.view }) as Feature);
  return { ...old, features, modified: Date.now() };
}

/** A footprint-shaped view of a component, for the Insert shelf. */
export function compFootprint(def: CompDef): Footprint {
  return { id: `comp:${def.name}`, name: def.name, note: def.note, view: def.view, mine: true, make: () => def.features.map((f) => ({ ...JSON.parse(JSON.stringify(f)), id: newId() })) };
}

/** Shapes from a part as a new component; they become its first copy. */
export function makeComponent(p: Project, shapes: Feature[], name: string): { def: CompDef; skipped: number } {
  const { fp, skipped } = footprintFrom(shapes, p, name);
  const def: CompDef = { name, note: fp.note, view: fp.view, features: fp.features, modified: Date.now() };
  return { def, skipped };
}

/** Link shapes already in the part as a copy of def (same order as def.features). */
export function linkCopy(p: Project, shapes: Feature[], def: CompDef) {
  const inst = newId();
  const same = shapes.filter((f) => f.view === def.view);
  same.forEach((f, k) => { f.comp = { name: def.name, inst, k }; f.group = inst; });
  p.components = { ...(p.components || {}), [def.name]: def };
}

/** A new copy dropped on the part (the middle of the face, like a footprint). */
export function insertCopy(p: Project, def: CompDef, onto?: ViewName): Feature[] {
  const inst = newId();
  const fs = placeFootprint(compFootprint(def), p, onto).map((f, k) => ({ ...f, comp: { name: def.name, inst, k }, group: inst }));
  p.components = { ...(p.components || {}), [def.name]: def };
  return fs;
}

/** Make every copy of def.name match def, each where it sits. Returns how many copies. */
export function updateCopies(p: Project, def: CompDef, only?: string): number {
  const insts = only ? [only] : copiesOf(p, def.name);
  for (const inst of insts) {
    const ms = members(p, inst);
    // where it sits now, against the definition it was made from
    const o = origin(p, inst) || [0, 0, 0];
    const at = p.features.indexOf(ms[0]);
    const fresh = def.features.map((d, k) => {
      const keep = ms.find((m) => m.comp!.k === k);
      const f: Feature = JSON.parse(JSON.stringify(d));
      return { ...f, view: ms[0]?.view ?? def.view, id: keep?.id ?? newId(), cu: d.cu + o[0], cv: d.cv + o[1], d0: d.d0 + o[2], d1: d.d1 + o[2], comp: { name: def.name, inst, k }, group: inst };
    });
    p.features = p.features.filter((f) => f.comp?.inst !== inst);
    p.features.splice(Math.max(0, Math.min(at, p.features.length)), 0, ...fresh);
  }
  p.components = { ...(p.components || {}), [def.name]: def };
  return insts.length;
}

/** Unlink a copy: its shapes stay, as a plain group. */
export function detach(p: Project, inst: string) {
  for (const f of p.features) if (f.comp?.inst === inst) delete f.comp;
  const left = new Set(p.features.filter((f) => f.comp).map((f) => f.comp!.name));
  if (p.components) for (const n of Object.keys(p.components)) if (!left.has(n)) delete p.components[n];
}
