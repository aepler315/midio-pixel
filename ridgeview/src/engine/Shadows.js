// Two sun shadow cascades in camera-relative space: a near one for crisp
// shadows on the slopes around the viewer and a far one so whole ranges
// throw shadows across valleys at low sun. Each cascade is an orthographic
// view along the sun direction, snapped to its texel grid to stop shimmer.
import * as THREE from 'three';
import { createDepthMaterial } from './TerrainMaterial.js';

export class Shadows {
  constructor(globals, size = 2048) {
    this.globals = globals;
    this.depthMaterial = createDepthMaterial();
    this.cascades = [0, 1].map(() => ({
      camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2),
      frustum: new THREE.Frustum(),
      target: null,
      matrix: new THREE.Matrix4(),
    }));
    this.setSize(size);
    this.enabled = true;
  }

  setSize(size) {
    if (this.size === size) return;
    this.size = size;
    for (const c of this.cascades) {
      c.target?.dispose();
      const depth = new THREE.DepthTexture(size, size, THREE.UnsignedIntType);
      depth.minFilter = THREE.NearestFilter; depth.magFilter = THREE.NearestFilter;
      c.target = new THREE.WebGLRenderTarget(size, size, { depthTexture: depth, depthBuffer: true });
    }
    this.globals.uShadow0.value = this.cascades[0].target.depthTexture;
    this.globals.uShadow1.value = this.cascades[1].target.depthTexture;
    this.globals.uShadowTexel.value.set(1 / size, 1 / size);
  }

  /**
   * Fit the cascades to the view.
   *   camera  the main camera (at the origin, camera-relative space)
   *   sunDir  THREE.Vector3 unit vector toward the sun
   *   agl     camera height above ground (m)
   */
  fit(camera, sunDir, agl, active) {
    this.active = active;
    this.globals.uShadowOn.value = active ? 1 : 0;
    if (!active) return [];
    const ranges = [
      Math.min(16000, Math.max(2500, agl * 6 + 2500)),
      Math.min(220000, Math.max(30000, agl * 30 + 30000)),
    ];
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const tanV = Math.tan((camera.fov * Math.PI) / 360), tanH = tanV * camera.aspect;
    const frusta = [];
    this.cascades.forEach((c, i) => {
      const d = ranges[i];
      // Bounding sphere of the view slice [0, d].
      const half = d / 2;
      const corner = Math.hypot(d * tanH, d * tanV, half);
      const center = fwd.clone().multiplyScalar(half);
      const r = Math.max(corner, half) * 1.02;
      const lightDir = sunDir.clone().normalize();
      // Light basis.
      const upRef = Math.abs(lightDir.z) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      const right = new THREE.Vector3().crossVectors(upRef, lightDir).normalize();
      const up = new THREE.Vector3().crossVectors(lightDir, right);
      // Snap the centre to texels in the light plane.
      const texel = (2 * r) / this.size;
      const cx = Math.round(center.dot(right) / texel) * texel;
      const cy = Math.round(center.dot(up) / texel) * texel;
      const cz = center.dot(lightDir);
      const snapped = right.clone().multiplyScalar(cx).add(up.clone().multiplyScalar(cy)).add(lightDir.clone().multiplyScalar(cz));
      const back = r + 60000; // reach casters well toward the sun
      const cam = c.camera;
      cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
      cam.near = 1; cam.far = back + r;
      cam.position.copy(snapped).addScaledVector(lightDir, back);
      cam.up.copy(up);
      cam.lookAt(snapped);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      c.matrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      c.frustum.setFromProjectionMatrix(c.matrix);
      // Bias in depth units: a few texels of slope tolerance, in metres.
      c.texelM = texel;
      c.bias = (texel * 0.6 + 0.5) / (cam.far - cam.near);
      frusta.push(c.frustum);
    });
    this.globals.uShadowM0.value.copy(this.cascades[0].matrix);
    this.globals.uShadowM1.value.copy(this.cascades[1].matrix);
    this.globals.uShadowBias.value.set(this.cascades[0].bias, this.cascades[1].bias);
    this.globals.uShadowTexelM.value.set(this.cascades[0].texelM, this.cascades[1].texelM);
    return frusta;
  }

  render(renderer, scene) {
    if (!this.active) return;
    const prev = scene.overrideMaterial;
    scene.overrideMaterial = this.depthMaterial;
    for (const c of this.cascades) {
      renderer.setRenderTarget(c.target);
      renderer.clear(false, true, false);
      renderer.render(scene, c.camera);
    }
    scene.overrideMaterial = prev;
    renderer.setRenderTarget(null);
  }
}
