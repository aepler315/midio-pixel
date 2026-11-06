import assert from 'node:assert/strict';
import test from 'node:test';
import { landRiseBase, landRiseCamera } from '../src/world/alpine/LandRiseCamera.js';

test('the opening camera clears actual flat ground and aims at it', () => {
  const pose = { eyeM: [10, 1900, 20], targetM: [2000, 3500, -3000], fovYDeg: 24 };
  const start = landRiseCamera(pose, { rise01: 0, baseM: 1000, groundM: 1800 });
  assert.equal(start.eyeM[1], 1100);
  assert.equal(start.targetM[1], 1000);
  const middle = landRiseCamera(pose, { rise01: .5, baseM: 1000, groundM: 1800 });
  assert.equal(middle.eyeM[1] - (1000 + .5 * (1800 - 1000)), 100);
  assert.equal(middle.targetM[1], 2250);
  assert.strictEqual(landRiseCamera(pose, { rise01: 1, baseM: 1000, groundM: 1800 }), pose);
  assert.deepEqual(start, landRiseCamera(pose, { rise01: 0, baseM: 1000, groundM: 1800 }));
  assert.equal(pose.eyeM[1], 1900, 'sampling never changes the authored camera');
});

test('the floor stays fixed across rail/tour changes and accepts negative elevations', () => {
  const p = { modeWater: { rail: { waterLevelM: -30 } }, waterLevelM: 500, data: { manifest: { boundsM: { min: [0, -100, 0] } } } };
  assert.equal(landRiseBase(p), -30);
  p.modeWater.rail.waterLevelM = null;
  assert.equal(landRiseBase(p), -100);
  assert.equal(landRiseBase({}), 0);
  const pose = { eyeM: [0, 500, 0], targetM: [0, 1000, -2000] };
  assert.equal(landRiseCamera(pose, { rise01: 0, baseM: -100 }).eyeM[1], 500);
});
