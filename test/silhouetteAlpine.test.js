import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValueNoise1D } from '../src/utils/noise.js';
import { alpineHeightField, rollingHeightField } from '../src/world/SilhouetteGenerator.js';

test('alpineHeightField is deterministic and stays in 0..1', () => {
  const noise = new ValueNoise1D(42, 256);
  const n = 256, step = 8, width = n * step;
  const a = alpineHeightField(noise, n, step, 42, width);
  const b = alpineHeightField(noise, n, step, 42, width);
  assert.equal(a.length, n);
  for (let i = 0; i < n; i++) {
    assert.equal(a[i], b[i]);
    assert.ok(a[i] >= 0 && a[i] <= 1, `height out of range at ${i}: ${a[i]}`);
  }
});

// The ridge rewrite made three structural promises that the old
// "independent cones maxed against a noise floor" field did not keep. Each
// is pinned here because each was a visible defect in the rendered field,
// not a theoretical one.

test('the field wraps seamlessly -- the tile seam is not a permanent low point', () => {
  // Summit distance wraps around the tile now. Without that, a summit near
  // x=0 contributed nothing at x=width-1, so the seam was pinned low -- and
  // the seam is the one place guaranteed to keep scrolling past.
  const noise = new ValueNoise1D(21, 256);
  const n = 512, step = 4, width = n * step;
  const h = alpineHeightField(noise, n, step, 606, width, 'range');
  // Continuous across the join: last sample and first sample agree about as
  // closely as any other adjacent pair does.
  let maxStep = 0;
  for (let i = 1; i < n; i++) maxStep = Math.max(maxStep, Math.abs(h[i] - h[i - 1]));
  const seamStep = Math.abs(h[0] - h[n - 1]);
  assert.ok(seamStep <= maxStep * 1.5 + 1e-6, `seam discontinuity: ${seamStep} vs max interior step ${maxStep}`);
});

test('a range spans its whole tile -- no long dead-flat stretch', () => {
  // The old field fell to a bare noise floor wherever no summit landed,
  // which left ~40% of every tile as flat ground scrolling past on repeat.
  const noise = new ValueNoise1D(31, 256);
  const n = 512, step = 4, width = n * step;
  const h = alpineHeightField(noise, n, step, 707, width, 'range');
  let lo = 1, hi = 0;
  for (const v of h) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const midline = lo + (hi - lo) * 0.35;
  // Longest run of samples sitting below a low threshold -- i.e. dead flat.
  let run = 0, worst = 0;
  for (let i = 0; i < n; i++) {
    run = h[i] < midline ? run + 1 : 0;
    if (run > worst) worst = run;
  }
  assert.ok(worst < n * 0.30, `dead stretch covers ${(worst / n * 100).toFixed(0)}% of the tile`);
});

test('summits are not clipped into flat-topped mesas', () => {
  // base + summit used to overshoot 1 and get resolved by clamp01, which
  // sawed the tops off exactly the peaks that matter most.
  const noise = new ValueNoise1D(41, 256);
  const n = 512, step = 4, width = n * step;
  for (const character of ['massif', 'range', 'crags', 'spires', 'plateau']) {
    const h = alpineHeightField(noise, n, step, 808, width, character);
    let atCeiling = 0;
    for (const v of h) if (v >= 0.999) atCeiling++;
    assert.equal(atCeiling, 0, `${character}: ${atCeiling} samples clipped flat at 1.0`);
  }
});

test('alpine profiles are peakier than rolling foothills', () => {
  const noise = new ValueNoise1D(7, 256);
  const n = 400, step = 5, width = n * step;
  const alpine = alpineHeightField(noise, n, step, 99, width);
  const rolling = rollingHeightField(noise, n, step, 2);

  let aMax = 0, rMax = 0, aSum = 0, rSum = 0;
  for (let i = 0; i < n; i++) {
    aMax = Math.max(aMax, alpine[i]);
    rMax = Math.max(rMax, rolling[i]);
    aSum += alpine[i];
    rSum += rolling[i];
  }
  // Alpine massifs push higher summits.
  assert.ok(aMax > 0.75, `alpine max too low: ${aMax}`);
  // Peakiness: max / mean is higher for alpine (sharp summits, lower valleys).
  const aPeak = aMax / (aSum / n + 1e-6);
  const rPeak = rMax / (rSum / n + 1e-6);
  assert.ok(aPeak > rPeak * 0.95, `alpine should be at least as peaky: a=${aPeak} r=${rPeak}`);
});

test('alpine massif has a few distinct high summits (not a flat plateau)', () => {
  const noise = new ValueNoise1D(3, 256);
  const n = 512, step = 4, width = n * step;
  const h = alpineHeightField(noise, n, step, 1234, width);
  // Count local maxima above 0.55
  let peaks = 0;
  for (let i = 2; i < n - 2; i++) {
    if (h[i] > 0.55 && h[i] >= h[i - 1] && h[i] >= h[i + 1] && h[i] > h[i - 2] && h[i] > h[i + 2]) {
      peaks++;
    }
  }
  assert.ok(peaks >= 2 && peaks <= 40, `expected several summits, got ${peaks}`);
});

test('bake keeps the ridge below the strip top, and flat tops are caprock not clipping', async () => {
  // generateSilhouette needs a canvas; skip if neither OffscreenCanvas nor document.
  const { generateSilhouette } = await import('../src/world/SilhouetteGenerator.js');
  if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined') {
    // Node without canvas polyfill — still verify the field isn't a plateau:
    // fraction of samples within 2% of the max should be small (sharp apex).
    const noise = new ValueNoise1D(11, 256);
    const n = 400, step = 5;
    const h = alpineHeightField(noise, n, step, 55, n * step);
    let max = 0;
    for (let i = 0; i < n; i++) max = Math.max(max, h[i]);
    // Flat tops are now the POINT -- these are caprocks (ColoradoPlateau.js),
    // and a mesa is what the shape language is for. But a flat top produced
    // by CLIPPING is still a bug, and the two look identical one sample at a
    // time. What separates them: clipping pins every flat top to the same
    // ceiling, while caprocks sit at each formation's own height. So the
    // guard is no longer "few samples near the max" -- it is "the flat tops
    // are not all at one height".
    const flats = [];
    let run = 0;
    for (let i = 1; i < n; i++) {
      if (Math.abs(h[i] - h[i - 1]) < max * 0.002 && h[i] > max * 0.35) run++;
      else { if (run >= 3) flats.push(h[i - 1]); run = 0; }
    }
    if (flats.length >= 2) {
      const lo = Math.min(...flats), hi = Math.max(...flats);
      assert.ok(hi - lo > max * 0.03,
        `every flat top sits at the same height (${lo}..${hi} of ${max}) -- that is a clip, not caprock`);
    }
    // And nothing may exceed the field's own ceiling, which is the actual
    // clipping symptom the original test was reaching for.
    for (let i = 0; i < n; i++) {
      assert.ok(h[i] <= 1.0001, `sample ${i} above the field ceiling: ${h[i]}`);
    }
    return;
  }
  const strip = generateSilhouette({
    seed: 77, height: 320, amplitude: 0.7, baseline: 0.35,
    color: '#445566', shadeMode: 'classic', profile: 'alpine',
  });
  const r = strip.ridge;
  assert.ok(r, 'ridge metadata present');
  // Every sample must sit at least a few px below the strip top.
  for (let i = 0; i < r.heights.length; i++) {
    const y = r.height * r.baseline - r.heights[i] * r.height * r.amplitude;
    assert.ok(y >= 4, `ridge clipped at sample ${i}: y=${y}`);
  }
});
