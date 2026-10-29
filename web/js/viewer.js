// The 3D scene: Ender 3 bed, build volume, camera controls, the move/rotate/
// scale gizmo, click picking and thumbnails.  Z is up, like the printer:
// X runs left->right, Y front->back, origin at the front-left bed corner.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
export const BED = { x: 235, y: 235, z: 245 };
const CENTER = new THREE.Vector3(BED.x / 2, BED.y / 2, 0);

export class Viewer extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.active = true;
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.setClearColor(0x0d0f12);
    container.prepend(r.domElement);

    const scene = this.scene = new THREE.Scene();
    const cam = this.camera = new THREE.PerspectiveCamera(38, 1, 1, 6000);
    scene.add(cam);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x30343a, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-0.6, 0.5, 1);       // follows the camera
    cam.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.6);
    rim.position.set(1, 1, -0.3);
    cam.add(rim);

    this.buildBed();
    this.models = new THREE.Group();
    this.preview = new THREE.Group();
    this.preview.visible = false;
    scene.add(this.models, this.preview);

    const ctl = this.controls = new OrbitControls(cam, r.domElement);
    ctl.enableDamping = true;
    ctl.dampingFactor = 0.12;
    ctl.screenSpacePanning = true;
    ctl.maxDistance = 2000;
    this.setView('iso');

    const tc = this.gizmo = new TransformControls(cam, r.domElement);
    tc.setSize(0.85);
    tc.addEventListener('dragging-changed', (e) => {
      ctl.enabled = !e.value;
      this.dispatchEvent(new CustomEvent(e.value ? 'transformstart' : 'transformend',
        { detail: tc.object }));
    });
    tc.addEventListener('objectChange', () =>
      this.dispatchEvent(new CustomEvent('transforming', { detail: tc.object })));
    scene.add(tc);
    this.setGizmoMode('translate');

    // A click (not a drag) picks a model / face.
    let down = null;
    r.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    r.domElement.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      if (tc.dragging) return;
      this.dispatchEvent(new CustomEvent('pick', { detail: this.raycast(e) }));
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      if (!this.active) return;
      ctl.update();
      r.render(scene, cam);
    };
    loop();
  }

  buildBed() {
    const g = this.bed = new THREE.Group();
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(BED.x, BED.y),
      new THREE.MeshStandardMaterial({ color: 0x1c2025, roughness: 0.95 }));
    plate.position.copy(CENTER).setZ(-0.05);
    g.add(plate);
    const minor = [], major = [];
    for (let i = 0; i <= BED.x; i += 10) (i % 50 ? minor : major).push(i, 0, 0, i, BED.y, 0);
    for (let j = 0; j <= BED.y; j += 10) (j % 50 ? minor : major).push(0, j, 0, BED.x, j, 0);
    const lines = (pts, color) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color }));
    };
    g.add(lines(minor, 0x262b31), lines(major, 0x343a42));
    // Front edge marker so you can tell which way the printer faces.
    const front = new THREE.Mesh(new THREE.PlaneGeometry(BED.x, 4),
      new THREE.MeshBasicMaterial({ color: 0xff8a3d, transparent: true, opacity: 0.55 }));
    front.position.set(BED.x / 2, -4, 0);
    g.add(front);
    const box = new THREE.BoxGeometry(BED.x, BED.y, BED.z);
    box.translate(BED.x / 2, BED.y / 2, BED.z / 2);
    const vol = new THREE.LineSegments(new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0x3a4048, transparent: true, opacity: 0.6 }));
    g.add(vol);
    // X/Y axis hints at the origin corner.
    g.add(lines([0, 0, 0.1, 25, 0, 0.1], 0xef5350), lines([0, 0, 0.1, 0, 25, 0.1], 0x43c47a));
    this.scene.add(g);
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setView(name) {
    const t = new THREE.Vector3(BED.x / 2, BED.y / 2, 15);
    const pos = {
      iso: [BED.x / 2 - 40, -230, 290],
      top: [BED.x / 2, BED.y / 2 - 0.01, 480],
      front: [BED.x / 2, -360, 40],
      side: [BED.x + 360, BED.y / 2, 40],
    }[name] || [BED.x / 2, -230, 290];
    this.camera.position.set(...pos);
    this.controls.target.copy(t);
    this.controls.update();
  }

  setGizmoMode(mode) {
    this.gizmo.setMode(mode);
    // Keep moves on the bed plane; rotate/scale on every axis.
    this.gizmo.showZ = mode !== 'translate';
  }

  attach(obj) { obj ? this.gizmo.attach(obj) : this.gizmo.detach(); }

  raycast(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(p, this.camera);
    const hit = rc.intersectObjects(this.models.children, false)[0];
    return hit ? { mesh: hit.object, faceIndex: hit.faceIndex, point: hit.point } : null;
  }

  showPreview(on) {
    this.preview.visible = on;
    this.models.visible = !on;
    if (on) this.gizmo.detach();
  }

  // A PNG of just the models, framed from the front-left, for the file list.
  snapshot(size = 300) {
    if (!this.models.children.length) return null;
    const r = this.snapRenderer ||= new THREE.WebGLRenderer({ antialias: true, alpha: true,
      preserveDrawingBuffer: true });
    r.setSize(size, size, false);
    r.setClearColor(0x000000, 0);
    const box = new THREE.Box3().setFromObject(this.models);
    const c = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const cam = new THREE.PerspectiveCamera(30, 1, 1, 6000);
    const dir = new THREE.Vector3(-0.45, -1, 0.75).normalize();
    cam.position.copy(c).addScaledVector(dir, radius / Math.sin(THREE.MathUtils.degToRad(15)) * 1.05);
    cam.lookAt(c);
    const light = new THREE.DirectionalLight(0xffffff, 2.4);
    light.position.set(-0.6, 0.5, 1);
    cam.add(light);
    this.scene.add(cam);
    const hidden = [this.bed, this.gizmo, this.preview];
    const was = hidden.map((o) => o.visible);
    hidden.forEach((o) => { o.visible = false; });
    const modelsWas = this.models.visible;
    this.models.visible = true;
    r.render(this.scene, cam);
    hidden.forEach((o, i) => { o.visible = was[i]; });
    this.models.visible = modelsWas;
    this.scene.remove(cam);
    return r.domElement.toDataURL('image/png').split(',')[1];
  }
}
