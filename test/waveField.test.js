import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  G, pmSpectralDensity, peakOmega, omegaForK, kForOmega, phaseSpeed,
  buildWaveComponents, fieldVariance, waveFieldSample, windSpeedForSeaState, easeSeaState,
  shouldRebuildSpectrum, SPECTRUM_REBUILD_STEP,
} from '../src/world/WaveField.js';

test('deep-water dispersion: phase speed strictly decreases as wavenumber grows -- longer waves outrun shorter ones', () => {
  const ks = [0.02, 0.05, 0.1, 0.3, 0.8, 2.0];
  let prevSpeed = Infinity;
  for (const k of ks) {
    const speed = phaseSpeed(k);
    assert.ok(speed < prevSpeed, `phase speed must decrease as k grows: k=${k} speed=${speed} prev=${prevSpeed}`);
    prevSpeed = speed;
  }
});

test('omegaForK and kForOmega are inverses of the same dispersion relation', () => {
  for (const k of [0.01, 0.1, 1, 5]) {
    const omega = omegaForK(k);
    assert.ok(Math.abs(kForOmega(omega) - k) < 1e-9, `round-trip failed for k=${k}`);
  }
  // omega^2 = G*k, directly.
  assert.ok(Math.abs(omegaForK(1) ** 2 - G) < 1e-9);
});

test('peakOmega rises as wind speed falls -- calmer wind means a higher-frequency (shorter-wave) peak', () => {
  const calm = peakOmega(2);
  const stormy = peakOmega(12);
  assert.ok(calm > stormy, `calm peak (${calm}) should exceed stormy peak (${stormy})`);
});

test('pmSpectralDensity is zero or negative-safe outside valid inputs, and positive at the spectrum peak', () => {
  assert.equal(pmSpectralDensity(0, 5), 0);
  assert.equal(pmSpectralDensity(5, 0), 0);
  assert.equal(pmSpectralDensity(-1, 5), 0);
  const wind = 6;
  const atPeak = pmSpectralDensity(peakOmega(wind), wind);
  assert.ok(atPeak > 0, 'density at the spectral peak must be positive');
});

test('buildWaveComponents is deterministic per (seed, windSpeed, count)', () => {
  const a = buildWaveComponents(42, 6, 20);
  const b = buildWaveComponents(42, 6, 20);
  assert.deepEqual(a, b);
});

test('a different seed produces a different field (not degenerate)', () => {
  const a = buildWaveComponents(1, 6, 20);
  const b = buildWaveComponents(2, 6, 20);
  assert.notDeepEqual(a, b);
});

test('every built component is finite and has a positive wavenumber/frequency', () => {
  for (const wind of [0.5, 3, 8, 15]) {
    const comps = buildWaveComponents(7, wind, 24);
    assert.equal(comps.length, 24);
    for (const c of comps) {
      assert.ok(Number.isFinite(c.k) && c.k > 0, `k must be finite and positive, got ${c.k}`);
      assert.ok(Number.isFinite(c.omega) && c.omega > 0, `omega must be finite and positive, got ${c.omega}`);
      assert.ok(Number.isFinite(c.amp) && c.amp >= 0, `amp must be finite and non-negative, got ${c.amp}`);
      assert.ok(c.dir === 1 || c.dir === -1);
    }
  }
});

test('total field variance grows with wind speed -- a stormier sea genuinely carries more energy', () => {
  const calmVar = fieldVariance(buildWaveComponents(3, 2, 32));
  const stormVar = fieldVariance(buildWaveComponents(3, 12, 32));
  assert.ok(stormVar > calmVar, `storm variance (${stormVar}) should exceed calm variance (${calmVar})`);
});

test('waveFieldSample returns finite, bounded displacement across a wide sweep of x and t', () => {
  const comps = buildWaveComponents(9, 8, 24);
  for (let i = 0; i <= 40; i++) {
    const x = i * 137.3;
    const t = i * 3.1;
    const { dx, dy } = waveFieldSample(comps, x, t);
    assert.ok(Number.isFinite(dx) && Number.isFinite(dy), `non-finite at x=${x} t=${t}`);
    // Generous bound: sum of amplitudes is the true ceiling for dy; dx is
    // capped by the steepness limit times the same, so this just guards
    // against a runaway, not a tuned exact bound.
    const ampSum = comps.reduce((s, c) => s + c.amp, 0);
    assert.ok(Math.abs(dy) <= ampSum + 1e-6, `dy exceeded the amplitude ceiling: ${dy} > ${ampSum}`);
    assert.ok(Math.abs(dx) <= ampSum + 1e-6, `dx exceeded the amplitude ceiling: ${dx} > ${ampSum}`);
  }
});

test('the field is deterministic in time -- same (components, x, t) always samples the same point', () => {
  const comps = buildWaveComponents(11, 7, 20);
  const a = waveFieldSample(comps, 500, 12.5);
  const b = waveFieldSample(comps, 500, 12.5);
  assert.deepEqual(a, b);
});

test('swell trains at different k pass through each other -- the field is a true superposition, not a max/blend', () => {
  // Two isolated single-component fields summed directly must equal the
  // field built from both components together, at every sample point --
  // proof there's no per-component gating or clamping hiding in
  // waveFieldSample beyond the shared steepness term (which itself only
  // depends on the full component list length, held equal here).
  const compA = [{ k: 0.05, omega: omegaForK(0.05), amp: 1.5, phase: 0.4, dir: 1 }];
  const compB = [{ k: 0.3, omega: omegaForK(0.3), amp: 0.8, phase: 1.1, dir: -1 }];
  const both = compA.concat(compB);
  for (const t of [0, 5, 17.3]) {
    const sA = waveFieldSample(compA, 300, t);
    const sB = waveFieldSample(compB, 300, t);
    const sBoth = waveFieldSample(both, 300, t);
    // Steepness q depends on components.length, which differs (1 vs 2), so
    // dx isn't linearly additive across different-length component lists --
    // only dy (the plain height sum) is exactly additive. That's the
    // physically meaningful "waves pass through each other" property.
    assert.ok(Math.abs(sBoth.dy - (sA.dy + sB.dy)) < 1e-9, `dy must superpose exactly at t=${t}`);
  }
});

test('windSpeedForSeaState is monotonic and clamps to a sane range', () => {
  assert.ok(windSpeedForSeaState(0) < windSpeedForSeaState(0.5));
  assert.ok(windSpeedForSeaState(0.5) < windSpeedForSeaState(1));
  assert.equal(windSpeedForSeaState(-5), windSpeedForSeaState(0)); // clamps below 0
  assert.equal(windSpeedForSeaState(5), windSpeedForSeaState(1)); // clamps above 1
});

test('easeSeaState never jumps instantly to the target -- a single frame moves only a small fraction of the way', () => {
  const next = easeSeaState(0, 1, 1 / 60, 10);
  assert.ok(next > 0 && next < 0.02, `expected a small step for a 1/60s frame over a 10s tau, got ${next}`);
});

test('easeSeaState converges to the target given enough time, and never overshoots', () => {
  let s = 0;
  for (let i = 0; i < 6000; i++) s = easeSeaState(s, 0.8, 1 / 60, 10); // 100s, 10 time constants
  assert.ok(Math.abs(s - 0.8) < 1e-3, `expected convergence to 0.8, got ${s}`);
  assert.ok(s <= 0.8 + 1e-9, 'must never overshoot the target');
});

test('easeSeaState responds to wind over roughly 10s, not instantaneously -- a drop cannot "make a wave" on one frame', () => {
  let s = 0;
  // After 1 second (1/10 of tau) it should have moved only a modest amount.
  for (let i = 0; i < 60; i++) s = easeSeaState(s, 1, 1 / 60, 10);
  assert.ok(s < 0.2, `expected < 0.2 sea-state rise after 1s of a 10s ease, got ${s}`);
});

// --- The spectrum has to actually follow the weather.
//
// The rebuild test used to compare the new sea state against the PREVIOUS
// FRAME's. easeSeaState has a ~10s time constant, so one frame at 60fps
// moves the sea state by at most dt/tau -- about 0.0017 -- and the step it
// was compared against is 0.01. The condition therefore never fired, at any
// tempo, for any song: the spectrum stayed at the sea state it was built
// with (0, dead calm) for the whole track, however loud the low end got.
// These tests drive the same loop BiomeManager runs.

/** The BiomeManager sea-weather loop, reduced to the two lines under test:
 *  ease the sea state each frame, rebuild when shouldRebuildSpectrum says
 *  so, and report what the spectrum ended up carrying. */
function runSeaWeather(target, seconds, { fps = 60, seed = 315 } = {}) {
  let seaState = 0;
  let spectrumSeaState = 0;
  let components = buildWaveComponents(seed, windSpeedForSeaState(0), 24);
  const initial = components;
  let rebuilds = 0;
  let maxFrameStep = 0;
  for (let frame = 0; frame < seconds * fps; frame++) {
    const next = easeSeaState(seaState, target, 1 / fps, 10);
    maxFrameStep = Math.max(maxFrameStep, Math.abs(next - seaState));
    if (shouldRebuildSpectrum(next, spectrumSeaState)) {
      components = buildWaveComponents(seed, windSpeedForSeaState(next), 24);
      spectrumSeaState = next;
      rebuilds++;
    }
    seaState = next;
  }
  return { seaState, spectrumSeaState, components, initial, rebuilds, maxFrameStep };
}

test('a single eased frame can never clear the rebuild step on its own -- the reason the previous-frame test never fired', () => {
  const step = easeSeaState(0, 1, 1 / 60, 10);
  assert.ok(
    step < SPECTRUM_REBUILD_STEP,
    `one frame moves the sea state ${step}, which must stay under the ${SPECTRUM_REBUILD_STEP} step `
    + 'or this test is not pinning the bug it was written for',
  );
  assert.equal(shouldRebuildSpectrum(step, 0), false, 'one frame of drift is not worth a rebuild');
});

test('the spectrum follows a rising sea instead of staying at the state it was built with', () => {
  const r = runSeaWeather(1, 60);
  assert.ok(r.seaState > 0.99, `the ease should have arrived: ${r.seaState}`);
  assert.ok(r.rebuilds > 0, 'the spectrum must be re-sampled at least once over a full calm-to-storm ramp');
  assert.notEqual(r.components, r.initial, 'the live spectrum must not still be the one built at sea state 0');
  assert.ok(
    Math.abs(r.spectrumSeaState - r.seaState) <= SPECTRUM_REBUILD_STEP,
    `the spectrum should trail the sea state by no more than one step: `
    + `sea ${r.spectrumSeaState} vs ${r.seaState}`,
  );
  assert.ok(
    fieldVariance(r.components) > fieldVariance(r.initial) * 100,
    'a storm spectrum carries far more energy than the dead-calm one it replaced',
  );
});

test('rebuilds stay bounded -- the sea keeps up without re-sampling every frame', () => {
  const r = runSeaWeather(1, 60);
  const frames = 60 * 60;
  // The ease moves at most maxFrameStep per frame, so clearing a
  // SPECTRUM_REBUILD_STEP gap takes several frames however fast the weather
  // turns. Anything near one-per-frame would mean the step had been tuned
  // away rather than the baseline fixed.
  assert.ok(r.rebuilds < frames / 10, `expected well under one rebuild per 10 frames, got ${r.rebuilds}`);
  assert.ok(r.maxFrameStep < SPECTRUM_REBUILD_STEP, 'the ease itself must stay gradual');
});

test('a settled sea stops rebuilding entirely', () => {
  const r = runSeaWeather(0.5, 120);
  const settled = runSeaWeather(0.5, 240);
  assert.equal(
    settled.rebuilds, r.rebuilds,
    'once the ease has converged the spectrum should be left alone, not re-sampled forever',
  );
});

test('a falling sea re-samples too -- the baseline is a distance, not a direction', () => {
  let seaState = 0.9, spectrumSeaState = 0.9, rebuilds = 0;
  for (let frame = 0; frame < 60 * 30; frame++) {
    const next = easeSeaState(seaState, 0, 1 / 60, 10);
    if (shouldRebuildSpectrum(next, spectrumSeaState)) { spectrumSeaState = next; rebuilds++; }
    seaState = next;
  }
  assert.ok(rebuilds > 0, 'a calming sea must re-sample as well as a rising one');
  assert.ok(Math.abs(spectrumSeaState - seaState) <= SPECTRUM_REBUILD_STEP);
});

// --- What the layer is actually worth on screen.
//
// Fixing the rebuild above makes the spectrum follow the weather, which is
// the behaviour the code always intended. It does NOT make the sea look
// different, and it is worth having that on the record with a number rather
// than in someone's head. BiomeManager draws this layer as
//     x += wave.dx * 0.6 * ampScale
//     y += wave.dy * 0.4 * ampScale
// onto contour rows sampled at 48 points across the canvas, where ampScale
// is at most 1 and usually well below it. At those gains the Pierson-
// Moskowitz amplitudes are sub-pixel at every sea state, so the "real
// spectral sea" contributes nothing a viewer can see, calm or storm.
//
// Two things stand between the layer and visibility, and raising the gain
// alone fixes neither:
//   - amplitude: a full storm moves a row about three quarters of a pixel,
//     against seaLineY's own 12.9px.
//   - spatial scale: the spectrum's peak wavelength at a full storm is
//     ~56px, and the rows are sampled every 40px. That is under two samples
//     per wavelength, so the peak component is already past Nyquist -- turn
//     the gain up as it stands and what appears is per-vertex jitter, not
//     swell.
// This test pins the measurement so that whoever retunes it has to come
// past this comment first.

const DRAW_DY_GAIN = 0.4; // BiomeManager's ocean contour pass
const DRAW_DX_GAIN = 0.6;
const ROW_SAMPLES = 48;
const ROW_WIDTH_PX = 1920;

/** Peak-to-trough vertical excursion (px) the layer actually contributes to
 *  a contour row at a given sea state, at ampScale = 1 (its maximum). */
function drawnRowExcursionPx(seaState) {
  const comps = buildWaveComponents(315, windSpeedForSeaState(seaState), 24);
  let lo = Infinity, hi = -Infinity, maxDx = 0;
  for (const t of [0, 7, 31, 97, 180, 300]) {
    for (let i = 0; i <= ROW_SAMPLES; i++) {
      const { dx, dy } = waveFieldSample(comps, (i / ROW_SAMPLES) * ROW_WIDTH_PX, t);
      lo = Math.min(lo, dy);
      hi = Math.max(hi, dy);
      maxDx = Math.max(maxDx, Math.abs(dx));
    }
  }
  return { y: (hi - lo) * DRAW_DY_GAIN, x: maxDx * DRAW_DX_GAIN };
}

test('MEASURED: the spectral layer moves a contour row less than a pixel at every sea state', () => {
  const calm = drawnRowExcursionPx(0);
  const storm = drawnRowExcursionPx(1);
  assert.ok(calm.y < 0.05, `dead calm contributes ${calm.y.toFixed(4)}px -- effectively nothing`);
  assert.ok(storm.y > calm.y * 10, 'a storm must at least carry far more than a dead calm');
  assert.ok(
    storm.y < 1,
    `a full storm moves a row ${storm.y.toFixed(4)}px. If this now exceeds a pixel the layer has been `
    + 'retuned -- read the comment above, and check the sampling rate before trusting the result.',
  );
  assert.ok(storm.x < 1, `horizontal Gerstner displacement is sub-pixel too: ${storm.x.toFixed(4)}px`);
});

test('MEASURED: the spectrum peak is past Nyquist for the row sampling it is drawn through', () => {
  const peakK = kForOmega(peakOmega(windSpeedForSeaState(1)));
  const peakWavelengthPx = (2 * Math.PI) / peakK;
  const sampleSpacingPx = ROW_WIDTH_PX / ROW_SAMPLES;
  assert.ok(
    peakWavelengthPx < 2 * sampleSpacingPx,
    `the peak wavelength at a full storm is ${peakWavelengthPx.toFixed(1)}px against a `
    + `${sampleSpacingPx}px sample spacing. This assertion records that the layer is ALIASED as drawn; `
    + 'if it starts failing, the sampling or the spectrum band has been fixed and the gain can be '
    + 'raised without turning swell into per-vertex jitter.',
  );
});
