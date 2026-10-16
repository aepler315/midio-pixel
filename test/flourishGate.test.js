import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlourishGate } from '../src/sim/FlourishGate.js';

/** Deterministic "always rolls low" / "always rolls high" sources, so the
 *  probability branch is testable without a seeded PRNG. */
const always = () => 0;
const never = () => 0.999999;

test('the minGap floor is never bypassed, not even by a transition at full intensity', () => {
  const g = new FlourishGate({ minGapMs: 1000, chance: 1, rand: always });
  assert.equal(g.tryFire(0, { intensity: 1, transition: true }), true);
  // This is the exact failure mode the disc spins had: the move is 420ms
  // long, so anything that lets it restart inside its own window means it
  // never resolves and the character reads as continuously rotating.
  assert.equal(g.tryFire(400, { intensity: 1, transition: true }), false);
  assert.equal(g.lastReason, 'floor');
  assert.equal(g.tryFire(999, { intensity: 1, transition: true }), false);
  assert.equal(g.tryFire(1000, { intensity: 1, transition: true }), true);
});

test('a transition skips the probability roll; an ordinary cue does not', () => {
  const g = new FlourishGate({ minGapMs: 100, chance: 0.5, rand: never });
  assert.equal(g.tryFire(0, { transition: true }), true, 'transition ignores the roll');
  assert.equal(g.tryFire(10000, { transition: false }), false, 'a losing roll blocks an ordinary cue');
  assert.equal(g.lastReason, 'chance');
});

test('higher intensity shortens the effective cooldown above the floor', () => {
  const calm = new FlourishGate({ minGapMs: 1000, chance: 1, intensityScale: 0.5, rand: always });
  const hot = new FlourishGate({ minGapMs: 1000, chance: 1, intensityScale: 0.5, rand: always });
  calm.tryFire(0, { intensity: 0 });
  hot.tryFire(0, { intensity: 1 });
  // At intensity 0 the gap is 2x the floor; at intensity 1 it's 1.5x.
  assert.equal(calm.tryFire(1700, { intensity: 0 }), false, 'calm still waiting at 1700ms');
  assert.equal(hot.tryFire(1700, { intensity: 1 }), true, 'hot is eligible at 1700ms');
});

test('intensity raises the firing probability between chance and intensityChance', () => {
  // rand() returns 0.6: below 0.7 (full intensity) but above 0.3 (at rest).
  const rand = () => 0.6;
  const cold = new FlourishGate({ minGapMs: 0, chance: 0.3, intensityChance: 0.7, intensityScale: 0, rand });
  const warm = new FlourishGate({ minGapMs: 0, chance: 0.3, intensityChance: 0.7, intensityScale: 0, rand });
  assert.equal(cold.tryFire(0, { intensity: 0 }), false, 'a quiet passage mostly stays still');
  assert.equal(warm.tryFire(0, { intensity: 1 }), true, 'a loud one flourishes more readily');
});

test('a denied attempt does not consume the cooldown', () => {
  const g = new FlourishGate({ minGapMs: 500, chance: 0, rand: always });
  assert.equal(g.tryFire(0, {}), false, 'chance 0 never fires');
  // lastFireMs must be untouched, or a run of denials would silently push
  // the next legitimate flourish further and further out.
  assert.equal(g.lastFireMs, -Infinity);
});

test('reset clears the last fire so a song swap does not hold a move back', () => {
  const g = new FlourishGate({ minGapMs: 5000, chance: 1, rand: always });
  assert.equal(g.tryFire(100000, {}), true);
  g.reset();
  assert.equal(g.tryFire(0, {}), true, 'after reset, a fresh timeline fires immediately');
});
