// Range lake mirror (WaterMirror.js): the reflected camera and the
// projection the water samples it through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mirrorCameraFor, mirrorTextureMatrix, mirrorSize, mirrorLevelFor, MIRROR_MIN_SAMPLES } from '../src/world/alpine/WaterMirror.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { sceneUniforms } from '../src/world/alpine/TerrainMaterial.js';

const camera = () => {
  const c = new THREE.PerspectiveCamera(35, 16 / 9, 20, 150000);
  c.position.set(3650, 2410, -3500);
  c.lookAt(9000, 2300, 12000);
  c.updateProjectionMatrix();
  c.updateMatrixWorld();
  return c;
};
const ndc = (cam, p) => new THREE.Vector3(...p).project(cam);

test('successive mirror frames never sample the texture being rendered', () => {
  const uniforms = sceneUniforms(THREE, {});
  const mirror = { target: { texture: new THREE.Texture(), width: 320, height: 180 }, matrix: new THREE.Matrix4(), frame: -1 };
  const p = { uniforms, mirrorLevelM: 2055, depthScene: {}, scenes: { far: {}, mid: {}, near: {} } };
  let target, draws = 0;
  const scene = Object.assign(Object.create(RangeScene.prototype), {
    THREE, camera: camera(), mirrorCamera: new THREE.PerspectiveCamera(), size: { width: 640, height: 360 }, stats: {},
    _ensureMirror: () => mirror,
    renderer: {
      setRenderTarget(value) { target = value; }, setClearColor() {}, clear() {},
      render() {
        assert.notEqual(uniforms.uMirror.value, target.texture, 'WebGL rejects an attached texture even when mirror amount is zero');
        draws++;
      },
    },
  });
  for (const side of ['A', 'B']) {
    for (const frameId of [1, 2]) {
      scene._prepareMirror(p, { qualityLevel: 0, frameId }, side, 'view');
      assert.equal(uniforms.uMirror.value, mirror.target.texture, 'water samples the completed mirror after the pass');
      assert.equal(uniforms.uMirrorAmount.value, 1);
      const previousDraws = draws;
      scene._prepareMirror(p, { qualityLevel: 0, frameId }, side, 'view');
      assert.equal(draws, previousDraws, 'same-frame cached mirror is not redrawn');
    }
  }
  assert.equal(draws, 16);
});

test('the mirror camera sees a point where the real camera sees its reflection, x mirrored', () => {
  const cam = camera(), level = 2055;
  const mirror = mirrorCameraFor(THREE, cam, level, new THREE.PerspectiveCamera());
  assert.ok(Math.abs(mirror.position.y - (2 * level - 2410)) < 1e-6);
  for (const p of [[8000, 4100, 20000], [4000, level, 6000], [9000, 2600, 14000]]) {
    const a = ndc(mirror, p), b = ndc(cam, [p[0], 2 * level - p[1], p[2]]);
    assert.ok(Math.abs(a.x + b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6, `${p}: ${a.x},${a.y} vs ${b.x},${b.y}`);
  }
});

test('off-axis zoom retains reflected coverage on both sides of the visible lake', () => {
  const cam = camera(), level = 2055;
  cam.setViewOffset(1280, 720, 512, 144, 512, 288);
  cam.updateMatrixWorld();
  const mirror = mirrorCameraFor(THREE, cam, level, new THREE.PerspectiveCamera());
  for (const point of [[8000, 4100, 20000], [4000, level, 6000], [9000, 2600, 14000]]) {
    const a = ndc(mirror, point), b = ndc(cam, [point[0], 2 * level - point[1], point[2]]);
    assert.ok(Math.abs(a.x + b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6, 'the crop must reflect with the camera basis');
  }
  const identity = mirror.projectionMatrix.clone().multiply(mirror.projectionMatrixInverse);
  assert.ok(identity.elements.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9));
});

test('a water point samples the mirror image where the ground above it lies', () => {
  const cam = camera(), level = 2055;
  const mirror = mirrorCameraFor(THREE, cam, level, new THREE.PerspectiveCamera());
  const m = mirrorTextureMatrix(THREE, mirror);
  // A peak beyond the lake, and the water point where its reflection shows.
  const peak = new THREE.Vector3(8000, 4100, 20000);
  const eye = cam.position, img = new THREE.Vector3(peak.x, 2 * level - peak.y, peak.z);
  const s = (level - eye.y) / (img.y - eye.y);
  const water = eye.clone().lerp(img, s);
  const uvOf = (v) => { const c = new THREE.Vector4(v.x, v.y, v.z, 1).applyMatrix4(m); return [c.x / c.w, c.y / c.w]; };
  const [u1, v1] = uvOf(water), [u2, v2] = uvOf(peak);
  assert.ok(Math.abs(u1 - u2) < 1e-6 && Math.abs(v1 - v2) < 1e-6);
  assert.ok(u1 > 0 && u1 < 1 && v1 > 0 && v1 < 1);
});

test('only views with visible water at their level mirror', () => {
  const tile = (visible, n, h) => ({ visible, flowBytes: new Uint8Array(n * 7).fill(255), heightsM: new Float32Array(n * 7).fill(h) });
  const data = (tiles) => ({ tiles: new Map(tiles.map((t, i) => [i, t])) });
  assert.equal(mirrorLevelFor(data([tile(true, MIRROR_MIN_SAMPLES, 2055)]), 2055), 2055);
  assert.equal(mirrorLevelFor(data([tile(false, 500, 2055)]), 2055), null, 'a lake the rail never sees');
  assert.equal(mirrorLevelFor(data([tile(true, 500, 1900)]), 2055), null, 'water at another level');
  assert.equal(mirrorLevelFor(data([tile(true, 500, 2055)]), null), null);
  assert.deepEqual(mirrorSize(1280, 720), { width: 640, height: 360 });
});

test('forest mirror accumulates soft colour before hard depth while using the mirror footprint', () => {
  const uniforms = sceneUniforms(THREE, {});
  const mirror = { target: { texture: new THREE.Texture(), width: 320, height: 180 }, matrix: new THREE.Matrix4(), frame: -1 };
  const p = { uniforms, mirrorLevelM: 2055, depthScene: {}, scenes: { far: {}, mid: {}, near: {} }, forest: { counts: { billboard: 1 } } };
  const footprints = [], layers = [];
  const scene = Object.assign(Object.create(RangeScene.prototype), {
    THREE, camera: camera(), mirrorCamera: new THREE.PerspectiveCamera(), size: { width: 640, height: 360 }, stats: {},
    _ensureMirror: () => mirror,
    renderer: { setRenderTarget() {}, setClearColor() {}, clear() {}, render(_scene, camera) { footprints.push(uniforms.uViewportPx.value.toArray()); layers.push(camera.layers.mask); } },
  });
  scene._prepareMirror(p, { qualityLevel: 0, frameId: 1 }, 'A', 'view');
  assert.deepEqual(footprints, Array.from({ length: 11 }, () => [320, 180]));
  // The last three: ink (layer 3) with the cast (layer 4), which the lake
  // reflects with each band.
  assert.deepEqual(layers, [1, 1, 1, 1, 2, 2, 2, 4, 8 | 16, 8 | 16, 8 | 16], 'paint receivers and all soft coverage before hard depth, ink and the cast');
  assert.deepEqual(uniforms.uViewportPx.value.toArray(), [640, 360]);
});
