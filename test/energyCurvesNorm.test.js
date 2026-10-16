import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves, FLAT_SPREAD_MIN } from '../src/audio/EnergyCurves.js';
import { FLAT_WEIGHTS, RABID_WEIGHTS } from '../src/audio/bands.js';

/** Fill every band with the same shaped curve, scaled by `gain`. */
function curvesFrom(shape, gain = 1, rateHz = 50) {
  const durationMs = (shape.length / rateHz) * 1000;
  const ec = new EnergyCurves(durationMs, rateHz);
  for (let i = 0; i < ec.n; i++) {
    const v = shape[Math.min(shape.length - 1, i)] * gain;
    ec.setFrame(i, new Array(7).fill(v));
  }
  return ec;
}

/** A quiet-then-loud song: half at 0.1, half at 0.6. */
function twoLevelShape(n = 400, lo = 0.1, hi = 0.6) {
  return Array.from({ length: n }, (_, i) => (i < n / 2 ? lo : hi));
}

test('calibration reports the song\'s own p10/p90, not absolute levels', () => {
  const ec = curvesFrom(twoLevelShape());
  const cal = ec.calibration(FLAT_WEIGHTS);
  // Half the song sits at 0.1 and half at 0.6, so p10 lands in the quiet
  // half and p90 in the loud one.
  assert.ok(Math.abs(cal.lo - 0.1) < 0.02, `p10 ${cal.lo}`);
  assert.ok(Math.abs(cal.hi - 0.6) < 0.02, `p90 ${cal.hi}`);
  assert.ok(cal.spread > 0.4);
});

test('the same musical shape normalizes identically whether the master is quiet or loud', () => {
  const shape = twoLevelShape();
  const quiet = curvesFrom(shape, 0.25);
  const loud = curvesFrom(shape, 1.0);

  // Sample in the quiet half and the loud half of each.
  for (const tMs of [2000, 6000]) {
    const q = quiet.globalEnergyNorm(tMs, FLAT_WEIGHTS);
    const l = loud.globalEnergyNorm(tMs, FLAT_WEIGHTS);
    assert.ok(Math.abs(q - l) < 0.02, `at ${tMs}ms: quiet=${q} loud=${l}`);
  }

  // ...and on the ABSOLUTE signal they are nothing alike -- which is exactly
  // the failure this normalization exists to fix.
  const rawQ = quiet.globalEnergy(6000, FLAT_WEIGHTS);
  const rawL = loud.globalEnergy(6000, FLAT_WEIGHTS);
  assert.ok(rawL - rawQ > 0.3, `raw signals should differ a lot: ${rawQ} vs ${rawL}`);
});

test('normalization spans the full range: the quiet part reads low and the loud part reads high', () => {
  const ec = curvesFrom(twoLevelShape(), 0.3); // a quiet master overall
  const quietPart = ec.globalEnergyNorm(2000, FLAT_WEIGHTS);
  const loudPart = ec.globalEnergyNorm(6000, FLAT_WEIGHTS);
  assert.ok(quietPart < 0.3, `quiet part should read low, got ${quietPart}`);
  assert.ok(loudPart > 0.7, `loud part should read high, got ${loudPart}`);
  // The old absolute signal never crossed CalmDirector's 0.55 CALM_HIGH here.
  assert.ok(ec.globalEnergy(6000, FLAT_WEIGHTS) < 0.55);
});

test('a flat/compressed song is NOT stretched into fake dynamics', () => {
  // Everything within a hair of 0.7 -- a brickwalled master. Normalizing
  // this to full scale would invent drops out of dither.
  const n = 400;
  const shape = Array.from({ length: n }, (_, i) => 0.7 + 0.005 * Math.sin(i / 7));
  const ec = curvesFrom(shape);
  const cal = ec.calibration(FLAT_WEIGHTS);
  assert.ok(cal.spread < FLAT_SPREAD_MIN, `spread ${cal.spread} should be below the flat floor`);

  let min = Infinity, max = -Infinity;
  for (let t = 0; t < 7000; t += 100) {
    const v = ec.globalEnergyNorm(t, FLAT_WEIGHTS);
    min = Math.min(min, v); max = Math.max(max, v);
  }
  // The output stays near the raw value instead of sweeping 0.15..0.85.
  assert.ok(max - min < 0.2, `flat song swung ${max - min}, should stay compressed`);
  assert.ok(Math.abs(max - 0.7) < 0.15, `flat song should sit near its raw level, got max ${max}`);
});

test('calibration is cached per weight vector, and setFrame invalidates it', () => {
  const ec = curvesFrom(twoLevelShape());
  const a = ec.calibration(FLAT_WEIGHTS);
  assert.equal(ec.calibration(FLAT_WEIGHTS), a, 'same weights should hand back the cached object');

  const rabid = ec.calibration(RABID_WEIGHTS);
  assert.notEqual(rabid, a, 'a different weight vector gets its own calibration');

  ec.setFrame(0, new Array(7).fill(0.9));
  assert.notEqual(ec.calibration(FLAT_WEIGHTS), a, 'writing a frame must invalidate the cache');
});

test('a silent song degrades to zero rather than dividing by its own nothing', () => {
  const ec = curvesFrom(new Array(200).fill(0));
  assert.equal(ec.calibration(FLAT_WEIGHTS).spread, 0);
  assert.equal(ec.globalEnergyNorm(1000, FLAT_WEIGHTS), 0);
});
