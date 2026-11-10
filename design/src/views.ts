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

/**
 * Where each view sits on the sheet (sheet coordinates in mm, y down).
 * Views share columns and rows so they stay projection-aligned: top, front
 * and bottom share X; left, front, right and back share Z.
 * bbox is the world box everything fits in.
 */
export function layout(bmin: Vec3, bmax: Vec3): Record<ViewName, { box: Box2; ou: number; ov: number }> {
  const sx = bmax[0] - bmin[0], sy = bmax[1] - bmin[1], sz = bmax[2] - bmin[2];
  const gap = Math.max(12, 0.45 * Math.max(sx, sy, sz));
  const pad = gap * 0.25;
  // column x positions (left edge of each column), row y positions (top edge)
  const colW = [sy, sx, sy, sx];
  const rowH = [sy, sz, sy];
  const colX: number[] = [];
  let x = 0;
  for (const w of colW) { colX.push(x); x += w + gap; }
  const rowY: number[] = [];
  let y = 0;
  for (const h of rowH) { rowY.push(y); y += h + gap; }
  const cell = (c: number, r: number) => ({ x: colX[c] - pad, y: rowY[r] - pad, w: colW[c] + 2 * pad, h: rowH[r] + 2 * pad });

  // ou/ov: sheet position = (ou + u, ov - v)
  const cx = (c: number) => colX[c];
  const cy = (r: number) => rowY[r];
  return {
    // u = X, v = Y
    top: { box: cell(1, 0), ou: cx(1) - bmin[0], ov: cy(0) + bmax[1] },
    // u = X, v = Z
    front: { box: cell(1, 1), ou: cx(1) - bmin[0], ov: cy(1) + bmax[2] },
    // u = -Y, v = Z  (u runs from -bmax.y to -bmin.y)
    left: { box: cell(0, 1), ou: cx(0) + bmax[1], ov: cy(1) + bmax[2] },
    // u = Y
    right: { box: cell(2, 1), ou: cx(2) - bmin[1], ov: cy(1) + bmax[2] },
    // u = -X
    back: { box: cell(3, 1), ou: cx(3) + bmax[0], ov: cy(1) + bmax[2] },
    // u = X, v = -Y (v runs from -bmax.y to -bmin.y; top of the box is v = -bmin.y)
    bottom: { box: cell(1, 2), ou: cx(1) - bmin[0], ov: cy(2) - bmin[1] },
  };
}
