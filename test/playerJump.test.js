import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JumpController, A, B } from '../src/sim/JumpController.js';
import { ParamBus } from '../src/core/ParamBus.js';

function makeJump() {
  return new JumpController(new ParamBus());
}

/** Fixed-step harness mirroring test/jumpPlanner.test.js's runLive, but with
 * the player-driven wiring: kicks feed only the timing EMA, taps launch. */
function runPlayerTaps(tapTimes, kickTimes) {
  const jump = makeJump();
  const STEP_MS = 1000 / 120;
  const landings = [];
  let ti = 0;
  let ki = 0;
  let t = 0;
  const endMs = tapTimes[tapTimes.length - 1] + 3000;
  while (t <= endMs) {
    jump.clearFrameFlags();
    while (ki < kickTimes.length && kickTimes[ki] <= t) jump.noteKickTiming(kickTimes[ki++]);
    while (ti < tapTimes.length && tapTimes[ti] <= t) jump.onPlayerTap({ tMs: tapTimes[ti++], vel: 0.7 });
    jump.update(t);
    if (jump.pendingLanding) landings.push(t);
    t += STEP_MS;
  }
  return landings;
}

test('onPlayerTap launches from the ground, anchored to the press time', () => {
  const jump = makeJump();
  jump.onPlayerTap({ tMs: 1000, vel: 0.8 });
  assert.equal(jump.airborne, true);
  assert.equal(jump.jumpStartMs, 1000);
  assert.equal(jump.lastLaunchVel, 0.8);
});

test('onPlayerTap never moves the beat-period EMA', () => {
  const jump = makeJump();
  const before = jump.beatPeriodMs;
  jump.onPlayerTap({ tMs: 0, vel: 0.7 });
  jump.update(2000); // land
  jump.onPlayerTap({ tMs: 2400, vel: 0.7 });
  assert.equal(jump.beatPeriodMs, before);
  assert.equal(jump.lastKickMs, null, 'taps are not kicks');
});

test('noteKickTiming moves the EMA without ever launching', () => {
  const jump = makeJump();
  jump.noteKickTiming(0);
  jump.noteKickTiming(400);
  jump.noteKickTiming(800);
  assert.ok(Math.abs(jump.beatPeriodMs - (500 * 0.7 + 400 * 0.3) * 0.7 - 400 * 0.3) < 1e-9);
  assert.equal(jump.airborne, false);
  assert.equal(jump.y, 0);
});

test('a player tap mid launch/hang force-relaunches (chart takeoffs never vanish)', () => {
  const jump = makeJump();
  jump.onPlayerTap({ tMs: 0, vel: 0.7 }); // D = 500 at the default beat period
  const midHang = jump.D * (A + B / 2);
  jump.update(midHang);
  const yBefore = jump.y;
  jump.onPlayerTap({ tMs: midHang, vel: 1 });
  assert.ok(Math.abs(jump.y - yBefore) < 1e-6, 'y stays C0-continuous through the force-relaunch');
  assert.equal(jump.lastLaunchVel, 1);
  assert.equal(jump.compress, null);
  assert.equal(jump.airborne, true);
  // Arc was re-seeded around the press (entry may sit mid-launch phase).
  assert.ok(jump.jumpStartMs <= midHang, 'new arc is anchored at or before the press');
  assert.ok(jump.jumpStartMs + jump.D > midHang, 'and still has airtime after the press');
});

test('force-relaunch at the apex never teleports to the ground', () => {
  const jump = makeJump();
  jump.onPlayerTap({ tMs: 0, vel: 0.8 });
  // Apex hang sits at u in [A, A+B); sample the middle of the hang.
  const apexMs = jump.D * (A + B / 2);
  jump.update(apexMs);
  assert.ok(jump.y > 100, `should be high at apex, got y=${jump.y}`);
  const yApex = jump.y;
  jump.onPlayerTap({ tMs: apexMs, vel: 0.9 });
  assert.equal(jump.airborne, true);
  assert.ok(Math.abs(jump.y - yApex) < 1e-6, `must not snap y to 0 at apex (y=${jump.y})`);
  assert.ok(jump.y > 100, 'still high after the force-relaunch');
  // A few steps later he should still be climbing or hanging, not grounded.
  jump.update(apexMs + 40);
  assert.ok(jump.y > 50, `must not have teleported to the ground (y=${jump.y})`);
});

test('raw onKick mid hang stays inert (only player taps force-relaunch)', () => {
  const jump = makeJump();
  jump.setKickTimes([0, 500, 1000, 1500]);
  jump.onKick({ tMs: 0, vel: 0.7, kick: true });
  const midHang = jump.D * (A + B / 2);
  jump.update(midHang);
  const start = jump.jumpStartMs;
  jump.onKick({ tMs: midHang, vel: 1, kick: true });
  assert.equal(jump.jumpStartMs, start, 'kick mid hang must not force-relaunch');
  assert.equal(jump.compress, null);
});

test('a tap in the early fall compresses and relaunches, like a live retarget', () => {
  const jump = makeJump();
  jump.onPlayerTap({ tMs: 0, vel: 0.7 });
  const earlyFall = jump.D * 0.7; // r = (0.70 - 0.65) / 0.35 ~ 0.14 < 0.3
  jump.onPlayerTap({ tMs: earlyFall, vel: 0.9 });
  assert.ok(jump.compress, 'compress engaged');
  jump.update(earlyFall + 120);
  assert.ok(jump.pendingLanding, 'the compressed arc touched down');
  assert.equal(jump.airborne, true, 'and immediately relaunched');
  assert.equal(jump.jumpStartMs, earlyFall + 120);
  assert.equal(jump.lastLaunchVel, 0.9);
});

test('on-time taps at a steady beat land within one sim step of the next kick', () => {
  const kicks = [];
  for (let i = 0; i <= 13; i++) kicks.push(i * 500);
  const taps = kicks.slice(1, 11); // tap kicks 500..5000
  const landings = runPlayerTaps(taps, kicks);
  assert.equal(landings.length, taps.length);
  for (const landMs of landings) {
    const nearest = Math.round(landMs / 500) * 500;
    assert.ok(Math.abs(landMs - nearest) <= 10, `landing ${landMs} should sit on the 500ms kick grid`);
  }
});

test('resetKickBaseline: the kick after a withheld span sets no interval', () => {
  const jump = makeJump();
  jump.noteKickTiming(0);
  jump.noteKickTiming(500); // steady: EMA stays at 500
  assert.equal(jump.beatPeriodMs, 500);
  jump.resetKickBaseline();
  jump.noteKickTiming(2050); // a 1550ms gap follows the skipped roll — must not register
  assert.equal(jump.beatPeriodMs, 500);
  jump.noteKickTiming(2550); // steady beats resume cleanly from the new baseline
  assert.equal(jump.beatPeriodMs, 500);
});
