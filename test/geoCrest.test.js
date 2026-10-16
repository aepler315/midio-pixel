import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ridgeYAt } from '../src/world/SilhouetteGenerator.js';
import { DANCE_LAYERS, danceOffset, DANCE_COL_W, FEVER_DANCE_GAIN } from '../src/world/MountainChoreo.js';
import {
  ridgeYSmooth, danceOffsetSmooth, assignBandFeatures, featureShape,
  geoCrestOffset, GEO_FEATURE_TYPES, GEO_MAX_LIFT_PX,
} from '../src/world/GeoCrest.js';

// A synthetic ridge (same shape SilhouetteGenerator.generateSilhouette bakes
// onto canvas.ridge) built without touching canvas -- generateSilhouette
// needs document/OffscreenCanvas, unavailable in plain node:test.
function makeRidge({ width = 2048, step = 4, baseline = 0.70, amplitude = 0.34, height = 320 } = {}) {
  const n = Math.floor(width / step) + 1;
  const heights = new Float32Array(n);
  // Coherent (band-limited) synthetic ridge -- real fbm noise is smooth
  // sample-to-sample; independent per-sample randomness would fail the
  // continuity checks below for reasons that have nothing to do with
  // ridgeYSmooth's own correctness.
  for (let i = 0; i < n; i++) heights[i] = Math.sin(i * 0.05) * 0.5 + Math.sin(i * 0.13 + 1.7) * 0.3;
  // Seamless wrap, same tail-blend SilhouetteGenerator applies.
  const blendCount = Math.max(1, Math.floor(n * 0.12));
  for (let i = 0; i < blendCount; i++) {
    const idx = n - blendCount + i;
    const t = i / blendCount;
    const tt = t * t * (3 - 2 * t);
    heights[idx] = heights[idx] * (1 - tt) + heights[0] * tt;
  }
  return { heights, step, baseline, amplitude, height };
}

const strip = { ridge: makeRidge() };

test('ridgeYSmooth matches ridgeYAt at exact sample points and stays continuous', () => {
  const { step } = strip.ridge;
  for (let i = 0; i < strip.ridge.heights.length; i++) {
    const x = i * step;
    assert.ok(Math.abs(ridgeYSmooth(strip.ridge, x) - ridgeYAt(strip, x)) < 1e-6, `mismatch at sample ${i}`);
  }
  let prev = ridgeYSmooth(strip.ridge, 0);
  for (let x = 0.1; x < 2048; x += 0.1) {
    const y = ridgeYSmooth(strip.ridge, x);
    assert.ok(Number.isFinite(y));
    assert.ok(Math.abs(y - prev) < 1, `discontinuity near x=${x}`);
    prev = y;
  }
});

test('ridgeYSmooth wraps seamlessly across the strip edge', () => {
  const yEnd = ridgeYSmooth(strip.ridge, 2047.9);
  const yStart = ridgeYSmooth(strip.ridge, 0.1);
  assert.ok(Math.abs(yEnd - yStart) < 2, 'wrap should be near-continuous (noise tail is head-blended)');
});

test('danceOffsetSmooth equals danceOffset at column boundaries', () => {
  // The ground truth moved from column CENTERS to column BOUNDARIES when the
  // blit started shearing each column between its two edges instead of
  // holding one sample flat across it. Under the old model the stroke was a
  // cosine ramp phase-shifted half a column from the blit's staircase, so it
  // matched the fill only where the two happened to cross -- the "ridges not
  // lining up with themselves" artifact. Boundaries are now the sample
  // points for both, which is why the next test can assert they agree
  // EVERYWHERE rather than only at sample points.
  const cfg = DANCE_LAYERS.L4;
  for (let col = 0; col <= 2048; col += DANCE_COL_W) {
    const exact = danceOffset(col, 1.7, 0.6, 0.3, cfg, 0.2);
    const smooth = danceOffsetSmooth(col, 1.7, 0.6, 0.3, cfg, 0.2);
    assert.ok(Math.abs(exact - smooth) < 1e-9, `column boundary ${col} mismatch`);
  }
});

test('and is exactly the straight line the shear paints between them', () => {
  // The blit shears each column linearly between its edge offsets, so the
  // crest polyline has to be that same straight line -- not near it.
  const cfg = DANCE_LAYERS.L4;
  for (const colW of [16, 32, 64]) {
    for (let b = 0; b < 600; b += colW) {
      const o0 = danceOffset(b, 2.4, 0.5, 0.4, cfg, 0);
      const o1 = danceOffset(b + colW, 2.4, 0.5, 0.4, cfg, 0);
      for (let f = 0; f <= 1.0001; f += 0.125) {
        const want = o0 + (o1 - o0) * f;
        const got = danceOffsetSmooth(b + f * colW, 2.4, 0.5, 0.4, cfg, 0, colW);
        assert.ok(Math.abs(want - got) < 1e-9,
          `colW=${colW} b=${b} f=${f}: ${got} is not on the line ${want}`);
      }
    }
  }
});

test('danceOffsetSmooth is continuous across every column seam and bounded', () => {
  const cfg = DANCE_LAYERS.L5;
  const bound = (cfg.waveAmp + cfg.bounceAmp) * (1 + FEVER_DANCE_GAIN) + 1e-6;
  let prev = danceOffsetSmooth(0, 3.1, 1, 1, cfg, 1);
  for (let x = 1; x < 2048; x += 1) {
    const v = danceOffsetSmooth(x, 3.1, 1, 1, cfg, 1);
    assert.ok(Number.isFinite(v));
    assert.ok(Math.abs(v) <= bound, `out of bounds at x=${x}: ${v}`);
    assert.ok(Math.abs(v - prev) < 2, `seam discontinuity near x=${x}`);
    prev = v;
  }
});

test('assignBandFeatures: 7 features, one per band, deterministic per seed', () => {
  const a = assignBandFeatures(123);
  const b = assignBandFeatures(123);
  const c = assignBandFeatures(456);
  assert.equal(a.length, 7);
  assert.deepEqual(new Set(a.map((f) => f.band)), new Set([0, 1, 2, 3, 4, 5, 6]));
  for (const f of a) {
    assert.ok(GEO_FEATURE_TYPES.includes(f.type));
    assert.ok(f.u0 >= 0 && f.u0 < 1);
    assert.ok(f.halfWidth > 0);
  }
  assert.deepEqual(a, b, 'same seed must reproduce identical geology');
  assert.notDeepEqual(a.map((f) => f.u0), c.map((f) => f.u0), 'different seeds should differ');
});

test('featureShape: bounded, finite, and archetype-shaped', () => {
  for (const type of GEO_FEATURE_TYPES) {
    let maxSlope = 0, prev = featureShape(type, -1, 0);
    for (let s = -1; s <= 1; s += 0.01) {
      const v = featureShape(type, s, 0);
      assert.ok(Number.isFinite(v) && v >= 0 && v <= 1 + 1e-9, `${type} out of [0,1] at s=${s}: ${v}`);
      maxSlope = Math.max(maxSlope, Math.abs(v - prev) / 0.01);
      prev = v;
    }
    if (type === 'cliff') assert.ok(maxSlope > 3, 'cliff should have a steep drop');
    if (type === 'knob') assert.ok(maxSlope < 3, 'knob should be gentle');
  }
  const arete = GEO_FEATURE_TYPES.includes('arete') ? 'arete' : null;
  if (arete) assert.ok(featureShape('arete', 0, 0) > featureShape('arete', 0.5, 0), 'arete peaks at center');
});

test('geoCrestOffset: silent bands lift nothing, one band lifts only its own window', () => {
  const features = assignBandFeatures(7);
  const silent = new Float32Array(7);
  for (let u = 0; u < 1; u += 0.05) assert.equal(geoCrestOffset(u, silent, features, 0), 0);

  const oneHot = new Float32Array(7);
  const target = features[0];
  oneHot[target.band] = 1;
  const atFeature = geoCrestOffset(target.u0, oneHot, features, 0);
  assert.ok(atFeature > 0, 'the assigned band should raise its own feature');

  const farU = ((target.u0 + 0.5) % 1);
  let farAny = false;
  for (const f of features) {
    if (f.band === target.band && Math.abs(((farU - f.u0 + 1.5) % 1) - 0.5) <= f.halfWidth) farAny = true;
  }
  if (!farAny) assert.equal(geoCrestOffset(farU, oneHot, features, 0), 0, 'far from any window of that band, lift is 0');
});

test('geoCrestOffset wraps continuously across u=0/1 and stays bounded', () => {
  const features = [{ band: 0, type: 'knob', u0: 0.0, halfWidth: 0.08 }];
  const full = [1, 0, 0, 0, 0, 0, 0];
  const left = geoCrestOffset(0.001, full, features, 0);
  const right = geoCrestOffset(0.999, full, features, 0);
  assert.ok(left > 0 && right > 0, 'a feature at u0=0 must contribute from both sides of the seam');
  assert.ok(Math.abs(left - geoCrestOffset(0.0, full, features, 0)) < 5);
  for (let u = 0; u < 1; u += 0.01) {
    const v = geoCrestOffset(u, full, features, 0);
    assert.ok(v >= 0 && v <= GEO_MAX_LIFT_PX * 1.01);
  }
});
