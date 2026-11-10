// The six drafting views, third-angle (US) layout.
//
// Each view has screen axes u (right) and v (up) and a depth d toward the
// viewer. eye is the direction from the part toward the viewer, so the
// view's (u, v, d) are world coordinates dotted with (uDir, vDir, eye).
// Back and bottom come out mirrored the drafting way on their own.

import type { ViewName, Vec3 } from './model.js';

export interface ViewDef {
  name: ViewName;
  label: string;
  eye: Vec3;
  uDir: Vec3;
  vDir: Vec3;
  toView(p: Vec3): [number, number, number];
  toWorld(u: number, v: number, d: number): Vec3;
}

function make(name: ViewName, label: string, eye: Vec3, uDir: Vec3, vDir: Vec3): ViewDef {
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return {
    name, label, eye, uDir, vDir,
    toView: (p) => [dot(p, uDir), dot(p, vDir), dot(p, eye)],
    toWorld: (u, v, d) => [
      u * uDir[0] + v * vDir[0] + d * eye[0],
      u * uDir[1] + v * vDir[1] + d * eye[1],
      u * uDir[2] + v * vDir[2] + d * eye[2],
    ],
  };
}

export const VIEWS: Record<ViewName, ViewDef> = {
  top: make('top', 'Top', [0, 0, 1], [1, 0, 0], [0, 1, 0]),
  front: make('front', 'Front', [0, -1, 0], [1, 0, 0], [0, 0, 1]),
  right: make('right', 'Right', [1, 0, 0], [0, 1, 0], [0, 0, 1]),
  left: make('left', 'Left', [-1, 0, 0], [0, -1, 0], [0, 0, 1]),
  back: make('back', 'Back', [0, 1, 0], [-1, 0, 0], [0, 0, 1]),
  bottom: make('bottom', 'Bottom', [0, 0, -1], [1, 0, 0], [0, -1, 0]),
};

export const VIEW_ORDER: ViewName[] = ['top', 'front', 'right', 'left', 'back', 'bottom'];

/** Slots that sit next to each other on the sheet: a ghost box appears in
 *  an empty slot when a neighbour is shown. */
export const NEIGHBOURS: Record<ViewName, ViewName[]> = {
  top: ['front'],
  front: ['top', 'left', 'right', 'bottom'],
  left: ['front'],
  right: ['front', 'back'],
  back: ['right'],
  bottom: ['front'],
};

/** Which world axis (0 x, 1 y, 2 z) and sign a view direction runs along. */
export function axisOf(d: Vec3): [number, number] {
  for (let i = 0; i < 3; i++) if (d[i] !== 0) return [i, d[i]];
  return [0, 1];
}

/** Is view b looking along the same axis as view a (parallel views)? */
export function parallel(a: ViewName, b: ViewName): boolean {
  return axisOf(VIEWS[a].eye)[0] === axisOf(VIEWS[b].eye)[0];
}

export interface Box2 { x: number; y: number; w: number; h: number }

/** Extra room a view needs round the part (mm): its dimensions sit there. */
export interface Margin { l: number; r: number; t: number; b: number }

/**
 * Where each view sits on the sheet (sheet coordinates in mm, y down).
 * Views share columns and rows so they stay projection-aligned: top, front
 * and bottom share X; left, front, right and back share Z. A column or row
 * with no shown view in it is only as big as a ghost box, so the shown views
 * get the room.
 */
export function layout(bmin: Vec3, bmax: Vec3, shown: Set<ViewName>, margins: Partial<Record<ViewName, Margin>> = {}): Record<ViewName, { box: Box2; ou: number; ov: number }> {
  const sx = bmax[0] - bmin[0], sy = bmax[1] - bmin[1], sz = bmax[2] - bmin[2];
  const full = Math.max(sx, sy, sz);
  const gap = Math.max(3, 0.28 * full);
  const pad = gap * 0.15;
  const ghost = Math.max(4, 0.26 * full);
  const has = (...v: ViewName[]) => v.some((x) => shown.has(x));
  const colW = [has('left') ? sy : ghost, has('top', 'front', 'bottom') ? sx : ghost, has('right') ? sy : ghost, has('back') ? sx : ghost];
  const rowH = [has('top') ? sy : ghost, has('front', 'left', 'right', 'back') ? sz : ghost, has('bottom') ? sy : ghost];
  // a column (row) makes room for the biggest margin of the views in it, so views never overlap
  const cols: ViewName[][] = [['left'], ['top', 'front', 'bottom'], ['right'], ['back']];
  const rows: ViewName[][] = [['top'], ['left', 'front', 'right', 'back'], ['bottom']];
  const mg = (v: ViewName): Margin => (shown.has(v) && margins[v]) || { l: 0, r: 0, t: 0, b: 0 };
  const colL = cols.map((vs) => Math.max(0, ...vs.map((v) => mg(v).l)));
  const colR = cols.map((vs) => Math.max(0, ...vs.map((v) => mg(v).r)));
  const rowT = rows.map((vs) => Math.max(0, ...vs.map((v) => mg(v).t)));
  const rowB = rows.map((vs) => Math.max(0, ...vs.map((v) => mg(v).b)));
  const colX: number[] = [];
  let x = 0;
  colW.forEach((w, c) => { x += colL[c]; colX.push(x); x += w + colR[c] + gap; });
  const rowY: number[] = [];
  let y = 0;
  rowH.forEach((h, r) => { y += rowT[r]; rowY.push(y); y += h + rowB[r] + gap; });
  const cell = (v: ViewName, c: number, r: number): Box2 => {
    // the view's box takes in its own dimensions
    const m = mg(v);
    if (shown.has(v)) return { x: colX[c] - pad - m.l, y: rowY[r] - pad - m.t, w: colW[c] + 2 * pad + m.l + m.r, h: rowH[r] + 2 * pad + m.t + m.b };
    // a ghost: a small box in the middle of its slot
    const w = Math.min(colW[c], ghost), h = Math.min(rowH[r], ghost);
    return { x: colX[c] + (colW[c] - w) / 2, y: rowY[r] + (rowH[r] - h) / 2, w, h };
  };
  const cx = (c: number) => colX[c];
  const cy = (r: number) => rowY[r];
  // ou/ov: sheet position = (ou + u, ov - v)
  return {
    top: { box: cell('top', 1, 0), ou: cx(1) - bmin[0], ov: cy(0) + bmax[1] },        // u = X, v = Y
    front: { box: cell('front', 1, 1), ou: cx(1) - bmin[0], ov: cy(1) + bmax[2] },    // u = X, v = Z
    left: { box: cell('left', 0, 1), ou: cx(0) + bmax[1], ov: cy(1) + bmax[2] },      // u = -Y
    right: { box: cell('right', 2, 1), ou: cx(2) - bmin[1], ov: cy(1) + bmax[2] },    // u = Y
    back: { box: cell('back', 3, 1), ou: cx(3) + bmax[0], ov: cy(1) + bmax[2] },      // u = -X
    bottom: { box: cell('bottom', 1, 2), ou: cx(1) - bmin[0], ov: cy(2) - bmin[1] },  // u = X, v = -Y
  };
}
