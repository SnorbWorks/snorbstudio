// Geometry helpers for the Prepare page: putting parts on the bed, finding
// the best orientation, spotting overhangs and writing STL for the slicer.
// All models are non-indexed BufferGeometry centred on their own origin, so
// rotation and scale happen about the model's middle.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BED } from './viewer.js';

const DOWN = new THREE.Vector3(0, 0, -1);
const COLORS = {
  body: new THREE.Color(0xb9c3cf),
  overhang: new THREE.Color(0xff4d4d),
  bed: new THREE.Color(0x3ddc97),
};

// --------------------------------------------------------------- loading

// Any loader result (geometry or object tree) -> one clean geometry.
export function toGeometry(result) {
  let geo;
  if (result.isBufferGeometry) {
    geo = result;
  } else {
    result.position.set(0, 0, 0);
    result.rotation.set(0, 0, 0);
    result.scale.set(1, 1, 1);
    result.updateMatrixWorld(true);
    const parts = [];
    result.traverse((o) => {
      if (!o.isMesh) return;
      let g = o.geometry.clone();
      g = g.index ? g.toNonIndexed() : g;
      for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
      g.applyMatrix4(o.matrixWorld);
      parts.push(g);
    });
    if (!parts.length) throw new Error('No mesh found in file');
    geo = parts.length === 1 ? parts[0] : mergeGeometries(parts);
  }
  if (geo.index) geo = geo.toNonIndexed();
  for (const k of Object.keys(geo.attributes)) if (k !== 'position') geo.deleteAttribute(k);
  geo.computeBoundingBox();
  const c = geo.boundingBox.getCenter(new THREE.Vector3());
  geo.translate(-c.x, -c.y, -c.z);
  geo.computeVertexNormals();         // non-indexed: flat face normals
  geo.setAttribute('color', new THREE.Float32BufferAttribute(
    new Float32Array(geo.attributes.position.count * 3), 3));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

export function makeMesh(geo, name) {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData = { name, faces: geo.attributes.position.count / 3 };
  return mesh;
}

// --------------------------------------------------------------- placement

export function worldBox(mesh) {
  mesh.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(mesh, true);
}

export function dropToBed(mesh) {
  mesh.position.z -= worldBox(mesh).min.z;
  mesh.updateMatrixWorld(true);
}

// Keep the footprint centre where it was while turning the part over.
function rotateKeepingPlace(mesh, q) {
  const before = worldBox(mesh).getCenter(new THREE.Vector3());
  mesh.quaternion.premultiply(q);
  const after = worldBox(mesh).getCenter(new THREE.Vector3());
  mesh.position.x += before.x - after.x;
  mesh.position.y += before.y - after.y;
  dropToBed(mesh);
}

export function rotateBy(mesh, axis, deg) {
  const v = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axis];
  rotateKeepingPlace(mesh, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...v), THREE.MathUtils.degToRad(deg)));
}

export function mirror(mesh, axis) {
  // Mirror in world space: flip the world axis through the part's centre.
  const m = new THREE.Matrix4().makeScale(axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1, 1);
  const before = worldBox(mesh).getCenter(new THREE.Vector3());
  mesh.updateMatrix();
  mesh.matrix.premultiply(m);
  mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
  const after = worldBox(mesh).getCenter(new THREE.Vector3());
  mesh.position.x += before.x - after.x;
  mesh.position.y += before.y - after.y;
  dropToBed(mesh);
}

// Volume in mm³ (signed tetrahedra; exact for closed meshes).
export function volume(mesh) {
  if (mesh.userData.localVolume == null) {
    const p = mesh.geometry.attributes.position.array;
    let v = 0;
    for (let i = 0; i < p.length; i += 9) {
      v += p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7])
        - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6])
        + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6]);
    }
    mesh.userData.localVolume = Math.abs(v / 6);
  }
  mesh.updateMatrixWorld(true);
  return mesh.userData.localVolume * Math.abs(mesh.matrixWorld.determinant());
}

export function rotate90(mesh, axis) {
  const v = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axis];
  rotateKeepingPlace(mesh, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...v), Math.PI / 2));
}

export function inBounds(mesh) {
  const b = worldBox(mesh);
  const e = 0.01;
  return b.min.x >= -e && b.min.y >= -e && b.max.x <= BED.x + e && b.max.y <= BED.y + e &&
    b.max.z <= BED.z + e;
}

export function centerOnBed(mesh) {
  const c = worldBox(mesh).getCenter(new THREE.Vector3());
  mesh.position.x += BED.x / 2 - c.x;
  mesh.position.y += BED.y / 2 - c.y;
  dropToBed(mesh);
}

// Shelf-pack every model's footprint, then centre the layout on the bed.
export function arrange(meshes, gap = 8) {
  if (!meshes.length) return true;
  const items = meshes.map((m) => {
    const b = worldBox(m);
    return { m, w: b.max.x - b.min.x, d: b.max.y - b.min.y, b };
  }).sort((a, b) => b.d - a.d || b.w - a.w);
  let x = 0, y = 0, rowD = 0, maxW = 0;
  const place = [];
  for (const it of items) {
    if (x > 0 && x + it.w > BED.x) { x = 0; y += rowD + gap; rowD = 0; }
    place.push({ it, x, y });
    x += it.w + gap;
    rowD = Math.max(rowD, it.d);
    maxW = Math.max(maxW, x - gap);
  }
  const totalD = y + rowD;
  const ox = (BED.x - maxW) / 2, oy = (BED.y - totalD) / 2;
  for (const { it, x: px, y: py } of place) {
    it.m.position.x += ox + px - it.b.min.x;
    it.m.position.y += oy + py - it.b.min.y;
    dropToBed(it.m);
  }
  return totalD <= BED.y && maxW <= BED.x;
}

// --------------------------------------------------------------- faces

// World-space face normals, areas and vertex positions (relative to the
// model centre - translation doesn't matter for orientation).
function faceData(mesh) {
  mesh.updateMatrixWorld(true);
  const pos = mesh.geometry.attributes.position.array;
  const m = new THREE.Matrix4().copy(mesh.matrixWorld).setPosition(0, 0, 0);
  const e = m.elements;
  const nv = pos.length / 3, nf = nv / 3;
  const v = new Float32Array(pos.length);
  for (let i = 0; i < nv; i++) {
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
    v[3 * i] = e[0] * x + e[4] * y + e[8] * z;
    v[3 * i + 1] = e[1] * x + e[5] * y + e[9] * z;
    v[3 * i + 2] = e[2] * x + e[6] * y + e[10] * z;
  }
  const n = new Float32Array(nf * 3), area = new Float32Array(nf);
  const flip = m.determinant() < 0 ? -1 : 1;     // mirrored parts
  for (let f = 0; f < nf; f++) {
    const a = 9 * f;
    const ux = v[a + 3] - v[a], uy = v[a + 4] - v[a + 1], uz = v[a + 5] - v[a + 2];
    const wx = v[a + 6] - v[a], wy = v[a + 7] - v[a + 1], wz = v[a + 8] - v[a + 2];
    let cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    const len = Math.hypot(cx, cy, cz) || 1;
    area[f] = len / 2;
    n[3 * f] = flip * cx / len; n[3 * f + 1] = flip * cy / len; n[3 * f + 2] = flip * cz / len;
  }
  return { v, n, area, nf };
}

// Group faces that point the same way; biggest groups are the flat sides.
function normalClusters(fd, limit) {
  const map = new Map();
  for (let f = 0; f < fd.nf; f++) {
    const nx = fd.n[3 * f], ny = fd.n[3 * f + 1], nz = fd.n[3 * f + 2];
    const key = `${Math.round(nx * 40)},${Math.round(ny * 40)},${Math.round(nz * 40)}`;
    let c = map.get(key);
    if (!c) map.set(key, c = { n: new THREE.Vector3(), area: 0 });
    c.n.x += nx * fd.area[f]; c.n.y += ny * fd.area[f]; c.n.z += nz * fd.area[f];
    c.area += fd.area[f];
  }
  return [...map.values()].sort((a, b) => b.area - a.area).slice(0, limit)
    .map((c) => ({ n: c.n.normalize(), area: c.area }));
}

// How a part would sit if direction `d` (world) pointed straight down:
// area touching the bed, overhang area and height.
function evaluate(fd, d, cosLimit) {
  const q = new THREE.Quaternion().setFromUnitVectors(d, DOWN);
  const R = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
  const r0 = R[2], r1 = R[6], r2 = R[10];     // world -> new z
  let zmin = Infinity, zmax = -Infinity;
  const nv = fd.v.length / 3;
  const z = new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    const zz = r0 * fd.v[3 * i] + r1 * fd.v[3 * i + 1] + r2 * fd.v[3 * i + 2];
    z[i] = zz;
    if (zz < zmin) zmin = zz;
    if (zz > zmax) zmax = zz;
  }
  let contact = 0, overhang = 0;
  for (let f = 0; f < fd.nf; f++) {
    const nz = r0 * fd.n[3 * f] + r1 * fd.n[3 * f + 1] + r2 * fd.n[3 * f + 2];
    const lo = Math.max(z[3 * f], z[3 * f + 1], z[3 * f + 2]) - zmin;
    if (lo < 0.05) { if (nz < -0.98) contact += fd.area[f]; continue; }
    if (nz < -cosLimit) overhang += fd.area[f];
  }
  return { q, contact, overhang, height: zmax - zmin };
}

export function layFlat(mesh) {
  const fd = faceData(mesh);
  let best = null;
  for (const c of normalClusters(fd, 40)) {
    const r = evaluate(fd, c.n, 0.7);
    if (!best || r.contact > best.contact) best = r;
  }
  if (best) rotateKeepingPlace(mesh, best.q);
  return best;
}

export function layFlatOnFace(mesh, faceIndex) {
  const fd = faceData(mesh);
  const d = new THREE.Vector3(fd.n[3 * faceIndex], fd.n[3 * faceIndex + 1], fd.n[3 * faceIndex + 2]);
  rotateKeepingPlace(mesh, new THREE.Quaternion().setFromUnitVectors(d, DOWN));
}

// Try every stable way to stand the part and keep the one with the least
// overhang (= least support), preferring a big footprint and low height.
export function autoOrient(mesh, angleDeg) {
  const fd = faceData(mesh);
  const cosLimit = Math.cos(THREE.MathUtils.degToRad(angleDeg));
  const dirs = normalClusters(fd, 30).map((c) => c.n);
  for (const a of [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]) {
    dirs.push(new THREE.Vector3(...a));
  }
  const now = evaluate(fd, DOWN.clone(), cosLimit);
  const totalArea = fd.area.reduce((s, a) => s + a, 0);
  const score = (r) => r.overhang + 0.02 * totalArea * (r.height / 100) -
    Math.min(r.contact, 0.05 * totalArea) * 0.5 + (r.contact < 4 ? totalArea : 0);
  let best = null;
  for (const d of dirs) {
    const r = evaluate(fd, d, cosLimit);
    r.score = score(r);
    if (!best || r.score < best.score) best = r;
  }
  now.score = score(now);
  if (best && best.score < now.score - 1e-6) rotateKeepingPlace(mesh, best.q);
  else best = now;
  return { before: now.overhang, after: best.overhang };
}

// --------------------------------------------------------------- overhangs

// Paint faces: red = needs support, green = sits on the bed.  Returns mm².
export function paintOverhangs(mesh, show, angleDeg) {
  const fd = faceData(mesh);
  const cosLimit = Math.cos(THREE.MathUtils.degToRad(angleDeg));
  const zoff = mesh.position.z;
  const col = mesh.geometry.attributes.color;
  const c = col.array;
  let overhang = 0;
  for (let f = 0; f < fd.nf; f++) {
    const z0 = fd.v[9 * f + 2] + zoff, z1 = fd.v[9 * f + 5] + zoff, z2 = fd.v[9 * f + 8] + zoff;
    const nz = fd.n[3 * f + 2];
    let k = COLORS.body;
    if (Math.max(z0, z1, z2) < 0.05 && nz < -0.98) k = COLORS.bed;
    else if (nz < -cosLimit && Math.min(z0, z1, z2) > 0.3) {
      overhang += fd.area[f];
      if (show) k = COLORS.overhang;
    }
    for (let j = 0; j < 3; j++) {
      c[9 * f + 3 * j] = k.r; c[9 * f + 3 * j + 1] = k.g; c[9 * f + 3 * j + 2] = k.b;
    }
  }
  col.needsUpdate = true;
  mesh.userData.overhang = overhang;
  return overhang;
}

// --------------------------------------------------------------- export

// Binary STL in bed coordinates, with real normals (PrusaSlicer rejects
// some files with zero normals).
export function toSTL(mesh) {
  mesh.updateMatrixWorld(true);
  const pos = mesh.geometry.attributes.position.array;
  const nf = pos.length / 9;
  const buf = new ArrayBuffer(84 + 50 * nf);
  const dv = new DataView(buf);
  const head = 'Ender Studio plate';
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, nf, true);
  const m = mesh.matrixWorld;
  const flip = m.determinant() < 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const u = new THREE.Vector3(), w = new THREE.Vector3();
  let o = 84;
  for (let f = 0; f < nf; f++) {
    a.fromArray(pos, 9 * f).applyMatrix4(m);
    b.fromArray(pos, 9 * f + 3).applyMatrix4(m);
    c.fromArray(pos, 9 * f + 6).applyMatrix4(m);
    if (flip) { const t = b.clone(); b.copy(c); c.copy(t); }
    u.subVectors(b, a); w.subVectors(c, a); u.cross(w).normalize();
    for (const v of [u, a, b, c]) {
      dv.setFloat32(o, v.x, true); dv.setFloat32(o + 4, v.y, true); dv.setFloat32(o + 8, v.z, true);
      o += 12;
    }
    o += 2;
  }
  return buf;
}
