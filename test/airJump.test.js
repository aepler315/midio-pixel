import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JumpController, A, W, jumpY } from '../src/sim/JumpController.js';
import { ParamBus } from '../src/core/ParamBus.js';
import { AirJumpSequencer, BUDGET_4BAR, BUDGET_8BAR } from '../src/sim/AirJumpSequencer.js';
import { PhraseTracker } from '../src/core/PhraseTracker.js';

const BAR_MS = 2000;
function makeJump() { return new JumpController(new ParamBus()); }
function tracker(bars = 64) {
  return new PhraseTracker(Array.from({ length: bars }, (_, i) => ({ ms: i * BAR_MS })), null);
}

test('airJump relaunches mid-air with no height snap (C0-continuous)', () => {
  const jump = makeJump();
  jump.onPlayerTap({ tMs: 0, vel: 0.7 });
  const tapMs = jump.D * 0.8; // late fall, well before landing
  jump.update(tapMs);
  const yBefore = jump.y;
  assert.ok(yBefore > 0, 'still airborne at the air-tap');
  const ok = jump.airJump({ tMs: tapMs, vel: 0.7 }, 1, { index: 0 });
  assert.equal(ok, true);
  assert.ok(Math.abs(jump.y - yBefore) < 1e-6, 'y is continuous through the relaunch');
  assert.ok(jump.pendingAirJump, 'one-shot FX flag set');
  // The new arc climbs from here: a moment later the character is HIGHER.
  jump.update(tapMs + 40);
  assert.ok(jump.y > yBefore, `should climb after the double jump (${jump.y} > ${yBefore})`);
});

test('airJump refuses on the ground and after the landing time', () => {
  const jump = makeJump();
  assert.equal(jump.airJump({ tMs: 100, vel: 0.7 }, 1), false);
  jump.onPlayerTap({ tMs: 1000, vel: 0.7 });
  const afterLanding = 1000 + jump.D + 50;
  assert.equal(jump.airJump({ tMs: afterLanding, vel: 0.7 }, 1), false, 'already landed by tMs');
  assert.equal(jump.state, 'GROUND');
});

test('airJump arc still lands (returns to y=0)', () => {
  const jump = makeJump();
  jump.onPlayerTap({ tMs: 0, vel: 0.7 });
  jump.update(jump.D * 0.85);
  assert.ok(jump.airJump({ tMs: jump.D * 0.85, vel: 0.9 }, 1.35, { index: 1, isFlourish: true }));
  const D2 = jump.D;
  let landed = false;
  for (let t = jump.jumpStartMs; t < jump.jumpStartMs + D2 + 100; t += 1000 / 120) {
    jump.clearFrameFlags();
    jump.update(t);
    if (jump.pendingLanding) { landed = true; break; }
  }
  assert.ok(landed, 'the double-jump arc completes with a landing');
  assert.equal(jump.y, 0);
});

test('sequencer: budget is 2 per 4-bar phrase and refills on phrase boundaries', () => {
  const seq = new AirJumpSequencer(tracker());
  assert.equal(seq.budget, BUDGET_4BAR);
  const t0 = 100; // inside phrase 0
  assert.ok(seq.tryConsume(t0));
  const g2 = seq.tryConsume(t0 + 50);
  assert.ok(g2);
  assert.equal(g2.isFlourish, true, 'last air jump in the phrase is the flourish');
  assert.equal(seq.tryConsume(t0 + 100), null, 'not forever — budget spent');
  // Next phrase (bar 4) refills.
  const t1 = 4 * BAR_MS + 10;
  assert.ok(seq.tryConsume(t1));
  assert.equal(seq.remainingAt(t1), 1);
});

test('sequencer: 8-bar phrasing widens the budget and decays the boost', () => {
  const pt = tracker();
  pt.phraseLenBars = 8; // force the 8-bar grouping
  const seq = new AirJumpSequencer(pt);
  assert.equal(seq.budget, BUDGET_8BAR);
  const g0 = seq.tryConsume(0);
  const g1 = seq.tryConsume(1);
  const g2 = seq.tryConsume(2);
  const g3 = seq.tryConsume(3);
  assert.ok(g0.boostMul > g1.boostMul && g1.boostMul > g2.boostMul, 'the chain tapers');
  assert.ok(g3.isFlourish && g3.boostMul > g0.boostMul, 'the finale spikes');
  assert.equal(seq.tryConsume(4), null);
});

test('sequencer: refund returns the last consume', () => {
  const seq = new AirJumpSequencer(tracker());
  seq.tryConsume(0);
  seq.tryConsume(1);
  assert.equal(seq.tryConsume(2), null);
  seq.refund();
  assert.ok(seq.tryConsume(3), 'refunded slot is usable again');
});

test('flourish boost clears the plain-jump apex from the same height', () => {
  // Same state, two boosts: the flourish arc's apex must be higher.
  const mk = () => {
    const j = makeJump();
    j.onPlayerTap({ tMs: 0, vel: 0.7 });
    j.update(j.D * 0.8);
    return j;
  };
  const a = mk(), b = mk();
  const t = a.D * 0.8;
  a.airJump({ tMs: t, vel: 0.7 }, 1, { index: 0 });
  b.airJump({ tMs: t, vel: 0.7 }, 1.35, { index: 1, isFlourish: true });
  assert.ok(b.H > a.H, 'flourish apex above the plain double jump');
});
