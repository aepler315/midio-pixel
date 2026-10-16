import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createForest } from '../src/world/alpine/ForestGL.js';
import { createSceneMaterial, sceneUniforms } from '../src/world/alpine/TerrainMaterial.js';

test('forest debug compiles only the colour passes without changing instance storage', () => {
  const placed = { mesh: new Float32Array([0, 0, 0, 20, 10, 0, .5, 2]),
    billboard: new Float32Array([2000, 0, 0, 20, 10, 0, .6, 1]), stride: 8, count: 2 };
  const normal = createForest(THREE, placed, {});
  const debug = createForest(THREE, placed, {}, { forestDebug: true });
  try {
    assert.equal(normal.byBand.near[0].material.defines.FOREST_DEBUG, undefined);
    assert.equal(debug.byBand.near[0].material.defines.FOREST_DEBUG, 1);
    assert.equal(debug.byBand.mid[0].material.defines.FOREST_DEBUG, 1);
    assert.ok(debug.depth.every(m => m.material.defines.FOREST_DEBUG === undefined));
    assert.equal(debug.bytes, 56);
    assert.deepEqual(debug.counts, normal.counts);
    assert.deepEqual(Object.keys(debug.uniforms), Object.keys(normal.uniforms));
    for (const band of ['mid', 'near']) for (const name of ['iPos', 'iSize', 'iVar']) {
      assert.deepEqual(debug.byBand[band][0].geometry.attributes[name].array, normal.byBand[band][0].geometry.attributes[name].array);
    }
  } finally { normal.dispose(); debug.dispose(); }
});

test('terrain debug adds a compile define without consuming uniform headroom', () => {
  const uniforms = sceneUniforms(THREE, {});
  const normal = createSceneMaterial(THREE, uniforms);
  const debug = createSceneMaterial(THREE, uniforms, { forestDebug: true });
  try {
    assert.equal(normal.defines.FOREST_DEBUG, undefined);
    assert.equal(debug.defines.FOREST_DEBUG, 1);
    assert.equal(debug.uniforms, normal.uniforms);
  } finally { normal.dispose(); debug.dispose(); }
});
