import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createForest } from '../src/world/alpine/ForestGL.js';
import * as forestGL from '../src/world/alpine/ForestGL.js';
import { sceneUniforms } from '../src/world/alpine/TerrainMaterial.js';
import { cullForestScene, restoreForestScene, attachForestCulling } from '../src/world/alpine/ForestCulling.js';
import { setTerrainDrawMode } from '../src/world/alpine/RailDraw.js';

test('static mesh spans retain original order, shared buffers and rail/tour prefixes without extra instance bytes', () => {
  const records = Array.from({ length: 12 }, (_, i) => [0, 1000, (i >= 5 && i <= 8) || i >= 10 ? 300 : -500, 20, 8, 1, .5, 1]);
  const placed = { stride: 8, count: 14, mesh: new Float32Array(records.flat()), meshDetail: new Float32Array(),
    billboard: new Float32Array([0, 1000, 300, 20, 8, 1, .5, 1, 0, 1000, 400, 20, 8, 1, .5, 1]),
    railCount: { mesh: 10, meshDetail: 0, billboard: 2 } };
  const u = sceneUniforms(THREE, { uHeightRange: { value: new THREE.Vector2(0, 2000) } });
  const forest = createForest(THREE, placed, u);
  try {
    const mesh = forest.byBand.mid.find(m => m.geometry.attributes.aBranch), geometry = mesh.geometry;
    assert.equal(forest.bytes, 14 * 7 * 4, 'the same seven instance floats are charged once');
    assert.deepEqual(geometry.userData.forestCull, { uniforms: forest.uniforms, prefix: true, spans: true });
    const originals = Object.fromEntries(['iPos', 'iSize', 'iVar'].map(name => [name, geometry.attributes[name]]));
    for (const [name, attribute] of Object.entries(originals)) {
      assert.equal(attribute.isInterleavedBufferAttribute, true, name);
      assert.equal(attribute.offset, 0);
      assert.equal(attribute.data.stride, attribute.itemSize);
      assert.equal(attribute.data.meshPerAttribute, 1);
    }
    const board = forest.byBand.mid.find(m => !m.geometry.attributes.aBranch);
    assert.equal(board.geometry.userData.forestCull, undefined, 'billboard bounds are unchanged');
    assert.equal(board.geometry.attributes.iPos.isInstancedBufferAttribute, true);
    const scene = new THREE.Scene(); scene.add(mesh); scene.updateMatrixWorld();
    const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
    camera.position.set(0, 1010, 0); camera.lookAt(0, 1010, 1); camera.updateMatrixWorld();
    for (const [mode, count, drawn] of [['rail', 10, 5], ['tour', 12, 8], ['rail', 10, 5]]) {
      setTerrainDrawMode(geometry, mode);
      assert.equal(geometry.instanceCount, count);
      const touched = cullForestScene(scene, camera, null);
      assert.equal(geometry.instanceCount, drawn, mode);
      for (const [name, original] of Object.entries(originals)) {
        const current = geometry.attributes[name];
        assert.equal(current.data, original.data, 'span views borrow the existing GPU buffer');
        assert.equal(current.offset, 4 * current.itemSize, 'aligned prefix trimming retains order');
      }
      assert.equal(geometry.attributes.iPos.getZ(1), records[5][2]);
      restoreForestScene(touched);
      assert.equal(geometry.instanceCount, count);
      for (const [name, original] of Object.entries(originals)) assert.equal(geometry.attributes[name], original);
    }
  } finally { forest.dispose(); }
});

test('span CPU storage has an explicit admitted bound without changing GPU instance bytes', () => {
  assert.equal(forestGL.forestSpanBytes?.(12), 12 * 16 + 64 * 1024);
  assert.equal(forestGL.forestSpanBytes(0), 0);
});

test('disposing a forest restores pending culling after an interrupted render', () => {
  const placed = { stride: 8, count: 1, mesh: new Float32Array([0, 0, 5000, 20, 8, 1, .5, 1]),
    meshDetail: new Float32Array(), billboard: new Float32Array() };
  const forest = createForest(THREE, placed, sceneUniforms(THREE, {}));
  const mesh = forest.byBand.mid.find(m => m.geometry.attributes.aBranch), geometry = mesh.geometry;
  const original = geometry.attributes.iPos;
  const scene = attachForestCulling(new THREE.Scene()); scene.add(mesh); scene.updateMatrixWorld();
  const camera = new THREE.PerspectiveCamera(40, 1, 1, 1000); camera.lookAt(0, 0, -1); camera.updateMatrixWorld();
  scene.onBeforeRender(null, scene, camera, null);
  assert.equal(geometry.instanceCount, 0);
  // No onAfterRender: this is the state left by a thrown GPU render.
  forest.dispose();
  assert.equal(geometry.instanceCount, 1);
  assert.equal(geometry.attributes.iPos, original);
});
