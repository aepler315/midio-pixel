// Planar reflection for lakes. A few times a second it casts rays over the
// lower part of the view; when they land on a lake it takes that lake's
// surface as a mirror plane and renders sky and terrain reflected in it
// (half resolution) for the water shader to sample. Fades in and out.
import * as THREE from 'three';
import { ecefToLonLat } from '../core/geo.js';

export class Reflection {
  constructor(globals) {
    this.globals = globals;
    this.want = 0;
    this.on = 0;
    this.h = 0;
    this.point = null;
    this.next = 0;
    this.target = null;
    this.matrix = new THREE.Matrix4();
    this.enabled = true;
  }

  /** Look for a lake surface in view (cheap enough at ~3 Hz). */
  detect(engine, now) {
    if (now < this.next) return;
    this.next = now + 350;
    if (!this.enabled || engine.looks.styleCode !== 0 && engine.looks.styleCode !== 5 && engine.looks.styleCode !== 3) { this.want = 0; return; }
    const { h } = engine.rig.lonLatH;
    if (engine.agl > 6000 || h > 12000) { this.want = 0; return; }
    const hits = [];
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 7; i++) {
        const nx = -0.85 + (i / 6) * 1.7, ny = -0.92 + (j / 3) * 0.9;
        const p = engine.pick(nx, ny);
        if (!p || p.t > 25000) continue;
        const ll = ecefToLonLat(...p.point);
        if (engine.tiles.waterAt(ll.lon, ll.lat) === 1) hits.push({ h: ll.h, point: p.point });
      }
    }
    if (hits.length < 2) { this.want = 0; return; }
    // The lake level most of the hits agree on.
    hits.sort((a, b) => a.h - b.h);
    let best = hits[0], bestN = 0;
    for (const a of hits) {
      const n = hits.filter((b) => Math.abs(b.h - a.h) < 1.5).length;
      if (n > bestN) { bestN = n; best = a; }
    }
    if (this.want && Math.abs(best.h - this.h) < 1.5) { this.want = 1; return; }
    this.h = best.h;
    this.point = best.point;
    this.want = 1;
  }

  render(engine, dt) {
    const g = this.globals;
    this.on += (this.want - this.on) * Math.min(1, dt * 2.5);
    if (this.on < 0.01 || !this.point) { g.uReflOn.value = 0; return; }
    const W = Math.max(2, Math.round(engine.hdr.width / 2)), H = Math.max(2, Math.round(engine.hdr.height / 2));
    if (!this.target || this.target.width !== W || this.target.height !== H) {
      this.target?.dispose();
      this.target = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: true });
    }
    // Mirror about the lake's tangent plane, in camera-relative space.
    const cam = engine.rig.pos;
    const n = new THREE.Vector3(...this.point).normalize();
    const p0 = new THREE.Vector3(this.point[0] - cam[0], this.point[1] - cam[1], this.point[2] - cam[2]);
    const d = n.dot(p0);
    const { x, y, z } = n;
    this.matrix.set(
      1 - 2 * x * x, -2 * x * y, -2 * x * z, 2 * d * x,
      -2 * x * y, 1 - 2 * y * y, -2 * y * z, 2 * d * y,
      -2 * x * z, -2 * y * z, 1 - 2 * z * z, 2 * d * z,
      0, 0, 0, 1,
    );
    g.uMirror.value.copy(this.matrix);
    g.uClipOn.value = 1;
    g.uReflH.value = this.h;
    g.uReflOn.value = 0; // never sample the texture being drawn...
    g.uReflTex.value = null; // ...nor even bind it (a feedback loop fails the draw)
    const sky = engine.sky.uniforms;
    const vp = new THREE.Matrix4().multiplyMatrices(engine.camera.projectionMatrix, engine.camera.matrixWorldInverse).multiply(this.matrix);
    sky.uInvViewProj.value.copy(vp).invert();
    sky.uSkyOrigin.value.copy(n).multiplyScalar(2 * d);
    const r = engine.renderer;
    const cloudsVisible = engine.clouds.mesh.visible;
    engine.clouds.mesh.visible = false;
    r.setRenderTarget(this.target);
    r.clear(true, true, false);
    r.render(engine.sky.scene, engine.sky.camera);
    r.render(engine.scene, engine.camera);
    r.setRenderTarget(null);
    engine.clouds.mesh.visible = cloudsVisible;
    // Back to normal for the main pass.
    g.uMirror.value.identity();
    g.uClipOn.value = 0;
    g.uReflOn.value = this.on;
    g.uReflTex.value = this.target.texture;
    sky.uSkyOrigin.value.set(0, 0, 0);
    engine.sky.update(engine.camera);
  }
}
