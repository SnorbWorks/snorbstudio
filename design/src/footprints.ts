// Footprints: ready-made groups of ordinary shapes (holes, pockets,
// standoffs) for parts that go in printed things: boards, servos, bearings,
// LEDs. Dropped on a part, they become normal features you can move, change
// or delete. Sizes are the common published ones; check against your part.
import type { Feature, Project, ViewName, P2 } from './model.js';
import { newId, nearDepth, shellCavity, isShape, profile } from './model.js';
import { VIEWS } from './views.js';
import { holeFromTable, type HoleKind } from './holes.js';

export interface Footprint {
  id: string;
  name: string;
  note: string;
  /** The face they go on (the top unless saved from another view). */
  view?: ViewName;
  /** One the owner saved (Save › Footprints), not a ready-made one. */
  mine?: boolean;
  /** The shapes, centred on (0, 0) in their view, its near face at depth 0 (cuts go down, standoffs up). */
  make(): Feature[];
}

/** A footprint as saved on the printer (/studio-api/footprints/<name>.json). */
export interface SavedFootprint { name: string; note: string; view: ViewName; features: Feature[] }

/**
 * Shapes from a part as a footprint: the ones on the same view as the first,
 * centred on (0, 0), depths measured from that view's near face. Shapes on
 * other views are left out (the count comes back as `skipped`).
 */
export function footprintFrom(feats: Feature[], p: Project, name: string): { fp: SavedFootprint; skipped: number } {
  const shapes = feats.filter((f) => isShape(f));
  const view = shapes[0]?.view ?? 'top';
  const same = shapes.filter((f) => f.view === view);
  const pts: P2[] = same.flatMap((f) => profile(f, 24));
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const cx = pts.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
  const cy = pts.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0;
  const top = nearDepth(view, p);
  const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
  const features = same.map((f) => {
    const c = JSON.parse(JSON.stringify(f)) as Feature;
    delete (c as any).refs; delete c.group; delete c.comp;
    return { ...c, cu: r4(c.cu - cx), cv: r4(c.cv - cy), d0: r4(c.d0 - top), d1: r4(c.d1 - top) };
  });
  const w = pts.length ? Math.max(...xs) - Math.min(...xs) : 0, h = pts.length ? Math.max(...ys) - Math.min(...ys) : 0;
  const note = `${same.length} shape${same.length === 1 ? '' : 's'}, ${+w.toFixed(1)} × ${+h.toFixed(1)} mm, from “${p.name || 'part'}”`;
  return { fp: { name, note, view, features }, skipped: shapes.length - same.length };
}

/** A saved footprint ready for the Library shelf. */
export function savedFootprint(s: SavedFootprint): Footprint {
  return {
    id: `mine:${s.name}`, name: s.name, note: s.note || '', view: s.view || 'top', mine: true,
    make: () => (s.features || []).map((f) => ({ ...JSON.parse(JSON.stringify(f)), id: newId() })),
  };
}

const base = (o: Partial<Feature>): Feature => ({
  id: newId(), type: 'rect', view: 'top', cu: 0, cv: 0, w: 0, h: 0, r: 0, corner: 0, d0: 0, d1: 0, op: 'cut', through: false, ...o,
} as Feature);

const hole = (x: number, y: number, size: string, kind: HoleKind, depth: number | null, top = 0): Feature => {
  const h = holeFromTable(size, kind, 'normal');
  return base({ type: 'hole', hole: h, r: h.d / 2, cu: x, cv: y, d0: top, d1: depth === null ? top - 1 : top - depth, through: depth === null });
};
const customHole = (x: number, y: number, d: number, depth: number | null): Feature => {
  const h = holeFromTable('custom', 'clear', 'normal', { d });
  return base({ type: 'hole', hole: h, r: d / 2, cu: x, cv: y, d0: 0, d1: depth === null ? -1 : -depth, through: depth === null });
};
const pocket = (w: number, h: number, depth: number | null, corner = 0, x = 0, y = 0): Feature =>
  base({ type: 'rect', w, h, corner, cu: x, cv: y, d0: 0, d1: depth === null ? -1 : -depth, through: depth === null, fit: true });
const standoff = (x: number, y: number, dia: number, height: number): Feature =>
  base({ type: 'circle', r: dia / 2, cu: x, cv: y, d0: 0, d1: height, op: 'add' });
const corners = (w: number, h: number) => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as [number, number][];

export const FOOTPRINTS: Footprint[] = [
  {
    id: 'pi45-holes', name: 'Raspberry Pi 4 / 5 holes', note: 'M2.5 clearance holes, 58 × 49 mm (board 85 × 56)',
    make: () => corners(58, 49).map(([x, y]) => hole(x, y, 'M2_5', 'clear', null)),
  },
  {
    id: 'pi45-standoffs', name: 'Raspberry Pi 4 / 5 standoffs', note: '6 mm standoffs, 5 mm tall, holes for M2.5 screws to tap into',
    make: () => corners(58, 49).flatMap(([x, y]) => [standoff(x, y, 6, 5), hole(x, y, 'M2_5', 'tap', 5, 5)]),
  },
  {
    id: 'pico-holes', name: 'Raspberry Pi Pico holes', note: 'M2 clearance holes, 47 × 11.4 mm (board 51 × 21)',
    make: () => corners(47, 11.4).map(([x, y]) => hole(x, y, 'M2', 'clear', null)),
  },
  {
    id: 'pico-standoffs', name: 'Raspberry Pi Pico standoffs', note: '4.5 mm standoffs, 4 mm tall, holes for M2 screws to tap into',
    make: () => corners(47, 11.4).flatMap(([x, y]) => [standoff(x, y, 4.5, 4), hole(x, y, 'M2', 'tap', 4, 4)]),
  },
  {
    id: 'sg90', name: 'SG90 micro servo', note: 'Body cut-out 22.8 × 12.4 through, screw holes 27.6 mm apart. Check your servo.',
    make: () => [pocket(22.8, 12.4, null), hole(-13.8, 0, 'M2', 'tap', 6), hole(13.8, 0, 'M2', 'tap', 6)],
  },
  {
    id: 'mg996r', name: 'MG996R servo', note: 'Body cut-out 40.6 × 19.8 through, four screw holes 49.5 × 10 mm. Check your servo.',
    make: () => [pocket(40.6, 19.8, null), ...corners(49.5, 10).map(([x, y]) => hole(x, y, 'M4', 'clear', null))],
  },
  {
    id: '608', name: '608 bearing seat', note: '22 mm × 7 mm pocket (with the printer fit) and a 10 mm hole through for an 8 mm shaft',
    make: () => [base({ type: 'circle', r: 11, d0: 0, d1: -7, fit: true }), customHole(0, 0, 10, null)],
  },
  {
    id: 'led5', name: '5 mm LED', note: 'A 5.1 mm hole through',
    make: () => [customHole(0, 0, 5.1, null)],
  },
  {
    id: 'led10', name: '10 mm LED', note: 'A 10.2 mm hole through',
    make: () => [customHole(0, 0, 10.2, null)],
  },
  {
    id: 'ec11', name: 'Rotary encoder (EC11)', note: 'A 7.2 mm hole for the threaded bush, through',
    make: () => [customHole(0, 0, 7.2, null)],
  },
  {
    id: 'm3-insert-boss', name: 'M3 insert boss', note: 'A 7 mm post, 6 mm tall, with a heat-set insert hole',
    make: () => [standoff(0, 0, 7, 6), hole(0, 0, 'M3', 'insert', 6, 6)],
  },
];

/**
 * A footprint's shapes placed on a part: centred on the body's top face, or
 * on the floor of a hollow body open at the top.
 */
export function placeFootprint(fp: Footprint, p: Project, onto?: ViewName): Feature[] {
  const view = onto || fp.view || 'top';
  const cav = shellCavity(p);
  const open = p.shell?.open;
  const s = p.stock;
  const mid = s.off ? [0, 0, 0] as const : [0, 1, 2].map((i) => (s.min[i] + s.max[i]) / 2);
  const [cx, cy] = VIEWS[view].toView([mid[0], mid[1], mid[2]]);
  // a hollow box open on this face: on the floor inside it
  const top = cav && open === view ? VIEWS[view].toView(VIEWS[view].eye[0] + VIEWS[view].eye[1] + VIEWS[view].eye[2] > 0 ? cav[0] : cav[1])[2] : nearDepth(view, p);
  return fp.make().map((f) => ({ ...f, view, cu: f.cu + cx, cv: f.cv + cy, d0: f.d0 + top, d1: f.d1 + top }));
}
