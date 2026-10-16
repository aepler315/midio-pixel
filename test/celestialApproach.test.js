// The sun and moon are coming, and the effect lives in a RATIO: size grows
// fast while position barely changes, so the eye files the body as far away
// and is then unable to reconcile how big it has become.
//
// The anchor every one of these has to respect: the frame is at most a
// 180-degree view, both bodies rise and set inside it, and whatever an
// approach does it must leave a body climbing out of the water on one side
// and going back into it on the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approachDistance, approachScale, approachedY, celestialApproach,
  D_FAR, D_NEAR, MAX_SCALE, APPROACH_LIFT, MAX_LIFT, OBSERVER_PARALLAX,
} from '../src/world/CelestialApproach.js';

const HORIZON = 400;

test('it starts at its established size and only ever grows', () => {
  assert.equal(approachScale(0), 1);
  let prev = 0;
  for (let t = 0; t <= 1; t += 0.05) {
    const s = approachScale(t);
    assert.ok(s >= prev - 1e-9, `scale went backwards at ${t}`);
    prev = s;
  }
  assert.ok(approachScale(1) > 3, 'it should end unmistakably larger');
  assert.ok(approachScale(1) <= MAX_SCALE);
});

test('the growth is CONVEX -- almost nothing, then a lot', () => {
  // This is what makes it unsettling rather than merely animated: the first
  // half of the song has to be deniable.
  const firstHalf = approachScale(0.5) - approachScale(0);
  const secondHalf = approachScale(1) - approachScale(0.5);
  assert.ok(secondHalf > firstHalf * 2,
    `growth should accelerate hard: ${firstHalf} then ${secondHalf}`);
});

test('the arc climbs at a CONSTANT rate', () => {
  // The counterpart to the convex size curve. Constant means there is never
  // a moment where the eye catches motion.
  const at = (t) => approachedY(HORIZON - 200, HORIZON, 0, t);
  // Integer steps: accumulating 0.1 in floats overshoots 1 on the last
  // iteration, and the clamp then reports a zero-length step that is an
  // artifact of the loop rather than of the curve.
  const steps = [];
  for (let i = 0; i < 10; i++) steps.push(at((i + 1) / 10) - at(i / 10));
  const first = steps[0];
  for (const s of steps) {
    assert.ok(Math.abs(s - first) < 1e-6, `climb rate varied: ${first} vs ${s}`);
  }
});

test('size outruns motion by a wide margin -- the whole illusion', () => {
  const grew = approachScale(1) / approachScale(0);
  const climbed = Math.abs(approachedY(HORIZON - 200, HORIZON, 0, 1)
    - approachedY(HORIZON - 200, HORIZON, 0, 0)) / 200;
  assert.ok(grew > climbed * 4,
    `size must outrun position: grew ${grew}x, climbed ${climbed} of its own altitude`);
});

// --- the anchor -----------------------------------------------------------

test('a body still rises out of the sea however close it has come', () => {
  // The property the previous version broke. It pulled every body toward a
  // fixed point up and left of Midio, which overrode the orbit's own rise and
  // set -- so the sun set at left-centre and the moon rose a moment later
  // almost on top of it, and neither came out of the water any more.
  for (let t = 0; t <= 1; t += 0.1) {
    assert.equal(approachedY(HORIZON, HORIZON, 0, t), HORIZON,
      `at the waterline the lift must be exactly zero (t=${t})`);
  }
});

test('the horizontal arc is never touched', () => {
  // Two bodies in opposition cannot both be pulled toward the same point and
  // still be a sky. x comes straight back out.
  for (const orbitX of [0, 120, 640, 1280]) {
    for (let t = 0; t <= 1; t += 0.25) {
      const a = celestialApproach({
        orbitX, orbitY: 200, horizonY: HORIZON, progress01: t,
      });
      assert.equal(a.x, orbitX, `x moved at t=${t}`);
    }
  }
});

test('the lift grows with altitude, so only the middle of the arc climbs', () => {
  const nearHorizon = HORIZON - approachedY(HORIZON - 20, HORIZON, 0, 1);
  const nearZenith = HORIZON - approachedY(HORIZON - 300, HORIZON, 0, 1);
  assert.ok(nearZenith > nearHorizon * 5,
    `a body near the zenith should climb far more than one at the waterline: ${nearHorizon} vs ${nearZenith}`);
});

test('at full approach the zenith climbs by the stated fraction', () => {
  // MAX_LIFT, not APPROACH_LIFT: the body never actually arrives, so
  // closeness tops out at 1 - D_NEAR/D_FAR and the lift is scaled by it.
  // Asserting the raw constant here is what caught that the comment claiming
  // "at closest approach" was overstating the effect by a third.
  const above = 300;
  const y = approachedY(HORIZON - above, HORIZON, 0, 1);
  assert.ok(Math.abs((HORIZON - y) - above * (1 + MAX_LIFT)) < 1e-6,
    `expected ${above * (1 + MAX_LIFT)} above the horizon, got ${HORIZON - y}`);
  assert.ok(MAX_LIFT < APPROACH_LIFT, 'the body never fully arrives');
});

test('a body below the waterline is not lifted out of it', () => {
  // The sun is continued below the horizon so the moon knows which way it is
  // lit. Closing must not float that hidden body back into view.
  const below = approachedY(HORIZON + 150, HORIZON, 0, 1);
  assert.ok(below > HORIZON, 'a set body must stay set');
});

// --- untouched behaviours -------------------------------------------------

test('at the start it sits exactly on its orbit, untouched', () => {
  const a = celestialApproach({
    orbitX: 900, orbitY: 180, horizonY: HORIZON, progress01: 0,
  });
  assert.equal(a.x, 900);
  assert.equal(a.y, 180);
  assert.equal(a.scale, 1);
});

test('distance closes but never reaches zero', () => {
  assert.equal(approachDistance(0), D_FAR);
  assert.equal(approachDistance(1), D_NEAR);
  assert.ok(D_NEAR > 0, 'it passes close by; it does not arrive');
  let prev = Infinity;
  for (let t = 0; t <= 1; t += 0.1) {
    const d = approachDistance(t);
    assert.ok(d < prev, 'distance must close monotonically');
    prev = d;
  }
});

test('progress outside 0..1 is clamped, not extrapolated', () => {
  assert.equal(approachScale(-3), approachScale(0));
  assert.equal(approachScale(9), approachScale(1));
  assert.equal(approachedY(200, HORIZON, 0, 9), approachedY(200, HORIZON, 0, 1));
});

test('a jump does not move the sun', () => {
  // The parallax term is real but tiny, and it GROWS with closeness rather
  // than being constant. An earlier version used Midio's live render y as the
  // anchor outright, which welded a body at astronomical distance to a
  // character's pose: he jumped three feet and the sun jumped with him.
  const still = approachedY(200, HORIZON, 0, 1);
  const airborne = approachedY(200, HORIZON, -120, 1);
  const moved = Math.abs(airborne - still);
  assert.ok(moved > 0, 'some parallax should exist -- it is a real effect');
  assert.ok(moved < 120 * OBSERVER_PARALLAX + 1e-6,
    `a 120px jump must not move the sun ${moved}px`);
  assert.ok(moved < 4, 'and in absolute terms it must be unpointable-at');
});

test('parallax is smaller when the body is further away', () => {
  const far = Math.abs(approachedY(200, HORIZON, -120, 0) - approachedY(200, HORIZON, 0, 0));
  const near = Math.abs(approachedY(200, HORIZON, -120, 1) - approachedY(200, HORIZON, 0, 1));
  assert.ok(near > far, 'a nearer body shifts more against the background');
  assert.equal(far, 0, 'and at full distance there is none at all');
});

test('the composite hands back everything a frame needs', () => {
  const a = celestialApproach({
    orbitX: 700, orbitY: 150, horizonY: HORIZON, observerDy: -40, progress01: 0.6,
  });
  for (const k of ['x', 'y', 'scale', 'distance']) {
    assert.ok(Number.isFinite(a[k]), `${k} should be a real number`);
  }
  assert.equal(a.x, 700);
  assert.equal(a.scale, approachScale(0.6));
});

// --- the moon's phase -----------------------------------------------------

test('the moon does not linger at the phase with no curve in it', () => {
  // At exactly quarter the terminator ellipse is degenerate and the lit
  // region's inner edge is a straight diameter across the disc. Correct
  // astronomy, and at this size it reads as a line drawn through the moon.
  // Softening the edge does not solve it -- half the disc is lit and half is
  // not, along a line, whatever the feather. So the phase is warped to cross
  // that value quickly and dwell where the terminator is visibly a curve.
  const SKEW = 4;
  const warp = (p) => {
    const half = p < 0.5 ? 0 : 1;
    const u = p < 0.5 ? p * 2 : (p - 0.5) * 2;
    const w = u < 0.5
      ? 0.5 * Math.pow(u * 2, SKEW)
      : 1 - 0.5 * Math.pow((1 - u) * 2, SKEW);
    return (half + w) * 0.5;
  };
  const straightFraction = (phaseOf) => {
    let near = 0, total = 0;
    for (let i = 0; i <= 2000; i++) {
      const ill = Math.max(0.16, 0.5 - 0.5 * Math.cos(2 * Math.PI * phaseOf(i / 2000)));
      total++;
      if (Math.abs(1 - 2 * ill) < 0.15) near++;   // |k/R|, the terminator half-width
    }
    return near / total;
  };
  const before = straightFraction((p) => p);
  const after = straightFraction(warp);
  assert.ok(after < before / 3,
    `the warp should cut the straight-terminator time hard: ${(before * 100).toFixed(1)}% -> ${(after * 100).toFixed(1)}%`);

  // ...without breaking the cycle it is warping.
  let prev = -1;
  for (let i = 0; i <= 2000; i++) {
    const ph = warp(i / 2000);
    assert.ok(ph >= prev - 1e-9, 'the phase must still run new -> full monotonically');
    prev = ph;
  }
  assert.ok(Math.abs(warp(0)) < 1e-9 && Math.abs(warp(1) - 1) < 1e-9,
    'and must still span a whole cycle');
});
