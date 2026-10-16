import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terrainFeatureSegments } from '../src/world/alpine/TerrainFeatures.js';
import { sceneUniforms } from '../src/world/alpine/TerrainMaterial.js';
import * as THREE from 'three';

test('sparse contour hints stay on the source triangles and never paint tile boundaries', () => {
  const positions = new Float32Array([0, 0, 0, 100, 200, 0, 100, 200, 100, 0, 0, 100]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const out = terrainFeatureSegments(positions, indices, { intervalM: 100, maxSegments: 8 });
  assert.ok(out.length > 0);
  for (let i = 0; i < out.length; i += 3) {
    assert.equal(out[i + 1], 100);
    assert.equal(out[i], 50, 'interpolated source surface, never arbitrary grid edges');
  }
});

test('feature extraction respects a strict memory bound and ignores no-data triangles', () => {
  const p = new Float32Array([0, 0, 0, 100, 2000, 0, 100, 2000, 100, 0, NaN, 100]);
  const out = terrainFeatureSegments(p, new Uint32Array([0, 1, 2, 0, 2, 3]), { intervalM: 100, maxSegments: 3 });
  assert.equal(out.length, 18);
  assert.ok([...out].every(Number.isFinite));
  assert.equal(terrainFeatureSegments(p, new Uint32Array([0, 2, 3])).length, 0);
});

test('non-pilot material uniforms reveal the entire existing landscape', () => {
  const u = sceneUniforms(THREE, {});
  assert.deepEqual(u.uNarrative.value.toArray(), [1, 1, 1, 1]);
  assert.equal(u.uNarrativeInk.value, 0);
});
