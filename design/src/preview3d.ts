// A small 3D look at the part. Uses the three.js Studio already serves.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class Preview3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
  private controls: OrbitControls;
  private mesh: THREE.Mesh | null = null;
  private edges: THREE.LineSegments | null = null;
  private fitted = false;
  active = true;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    host.appendChild(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(60, -80, 60);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => this.draw());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9a88a6, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, -1.5, 2);
    this.camera.add(sun);
    this.scene.add(this.camera);
    new ResizeObserver(() => this.resize()).observe(host);
    const loop = () => { requestAnimationFrame(loop); if (this.active && this.controls.update()) this.draw(); };
    loop();
  }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.draw();
  }

  /** Light up some triangles of the part (a printability problem), or clear with null. */
  highlight(tris: number[] | null) {
    if (this.marks) { this.scene.remove(this.marks); this.marks.geometry.dispose(); this.marks = null; }
    if (tris && tris.length && this.mesh) {
      const src = this.mesh.geometry, idx = src.getIndex()!;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', src.getAttribute('position').clone());   // its own copy: disposing this must not free the part's buffer
      const ix: number[] = [];
      for (const t of tris) ix.push(idx.getX(3 * t), idx.getX(3 * t + 1), idx.getX(3 * t + 2));
      g.setIndex(ix);
      this.marks = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xff4d5e, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      this.scene.add(this.marks);
      // swing round to face it: from the way the marked faces look (an overhang: from underneath)
      const pos = g.getAttribute('position');
      const n = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      for (let k = 0; k < ix.length; k += 3) {
        a.fromBufferAttribute(pos, ix[k]); b.fromBufferAttribute(pos, ix[k + 1]); c.fromBufferAttribute(pos, ix[k + 2]);
        n.add(b.clone().sub(a).cross(c.clone().sub(a)));     // area-weighted
      }
      const box = new THREE.Box3().setFromObject(this.mesh);
      const centre = box.getCenter(new THREE.Vector3());
      const dist = this.camera.position.distanceTo(this.controls.target);
      if (n.lengthSq() > 1e-12) {
        n.normalize();                                         // the part's mesh is wound outward
        const dir = n.clone().add(new THREE.Vector3(0.45, -0.6, 0)).normalize();
        this.controls.target.copy(centre);
        this.camera.position.copy(centre).add(dir.multiplyScalar(dist));
      }
      this.controls.update();
    }
    this.draw();
  }
  private marks: THREE.Mesh | null = null;

  setMesh(m: { vertices: number[]; triangles: number[] } | null) {
    this.highlight(null);
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    if (this.edges) { this.scene.remove(this.edges); this.edges.geometry.dispose(); }
    this.mesh = this.edges = null;
    if (!m) return this.draw();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.vertices, 3));
    g.setIndex(m.triangles);
    g.computeVertexNormals();
    this.mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xeadcec, roughness: 0.7, metalness: 0.05, flatShading: false }));
    this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), new THREE.LineBasicMaterial({ color: 0x2b1a33 }));
    this.scene.add(this.mesh, this.edges);
    // frame it again when the part has moved off or changed size a lot (another part opened)
    const box = new THREE.Box3().setFromObject(this.mesh);
    const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2 || 10;
    if (!this.fitted || c.distanceTo(this.fitC) > this.fitR * 0.75 || r > this.fitR * 1.8 || r < this.fitR * 0.4) this.fit();
    this.draw();
  }
  /**
   * Shapes drawn but not given a height yet: flat outlines with a light fill
   * where they'll be, so a sketch is never invisible (dashed for cuts).
   */
  setSketches(loops: { pts: [number, number, number][]; cut: boolean }[]) {
    if (this.sketches) {
      this.scene.remove(this.sketches);
      this.sketches.traverse((o: any) => { o.geometry?.dispose(); o.material?.dispose(); });
    }
    this.sketches = null;
    if (loops.length) {
      const g = new THREE.Group();
      for (const { pts, cut } of loops) {
        if (pts.length < 3) continue;
        const v3 = pts.map((q) => new THREE.Vector3(q[0], q[1], q[2]));
        // which way the loop faces: drop that axis to triangulate it flat
        const n = new THREE.Vector3();
        for (let i = 0; i < v3.length; i++) {
          const a = v3[i], b = v3[(i + 1) % v3.length];
          n.x += (a.y - b.y) * (a.z + b.z); n.y += (a.z - b.z) * (a.x + b.x); n.z += (a.x - b.x) * (a.y + b.y);
        }
        const ax = Math.abs(n.x) >= Math.abs(n.y) && Math.abs(n.x) >= Math.abs(n.z) ? 0 : Math.abs(n.y) >= Math.abs(n.z) ? 1 : 2;
        const [i0, i1] = ax === 0 ? [1, 2] : ax === 1 ? [0, 2] : [0, 1];
        const flat = pts.map((q) => new THREE.Vector2(q[i0], q[i1]));
        const tris = THREE.ShapeUtils.triangulateShape(flat, []);
        const fg = new THREE.BufferGeometry();
        fg.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
        fg.setIndex(tris.flat());
        const colour = cut ? 0xd04a6a : 0xb04aa5;
        g.add(new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })));
        const lg = new THREE.BufferGeometry().setFromPoints(v3);
        const line = new THREE.LineLoop(lg, cut ? new THREE.LineDashedMaterial({ color: colour, dashSize: 1.2, gapSize: 0.8 }) : new THREE.LineBasicMaterial({ color: colour }));
        if (cut) line.computeLineDistances();
        g.add(line);
      }
      this.sketches = g;
      this.scene.add(g);
      if (!this.mesh) this.fit();
    }
    this.draw();
  }
  private sketches: THREE.Group | null = null;

  private fitC = new THREE.Vector3();
  private fitR = 10;

  fit() {
    const what = this.mesh || this.sketches;
    if (!what) return;
    const box = new THREE.Box3().setFromObject(what);
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2 || 10;
    this.controls.target.copy(c);
    this.camera.position.copy(c).add(new THREE.Vector3(1, -1.4, 1).normalize().multiplyScalar(r * 3.2));
    this.camera.near = r / 50; this.camera.far = r * 50;
    this.camera.updateProjectionMatrix();
    this.fitted = true;
    this.fitC.copy(c); this.fitR = r;
    this.draw();
  }

  draw() { this.renderer.render(this.scene, this.camera); }

  /** A small JPEG of the part as it looks now (for the library), or null with nothing to show. */
  snapshot(w = 200, h = 150): string | null {
    if (!this.mesh) return null;
    const src = this.renderer.domElement;
    if (!src.width || !src.height) return null;
    this.draw();     // the drawing buffer is only good straight after a render
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#f4f5f7'; g.fillRect(0, 0, w, h);
    const k = Math.min(w / src.width, h / src.height);
    const dw = src.width * k, dh = src.height * k;
    g.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
    try { return c.toDataURL('image/jpeg', 0.82); } catch { return null; }
  }
}
