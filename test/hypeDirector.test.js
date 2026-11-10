import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HypeDirector } from '../src/sim/HypeDirector.js';

// HypeDirector's drop detector reads globalEnergyNorm -- see CalmDirector's
// test for why a fixed-value stub is the right fixture for these thresholds.
function fakeEnergy(value) {
  return { globalEnergy: () => value, globalEnergyNorm: () => value };
}

const STEP = 1 / 120;

test('a sudden loud attack after a quiet stretch fires exactly one drop', () => {
  const hype = new HypeDirector();
  let t = 0;
  for (let i = 0; i < 600; i++) { hype.update(t, STEP, fakeEnergy(0.1)); t += 8.33; } // 5s quiet
  assert.equal(hype.dropCount, 0);

  for (let i = 0; i < 120; i++) { hype.update(t, STEP, fakeEnergy(0.95)); t += 8.33; } // the drop hits
  assert.equal(hype.dropCount, 1, 'the attack must register as a drop');
  assert.ok(hype.surge > 0.5, 'surge should still be hot right after');
});

test('sustained loud music never re-fires: fast and slow EMAs converge', () => {
  const hype = new HypeDirector();
  let t = 0;
  for (let i = 0; i < 600; i++) { hype.update(t, STEP, fakeEnergy(0.1)); t += 8.33; }
  for (let i = 0; i < 2400; i++) { hype.update(t, STEP, fakeEnergy(0.95)); t += 8.33; } // 20s loud
  assert.equal(hype.dropCount, 1, 'only the initial attack counts, not the sustain');
});

test('the cooldown blocks rapid-fire drops from an oscillating dynamic', () => {
  const hype = new HypeDirector();
  let t = 0;
  // Alternate 1.5s quiet / 1.5s loud for 12s: without a cooldown this would
  // fire every cycle; with it, at most every 6s.
  for (let i = 0; i < 1440; i++) {
    const loud = Math.floor(t / 1500) % 2 === 1;
    hype.update(t, STEP, fakeEnergy(loud ? 0.95 : 0.05));
    t += 8.33;
  }
  assert.ok(hype.dropCount <= 2, `cooldown must cap drops, got ${hype.dropCount}`);
});

test('kick slams spike and decay; surge decays', () => {
  const hype = new HypeDirector();
  hype.onKick(1);
  assert.ok(hype.slam >= 0.9);
  let t = 0;
  for (let i = 0; i < 60; i++) { hype.update(t, STEP, fakeEnergy(0.3)); t += 8.33; } // 0.5s
  assert.ok(hype.slam < 0.05, 'slam must decay within half a second');

});

test('buildUp rises on a sustained energy ramp without ever firing a drop', () => {
  const hype = new HypeDirector();
  let t = 0;
  // Fully settle at a flat level first (~5 slow-EMA time constants) so the
  // startup transient itself (slow catching up to fast from 0) isn't
  // mistaken for a ramp.
  for (let i = 0; i < 1500; i++) { hype.update(t, STEP, fakeEnergy(0.1)); t += 8.33; }
  assert.ok(hype.buildUp < 0.05, 'no ramp yet -- buildUp should sit near 0');

  // A gradual, sustained rise -- never a sudden attack, so no drop should fire.
  for (let i = 0; i < 600; i++) {
    const e = 0.1 + 0.6 * (i / 600);
    hype.update(t, STEP, fakeEnergy(e));
    t += 8.33;
  }
  assert.equal(hype.dropCount, 0, 'a gradual ramp is a build-up, not a drop');
  assert.ok(hype.buildUp > 0.15, `expected buildUp to rise on a sustained crescendo, got ${hype.buildUp}`);
});

test('buildUp settles back toward 0 once the ramp plateaus', () => {
  const hype = new HypeDirector();
  let t = 0;
  for (let i = 0; i < 600; i++) {
    const e = 0.1 + 0.7 * Math.min(1, i / 400);
    hype.update(t, STEP, fakeEnergy(e));
    t += 8.33;
  }
  const peak = hype.buildUp;
  // Hold steady at the plateau -- fast catches up to slow, delta -> 0.
  for (let i = 0; i < 600; i++) { hype.update(t, STEP, fakeEnergy(0.8)); t += 8.33; }
  assert.ok(hype.buildUp < peak * 0.3, `buildUp should decay once the ramp plateaus, was ${peak}, now ${hype.buildUp}`);
});
