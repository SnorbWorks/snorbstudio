// Simple parts made right on the Prepare page: boxes, cylinders, tubes,
// cones, spheres and raised text (name tags, labels).  Each shape becomes a
// small STL so it goes through the library and slicer like any other model.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { el } from './ui.js';

const SEG = 96;

export const SHAPES = {
  box: { label: 'Box', fields: [['w', 'Width', 20], ['d', 'Depth', 20], ['h', 'Height', 20]] },
  cylinder: { label: 'Cylinder', fields: [['dia', 'Diameter', 20], ['h', 'Height', 20]] },
  tube: { label: 'Tube / ring', fields: [['dia', 'Outer diameter', 30], ['hole', 'Hole diameter', 20], ['h', 'Height', 10]] },
  cone: { label: 'Cone', fields: [['dia', 'Bottom diameter', 30], ['top', 'Top diameter', 0], ['h', 'Height', 30]] },
  sphere: { label: 'Sphere', fields: [['dia', 'Diameter', 30]] },
  text: { label: 'Text', fields: [['text', 'Text', 'Hello'], ['size', 'Letter height', 12], ['h', 'Letter thickness', 3], ['base', 'Base plate thickness (0 = none)', 2]] },
};

let fontPromise;
function font() {
  fontPromise ??= new Promise((ok, bad) =>
    new FontLoader().load('vendor/three/addons/fonts/helvetiker_bold.typeface.json', ok, undefined, bad));
  return fontPromise;
}

const clean = (g) => {
  g = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
  return g;
};

function ring(outer, inner, h) {
  const s = new THREE.Shape().absarc(0, 0, outer / 2, 0, Math.PI * 2, false);
  if (inner > 0) s.holes.push(new THREE.Path().absarc(0, 0, inner / 2, 0, Math.PI * 2, true));
  return new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: SEG });
}

// Geometry in mm, Z up.  Throws with a friendly message on bad sizes.
export async function buildShape(kind, v) {
  const pos = (k, name) => {
    if (!(v[k] > 0)) throw new Error(`${name} must be more than 0 mm.`);
    return v[k];
  };
  switch (kind) {
    case 'box':
      return new THREE.BoxGeometry(pos('w', 'Width'), pos('d', 'Depth'), pos('h', 'Height'));
    case 'cylinder':
      return ring(pos('dia', 'Diameter'), 0, pos('h', 'Height'));
    case 'tube': {
      const o = pos('dia', 'Outer diameter');
      if (!(v.hole > 0 && v.hole < o - 0.8)) throw new Error('The hole has to be smaller than the outside (walls at least 0.4 mm).');
      return ring(o, v.hole, pos('h', 'Height'));
    }
    case 'cone': {
      const g = new THREE.CylinderGeometry(Math.max(0, v.top || 0) / 2, pos('dia', 'Bottom diameter') / 2,
        pos('h', 'Height'), SEG);
      return g.rotateX(Math.PI / 2);
    }
    case 'sphere':
      return new THREE.SphereGeometry(pos('dia', 'Diameter') / 2, SEG, SEG / 2);
    case 'text': {
      const text = String(v.text || '').trim();
      if (!text) throw new Error('Type some text first.');
      const base = Math.max(0, +v.base || 0);
      const g = clean(new TextGeometry(text, {
        font: await font(), size: pos('size', 'Letter height'), height: pos('h', 'Letter thickness'),
        curveSegments: 8, bevelEnabled: false }));
      if (!base) return g;
      g.computeBoundingBox();
      const b = g.boundingBox, pad = Math.max(2, v.size * 0.3);
      const w = b.max.x - b.min.x + 2 * pad, d = b.max.y - b.min.y + 2 * pad;
      const plate = clean(new THREE.BoxGeometry(w, d, base))
        .translate((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, -base / 2);
      return mergeGeometries([g, plate]);
    }
  }
  throw new Error(`Unknown shape ${kind}`);
}

export function shapeName(kind, v) {
  const n = (x) => +(+x).toFixed(1);
  const dims = {
    box: () => `${n(v.w)}x${n(v.d)}x${n(v.h)}`,
    cylinder: () => `d${n(v.dia)}x${n(v.h)}`,
    tube: () => `d${n(v.dia)}-${n(v.hole)}x${n(v.h)}`,
    cone: () => `d${n(v.dia)}-${n(v.top || 0)}x${n(v.h)}`,
    sphere: () => `d${n(v.dia)}`,
    text: () => String(v.text).trim().replace(/[^\w-]+/g, '_').slice(0, 24),
  }[kind]();
  return `${kind}-${dims}.stl`;
}

// The form shown in the "Add a shape" dialog.  read() gives {kind, values}.
export function shapeForm() {
  const kindSel = el('select', {}, ...Object.entries(SHAPES).map(([k, s]) => el('option', { value: k }, s.label)));
  const fields = el('div', { class: 'shape-fields' });
  const draw = () => {
    fields.replaceChildren(...SHAPES[kindSel.value].fields.map(([k, label, def]) => el('label', { class: 'field' },
      el('span', {}, typeof def === 'number' ? `${label} (mm)` : label),
      el('input', typeof def === 'number'
        ? { type: 'number', min: 0, step: 0.1, value: def, 'data-k': k }
        : { type: 'text', maxlength: 40, value: def, 'data-k': k }))));
  };
  kindSel.onchange = draw;
  draw();
  const form = el('div', { class: 'shape-form' }, el('label', { class: 'field' }, el('span', {}, 'Shape'), kindSel), fields);
  return {
    form,
    read() {
      const values = {};
      for (const i of fields.querySelectorAll('input')) values[i.dataset.k] = i.type === 'number' ? +i.value : i.value;
      return { kind: kindSel.value, values };
    },
  };
}
