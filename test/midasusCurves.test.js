import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIDASUS_CURVES, MIDASUS_CURVE_NAMES, ratioForInterval, normalizeCurveEnv, HARMONOGRAPH_DECAY_MS,
} from '../src/sim/MidasusCurves.js';

test('ratioForInterval always returns two positive integers, for every interval and its octave-equivalents', () => {
  for (let semitones = -36; semitones <= 36; semitones++) {
    const [p, q] = ratioForInterval(semitones);
    assert.ok(Number.isInteger(p) && p > 0, `p must be a positive integer at ${semitones}`);
    assert.ok(Number.isInteger(q) && q > 0, `q must be a positive integer at ${semitones}`);
  }
  // Octave-equivalent intervals (mod 12) must map to the same ratio.
  assert.deepEqual(ratioForInterval(7), ratioForInterval(19));
  assert.deepEqual(ratioForInterval(-5), ratioForInterval(7));
});

test('normalizeCurveEnv fills in sane defaults from a bare/partial env', () => {
  const env = normalizeCurveEnv({});
  assert.equal(env.lastIntervalSemitones, 0);
  assert.equal(env.lastPitchClass, 0);
  assert.equal(env.lastVel, 0.5);
  assert.deepEqual(normalizeCurveEnv({ lastPitchClass: 13 }).lastPitchClass, 1); // wraps into 0..11
});

// The total-coverage sweep every family gets: for a wide spread of
// t/phi/rest-level/env combinations, point() must always return finite,
// boundedly-scaled coordinates -- never NaN/Infinity, and never blown up
// far past the figure's own nominal scale (a broken param, e.g. division
// by a near-zero denominator, would show up as a huge or non-finite value).
const ENV_SAMPLES = [
  { lastIntervalSemitones: 0, lastPitchClass: 0, lastVel: 0 },
  { lastIntervalSemitones: 7, lastPitchClass: 4, lastVel: 0.5 },
  { lastIntervalSemitones: -12, lastPitchClass: 11, lastVel: 1 },
  { lastIntervalSemitones: 37, lastPitchClass: -3, lastVel: 2 }, // out-of-range on purpose
];

for (const name of MIDASUS_CURVE_NAMES) {
  test(`${name}: every point is finite and stays within a sane bound across its whole parameter range`, () => {
    const curve = MIDASUS_CURVES[name];
    for (const rawEnv of ENV_SAMPLES) {
      const env = normalizeCurveEnv(rawEnv);
      const params = curve.params(env);
      for (const a of [0.4, 1, 1.6]) { // calmLevel 0..1 -> a in [1, 1.6]; also check below 1
        for (const r of [0.5, 1]) {
          for (let i = 0; i <= 20; i++) {
            const t = i * 0.37; // sweep well past one full cycle
            const phi = i * 0.91;
            const restU = i / 20;
            const p = curve.point(t, phi, a, r, params, restU);
            assert.ok(Number.isFinite(p.x), `${name} x not finite: t=${t} phi=${phi} a=${a} r=${r}`);
            assert.ok(Number.isFinite(p.y), `${name} y not finite: t=${t} phi=${phi} a=${a} r=${r}`);
            // Generous bound: the largest nominal coefficient across every
            // family is ~90px, times the largest `a` (up to 1.6) and a
            // healthy safety margin -- catches a runaway (e.g. NaN-adjacent
            // near-zero-denominator blowups), not tuned to any exact figure.
            assert.ok(Math.abs(p.x) < 400, `${name} x exploded: ${p.x}`);
            assert.ok(Math.abs(p.y) < 400, `${name} y exploded: ${p.y}`);
          }
        }
      }
    }
  });
}

test('harmonograph fully damps out by the end of its decay window, regardless of how hard the note hit', () => {
  const curve = MIDASUS_CURVES.harmonograph;
  for (const lastVel of [0, 0.5, 1]) {
    const params = curve.params(normalizeCurveEnv({ lastIntervalSemitones: 7, lastVel }));
    const early = curve.point(1, 0, 1, 1, params, 0);
    const late = curve.point(1, 0, 1, 1, params, 1);
    const earlyMag = Math.hypot(early.x, early.y);
    const lateMag = Math.hypot(late.x, late.y);
    assert.ok(lateMag < earlyMag, `vel=${lastVel}: figure should shrink toward the end of the rest, got early=${earlyMag} late=${lateMag}`);
  }
});

test('petal count is always odd and in a bounded range, however the pitch class lands', () => {
  const curve = MIDASUS_CURVES.petal;
  for (let pc = 0; pc < 12; pc++) {
    const params = curve.params(normalizeCurveEnv({ lastPitchClass: pc }));
    assert.ok(params.petals % 2 === 1, `petal count should be odd, got ${params.petals} for pc=${pc}`);
    assert.ok(params.petals >= 3 && params.petals <= 13, `petal count out of range: ${params.petals}`);
  }
});

test('HARMONOGRAPH_DECAY_MS is a sane positive duration', () => {
  assert.ok(HARMONOGRAPH_DECAY_MS > 500 && HARMONOGRAPH_DECAY_MS < 20000);
});
