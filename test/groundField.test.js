import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GroundField, rippleOffsetAt, kickGlowAt, triangularBandIndex, calmGrooveParams } from '../src/world/GroundField.js';
import { Conductor } from '../src/core/Conductor.js';
import { makeNoteEvent, Role } from '../src/core/NoteEvent.js';

const BASE_Y = 480;
const STEP_S = 1000 / 120 / 1000;

function fakeEnergyCurves(value) {
  return { sample: () => value, globalEnergy: () => value };
}

// Band 1 is held distinct from every other band so tests can isolate a
// specific band's contribution to the EQ-bar height (the triangular ramp --
// see triangularBandIndex -- means which slice reads band 1 shifts with
// slice index, so this is only used where the test doesn't care which slice
// gets which band, just that bass vs. non-bass differ).
function fakeEnergyCurvesBanded(bassValue, otherValue) {
  return { sample: (band) => (band === 1 ? bassValue : otherValue), globalEnergy: () => otherValue };
}

test('no render-only shiver: with steady energy and no ripple/glow, render bar height stays essentially frame-to-frame constant', () => {
  // Regression for reported ground jitter: visibleBars used to add its own
  // 13Hz buzz the physics line (heightAt) never had, so the two visibly
  // diverged. With that removed, a steady input should settle to an almost
  // static bar height across consecutive frames -- any residual drift is
  // only the slow groove wave, not a fast shiver.
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  let t = 0;
  for (let i = 0; i < 600; i++) { gf.update(t, STEP_S, 0, fakeEnergyCurves(1)); t += 8.33; }

  const physicsBefore = gf.heightAt(100);
  let prevY = null;
  for (let i = 0; i < 30; i++) {
    gf.update(t, STEP_S, 0, fakeEnergyCurves(1));
    const bars = gf.visibleBars(0, 220, 1280);
    const y = bars[2].y;
    if (prevY != null) assert.ok(Math.abs(y - prevY) < 0.05, `frame-to-frame bar height jumped by ${Math.abs(y - prevY)}, expected no fast shiver`);
    prevY = y;
    // Physics reference must stay put (modulo spring settle residue).
    assert.ok(Math.abs(gf.heightAt(100) - physicsBefore) < 0.01);
    t += 8.33;
  }
});

test('the Unraveling: flatten visually settles the EQ bars toward baseGroundY, but never touches heightAt (physics)', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  let t = 0;
  // Let the springs settle under strong non-bass energy (bass=0 so the
  // buzz micro-vibration stays silent) so slices sit away from
  // baseGroundY purely from the EQ-offset before we test flattening.
  const energy = fakeEnergyCurvesBanded(0, 1);
  for (let i = 0; i < 600; i++) { gf.update(t, STEP_S, 0, energy); t += 8.33; }

  const physicsHeight = gf.heightAt(100);
  const barsBefore = gf.visibleBars(0, 220, 1280);
  assert.ok(barsBefore.some((b) => Math.abs(b.y - BASE_Y) > 1), 'slices should be visibly offset before flattening');

  gf.flatten = 1;
  const barsFlat = gf.visibleBars(0, 220, 1280);
  for (const b of barsFlat) assert.ok(Math.abs(b.y - BASE_Y) < 0.05, `expected slice ${b.x} to lie flat at baseGroundY, got y=${b.y}`);

  // Physics reference is untouched by flatten, at any value.
  assert.ok(Math.abs(gf.heightAt(100) - physicsHeight) < 1e-9);
});

test('flatten interpolates smoothly between the offset and flat bar heights', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  let t = 0;
  const energy = fakeEnergyCurvesBanded(0, 1);
  for (let i = 0; i < 600; i++) { gf.update(t, STEP_S, 0, energy); t += 8.33; }

  gf.flatten = 0;
  const yFull = gf.visibleBars(0, 220, 1280)[2].y;
  gf.flatten = 0.5;
  const yHalf = gf.visibleBars(0, 220, 1280)[2].y;
  gf.flatten = 1;
  const yFlat = gf.visibleBars(0, 220, 1280)[2].y;

  const offsetFull = Math.abs(yFull - BASE_Y);
  const offsetHalf = Math.abs(yHalf - BASE_Y);
  assert.ok(Math.abs(offsetHalf - offsetFull * 0.5) < 0.01, `expected the half-flattened offset to be half the full offset, got full=${offsetFull} half=${offsetHalf}`);
  assert.ok(Math.abs(yFlat - BASE_Y) < 0.05);
});

test('triangularBandIndex: neighboring slices always read spectrally adjacent bands', () => {
  // Regression for reported ground stair-stepping: slices used to read
  // (index + BAND_SHIFT) % 7, so neighbours could land on unrelated bands
  // and differ by up to the full RISE_AMPLITUDE_PX at every slice edge. The
  // triangular ramp guarantees a step of exactly 1 band between neighbours.
  for (let i = 0; i < 40; i++) {
    const a = triangularBandIndex(i);
    const b = triangularBandIndex(i + 1);
    assert.equal(Math.abs(a - b), 1, `slices ${i}/${i + 1} read bands ${a}/${b}, expected adjacent`);
    assert.ok(a >= 0 && a <= 6);
  }
});

function buildConductor(durationMs, kickPeriodMs = 500) {
  const timeline = [];
  for (let t = 0; t < durationMs; t += kickPeriodMs) {
    timeline.push(makeNoteEvent({ tMs: t, pitch: 36, vel: 0.8, role: Role.RHYTHM, kick: true, src: 'audio' }));
  }
  const conductor = new Conductor();
  conductor.load({ timeline, barGrid: [], durationMs });
  return conductor;
}

test('GroundField generates slices ahead of worldX and trims ones far behind', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  gf.update(0, STEP_S, 0, fakeEnergyCurves(0.5));
  const initialCount = gf.slices.length;
  assert.ok(initialCount > 5);

  // Scroll far forward -- old slices should get trimmed, new ones generated.
  for (let i = 0; i < 500; i++) gf.update(i * 8.33, STEP_S, i * 20, fakeEnergyCurves(0.5));
  assert.ok(gf.slices[0].worldXStart > 0, 'slices behind worldX should have been trimmed');
});

test('GroundField.heightAt settles toward the energy-driven target over time', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  let t = 0;
  for (let i = 0; i < 300; i++) { gf.update(t, STEP_S, 0, fakeEnergyCurves(1)); t += 8.33; }
  const y = gf.heightAt(0);
  // High energy should have lifted this slice noticeably above baseline.
  assert.ok(y < BASE_Y - 10, `expected the ground to rise with high energy, got ${y}`);
});

test('GroundField never schedules a gag for a very short song', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 5000, songSeed: 1 });
  assert.equal(gf._gagQueue.length, 0);
});

test('GroundField schedules 1-2 gags in the back half of a long song', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 120000, songSeed: 1 });
  assert.ok(gf._gagQueue.length >= 1 && gf._gagQueue.length <= 2);
  for (const tMs of gf._gagQueue) {
    assert.ok(tMs >= 120000 * 0.5 && tMs <= 120000 * 0.92);
  }
});

test('GroundField gag sinks a run of slices then recovers with justRecovered firing once', () => {
  const durationMs = 20000;
  const conductor = buildConductor(durationMs, 500);
  const gf = new GroundField(BASE_Y, { conductor, durationMs, songSeed: 3 });
  // Force a gag to fire immediately for a deterministic test.
  gf._gagQueue = [1000];

  let worldX = 0;
  let t = 0;
  const dtMs = 8.33;
  let sawSink = false;
  let recoverCount = 0;
  const minYSeen = { v: Infinity };

  while (t < durationMs) {
    conductor.dispatchUpTo(t);
    gf.update(t, dtMs / 1000, worldX, fakeEnergyCurves(0.3));
    worldX += 220 * (dtMs / 1000); // baseline scroll speed
    const y = gf.heightAt(worldX);
    minYSeen.v = Math.min(minYSeen.v, worldX); // just to keep worldX referenced
    if (gf.justRecovered) recoverCount++;
    t += dtMs;
    if (t > 1000 && t < 6000) {
      // Check whether any slice near current worldX is visibly sagging (y > baseline).
      if (y > BASE_Y + 20) sawSink = true;
    }
    if (recoverCount > 0 && t > 8000) break;
  }

  assert.ok(sawSink, 'expected the ground to visibly sag during the gag window');
  assert.ok(recoverCount >= 1, 'expected justRecovered to fire at least once');
});

test('pulseAt sinks the nearest slice by the given amount and recovers on schedule', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  let t = 0;
  gf.update(t, STEP_S, 0, fakeEnergyCurves(0));
  gf.pulseAt(t, 50, 40, t + 300); // sink 40px at worldX=50, recover at t+300ms

  let sawSink = false;
  while (t < 1500) {
    t += 8.33;
    gf.update(t, STEP_S, 0, fakeEnergyCurves(0));
    if (gf.heightAt(50) > BASE_Y + 15) sawSink = true;
  }
  assert.ok(sawSink, 'the pulsed slice should visibly sink toward the requested depth');
  // After recovering, it should settle back near baseline (no residual gag state).
  assert.ok(Math.abs(gf.heightAt(50) - BASE_Y) < 5, `expected settle near baseline, got ${gf.heightAt(50)}`);
});

test('pulseAt with a negative sag rises the slice (a mole-ridge bump)', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  let t = 0;
  gf.update(t, STEP_S, 0, fakeEnergyCurves(0));
  gf.pulseAt(t, 50, -7, t + 220);

  let minY = Infinity;
  while (t < 400) {
    t += 8.33;
    gf.update(t, STEP_S, 0, fakeEnergyCurves(0));
    minY = Math.min(minY, gf.heightAt(50));
  }
  assert.ok(minY < BASE_Y - 1, `expected the ground to rise for a negative pulse, min height ${minY}`);
});

test('pulseAt fires justRecovered once, like the scripted gag', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  let t = 0;
  gf.update(t, STEP_S, 0, fakeEnergyCurves(0));
  gf.pulseAt(t, 50, 30, t + 200);

  let recoverCount = 0;
  while (t < 1200) {
    t += 8.33;
    gf.update(t, STEP_S, 0, fakeEnergyCurves(0));
    if (gf.justRecovered) recoverCount++;
  }
  assert.equal(recoverCount, 1);
});

test('rippleOffsetAt has bounded support in time: 0 before the wavefront arrives, 0 long after it settles', () => {
  const ripple = { originWorldX: 1000, startMs: 0, strength: 1 };
  // Far away, early: the front hasn't traveled there yet.
  assert.equal(rippleOffsetAt(1000 + 5000, 10, ripple), 0);
  // Right at the origin, long after: fully decayed.
  assert.equal(rippleOffsetAt(1000, 5000, ripple), 0);
});

test('rippleOffsetAt is symmetric in distance from the origin (radial, direction-agnostic)', () => {
  const ripple = { originWorldX: 500, startMs: 0, strength: 0.8 };
  for (const [d, t] of [[50, 100], [120, 200], [200, 260]]) {
    const left = rippleOffsetAt(500 - d, t, ripple);
    const right = rippleOffsetAt(500 + d, t, ripple);
    assert.ok(Math.abs(left - right) < 1e-9, `d=${d} t=${t}: left=${left} right=${right}`);
  }
});

test('rippleOffsetAt magnitude never exceeds strength*RIPPLE_AMPLITUDE_PX (11px at strength=1)', () => {
  const ripple = { originWorldX: 0, startMs: 0, strength: 1 };
  let maxAbs = 0;
  for (let d = 0; d <= 400; d += 10) {
    for (let t = 0; t <= 700; t += 15) {
      maxAbs = Math.max(maxAbs, Math.abs(rippleOffsetAt(d, t, ripple)));
    }
  }
  assert.ok(maxAbs <= 11 + 1e-6, `expected bounded by 11px, got ${maxAbs}`);
});

test('impulse() ripples the render bars but heightAt (physics) stays bit-identical throughout its life', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  let t = 0;
  gf.update(t, STEP_S, 0, fakeEnergyCurves(0));
  const physicsBefore = gf.heightAt(100);
  gf.impulse(100, 1, t);

  let sawRippledBar = false;
  while (t < 600) {
    t += 8.33;
    gf.update(t, STEP_S, 0, fakeEnergyCurves(0));
    assert.ok(Math.abs(gf.heightAt(100) - physicsBefore) < 1e-9, 'a ripple must never move the physics reference');
    const bars = gf.visibleBars(0, 220, 1280);
    const near = bars.find((b) => Math.abs(b.x - (100 + 220)) < 45);
    if (near && Math.abs(near.y - BASE_Y) > 0.5) sawRippledBar = true;
  }
  assert.ok(sawRippledBar, 'expected a visible bob in the rendered bar near the impact');
});

test('impulse() fully settles back after RIPPLE_TOTAL_LIFE_MS -- no residual drift', () => {
  const gfA = new GroundField(BASE_Y, { durationMs: 0 });
  const gfB = new GroundField(BASE_Y, { durationMs: 0 });
  gfA.update(0, STEP_S, 0, fakeEnergyCurves(0));
  gfB.update(0, STEP_S, 0, fakeEnergyCurves(0));
  gfA.impulse(100, 1, 0); // only gfA gets the ripple

  let t = 0;
  while (t < 1500) {
    t += 8.33;
    gfA.update(t, STEP_S, 0, fakeEnergyCurves(0));
    gfB.update(t, STEP_S, 0, fakeEnergyCurves(0));
  }
  const barsA = gfA.visibleBars(0, 220, 1280);
  const barsB = gfB.visibleBars(0, 220, 1280);
  for (let i = 0; i < barsA.length; i++) {
    assert.ok(Math.abs(barsA[i].y - barsB[i].y) < 0.05, `bar ${i} did not settle back to the un-rippled baseline`);
  }
});

test('a fast combo of impulses never exceeds RIPPLE_MAX_ACTIVE tracked ripples', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  gf.update(0, STEP_S, 0, fakeEnergyCurves(0));
  for (let i = 0; i < 12; i++) gf.impulse(100 + i * 10, 1, i * 5);
  assert.ok(gf._ripples.length <= 4);
});

test('a worst-case pile-up of max-strength ripples stays under the softcap ceiling', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  gf.update(0, STEP_S, 0, fakeEnergyCurves(0));
  for (let i = 0; i < 4; i++) gf.impulse(100, 1, 0); // 4 simultaneous, in-phase, same point
  const bars = gf.visibleBars(0, 220, 1280);
  const near = bars.find((b) => Math.abs(b.x - (100 + 220)) < 45);
  assert.ok(Math.abs(near.y - BASE_Y) <= 21, `pile-up offset ${Math.abs(near.y - BASE_Y)} exceeded the softcap`);
});

test('impulse with zero or negative strength is a no-op', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  gf.update(0, STEP_S, 0, fakeEnergyCurves(0));
  gf.impulse(100, 0, 0);
  gf.impulse(100, -1, 0);
  assert.equal(gf._ripples.length, 0);
});

test('a second pulseAt on the same slice before the first resolves still recovers cleanly', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  let t = 0;
  gf.update(t, STEP_S, 0, fakeEnergyCurves(0));
  gf.pulseAt(t, 50, 40, t + 1000);
  t += 100;
  gf.update(t, STEP_S, 0, fakeEnergyCurves(0));
  gf.pulseAt(t, 50, -7, t + 220); // re-pulse before the first has recovered

  let ranWithoutThrowing = true;
  try {
    while (t < 2000) {
      t += 8.33;
      gf.update(t, STEP_S, 0, fakeEnergyCurves(0));
    }
  } catch {
    ranWithoutThrowing = false;
  }
  assert.ok(ranWithoutThrowing);
  assert.ok(Math.abs(gf.heightAt(50) - BASE_Y) < 5, 'should still settle back near baseline eventually');
});

test('kickGlowAt has bounded support in time: 0 before the wavefront arrives, 0 long after it settles', () => {
  const glow = { originWorldX: 1000, startMs: 0, strength: 1 };
  assert.equal(kickGlowAt(1000 + 5000, 10, glow), 0);
  assert.equal(kickGlowAt(1000, 5000, glow), 0);
});

test('kickGlowAt is symmetric in distance from the origin (radial, direction-agnostic)', () => {
  const glow = { originWorldX: 500, startMs: 0, strength: 0.8 };
  for (const [d, t] of [[50, 60], [120, 140], [200, 220]]) {
    const left = kickGlowAt(500 - d, t, glow);
    const right = kickGlowAt(500 + d, t, glow);
    assert.ok(Math.abs(left - right) < 1e-9, `d=${d} t=${t}: left=${left} right=${right}`);
  }
});

test('kickGlowAt peaks right as the front arrives and never exceeds strength', () => {
  const glow = { originWorldX: 0, startMs: 0, strength: 1 };
  let maxAbs = 0;
  for (let d = 0; d <= 300; d += 10) {
    for (let t = 0; t <= 500; t += 10) {
      maxAbs = Math.max(maxAbs, kickGlowAt(d, t, glow));
    }
  }
  assert.ok(maxAbs <= 1 + 1e-9, `expected bounded by strength=1, got ${maxAbs}`);
  assert.ok(maxAbs > 0.9, `expected the pulse to peak near 1 right at the front, got ${maxAbs}`);
});

test('kickGlow() lights render bars near the origin, but heightAt (physics) stays untouched', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  let t = 0;
  gf.update(t, STEP_S, 0, fakeEnergyCurves(0));
  const physicsBefore = gf.heightAt(100);
  gf.kickGlow(100, t, 1);

  let sawGlow = false;
  while (t < 400) {
    t += 8.33;
    gf.update(t, STEP_S, 0, fakeEnergyCurves(0));
    assert.equal(gf.heightAt(100), physicsBefore, 'a kick glow must never move the physics reference');
    const bars = gf.visibleBars(0, 220, 1280);
    const near = bars.find((b) => Math.abs(b.x - (100 + 220)) < 45);
    if (near && near.glow > 0.05) sawGlow = true;
  }
  assert.ok(sawGlow, 'expected a lit bar near the kick origin');
});

test('kickGlow() fully fades after its life -- glow returns to 0, no residual', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  gf.update(0, STEP_S, 0, fakeEnergyCurves(0));
  gf.kickGlow(100, 0, 1);

  let t = 0;
  while (t < 1000) {
    t += 8.33;
    gf.update(t, STEP_S, 0, fakeEnergyCurves(0));
  }
  const bars = gf.visibleBars(0, 220, 1280);
  for (const bar of bars) assert.equal(bar.glow, 0, `bar at x=${bar.x} should be fully dark after the glow's life`);
});

test('a fast combo of kicks never exceeds GLOW_MAX_ACTIVE tracked glow records', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  gf.update(0, STEP_S, 0, fakeEnergyCurves(0));
  for (let i = 0; i < 10; i++) gf.kickGlow(100 + i * 10, i * 5, 1);
  assert.ok(gf._glows.length <= 3);
});

test('kickGlow with zero or negative vel is a no-op', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  gf.update(0, STEP_S, 0, fakeEnergyCurves(0));
  gf.kickGlow(100, 0, 0);
  gf.kickGlow(100, 0, -1);
  assert.equal(gf._glows.length, 0);
});

test('activeGlowScreenLights is empty with no active glow', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  gf.update(0, STEP_S, 0, fakeEnergyCurves(0));
  assert.deepEqual(gf.activeGlowScreenLights(0, 220), []);
});

test('activeGlowScreenLights resolves an active glow to its screen-space position, matching visibleBars\' own worldX->screenX convention', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  gf.update(0, STEP_S, 0, fakeEnergyCurves(0));
  gf.kickGlow(100, 0, 1);
  gf.update(8, STEP_S, 0, fakeEnergyCurves(0));

  const [l] = gf.activeGlowScreenLights(0, 220);
  assert.ok(l, 'expected one active glow light');
  assert.equal(l.x, 100 - 0 + 220); // originWorldX - worldX + originX, same formula visibleBars uses
  assert.ok(l.intensity > 0 && l.intensity <= 1);
  assert.equal(l.y, gf.heightAt(100));
});

test('activeGlowScreenLights fades out and disappears once the glow\'s life ends, same lifetime as the bars\' own glow field', () => {
  const gf = new GroundField(BASE_Y, { durationMs: 0 });
  gf.update(0, STEP_S, 0, fakeEnergyCurves(0));
  gf.kickGlow(100, 0, 1);

  let t = 0;
  while (t < 1000) {
    t += 8.33;
    gf.update(t, STEP_S, 0, fakeEnergyCurves(0));
  }
  assert.deepEqual(gf.activeGlowScreenLights(0, 220), []);
});

// --- calmGrooveParams: the groove wave widens/slows with calm; heightAt()'s
// physics (baseTarget/spring) must stay completely untouched, same
// render/physics discipline as the buzz/ripple/glow effects above ---

test('calmGrooveParams: identity at calm=0, widens/slows monotonically toward calm=1', () => {
  const c0 = calmGrooveParams(0);
  assert.equal(c0.wavelengthMul, 1);
  assert.equal(c0.rateMul, 1);

  let prevWave = -Infinity, prevRate = Infinity;
  for (const c of [0, 0.25, 0.5, 0.75, 1]) {
    const p = calmGrooveParams(c);
    assert.ok(p.wavelengthMul >= prevWave - 1e-9, 'wavelength must not narrow as calm rises');
    assert.ok(p.rateMul <= prevRate + 1e-9, 'rate must not speed up as calm rises');
    prevWave = p.wavelengthMul; prevRate = p.rateMul;
  }
  assert.ok(calmGrooveParams(1).wavelengthMul > 1, 'full calm must genuinely broaden the swell');
  assert.ok(calmGrooveParams(1).rateMul < 1, 'full calm must genuinely slow the roll');
});

test('calmGrooveParams clamps out-of-range input the same as clamp01', () => {
  assert.deepEqual(calmGrooveParams(-1), calmGrooveParams(0));
  assert.deepEqual(calmGrooveParams(2), calmGrooveParams(1));
});

test('calmLevel passed to update() never changes heightAt() -- the physics reference stays exactly as tuned regardless of mood, only the render-only groove wave reacts', () => {
  const gfHot = new GroundField(BASE_Y, { durationMs: 0 });
  const gfCalm = new GroundField(BASE_Y, { durationMs: 0 });
  let t = 0;
  for (let i = 0; i < 400; i++) {
    gfHot.update(t, STEP_S, i * 5, fakeEnergyCurvesBanded(0.7, 0.5), 0);
    gfCalm.update(t, STEP_S, i * 5, fakeEnergyCurvesBanded(0.7, 0.5), 1);
    t += 8.33;
  }
  for (let x = 0; x < 2000; x += 137) {
    assert.equal(gfHot.heightAt(x), gfCalm.heightAt(x), `heightAt(${x}) diverged between calm=0 and calm=1`);
  }
});
