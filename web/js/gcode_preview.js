// Layer-by-layer toolpath preview for PrusaSlicer G-code.  Extrusion moves
// become line segments coloured by feature (;TYPE: comments); layers below
// the current one are drawn dimmer so the current layer stands out.

import * as THREE from 'three';

export const FEATURES = {
  'Perimeter': '#ffc240',
  'External perimeter': '#ff8a3d',
  'Overhang perimeter': '#4fc3f7',
  'Internal infill': '#e0524a',
  'Solid infill': '#b05cd6',
  'Top solid infill': '#ff5c8a',
  'Bottom solid infill': '#9b6bd6',
  'Bridge infill': '#5c9cff',
  'Gap fill': '#f5f5f5',
  'Skirt/Brim': '#36c9b4',
  'Support material': '#43c47a',
  'Support material interface': '#2e8b57',
  'Ironing': '#ffe08a',
  'Wipe tower': '#9e9e9e',
  'Custom': '#9e9e9e',
};
const OTHER = '#9e9e9e';

export function parseGcode(text) {
  const segs = [];               // x0,y0,z0,x1,y1,z1 per segment
  const types = [];              // feature index per segment
  const layerStart = [];         // first segment index of each layer
  const layerZ = [];
  const typeNames = Object.keys(FEATURES);
  let x = 0, y = 0, z = 0, e = 0;
  let absXYZ = true, absE = false, type = typeNames.indexOf('Custom');
  let layerPending = true;
  let zComment = 0;
  const colorZ = [];             // ;Z: heights that have an M600 filament change
  let pos = 0;
  const len = text.length;
  while (pos < len) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = len;
    const line = text.slice(pos, end);
    pos = end + 1;
    const c0 = line.charCodeAt(0);
    if (c0 === 59) {                                   // ';'
      if (line.startsWith(';TYPE:')) {
        let t = typeNames.indexOf(line.slice(6).trim());
        if (t < 0) { typeNames.push(line.slice(6).trim()); t = typeNames.length - 1; }
        type = t;
      } else if (line.startsWith(';LAYER_CHANGE')) {
        layerPending = true;
      } else if (line.startsWith(';Z:')) {
        zComment = parseFloat(line.slice(3));
      }
      continue;
    }
    if (c0 === 71) {                                   // 'G'
      const sp = line.indexOf(';');
      const code = sp >= 0 ? line.slice(0, sp) : line;
      const words = code.trim().split(/\s+/);
      const g = words[0];
      if (g === 'G1' || g === 'G0') {
        let nx = x, ny = y, nz = z, de = 0, hasE = false;
        for (let i = 1; i < words.length; i++) {
          const w = words[i], v = parseFloat(w.slice(1));
          switch (w[0]) {
            case 'X': nx = absXYZ ? v : x + v; break;
            case 'Y': ny = absXYZ ? v : y + v; break;
            case 'Z': nz = absXYZ ? v : z + v; break;
            case 'E': hasE = true; de = absE ? v - e : v; if (absE) e = v; break;
          }
        }
        if (hasE && de > 0 && (nx !== x || ny !== y)) {
          if (layerPending || layerZ.length === 0) {
            layerStart.push(types.length);
            layerZ.push(nz);
            layerPending = false;
          }
          segs.push(x, y, z, nx, ny, nz);
          types.push(type);
        }
        x = nx; y = ny; z = nz;
      } else if (g === 'G90') absXYZ = true;
      else if (g === 'G91') absXYZ = false;
      else if (g === 'G92') {
        for (const w of words.slice(1)) if (w[0] === 'E') e = parseFloat(w.slice(1));
      }
    } else if (c0 === 77) {                            // 'M'
      if (line.startsWith('M600')) colorZ.push(zComment);
      else if (line.startsWith('M82')) absE = true;
      else if (line.startsWith('M83')) absE = false;
    }
  }
  return { segs: new Float32Array(segs), types: Uint8Array.from(types), layerStart, layerZ, typeNames, colorZ };
}

export class GcodePreview {
  constructor(group) {
    this.group = group;
    this.hiddenTypes = new Set();
  }

  load(parsed) {
    this.p = parsed;
    this.build();
  }

  build() {
    for (const o of [...this.group.children]) { o.geometry.dispose(); this.group.remove(o); }
    const { segs, types, layerStart, typeNames } = this.p;
    const n = types.length;
    // Keep segments sorted by layer (they already are) but drop hidden types,
    // remembering where each layer starts in the filtered list.
    const pos = new Float32Array(n * 6), col = new Float32Array(n * 6), dim = new Float32Array(n * 6);
    const starts = [];
    let k = 0, layer = 0;
    const cols = typeNames.map((t) => new THREE.Color(FEATURES[t] || OTHER));
    for (let i = 0; i < n; i++) {
      while (layer < layerStart.length && layerStart[layer] <= i) { starts.push(k); layer++; }
      if (this.hiddenTypes.has(typeNames[types[i]])) continue;
      pos.set(segs.subarray(6 * i, 6 * i + 6), 6 * k);
      const c = cols[types[i]];
      for (let j = 0; j < 2; j++) {
        col[6 * k + 3 * j] = c.r; col[6 * k + 3 * j + 1] = c.g; col[6 * k + 3 * j + 2] = c.b;
        dim[6 * k + 3 * j] = c.r * 0.38; dim[6 * k + 3 * j + 1] = c.g * 0.38; dim[6 * k + 3 * j + 2] = c.b * 0.38;
      }
      k++;
    }
    while (starts.length < layerStart.length) starts.push(k);
    starts.push(k);
    this.starts = starts;
    const posAttr = new THREE.BufferAttribute(pos.subarray(0, k * 6), 3);
    const mk = (colors) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', posAttr);
      g.setAttribute('color', new THREE.BufferAttribute(colors.subarray(0, k * 6), 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }));
    };
    this.below = mk(dim);
    this.current = mk(col);
    this.group.add(this.below, this.current);
    this.setLayer(this.layer ?? this.layers - 1, this.single);
  }

  get layers() { return this.p ? this.p.layerZ.length : 0; }

  setLayer(i, single = false) {
    this.layer = Math.max(0, Math.min(i, this.layers - 1));
    this.single = single;
    const s = this.starts;
    this.below.geometry.setDrawRange(0, single ? 0 : s[this.layer] * 2);
    this.current.geometry.setDrawRange(s[this.layer] * 2, (s[this.layer + 1] - s[this.layer]) * 2);
  }

  toggleType(t) {
    this.hiddenTypes.has(t) ? this.hiddenTypes.delete(t) : this.hiddenTypes.add(t);
    this.build();
  }

  usedTypes() {
    const used = new Set(this.p.types);
    return this.p.typeNames.filter((_, i) => used.has(i));
  }
}
