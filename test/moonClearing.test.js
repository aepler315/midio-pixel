import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { STORM_GLSL } from '../src/world/alpine/RangeStorm.js';
import { SCENE_FRAG } from '../src/world/alpine/TerrainMaterial.js';
import { createForest } from '../src/world/alpine/ForestGL.js';

// Execute the scalar functions assembled into the production shaders. This
// checks the receiver-light equation itself rather than a test-only JS twin.
function scalar(name, parameters, bindings) {
  const match = STORM_GLSL.match(new RegExp(`float ${name}\\([^)]*\\)\\s*\\{([^}]+)\\}`));
  assert.ok(match, `production shader provides ${name}`);
  const body = match[1].replace(/\bfloat\s+/g, 'let ');
  return new Function(...parameters, ...Object.keys(bindings), body);
}
function receiver(clearing) {
  const uStorm = { z: clearing };
  const shadow = scalar('stormShadow', ['opening'], { uStorm });
  const stormShadow = opening => shadow(opening, uStorm);
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const ambient = scalar('stormAmbient', ['total', 'sheltered', 'opening'], { stormShadow, clamp });
  return { key: stormShadow, ambient: (total, sheltered, opening) => ambient(total, sheltered, opening, stormShadow, clamp) };
}

test('clearing shadows retain the sheltered moon fill when the coda key is zero', () => {
  const r = receiver(1), total = 1.93125, sheltered = 1.05625;
  assert.equal(r.key(0), .5, 'the direct shadow keeps its original contrast');
  assert.ok(Math.abs(r.ambient(total, sheltered, 0) - 1.49375) < 1e-12);
  assert.equal(r.ambient(total, sheltered, 1), total);
  const forest = createForest(THREE, { mesh: new Float32Array([0, 0, -100, 20, 10, 0, .5, 2]),
    billboard: new Float32Array([0, 0, -2000, 20, 10, 0, .5, 2]), stride: 8, count: 2 }, {});
  try {
    const fragments = [SCENE_FRAG, ...Object.values(forest.byBand).flat().map(mesh => mesh.material.fragmentShader)];
    assert.ok(fragments.length > 2, 'both mesh and billboard shaders are inspected');
    for (const glsl of fragments) {
      assert.ok(glsl.includes('stormAmbient(uAmbientScale, uMoonAmbientScale, opening)'), 'terrain and every tree representation share the receiver equation');
      assert.ok(glsl.includes('stormShadow(opening)'), 'direct and local light retain cloud shadows');
    }
  } finally { forest.dispose(); }
});

test('daylight, absent moon and clearing-zero ambient keep their previous response', () => {
  for (const clearing of [0, .25, .5, 1]) for (const opening of [0, .3, .7, 1]) {
    const r = receiver(clearing), oldShadow = 1 - clearing * (1 - opening) * .5;
    assert.equal(r.key(opening), oldShadow);
    assert.equal(r.ambient(2.5, 0, opening), 2.5 * oldShadow);
    assert.equal(r.ambient(.875, 0, opening), .875 * oldShadow);
    if (!clearing) assert.equal(r.ambient(1.93125, 1.05625, opening), 1.93125);
  }
});

test('sheltered receiver light remains bounded throughout a moon handover', () => {
  const r = receiver(1), total = 1.93125;
  let previous = r.ambient(total, 0, 0);
  for (let n = 1; n <= 100; n++) {
    const value = r.ambient(total, total * n / 100, 0);
    assert.ok(value >= previous && value <= total);
    assert.ok(value - previous < .01);
    previous = value;
  }
  assert.equal(r.ambient(total, -1, 0), total * .5);
  assert.equal(r.ambient(total, total * 2, 0), total);
});
