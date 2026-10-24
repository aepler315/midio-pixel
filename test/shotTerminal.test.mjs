import test from 'node:test';
import assert from 'node:assert/strict';
import { planShotTour } from '../src/world/terrain/ShotPlanner.js';
import { buildShotTimeline } from '../src/world/terrain/ShotTimeline.js';
import { quickTerminalFixture } from './fixtures/quick-terminal-fixture.mjs';

test('a legal slower terminal transfer preserves the opening payoff and hero climax', () => {
  const { library, options } = quickTerminalFixture();
  const plan = planShotTour(library, options);
  assert.equal(plan.fallback, null);
  assert.deepEqual(plan.items.filter(item => item.kind === 'shot' && Number.isFinite(item.payoffMs)).map(item => [item.id, item.payoffMs]),
    [['opening', 16000], ['hero', 128000]], 'a legal ending must remain available to the earlier two-payoff route');
  assert.equal(plan.items.at(-1).id, 'depart');
  assert.equal(plan.items.at(-1).endMs, options.durationMs);

  const timeline = buildShotTimeline(library, plan), motion = library.motion;
  assert.ok(timeline.diagnostics.maxAccelMps2 <= motion.maxAccelMps2, 'tangential acceleration stays legal');
  assert.ok(timeline.diagnostics.maxFlowRatio <= 1, 'image flow stays legal');
  assert.ok(timeline.diagnostics.maxYawDegPerSec <= motion.maxYawDegPerSec, 'yaw stays legal');
  assert.equal(timeline.diagnostics.payoffErrorMs, 0);
  let previous = null, maxSpeed = 0, maxClimb = 0;
  for (let i = 0;; i++) {
    const ms = Math.min(options.durationMs, i * 1000 / 60), eye = timeline.poseAt(ms).eyeM;
    if (previous) {
      const dt = (ms - previous.ms) / 1000;
      maxSpeed = Math.max(maxSpeed, Math.hypot(...eye.map((v, k) => v - previous.eye[k])) / dt);
      maxClimb = Math.max(maxClimb, Math.abs(eye[1] - previous.eye[1]) / dt);
    }
    previous = { ms, eye };
    if (ms === options.durationMs) break;
  }
  assert.ok(maxSpeed <= motion.maxSpeedMps, 'the drawn camera stays within the speed limit');
  assert.ok(maxClimb <= motion.maxClimbMps, 'the drawn camera stays within the climb limit');
});
