// Footprints: ready-made groups of ordinary shapes (holes, pockets,
// standoffs) for parts that go in printed things: boards, servos, bearings,
// LEDs. Dropped on a part, they become normal features you can move, change
// or delete. Sizes are the common published ones; check against your part.
import type { Feature, Project } from './model.js';
import { newId, nearDepth, shellCavity } from './model.js';
import { holeFromTable, type HoleKind } from './holes.js';

export interface Footprint {
  id: string;
  name: string;
  note: string;
  /** The shapes, centred on (0, 0) in the top view, top face at depth 0 (cuts go down, standoffs up). */
  make(): Feature[];
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
export function placeFootprint(fp: Footprint, p: Project): Feature[] {
  const cav = shellCavity(p);
  const open = p.shell?.open;
  const s = p.stock;
  const cx = s.off ? 0 : (s.min[0] + s.max[0]) / 2, cy = s.off ? 0 : (s.min[1] + s.max[1]) / 2;
  const top = cav && open === 'top' ? cav[0][2] : nearDepth('top', p);
  return fp.make().map((f) => ({ ...f, cu: f.cu + cx, cv: f.cv + cy, d0: f.d0 + top, d1: f.d1 + top }));
}
