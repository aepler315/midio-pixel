// Midio's always-on motion. He was the only one of the trio who stood still
// between events, which is what forced a walk cycle onto a nine-vertex
// crystal shard. These pin the properties that make the motion CONSTANT --
// the thing that actually retires the gait -- rather than the exact curve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  midioHoverPx, midioPrecessDeg, midioCoreSpinDeg, midioMotion,
  midioPulseEnv, midioPulseScale,
  HOVER_LIFT_PX, PRECESS_BASE_DEG, PRECESS_ENERGY_DEG, CORE_SPIN_BASE_DPS,
} from '../src/render/MidioMotion.js';

test('he never touches the ground line -- there is no gait to animate', () => {
  // Negative is up. The lift has to hold even in dead silence, or he settles
  // onto the ground and needs feet again.
  for (let t = 0; t < 40; t += 0.13) {
    assert.ok(midioHoverPx(t, 0) <= -HOVER_LIFT_PX * 0.5,
      `t=${t.toFixed(2)} let him sink to ${midioHoverPx(t, 0)}`);
  }
});

test('the hover never settles, at any energy -- it is motion, not a pose', () => {
  for (const e of [0, 0.5, 1]) {
    const seen = new Set();
    for (let t = 0; t < 25; t += 0.05) seen.add(midioHoverPx(t, e).toFixed(2));
    assert.ok(seen.size > 40, `energy=${e} produced only ${seen.size} distinct heights`);
  }
});

test('energy raises the hover swing without ever letting him touch down', () => {
  const span = (e) => {
    let lo = Infinity, hi = -Infinity;
    for (let t = 0; t < 30; t += 0.02) { const v = midioHoverPx(t, e); if (v < lo) lo = v; if (v > hi) hi = v; }
    return { lo, hi, span: hi - lo };
  };
  const calm = span(0), loud = span(1);
  assert.ok(loud.span > calm.span * 1.4, `loud should swing wider: ${calm.span} -> ${loud.span}`);
  assert.ok(loud.hi < 0 && calm.hi < 0, 'the top of the swing is still above the ground line');
});

test('precession sways both ways and stays well short of falling over', () => {
  let lo = Infinity, hi = -Infinity;
  for (let t = 0; t < 60; t += 0.03) {
    const v = midioPrecessDeg(t, 1);
    if (v < lo) lo = v; if (v > hi) hi = v;
  }
  assert.ok(lo < -1 && hi > 1, 'must sway to both sides, not lean one way');
  const bound = PRECESS_BASE_DEG + PRECESS_ENERGY_DEG;
  assert.ok(hi <= bound + 1e-6 && lo >= -bound - 1e-6, `sway ${lo}..${hi} exceeded its own bound ${bound}`);
});

test('the core spin only ever advances -- it can never stall on a beat', () => {
  let prev = -Infinity;
  for (let t = 0; t < 30; t += 0.05) {
    const v = midioCoreSpinDeg(t, 0);
    assert.ok(v >= prev, `spin went backwards at t=${t}`);
    prev = v;
  }
  // And it keeps turning in silence: that is the "powered, not adrift" cue.
  assert.ok(midioCoreSpinDeg(10, 0) >= 10 * CORE_SPIN_BASE_DPS - 1e-6);
  assert.ok(midioCoreSpinDeg(10, 1) > midioCoreSpinDeg(10, 0), 'energy spins it faster');
});

test('reduced motion scales everything toward rest, and 0 is a full stop', () => {
  // The accessibility toggle is exactly what this is for.
  const full = midioMotion(3.3, 1, 1);
  const reduced = midioMotion(3.3, 1, 0.25);
  assert.ok(Math.abs(reduced.hoverPx) < Math.abs(full.hoverPx));
  assert.ok(Math.abs(reduced.precessDeg) < Math.abs(full.precessDeg));
  assert.ok(reduced.coreSpinDeg < full.coreSpinDeg);
  const off = midioMotion(3.3, 1, 0);
  // pulseScale is a MULTIPLIER, so its "stopped" value is 1, not 0.
  assert.deepEqual(off, { hoverPx: 0, precessDeg: 0, coreSpinDeg: 0, pulseScale: 1 });
});

test('every term is finite across a long run at every energy', () => {
  for (const e of [0, 0.37, 1]) {
    for (let t = 0; t < 600; t += 7.3) {
      const m = midioMotion(t, e);
      assert.ok(Number.isFinite(m.hoverPx) && Number.isFinite(m.precessDeg) && Number.isFinite(m.coreSpinDeg));
    }
  }
});

// --- Baseline pulse -------------------------------------------------------
// He had no beat-locked layer at all: the hover/precession/spin are
// deliberately co-prime and never land on anything, so he read as alive but
// arhythmic next to Broshi, whose flash and stride visibly agree with the
// music.
test('the pulse peaks ON the beat and falls away after it', () => {
  assert.equal(midioPulseEnv(0), 1);
  assert.ok(midioPulseEnv(0.15) < midioPulseEnv(0.05));
  assert.ok(midioPulseEnv(0.5) < midioPulseEnv(0.15));
});

test('and rises back INTO the next beat rather than strobing at the wrap', () => {
  // A bare decay jumps from ~0 straight to 1 at the beat, which reads as a
  // one-frame strobe. The attack window is what makes it a heartbeat.
  assert.ok(midioPulseEnv(0.999) > 0.9, 'should be nearly peaked just before the beat');
  const step = Math.abs(midioPulseEnv(0.999) - midioPulseEnv(0));
  assert.ok(step < 0.15, `discontinuity of ${step} at the beat wrap`);
});

test('the envelope is bounded and wraps for any phase a caller hands in', () => {
  for (let p = -3; p <= 3; p += 0.037) {
    const v = midioPulseEnv(p);
    assert.ok(v >= 0 && v <= 1 + 1e-9, `env out of range at ${p}: ${v}`);
  }
  assert.ok(Math.abs(midioPulseEnv(1.25) - midioPulseEnv(0.25)) < 1e-12, 'must wrap');
  assert.equal(midioPulseEnv(NaN), 0);
});

test('it is a BASELINE: subtle, and louder music only swells it a little', () => {
  const quiet = midioPulseScale(0, 0);
  const loud = midioPulseScale(0, 1);
  assert.ok(quiet > 1, 'it must be present even in silence -- that is the point');
  assert.ok(loud > quiet, 'and energy should swell it');
  assert.ok(loud < 1.09, `too large to sit under the event vocabulary: ${loud}`);
});

test('reduced motion stills the pulse to exactly 1', () => {
  assert.equal(midioPulseScale(0, 1, 0), 1);
  assert.equal(midioPulseScale(0.4, 1, 0), 1);
});

test('no beat grid means no pulse, not a guessed one', () => {
  assert.equal(midioMotion(2, 1, 1, null).pulseScale, 1);
  assert.ok(midioMotion(2, 1, 1, 0).pulseScale > 1);
});
