// The Pi 5 case (models/pi5_case.py) as Design-tab projects: every wall,
// cut-out, standoff and vent is a shape that can be selected and changed.
//
//   cd studio/design && node build.mjs && node tools/pi5_case_design.mjs
//
// Writes models/pi5_case_tray.design.json and models/pi5_case_lid.design.json
// and checks each builds to the same volume as the script's STL. Put them on
// the Pi as designs named like the STLs (pi5_case_tray, pi5_case_lid) and the
// library's "Send to Design" opens them instead of the bare STL.

import { writeFileSync } from 'node:fs';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { build } from '../test/build/geometry.mjs';
import { newProject } from '../test/build/model.mjs';
import { VIEWS } from '../test/build/views.mjs';

// --- the script's numbers
const BW = 85, BD = 56, BT = 1.6;
const PORTS_Y0 = [11.2, 25.8, 39.2];
const WALL = 2, FLOOR = 2, GAP = 1, STANDOFF = 3, HEADROOM = 19, R = 3;
const IW = BW + 2 * GAP, ID = BD + 2 * GAP;
const OW = IW + 2 * WALL, OD = ID + 2 * WALL;
const PCB_Z = FLOOR + STANDOFF;
const OH = PCB_Z + BT + HEADROOM;
const BX = WALL + GAP, BY = WALL + GAP;
const LID_T = 2, LIP_H = 3, LIP_W = 1.2, FIT = 0.3;

let n = 0;
const r4 = (x) => Math.round(x * 1e4) / 1e4;

/** A box as a rectangle drawn in a view and pushed (cut) or pulled (add) along its depth. */
function box(view, op, x0, y0, z0, x1, y1, z1, extra = {}) {
  const V = VIEWS[view];
  const cs = [];
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) cs.push(V.toView([x, y, z]));
  const us = cs.map((c) => c[0]), vs = cs.map((c) => c[1]), ds = cs.map((c) => c[2]);
  const [ua, ub, va, vb, da, db] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs), Math.min(...ds), Math.max(...ds)];
  return {
    id: `pi${++n}`, type: 'rect', view, cu: r4((ua + ub) / 2), cv: r4((va + vb) / 2), w: r4(ub - ua), h: r4(vb - va), r: 0, corner: 0,
    // a cut starts on the face nearest the viewer and goes in; an add starts on the far face and comes out
    d0: r4(op === 'cut' ? db : da), d1: r4(op === 'cut' ? da : db), op, through: false, ...extra,
  };
}

/** A round post or hole, drawn in the top view. */
function cyl(op, x, y, z0, h, d, extra = {}) {
  return {
    id: `pi${++n}`, type: 'circle', view: 'top', cu: r4(x), cv: r4(y), w: 0, h: 0, r: d / 2, corner: 0,
    d0: r4(op === 'cut' ? z0 + h : z0), d1: r4(op === 'cut' ? z0 : z0 + h), op, through: false, ...extra,
  };
}

const row = (count, dx) => ({ pattern: { kind: 'linear', count, step: [dx, 0, 0], center: [0, 0, 0], axis: [0, 0, 1], angle: 360 } });
// the four mounting holes: a pair 58 apart, mirrored across the board's middle (holes 49 apart)
const holes = { ...row(2, 58), mirror: { axis: 1, at: BY + 3.5 + 49 / 2 } };

function tray() {
  const f = [];
  f.push({ ...box('top', 'add', 0, 0, 0, OW, OD, OH), corner: R });                       // the rounded shell
  f.push(box('top', 'cut', WALL, WALL, FLOOR, OW - WALL, OD - WALL, OH + 1));                // hollow it out
  f.push(cyl('add', BX + 3.5, BY + 3.5, FLOOR - 0.01, STANDOFF + 0.01, 6, holes));          // standoffs
  f.push(cyl('cut', BX + 3.5, BY + 3.5, 0.8, OH, 2.4, holes));                               // M2.5 pilot holes
  f.push(box('right', 'cut', OW - WALL - 1, WALL + 1.5, PCB_Z - 0.5, OW + 1, OD - WALL - 1.5, OH + 1));   // USB + Ethernet end
  const x0 = BX + PORTS_Y0[0] - 7, x1 = BX + PORTS_Y0[2] + 7;
  f.push(box('front', 'cut', x0, -1, PCB_Z - 1, x1, WALL + 1, PCB_Z + BT + 9.5));          // USB-C + 2x micro-HDMI
  f.push(box('left', 'cut', -1, BY + BD / 2 - 8, FLOOR + 0.6, WALL + 1, BY + BD / 2 + 8, PCB_Z + 0.4));   // microSD
  f.push(box('left', 'cut', -1, BY + 5, PCB_Z + BT + 1, WALL + 1, BY + BD - 5, OH - 4));   // power button / PCIe / fan
  f.push(box('back', 'cut', BX + 10, OD - WALL - 1, PCB_Z + 6, BX + 13, OD + 1, OH - 5, row(9, 7)));      // wall vents
  f.push(box('bottom', 'cut', BX + 14, BY + 14, -1, BX + 17, BY + BD - 14, FLOOR + 1, row(7, 7)));         // floor vents
  return f;
}

function lid() {
  const f = [];
  f.push({ ...box('top', 'add', 0, 0, 0, OW, OD, LID_T), corner: R });                     // the plate
  const x0 = WALL + FIT, y0 = WALL + FIT, x1 = OW - WALL - FIT - 2, y1 = OD - WALL - FIT;
  f.push(box('top', 'add', x0, y0, LID_T, x1, y1, LID_T + LIP_H));                          // the lip...
  f.push(box('top', 'cut', x0 + LIP_W, y0 + LIP_W, LID_T, x1 - LIP_W, y1 - LIP_W, LID_T + LIP_H + 1));  // ...a ring
  const gy = (ty) => OD - ty;                                                               // the lid prints lip-up: y mirrored
  f.push(box('top', 'cut', BX + 6, gy(BY + BD - 0.5), -1, BX + 59, gy(BY + BD - 7.5), LID_T + 1));       // GPIO ribbon slot
  f.push(box('top', 'cut', BX + 14, gy(BY + 42), -1, BX + 16.5, gy(BY + 10), LID_T + 1, row(8, 5)));     // cooler vents
  return f;
}

const OC = await opencascade({ locateFile: () => new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url).pathname });
setOC(OC);
for (const [name, features, stlVolume] of [['pi5_case_tray', tray(), 19004], ['pi5_case_lid', lid(), 10250]]) {
  const p = { ...newProject(), name, views: ['top', 'front', 'right'], stock: { ...newProject().stock, off: true }, features };
  const r = build(p, ['top'], false, false);
  const bad = Object.entries(r.effect).filter(([, e]) => !e).map(([id]) => id);
  console.log(name, `${features.length} shapes, volume ${r.volume.toFixed(0)} mm³ (STL ${stlVolume})`, bad.length ? `NO EFFECT: ${bad}` : '', Object.keys(r.errors).length ? r.errors : '');
  if (Math.abs(r.volume - stlVolume) / stlVolume > 0.01) throw new Error(`${name}: volume off by more than 1%`);
  writeFileSync(new URL(`../../../models/${name}.design.json`, import.meta.url), JSON.stringify(p, null, 1));
}
