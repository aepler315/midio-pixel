import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Murmuration, calmNoiseParams } from '../src/world/Murmuration.js';
import { curl2 } from '../src/utils/fields.js';

test('wind assist nudges the flock without overriding its own steering: a strong sustained gust shifts the centroid downwind', () => {
  const calm = new Murmuration(800, 600, 3);
  const windy = new Murmuration(800, 600, 3);
  for (let i = 0; i < 180; i++) {
    calm.update(i * 16.6, 1 / 60, null, 0, null);
    windy.update(i * 16.6, 1 / 60, null, 0, { x: 500, y: 0 });
  }
  const cCalm = calm._centroid(), cWindy = windy._centroid();
  // Wrap-aware shortest delta -- same trick the class uses internally.
  const dx = ((cWindy.x - cCalm.x + 1200) % 800) - 400;
  assert.ok(dx > 0, `expected the windy flock's centroid to drift right of the calm one, got dx=${dx}`);
});

test('no wind argument is a pure no-op: identical seeds produce identical flocks with or without an explicit null', () => {
  const a = new Murmuration(800, 600, 11);
  const b = new Murmuration(800, 600, 11);
  for (let i = 0; i < 60; i++) {
    a.update(i * 16.6, 1 / 60, null, 0);
    b.update(i * 16.6, 1 / 60, null, 0, null);
  }
  for (let i = 0; i < a.boids.length; i++) {
    assert.equal(a.boids[i].x, b.boids[i].x);
    assert.equal(a.boids[i].y, b.boids[i].y);
  }
});

// --- calmNoiseParams: calm widens the wander field's correlation length,
// not just its speed cap (see Murmuration.js header comment) ---

test('calmNoiseParams: identity at calm=0, and monotonic toward a wider/slower/stronger field as calm rises', () => {
  const c0 = calmNoiseParams(0);
  assert.equal(c0.spatialScale, 1);
  assert.equal(c0.temporalScale, 1);
  assert.equal(c0.gainMul, 1);

  const samples = [0, 0.25, 0.5, 0.75, 1];
  let prevSpatial = Infinity, prevTemporal = Infinity, prevGain = -Infinity;
  for (const c of samples) {
    const p = calmNoiseParams(c);
    assert.ok(p.spatialScale <= prevSpatial + 1e-9, 'spatial scale must not increase with calm');
    assert.ok(p.temporalScale <= prevTemporal + 1e-9, 'temporal scale must not increase with calm');
    assert.ok(p.gainMul >= prevGain - 1e-9, 'gain must not decrease with calm');
    prevSpatial = p.spatialScale; prevTemporal = p.temporalScale; prevGain = p.gainMul;
  }
  assert.ok(calmNoiseParams(1).spatialScale < 1, 'full calm must genuinely widen the field, not just cap speed');
});

test('calmNoiseParams clamps out-of-range input the same as clamp01', () => {
  assert.deepEqual(calmNoiseParams(-1), calmNoiseParams(0));
  assert.deepEqual(calmNoiseParams(2), calmNoiseParams(1));
});

test('a lower spatial scale genuinely widens the noise field\'s correlation length: averaged over many sample pairs at a fixed separation, calm reads more alike than hot', () => {
  // A single point pair is too noisy to pin (local structure can go either
  // way -- verified empirically), but the correlation LENGTH is a real,
  // averaged property of the field: sampled at a lower spatial frequency,
  // pairs at the same fixed separation should agree more often on average.
  const { spatialScale: s0 } = calmNoiseParams(0);
  const { spatialScale: s1 } = calmNoiseParams(1);
  const dot = (a, b) => (a.x * b.x + a.y * b.y) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y) || 1);

  function avgCorrelation(scale, dist, n) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x1 = (i * 137) % 2000, y1 = (i * 91) % 1500;
      const ang = (i * 2.399) % (2 * Math.PI); // irrational-ish spread, avoids periodic aliasing
      const x2 = x1 + Math.cos(ang) * dist, y2 = y1 + Math.sin(ang) * dist;
      const tSec = 3 + i * 0.7;
      const a = curl2(x1 * 0.0028 * scale, y1 * 0.0028 * scale, tSec * 0.08);
      const b = curl2(x2 * 0.0028 * scale, y2 * 0.0028 * scale, tSec * 0.08);
      sum += dot(a, b);
    }
    return sum / n;
  }

  for (const dist of [80, 160, 250]) {
    const hot = avgCorrelation(s0, dist, 150);
    const calm = avgCorrelation(s1, dist, 150);
    assert.ok(calm > hot, `at ${dist}px separation, expected calm to correlate more on average: hot=${hot.toFixed(3)} calm=${calm.toFixed(3)}`);
  }
});
