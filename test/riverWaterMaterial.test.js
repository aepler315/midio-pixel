import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_FRAG } from '../src/world/alpine/TerrainMaterial.js';

test('a current pattern travels downstream at the sourced metres per second', () => {
  // Run the actual scalar GLSL helper. Literal expectations independently
  // describe a feature moving 1 metre downstream over 2.5 seconds at .4m/s.
  const helper = SCENE_FRAG.match(/float riverTravel\(float distanceM, float speedMps, float timeSec\) \{([\s\S]*?)\n\s*\}/);
  assert.ok(helper, 'the river shader needs distance-based current advection');
  const travel = new Function('distanceM', 'speedMps', 'timeSec', helper[1].replace(/\bmax\(/g, 'Math.max('));
  assert.equal(travel(10, .4, 0), 10);
  assert.equal(travel(11, .4, 2.5), 10);
  assert.equal(travel(10, .4, 2.5), 9);
  assert.equal(travel(10, 0, 20), 10, 'zero flow cannot advance the pattern');
});

test('resolved current has restrained ambient contrast and averages away below a pixel', () => {
  const helper = SCENE_FRAG.match(/float riverCurrentTone\(float phase, float resolved\) \{([\s\S]*?)\n\s*\}/);
  assert.ok(helper, 'flow must remain legible when there is no direct glint');
  const tone = new Function('phase', 'resolved', helper[1].replace(/\bcos\(/g, 'Math.cos('));
  assert.equal(tone(0, 1), 1.1);
  assert.equal(tone(Math.PI, 1), .9);
  assert.equal(tone(0, 0), 1, 'unresolved ripples preserve their mean instead of aliasing');
});
