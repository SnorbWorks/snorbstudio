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
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8890a0, 1.6));
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

  setMesh(m: { vertices: number[]; triangles: number[] } | null) {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    if (this.edges) { this.scene.remove(this.edges); this.edges.geometry.dispose(); }
    this.mesh = this.edges = null;
    if (!m) return this.draw();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.vertices, 3));
    g.setIndex(m.triangles);
    g.computeVertexNormals();
    this.mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xd9dde3, roughness: 0.7, metalness: 0.05, flatShading: false }));
    this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), new THREE.LineBasicMaterial({ color: 0x23272d }));
    this.scene.add(this.mesh, this.edges);
    // frame it again when the part has moved off or changed size a lot (another part opened)
    const box = new THREE.Box3().setFromObject(this.mesh);
    const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2 || 10;
    if (!this.fitted || c.distanceTo(this.fitC) > this.fitR * 0.75 || r > this.fitR * 1.8 || r < this.fitR * 0.4) this.fit();
    this.draw();
  }
  private fitC = new THREE.Vector3();
  private fitR = 10;

  fit() {
    if (!this.mesh) return;
    const box = new THREE.Box3().setFromObject(this.mesh);
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
}
