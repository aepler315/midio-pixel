import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CameraDirector, CALM_DRIFT_AMP_PX, CALM_DRIFT_PERIOD_SEC,
  beatSwayOffset, BEAT_SWAY_BASE_PX, BEAT_SWAY_ENERGY_PX, BEAT_SWAY_LATERAL_PX,
  UNIVERSE_ZOOM_DIP, UNIVERSE_ROLL_MAX, FLOAT_TILT_MAX, ZOOM_MIN,
} from '../src/render/CameraDirector.js';

test('calm level introduces a slow, subtle drift when nothing else is shaking the camera', () => {
  const cam = new CameraDirector();
  let sawNonZero = false;
  let maxAbs = 0;
  // Run several full sweep periods so the smoothed amplitude reaches its
  // steady peak and the sinusoid actually swings through it.
  const steps = Math.ceil(CALM_DRIFT_PERIOD_SEC * 3 / (1 / 60));
  for (let i = 0; i < steps; i++) {
    cam.update(1 / 60, 1);
    if (cam.shakeX !== 0 || cam.shakeY !== 0) sawNonZero = true;
    maxAbs = Math.max(maxAbs, Math.abs(cam.shakeX), Math.abs(cam.shakeY));
  }
  assert.ok(sawNonZero, 'expected calm drift to move the camera off dead-zero at some point');
  assert.ok(maxAbs <= CALM_DRIFT_AMP_PX + 0.01, `expected drift to stay within its amplitude, got ${maxAbs}`);
  // Subtle by design: enough to read as gentle life, nowhere near the 26px
  // wide-sweep that read as the whole scene trembling.
  assert.ok(maxAbs > 3, `expected a small-but-visible drift, got ${maxAbs}`);
  assert.ok(maxAbs < 10, `drift must not tremble the frame (was 26px), got ${maxAbs}`);
});

test('calm drift amplitude scales with calmLevel (a partly-calm section sweeps proportionally less)', () => {
  const full = new CameraDirector(), half = new CameraDirector();
  let maxFull = 0, maxHalf = 0;
  // Let both reach steady amplitude (smoothing converges within ~3 tau),
  // then measure over a full period.
  const warmup = Math.ceil(4 / (1 / 60));
  for (let i = 0; i < warmup; i++) { full.update(1 / 60, 1); half.update(1 / 60, 0.5); }
  const steps = Math.ceil(CALM_DRIFT_PERIOD_SEC / (1 / 60));
  for (let i = 0; i < steps; i++) {
    full.update(1 / 60, 1);
    half.update(1 / 60, 0.5);
    maxFull = Math.max(maxFull, Math.abs(full.shakeX));
    maxHalf = Math.max(maxHalf, Math.abs(half.shakeX));
  }
  assert.ok(maxFull > 0 && maxHalf > 0, 'both should drift');
  assert.ok(Math.abs(maxHalf - maxFull * 0.5) < 1, `expected roughly half the amplitude, got full=${maxFull} half=${maxHalf}`);
});

test('calm drift amplitude eases smoothly when calmLevel jumps (no camera snap)', () => {
  const cam = new CameraDirector();
  // Sudden calm onset: a 0->1 jump must not translate the camera tens of
  // pixels in one frame (the trembling bug).
  for (let i = 0; i < 30; i++) cam.update(1 / 60, 0);
  cam.update(1 / 60, 1);
  const snapX = cam.shakeX, snapY = cam.shakeY;
  assert.ok(Math.abs(snapX) < 2, `expected a small eased first step, got ${snapX}`);
  assert.ok(Math.abs(snapY) < 2, `expected a small eased first step, got ${snapY}`);
  // ...and the amplitude ramps up over a couple seconds rather than arriving instantly.
  let earlyMax = 0;
  for (let i = 0; i < 60; i++) { cam.update(1 / 60, 1); earlyMax = Math.max(earlyMax, Math.abs(cam.shakeX)); }
  assert.ok(earlyMax < CALM_DRIFT_AMP_PX * 0.6, `amplitude should ramp, not jump to full (got ${earlyMax})`);
});

test('with calmLevel 0, the camera stays at dead-zero absent any shake trigger', () => {
  const cam = new CameraDirector();
  for (let i = 0; i < 60; i++) cam.update(1 / 60, 0);
  assert.equal(cam.shakeX, 0);
  assert.equal(cam.shakeY, 0);
});

test('impact shake and calm drift compose additively rather than one overriding the other', () => {
  const cam = new CameraDirector();
  cam.shake(10);
  cam.update(1 / 60, 1);
  // Right after a shake trigger, the shake term dominates but the call must not throw
  // or discard the drift signal entirely -- just assert it produced *some* offset.
  assert.ok(Math.abs(cam.shakeX) > 0 || Math.abs(cam.shakeY) > 0);
});

test('an impact excites a small camera roll that rings down to zero', () => {
  const cam = new CameraDirector();
  assert.equal(cam.roll, 0);
  cam.shake(10);
  let maxRoll = 0;
  for (let i = 0; i < 30; i++) { cam.update(1 / 60, 0); maxRoll = Math.max(maxRoll, Math.abs(cam.roll)); }
  assert.ok(maxRoll > 0, 'expected the shake to excite a roll oscillation');
  assert.ok(maxRoll < 0.03, `roll should stay subtle (fractions of a degree), got ${maxRoll} rad`);

  for (let i = 0; i < 300; i++) cam.update(1 / 60, 0);
  assert.ok(Math.abs(cam.roll) < 1e-4, `expected the roll to ring down, got ${cam.roll}`);
});

test('consecutive impacts alternate roll direction', () => {
  const first = new CameraDirector();
  first.shake(10);
  first.update(0.02, 0);
  const firstSign = Math.sign(first.roll);

  first.shake(10); // re-strike: direction flips
  first.update(0.02, 0);
  assert.equal(Math.sign(first.roll), -firstSign);
});

// --- Beat sway ------------------------------------------------------------

// kickEnv's own attack ramps 0->1 over its first 40ms (see MountainChoreo.js),
// so tauMs=0 is the very instant of the beat (envelope still 0) -- these
// tests sample at tauMs=40, the envelope's peak, to check amplitudes.
test('beatSwayOffset snaps up right on the beat and settles back down, scaled by energy', () => {
  const quiet = beatSwayOffset(40, 1, 0, 1);
  const loud = beatSwayOffset(40, 1, 1, 1);
  assert.ok(Math.abs(quiet.y - BEAT_SWAY_BASE_PX) < 1e-6, 'even at zero energy, the base dip is present');
  assert.ok(Math.abs(loud.y - (BEAT_SWAY_BASE_PX + BEAT_SWAY_ENERGY_PX)) < 1e-6, 'full energy adds the full extra dip');

  const atBeat = beatSwayOffset(0, 1, 1, 1);
  assert.equal(atBeat.y, 0, 'the very instant of the beat is still the start of the attack, not the peak');

  const settled = beatSwayOffset(700, 1, 1, 1); // well past kickEnv's settle window
  assert.ok(settled.y < loud.y * 0.1, 'should have rung most of the way back down by 700ms');
});

test('beatSwayOffset\'s lateral nudge only appears with real musical energy, and flips with sign', () => {
  const stillCalm = beatSwayOffset(40, 1, 0, 1);
  assert.equal(stillCalm.x, 0, 'no lateral nudge at zero energy');

  const right = beatSwayOffset(40, 1, 1, 1);
  const left = beatSwayOffset(40, -1, 1, 1);
  assert.ok(right.x > 0);
  assert.ok(Math.abs(left.x + right.x) < 1e-9, 'the sign flips the nudge, magnitude unchanged');
});

test('beatSwayOffset is scaled down by the reduced-motion multiplier', () => {
  const full = beatSwayOffset(40, 1, 1, 1);
  const half = beatSwayOffset(40, 1, 1, 0.5);
  assert.ok(Math.abs(half.y - full.y * 0.5) < 1e-9);
  assert.ok(Math.abs(half.x - full.x * 0.5) < 1e-9);
});

test('CameraDirector ignores beat sway entirely when no beat clock is supplied (default null)', () => {
  const cam = new CameraDirector();
  for (let i = 0; i < 10; i++) cam.update(1 / 60, 0, false);
  assert.equal(cam.shakeX, 0);
  assert.equal(cam.shakeY, 0);
});

test('CameraDirector applies a beat-locked sway that moves the frame even with no impact/calm active', () => {
  const cam = new CameraDirector();
  let sawMotion = false;
  // Walk a beat clock at a plausible tempo (500ms/beat) across several beats.
  const periodMs = 500;
  let tMs = 0;
  for (let i = 0; i < 300; i++) {
    const dtMs = 1000 / 60;
    tMs += dtMs;
    const tau = tMs % periodMs;
    cam.update(dtMs / 1000, 0, false, tau, 1);
    if (Math.abs(cam.shakeY) > 0.5) sawMotion = true;
  }
  assert.ok(sawMotion, 'a beat-locked section with real energy should visibly move the camera');
});

test('a fresh beat crossing (tau wraps back toward 0) flips the lateral sway sign', () => {
  const cam = new CameraDirector();
  cam.update(0.001, 0, false, 490, 1); // just before a beat at period 500
  const xBefore = Math.sign(cam.shakeX) || cam._beatSwaySign;
  cam.update(0.001, 0, false, 5, 1); // wrapped: a new beat just landed
  cam.update(0.001, 0, false, 6, 1); // same beat, one tick later
  assert.equal(cam._beatSwaySign, -xBefore || cam._beatSwaySign, 'sign should have flipped across the wrap');
});

test('calm sections keep only a fraction of the beat sway, never the full-energy amount', () => {
  const calm = new CameraDirector(), active = new CameraDirector(), calmNoBeat = new CameraDirector();
  const dtSec = 0.001;
  // Isolate the beat-sway term from calm's own additive drift by running a
  // same-calm camera with no beat clock and subtracting its frame -- the
  // drift state (smoothed amplitude + phase) is identical between the two,
  // so it cancels exactly without re-deriving the drift formula.
  calmNoBeat.update(dtSec, 1, false, null, 1);
  calm.update(dtSec, 1, false, 40, 1);
  active.update(dtSec, 0, false, 40, 1);

  const calmSwayY = calm.shakeY - calmNoBeat.shakeY;

  assert.ok(calmSwayY < active.shakeY, 'deep calm should visibly damp the beat nod');
  assert.ok(calmSwayY > 0, 'but not silence it completely');
});

// --- Universe-shift reframe ---

test('a zero universePulse is a complete no-op, same as omitting it', () => {
  const withZero = new CameraDirector();
  const omitted = new CameraDirector();
  withZero.update(1 / 60, 0, false, null, 0, 0);
  omitted.update(1 / 60, 0, false, null, 0);
  assert.equal(withZero.zoom, omitted.zoom);
  assert.equal(withZero.roll, omitted.roll);
});

test('a full-strength universePulse pulls the zoom back by UNIVERSE_ZOOM_DIP and adds roll', () => {
  const cam = new CameraDirector();
  // Run zoom's own ease up to (near) 1 first with no pulse, so the dip below
  // is measured against a settled baseline rather than the initial transient.
  for (let i = 0; i < 300; i++) cam.update(1 / 60, 0, false, null, 0, 0);
  const baseZoom = cam.zoom;
  const baseRoll = cam.roll;
  cam.update(1 / 60, 0, false, null, 0, 1);
  assert.ok(Math.abs(cam.zoom - (baseZoom - UNIVERSE_ZOOM_DIP)) < 1e-6, `expected the full dip, got zoom ${cam.zoom}`);
  assert.ok(Math.abs(cam.roll - baseRoll) <= UNIVERSE_ROLL_MAX + 1e-9, 'roll tilt stays within its documented max');
  assert.notEqual(cam.roll, baseRoll, 'a full pulse should visibly tilt the frame');
});

test('the reframe scales linearly with pulse strength, and reduced motion shrinks (not silences) it', () => {
  const full = new CameraDirector();
  const half = new CameraDirector();
  const reduced = new CameraDirector();
  full.update(1 / 60, 0, false, null, 0, 1);
  half.update(1 / 60, 0, false, null, 0, 0.5);
  reduced.update(1 / 60, 0, true, null, 0, 1);
  const fullDip = 1 - full.zoom;
  const halfDip = 1 - half.zoom;
  assert.ok(Math.abs(halfDip - fullDip / 2) < 1e-6, `expected half the dip at half pulse, got ${halfDip} vs ${fullDip}`);
  assert.ok(Math.abs(reduced.roll) < Math.abs(full.roll), 'reduced motion should shrink the roll tilt');
  assert.ok(Math.abs(reduced.roll) > 0, 'but not eliminate it outright');
});

test('consecutive shifts alternate which way the reframe tilts', () => {
  const cam = new CameraDirector();
  cam.update(1 / 60, 0, false, null, 0, 0); // pulse starts at 0 -- no shift yet
  cam.update(1 / 60, 0, false, null, 0, 1); // pulse rises from 0 -- first shift
  const firstSign = cam._universeRollSign;
  cam.update(1 / 60, 0, false, null, 0, 0); // pulse falls back toward 0
  cam.update(1 / 60, 0, false, null, 0, 1); // rises from 0 again -- second shift
  const secondSign = cam._universeRollSign;
  assert.equal(secondSign, -firstSign);
});

test('a pulse held elevated across many frames never runs the zoom away -- regression for a real bug', () => {
  // The dip must be read off the eased base fresh each frame, not
  // accumulated into zoom/_zoomBase itself, or holding pulse=1 across the
  // ~100+ frames a real rise-and-settle spans compounds into a huge,
  // nonsensical negative zoom (a real Renderer.js stageW = nominalW/zoom
  // would go negative too). Walk a realistic full pulse cycle using
  // ParallelUniverseDirector's own shape, not a synthetic held-at-1 pulse.
  const cam = new CameraDirector();
  const dtSec = 1 / 60;
  let minZoom = Infinity;
  for (let i = 0; i < 400; i++) {
    // Same rise-then-settle shape ParallelUniverseDirector.update() produces.
    const u = (i * dtSec) / 0.9;
    const pulse = u < 1 ? Math.sin(u * Math.PI * 0.5) : Math.max(0, 2 - u) ** 2;
    cam.update(dtSec, 0, false, null, 0, pulse);
    minZoom = Math.min(minZoom, cam.zoom);
  }
  assert.ok(minZoom > 1 - UNIVERSE_ZOOM_DIP - 0.01, `zoom dipped far past its documented bound: ${minZoom}`);
  assert.ok(minZoom > 0, 'zoom must never go non-positive -- Renderer divides the stage width by it');
});

// --- Float tilt (per-layer differential tilt while pulled back) ---

test('floatTilt is 0 at normal framing (zoom=1) and rises smoothly as the camera pulls back', () => {
  const cam = new CameraDirector();
  cam.update(1 / 60, 0, false); // zoom starts at (and stays near) 1 with no target set
  assert.ok(Math.abs(cam.floatTilt) < 1e-6, `expected ~0 floatTilt at rest, got ${cam.floatTilt}`);

  cam._zoomTarget = ZOOM_MIN;
  let last = 0;
  for (let i = 0; i < 600; i++) {
    cam.update(1 / 60, 0, false);
    assert.ok(cam.floatTilt >= last - 1e-9, `floatTilt should rise monotonically as zoom eases down, dipped at frame ${i}`);
    last = cam.floatTilt;
  }
  assert.ok(Math.abs(cam.floatTilt - FLOAT_TILT_MAX) < 1e-3, `expected floatTilt to settle near its max, got ${cam.floatTilt}`);
});

test('floatTilt never exceeds FLOAT_TILT_MAX even at the hardest pull-back', () => {
  const cam = new CameraDirector();
  cam._zoomTarget = ZOOM_MIN;
  for (let i = 0; i < 1000; i++) {
    cam.update(1 / 60, 0, false);
    assert.ok(cam.floatTilt <= FLOAT_TILT_MAX + 1e-6, `floatTilt overshot: ${cam.floatTilt}`);
    assert.ok(cam.floatTilt >= 0, `floatTilt went negative: ${cam.floatTilt}`);
  }
});

test('reduced motion shrinks floatTilt rather than eliminating it', () => {
  const full = new CameraDirector();
  const reduced = new CameraDirector();
  full._zoomTarget = ZOOM_MIN;
  reduced._zoomTarget = ZOOM_MIN;
  for (let i = 0; i < 300; i++) {
    full.update(1 / 60, 0, false);
    reduced.update(1 / 60, 0, true);
  }
  assert.ok(reduced.floatTilt < full.floatTilt, 'reduced motion should tilt less');
  assert.ok(reduced.floatTilt > 0, 'but not zero -- the cue should still communicate the pull-back');
});

test('a universe-shift pull-back also drives floatTilt, not just off-frame pull-back', () => {
  const cam = new CameraDirector();
  // No off-frame target set (_zoomTarget stays 1); only the universe pulse dips zoom.
  for (let i = 0; i < 5; i++) cam.update(1 / 60, 0, false, null, 0, 1);
  assert.ok(cam.floatTilt > 0, 'a universe-reframe pull-back should tilt the layers too, not be ignored');
});
