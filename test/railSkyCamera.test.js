import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sky from '../src/world/alpine/RangeSkyComposition.js';
const referencePose = { eyeM: [0, 100, 1000], targetM: [0, 100, 0], fovYDeg: 35, aspect: 16 / 9 };

test('ordinary sky anchors use the resolved terrain camera and its off-axis crop', () => {
  assert.equal(typeof sky.projectRailSky, 'function');
  const pose = { ...referencePose, viewOffset: { fx: .5, rx: 0, uy: 0 } };
  const camera = { from: { referencePose, pose, aspect: 16 / 9 }, mix: 0 };
  const p = sky.projectRailSky({ xFrac: .6, yFrac: .3 }, camera);
  assert.ok(Math.abs(p.xFrac - .7) < 1e-9);
  assert.ok(Math.abs(p.yFrac - .1) < 1e-9);
});

test('view travel blends projected sky anchors continuously and restores them on pause', () => {
  assert.equal(typeof sky.projectRailSky, 'function');
  const from = { referencePose, pose: referencePose, aspect: 16 / 9 };
  const to = { referencePose, pose: { ...referencePose, targetM: [100, 140, 0] }, aspect: 16 / 9 };
  const point = { xFrac: .65, yFrac: .2 };
  const a = sky.projectRailSky(point, { from, to, mix: .5 });
  assert.deepEqual(a, sky.projectRailSky(point, { from, to, mix: .5 }));
  const b = sky.projectRailSky(point, { from, to, mix: .5001 });
  assert.ok(Math.abs(a.xFrac - b.xFrac) < .0001 && Math.abs(a.yFrac - b.yFrac) < .0001);
});
