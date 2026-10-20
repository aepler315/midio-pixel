import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mirrorCameraFor } from '../src/world/alpine/WaterMirror.js';
import { forestBatchFootprintPx, forestDetailWeight } from '../src/world/alpine/ForestDetail.js';

test('the mirror camera keeps distant resolvable trees inside its copied clipping planes', () => {
  const main = new THREE.PerspectiveCamera(10, 16 / 9, 20, 150000);
  const mirror = new THREE.PerspectiveCamera();
  main.updateMatrixWorld();
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array([0, 0, -2200]), 3));
  geometry.setAttribute('iSize', new THREE.InstancedBufferAttribute(new Float32Array([40, 20]), 2));
  try {
    mirrorCameraFor(THREE, main, 0, mirror);
    const footprint = forestBatchFootprintPx(geometry, mirror, 640, 360);
    assert.ok(footprint >= 64, `a ${footprint.toFixed(3)} px reflected footprint must retain the resolvable distant tree`);
    assert.equal(forestDetailWeight(footprint), 1, 'reflection detail uses the mirrored camera and target');
    assert.equal(mirror.near, main.near);
    assert.equal(mirror.far, main.far);
    assert.equal(footprint, forestBatchFootprintPx(geometry, main, 640, 360), 'symmetric views agree on the conservative footprint');
  } finally { geometry.dispose(); }
});
