// Screw holes: sizes for the common printed-part screws, and what each kind
// of hole needs (clearance, tapped, heat-set insert, counterbore,
// countersink, nut trap). All mm. Nothing here touches the DOM or OpenCASCADE.

export type HoleKind = 'clear' | 'tap' | 'insert' | 'cbore' | 'csk' | 'nut';
export type HoleFit = 'close' | 'normal' | 'loose';

export interface HoleSpec {
  size: string;          // a key of SCREWS, or 'custom'
  kind: HoleKind;
  fit: HoleFit;          // clearance class (clear, cbore, csk, nut)
  d: number;             // the bore Ø actually used (custom size, or worked out from the table)
  headD: number;         // counterbore / countersink Ø at the surface
  headDepth: number;     // counterbore depth
  nutAF: number;         // nut trap: across the flats
  nutDepth: number;      // nut trap: how deep
  nutRot: number;        // nut trap: turned, degrees
  insertLen: number;     // heat-set insert length (the hole goes this deep plus a little)
}

export interface Screw {
  label: string;
  d: number;                         // nominal major Ø
  clear: [number, number, number];   // close, normal, loose clearance Ø
  tap: number;                       // pilot for the screw to cut its own thread in plastic
  insert: [number, number] | null;   // heat-set insert hole Ø, insert length
  cbore: [number, number];           // socket-head counterbore Ø, depth
  csk: number;                       // flat-head (90°) countersink Ø at the surface
  nut: [number, number];             // hex nut across flats, thickness
}

// ISO 273 clearances; socket heads ISO 4762; flat heads ISO 10642 / 7046;
// hex nuts ISO 4032; inserts per the common (Ruthex/CNC Kitchen) sizes.
export const SCREWS: Record<string, Screw> = {
  M2:   { label: 'M2',   d: 2,   clear: [2.2, 2.4, 2.6],   tap: 1.7, insert: [3.2, 3.0], cbore: [4.4, 2.2],  csk: 4.0,  nut: [4.0, 1.6] },
  M2_5: { label: 'M2.5', d: 2.5, clear: [2.7, 2.9, 3.1],   tap: 2.1, insert: [3.6, 4.0], cbore: [5.2, 2.7],  csk: 4.9,  nut: [5.0, 2.0] },
  M3:   { label: 'M3',   d: 3,   clear: [3.2, 3.4, 3.6],   tap: 2.5, insert: [4.0, 5.7], cbore: [6.0, 3.2],  csk: 6.7,  nut: [5.5, 2.4] },
  M4:   { label: 'M4',   d: 4,   clear: [4.3, 4.5, 4.8],   tap: 3.3, insert: [5.6, 8.1], cbore: [7.6, 4.2],  csk: 9.0,  nut: [7.0, 3.2] },
  M5:   { label: 'M5',   d: 5,   clear: [5.3, 5.5, 5.8],   tap: 4.2, insert: [6.4, 9.5], cbore: [9.2, 5.2],  csk: 11.2, nut: [8.0, 4.7] },
  M6:   { label: 'M6',   d: 6,   clear: [6.4, 6.6, 7.0],   tap: 5.0, insert: [8.0, 12.7], cbore: [11.0, 6.2], csk: 13.4, nut: [10.0, 5.2] },
  n4:   { label: '#4',   d: 2.84, clear: [3.0, 3.3, 3.6],  tap: 2.3, insert: [4.0, 4.8], cbore: [5.8, 3.0],  csk: 5.7,  nut: [6.35, 2.4] },
  n6:   { label: '#6',   d: 3.51, clear: [3.7, 4.0, 4.3],  tap: 2.8, insert: [4.8, 5.7], cbore: [6.9, 3.7],  csk: 7.1,  nut: [7.94, 2.8] },
  n8:   { label: '#8',   d: 4.17, clear: [4.4, 4.6, 5.0],  tap: 3.4, insert: [5.6, 6.4], cbore: [8.1, 4.4],  csk: 8.4,  nut: [8.73, 3.2] },
  q20:  { label: '¼"',   d: 6.35, clear: [6.6, 6.9, 7.3],  tap: 5.3, insert: [8.0, 12.7], cbore: [11.4, 6.5], csk: 13.0, nut: [11.11, 5.6] },
};
export const SCREW_ORDER = ['M2', 'M2_5', 'M3', 'M4', 'M5', 'M6', 'n4', 'n6', 'n8', 'q20'];

export const KIND_LABEL: Record<HoleKind, string> = {
  clear: 'Clearance', tap: 'Tapped', insert: 'Heat-set insert', cbore: 'Counterbore', csk: 'Countersink', nut: 'Nut trap',
};

/** A hole spec with every size worked out from the screw table (custom keeps its own Ø). */
export function holeFromTable(size: string, kind: HoleKind, fit: HoleFit = 'normal', keep?: Partial<HoleSpec>): HoleSpec {
  const s = SCREWS[size];
  const fi = fit === 'close' ? 0 : fit === 'loose' ? 2 : 1;
  if (!s) {
    const d = keep?.d ?? 3.4;
    return { size: 'custom', kind, fit, d, headD: keep?.headD ?? d * 1.8, headDepth: keep?.headDepth ?? d,
      nutAF: keep?.nutAF ?? d * 1.7, nutDepth: keep?.nutDepth ?? d * 0.8, nutRot: keep?.nutRot ?? 0, insertLen: keep?.insertLen ?? d * 1.6 };
  }
  const d = kind === 'tap' ? s.tap : kind === 'insert' && s.insert ? s.insert[0] : s.clear[fi];
  return {
    size, kind, fit, d,
    headD: kind === 'csk' ? s.csk + 0.2 : s.cbore[0],
    headDepth: s.cbore[1],
    nutAF: s.nut[0], nutDepth: s.nut[1] + 0.3, nutRot: keep?.nutRot ?? 0,
    insertLen: s.insert ? s.insert[1] : s.d * 1.6,
  };
}

export function defaultHole(): HoleSpec { return holeFromTable('M3', 'clear', 'normal'); }

/** The widest the hole gets at any depth (for its box on the sheet). */
export function holeOuterD(h: HoleSpec, fit = 0): number {
  if (h.kind === 'cbore' || h.kind === 'csk') return h.headD + fit;
  if (h.kind === 'nut') return (h.nutAF + fit) / Math.cos(Math.PI / 6);
  return h.d + fit;
}

/** A short name: "M3 clearance", "M3 heat-set insert". */
export function holeLabel(h: HoleSpec): string {
  const size = SCREWS[h.size]?.label ?? `Ø${+h.d.toFixed(2)}`;
  return `${size} ${KIND_LABEL[h.kind].toLowerCase()}`;
}

/** The hexagon of a nut trap, corners round (cu, cv). */
export function hexPoints(cu: number, cv: number, af: number, rotDeg: number): [number, number][] {
  const R = af / 2 / Math.cos(Math.PI / 6);
  const a0 = (rotDeg * Math.PI) / 180;
  return Array.from({ length: 6 }, (_, k) => [cu + R * Math.cos(a0 + (k * Math.PI) / 3), cv + R * Math.sin(a0 + (k * Math.PI) / 3)] as [number, number]);
}
