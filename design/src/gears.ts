// Gear outlines (pure maths, no CAD kernel): involute spur/helical teeth,
// internal ring gears and racks. All sizes in mm, angles in degrees.
//
// Printed gears need a little play, so `backlash` thins every tooth by that
// much at the pitch circle (0.1-0.15 mm suits an FDM printer).

export interface GearSpec {
  kind: 'spur' | 'helical' | 'ring' | 'rack';
  pitch: 'module' | 'dp';     // how the owner enters it; module (mm) is stored either way
  module: number;             // mm of pitch diameter per tooth (DP = 25.4 / module)
  teeth: number;
  pa: number;                 // pressure angle: 20 (default), 14.5 (legacy), 25 (heavy duty)
  helix: number;              // helical: helix angle
  backlash: number;           // mm taken off each tooth at the pitch circle
  rim: number;                // ring: rim thickness outside the roots; rack: backing below the roots
  bore: 'none' | 'round' | 'd';
  boreD: number;              // bore diameter
  flat: number;               // D bore: distance from the flat to the far side of the bore
  screw: number;              // set screw hole diameter (0 = none), radial, through the hub
  hubD: number;               // hub diameter (0 = no hub)
  hubLen: number;             // hub length, on the start side
}

export function defaultGear(): GearSpec {
  return {
    kind: 'spur', pitch: 'module', module: 1, teeth: 20, pa: 20, helix: 20, backlash: 0.1,
    rim: 3, bore: 'none', boreD: 5, flat: 4.5, screw: 0, hubD: 0, hubLen: 0,
  };
}

const rad = (d: number) => (d * Math.PI) / 180;
const inv = (a: number) => Math.tan(a) - a;

export function pitchRadius(g: GearSpec) { return (g.module * g.teeth) / 2; }

/** The outermost radius of the gear (ring: the rim). */
export function outerRadius(g: GearSpec) {
  const rp = pitchRadius(g);
  if (g.kind === 'ring') return rp + 1.25 * g.module + g.rim;
  return rp + g.module;
}

/**
 * One closed outline of an external gear with z teeth, centred on 0,0,
 * tooth 0 pointing along +u. addendum/dedendum in modules; thin: mm
 * taken off each tooth at the pitch circle (negative fattens it).
 */
export function gearOutline(m: number, z: number, paDeg: number, add = 1, ded = 1.25, thin = 0, steps = 8): [number, number][] {
  const pa = rad(paDeg);
  const rp = (m * z) / 2, rb = rp * Math.cos(pa), ra = rp + add * m, rf = Math.max(0.2 * rp, rp - ded * m);
  // half the tooth's angular thickness at the base circle
  const halfPitch = Math.PI / (2 * z) - thin / 2 / rp;
  const psiB = halfPitch + inv(pa);
  const flank = (r: number) => psiB - inv(Math.acos(Math.min(1, rb / r)));   // half-angle of the tooth at radius r
  const r0 = Math.max(rb, rf);
  const radii: number[] = [];
  for (let i = 0; i <= steps; i++) radii.push(r0 + ((ra - r0) * i) / steps);
  const out: [number, number][] = [];
  const pt = (r: number, a: number): [number, number] => [r * Math.cos(a), r * Math.sin(a)];
  const fr0 = flank(r0);
  for (let k = 0; k < z; k++) {
    const c = (2 * Math.PI * k) / z;
    if (rf < rb - 1e-9) out.push(pt(rf, c - fr0));          // radial from the root up to the base circle
    for (const r of radii) out.push(pt(r, c - flank(r)));   // rising flank
    out.push(pt(ra, c));                                     // tip
    for (const r of [...radii].reverse()) out.push(pt(r, c + flank(r)));
    if (rf < rb - 1e-9) out.push(pt(rf, c + fr0));
    // the root, round to the next tooth
    const a0 = c + fr0, a1 = c + (2 * Math.PI) / z - fr0;
    for (let i = 1; i < 4; i++) out.push(pt(rf, a0 + ((a1 - a0) * i) / 4));
  }
  return dedupe(out);
}

/** One piece of a smooth outline: a line, a cubic Bézier, or an arc through a point. */
export type Seg =
  | { t: 'L'; p: [number, number] }
  | { t: 'C'; c1: [number, number]; c2: [number, number]; p: [number, number] }
  | { t: 'A'; m: [number, number]; p: [number, number] };
export interface Path { start: [number, number]; segs: Seg[] }

/**
 * The same outline as gearOutline, but each flank is one cubic Bézier and the
 * tips and roots are arcs: about 6 pieces a tooth instead of 25 straight ones,
 * so the solid has far fewer faces and edges (faster hidden lines, cleaner STL).
 */
export function gearPath(m: number, z: number, paDeg: number, add = 1, ded = 1.25, thin = 0): Path {
  const pa = rad(paDeg);
  const rp = (m * z) / 2, rb = rp * Math.cos(pa), ra = rp + add * m, rf = Math.max(0.2 * rp, rp - ded * m);
  const psiB = Math.PI / (2 * z) - thin / 2 / rp + inv(pa);
  const flank = (r: number) => psiB - inv(Math.acos(Math.min(1, rb / r)));
  const r0 = Math.max(rb, rf);
  const pt = (r: number, a: number): [number, number] => [r * Math.cos(a), r * Math.sin(a)];
  // the tip may come to a point on small or high-pressure-angle teeth: stop the flank there
  let rTop = ra;
  if (flank(ra) <= 1e-6) { let lo = r0, hi = ra; for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (flank(mid) > 1e-6) lo = mid; else hi = mid; } rTop = lo; }
  const segs: Seg[] = [];
  // a flank from radius r0 to rTop (side -1: the rising one, +1: falling), as one Bézier
  const flankBez = (c: number, side: number, ra0: number, ra1: number): Seg => {
    const P = (r: number) => pt(r, c + side * flank(r));
    const up = ra1 > ra0;
    const p0 = P(ra0), p3 = P(ra1);
    const h = Math.abs(ra1 - ra0) * 1e-4 * (up ? 1 : -1);
    const t0 = P(ra0 + h), t1 = P(ra1 - h);
    const dir = (a: [number, number], b: [number, number]): [number, number] => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
    const d0 = dir(p0, t0), d1 = dir(p3, t1);
    // handle lengths by least squares against points on the true involute
    const N = 16;
    const samples: [number, number][] = [];
    for (let i = 1; i < N; i++) samples.push(P(ra0 + ((ra1 - ra0) * i) / N));
    // parameters by chord length along the samples
    const all = [p0, ...samples, p3];
    const cum = [0];
    for (let i = 1; i < all.length; i++) cum.push(cum[i - 1] + Math.hypot(all[i][0] - all[i - 1][0], all[i][1] - all[i - 1][1]));
    let ts = cum.slice(1, -1).map((c) => c / cum[cum.length - 1]);
    let a = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) / 3, b = a;
    const bez = (t: number): [number, number] => {
      const u = 1 - t;
      const c1 = [p0[0] + d0[0] * a, p0[1] + d0[1] * a], c2 = [p3[0] + d1[0] * b, p3[1] + d1[1] * b];
      return [u ** 3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * p3[0], u ** 3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * p3[1]];
    };
    for (let iter = 0; iter < 4; iter++) {
      // B(t) = base(t) + A(t)·a·d0 + Bt(t)·b·d1: linear in a and b
      let s11 = 0, s12 = 0, s22 = 0, r1 = 0, r2 = 0;
      ts.forEach((t, i) => {
        const u = 1 - t, A = 3 * u * u * t, Bt = 3 * u * t * t;
        const base = [(u ** 3 + A) * p0[0] + (t ** 3 + Bt) * p3[0], (u ** 3 + A) * p0[1] + (t ** 3 + Bt) * p3[1]];
        const e = [samples[i][0] - base[0], samples[i][1] - base[1]];
        const x1 = [A * d0[0], A * d0[1]], x2 = [Bt * d1[0], Bt * d1[1]];
        s11 += x1[0] * x1[0] + x1[1] * x1[1]; s12 += x1[0] * x2[0] + x1[1] * x2[1]; s22 += x2[0] * x2[0] + x2[1] * x2[1];
        r1 += x1[0] * e[0] + x1[1] * e[1]; r2 += x2[0] * e[0] + x2[1] * e[1];
      });
      const det = s11 * s22 - s12 * s12;
      if (Math.abs(det) < 1e-18) break;
      a = (r1 * s22 - r2 * s12) / det; b = (s11 * r2 - s12 * r1) / det;
      // move each sample's parameter to the nearest point on the new curve (a few Newton-free steps)
      ts = ts.map((t, i) => {
        let best = t, bd = Infinity;
        for (let k = -8; k <= 8; k++) {
          const tt = Math.max(0, Math.min(1, t + k * 0.004));
          const q = bez(tt), d = (q[0] - samples[i][0]) ** 2 + (q[1] - samples[i][1]) ** 2;
          if (d < bd) { bd = d; best = tt; }
        }
        return best;
      });
    }
    return { t: 'C', c1: [p0[0] + d0[0] * a, p0[1] + d0[1] * a], c2: [p3[0] + d1[0] * b, p3[1] + d1[1] * b], p: p3 };
  };
  const fr0 = flank(r0);
  const radial = rf < rb - 1e-9;
  const start: [number, number] = radial ? pt(rf, -fr0) : pt(r0, -fr0);
  for (let k = 0; k < z; k++) {
    const c = (2 * Math.PI * k) / z;
    if (radial) segs.push({ t: 'L', p: pt(r0, c - fr0) });
    // two pieces a flank: the involute bends hardest near the base circle
    const rMid = r0 + (rTop - r0) * 0.35;
    segs.push(flankBez(c, -1, r0, rMid), flankBez(c, -1, rMid, rTop));
    const ft = flank(rTop);
    if (ft > 1e-6) segs.push({ t: 'A', m: pt(rTop, c), p: pt(rTop, c + ft) });
    segs.push(flankBez(c, 1, rTop, rMid), flankBez(c, 1, rMid, r0));
    if (radial) segs.push({ t: 'L', p: pt(rf, c + fr0) });
    // the root, round to the next tooth (the last one closes the outline)
    const a0 = c + fr0, a1 = c + (2 * Math.PI) / z - fr0;
    const end = radial ? pt(rf, a1) : pt(r0, a1);
    const rr = radial ? rf : r0;
    if (a1 - a0 > 1e-6) segs.push({ t: 'A', m: pt(rr, (a0 + a1) / 2), p: end });
  }
  return { start, segs };
}

/** Turn and move a path the way place() does an outline. */
export function placePath(path: Path, cu: number, cv: number, rotDeg: number): Path {
  const c = Math.cos(rad(rotDeg)), s = Math.sin(rad(rotDeg));
  const f = ([x, y]: [number, number]): [number, number] => [cu + x * c - y * s, cv + x * s + y * c];
  return {
    start: f(path.start),
    segs: path.segs.map((g) => (g.t === 'L' ? { t: 'L', p: f(g.p) } : g.t === 'C' ? { t: 'C', c1: f(g.c1), c2: f(g.c2), p: f(g.p) } : { t: 'A', m: f(g.m), p: f(g.p) })),
  };
}

/** A rack's outline: teeth along +u, centred on 0, pitch line at v = 0. */
export function rackOutline(m: number, n: number, paDeg: number, backing: number, thin = 0): [number, number][] {
  const p = Math.PI * m, pa = rad(paDeg);
  const a = m, d = 1.25 * m;
  const half = p / 4 - thin / 2;                      // half tooth thickness at the pitch line
  const len = n * p;
  const x0 = -len / 2;
  const out: [number, number][] = [[x0, -d - backing]];
  for (let k = 0; k < n; k++) {
    const c = x0 + p * (k + 0.5);
    out.push([c - half - d * Math.tan(pa), -d], [c - half + a * Math.tan(pa), a], [c + half - a * Math.tan(pa), a], [c + half + d * Math.tan(pa), -d]);
  }
  out.push([x0 + len, -d], [x0 + len, -d - backing]);
  out.unshift([x0, -d]);
  return [out[1], out[0], ...out.slice(2)];
}

function dedupe(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) out.push(p);
  }
  const f = out[0], l = out[out.length - 1];
  if (out.length > 1 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-6) out.pop();
  return out;
}

/** Rotate a gear outline (degrees) and move it to (cu, cv). */
export function place(pts: [number, number][], cu: number, cv: number, rotDeg: number): [number, number][] {
  const c = Math.cos(rad(rotDeg)), s = Math.sin(rad(rotDeg));
  return pts.map(([x, y]) => [cu + x * c - y * s, cv + x * s + y * c]);
}

/** Centre distance of two external gears of the same module. */
export function centreDistance(m: number, z1: number, z2: number) { return (m * (z1 + z2)) / 2; }

/**
 * The rotation gear 2 needs so its teeth sit in gear 1's gaps, when gear 2's
 * centre is in direction phiDeg from gear 1's (both external, same module).
 */
export function meshRotation(rot1: number, z1: number, z2: number, phiDeg: number): number {
  return phiDeg + 180 + 180 / z2 - ((rot1 - phiDeg) * z1) / z2;
}
