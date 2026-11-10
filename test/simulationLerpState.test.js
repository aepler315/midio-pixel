// Simulation.lerpState: the interpolated pose's world origin is the stage
// anchor's x, whatever the world scrolled between the two steps. Renderer and
// RangeFrame read it as pose.midioX; originX carries the same value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/sim/Simulation.js';

test('lerpState: the pose\'s world origin follows the stage anchor', () => {
  const stub = {
    prev: { worldX: 0, midioY: 540, scaleX: 1, scaleY: 1, leanDeg: 0 },
    curr: { worldX: 2, midioY: 540, scaleX: 1, scaleY: 1, leanDeg: 0 },
    stageAnchor: { x: 220 },
  };
  for (const x of [220, 300]) {
    stub.stageAnchor.x = x;
    for (const alpha of [0, 0.5, 1]) {
      const pose = Simulation.prototype.lerpState.call(stub, alpha);
      assert.equal(pose.midioX, x, `anchor ${x}, alpha ${alpha}`);
      assert.equal(pose.originX, x);
    }
  }
});
