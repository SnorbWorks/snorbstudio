// A see-through hot end for the toolpath view: the Ender 3's nozzle, heater
// block, heat sink and fan shroud, the direct-drive extruder on top and the
// CR Touch beside it, with the nozzle tip at the printer's live position.
// Sizes are close to the real parts, not exact. Z is up, the tip at the origin.

import * as THREE from 'three';

const PROBE = [-43, -10];        // CR Touch offset from the nozzle (printer.cfg)

export class Hotend {
  constructor(scene) {
    const g = this.group = new THREE.Group();
    g.visible = false;
    g.renderOrder = 10;
    const glass = new THREE.MeshStandardMaterial({ color: 0xd9a3d8, transparent: true, opacity: 0.22,
      roughness: 0.5, depthWrite: false, side: THREE.DoubleSide });
    const metal = new THREE.MeshStandardMaterial({ color: 0xf7b6c8, transparent: true, opacity: 0.4,
      roughness: 0.4, depthWrite: false });
    // the tip and its marks: bright and drawn over everything, so they show on any colour of toolpath
    const tipMat = new THREE.MeshBasicMaterial({ color: 0x4fe3ff, transparent: true, opacity: 0.95, depthTest: false });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0xf4e9f5, transparent: true, opacity: 0.45, depthWrite: false });
    const add = (geo, mat, x, y, z, edges = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      g.add(m);
      if (edges) {
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), edgeMat);
        e.position.copy(m.position);
        g.add(e);
      }
      return m;
    };
    const cyl = (r0, r1, h, n = 24) => new THREE.CylinderGeometry(r1, r0, h, n).rotateX(Math.PI / 2);   // along Z, r0 at the bottom
    // nozzle: the tip, its hex, the throat
    add(cyl(0.4, 3.2, 3), tipMat, 0, 0, 1.5, false).renderOrder = 20;
    add(cyl(4, 4, 3, 6), metal, 0, 0, 4.5);
    // heater block (heater cartridge to the right), heat break
    add(new THREE.BoxGeometry(23, 16, 11.5), metal, 3.5, 0, 6 + 5.75);
    add(cyl(2.5, 2.5, 5), metal, 0, 0, 20);
    // heat sink inside the fan shroud, the part-cooling duct below the shroud's front
    add(new THREE.BoxGeometry(25, 25, 26), metal, 0, 0, 22.5 + 13);
    add(new THREE.BoxGeometry(46, 32, 52), glass, -3, -3, 20 + 26);
    add(new THREE.BoxGeometry(20, 14, 10), glass, 0, -18, 13);
    // direct-drive extruder and its motor on top
    add(new THREE.BoxGeometry(44, 42, 42), glass, 0, 0, 72 + 21);
    // CR Touch (pin up)
    add(cyl(6.5, 6.5, 37), glass, PROBE[0], PROBE[1], 8 + 18.5);
    add(cyl(1, 1, 6, 8), metal, PROBE[0], PROBE[1], 5);

    // a line from the tip to the bed and a ring under it, so the spot reads from any angle
    const drop = new THREE.BufferGeometry();
    drop.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3));
    this.drop = new THREE.Line(drop, new THREE.LineDashedMaterial({ color: 0x4fe3ff, dashSize: 2, gapSize: 2, transparent: true, opacity: 0.8, depthTest: false }));
    g.add(this.drop);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(2.6, 3.6, 32),
      new THREE.MeshBasicMaterial({ color: 0x4fe3ff, transparent: true, opacity: 0.8, depthTest: false, side: THREE.DoubleSide }));
    this.drop.renderOrder = this.ring.renderOrder = 20;
    g.add(this.ring);
    scene.add(g);

    this.target = null;          // where the printer says the tip is
    this.last = performance.now();
  }

  /** The nozzle tip's position (bed coordinates, mm), or null to hide it. */
  set(pos) {
    if (!pos) { this.target = null; this.group.visible = false; return; }
    const first = !this.target || !this.group.visible;
    this.target = new THREE.Vector3(pos[0], pos[1], pos[2]);
    if (first) this.group.position.copy(this.target);
    this.group.visible = true;
  }

  /** Each frame: glide toward the latest position (updates come a few times a second). */
  tick() {
    const now = performance.now(), dt = Math.min(0.2, (now - this.last) / 1000);
    this.last = now;
    if (!this.target || !this.group.visible) return;
    this.group.position.lerp(this.target, 1 - Math.exp(-dt * 12));
    const z = Math.max(0.01, this.group.position.z);
    const a = this.drop.geometry.attributes.position;
    a.setZ(1, -z); a.needsUpdate = true;
    this.drop.computeLineDistances();
    this.ring.position.set(0, 0, -z + 0.05);
  }
}
