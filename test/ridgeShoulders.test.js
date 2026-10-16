// Which summits earn shoulders. This is the guard between "the ranges have
// volume" and "the skyline is a hairball": on a noise ridge roughly every
// third sample is a local maximum, so the selection has to be driven by
// prominence and spacing, not by local-maximum-ness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager, shoulderFacetSide, FACET_SUN_FLIP } from '../src/world/BiomeManager.js';

// _ridgePeaks reads nothing off `this`, so a bare prototype call keeps this
// away from the constructor's canvas/audio dependencies (same trick as
// test/sectionDetection.test.js).
const peaksOf = (pts) => BiomeManager.prototype._ridgePeaks.call({}, pts);

/** Screen-space crest points from a list of y values, 8px apart (CREST_STEP_PX). */
function ridge(ys) {
  return ys.map((y, i) => ({ x: i * 8, y, stripX: i * 8 }));
}

/** A summit `h` tall over `half` samples each side, on a `base` skyline. */
function summit(base, h, half) {
  const out = [];
  for (let i = -half; i <= half; i++) {
    out.push(base - h * (1 - Math.abs(i) / half) ** 0.7);
  }
  return out;
}

test('a real summit is found, and its prominence is its height over the saddles', () => {
  const pts = ridge([...Array(6).fill(400), ...summit(400, 100, 8), ...Array(6).fill(400)]);
  const peaks = peaksOf(pts);
  assert.equal(peaks.length, 1, `expected one summit, got ${peaks.length}`);
  assert.ok(Math.abs(peaks[0].prominence - 100) < 1e-6, `prominence ${peaks[0].prominence}`);
  assert.ok(Math.abs(pts[peaks[0].i].y - 300) < 1e-6, 'should sit at the actual apex');
});

test('noise ripples never earn shoulders -- only prominence does', () => {
  // A wobbly but essentially flat skyline: lots of local maxima, none of
  // them a mountain. Spurring these is exactly how the ridge turns noisy.
  const ys = [];
  for (let i = 0; i < 60; i++) ys.push(400 - 6 * Math.sin(i * 1.1) - 4 * Math.sin(i * 2.7));
  const localMaxima = ys.filter((y, i) => i > 0 && i < ys.length - 1 && y < ys[i - 1] && y <= ys[i + 1]).length;
  assert.ok(localMaxima >= 5, `fixture should be bumpy, only ${localMaxima} local maxima`);
  assert.equal(peaksOf(ridge(ys)).length, 0, 'a ripple is not a summit');
});

test('two summits closer than the spacing floor yield only the more prominent', () => {
  // Both clear the prominence floor; their apexes sit ~80px apart, well
  // inside the ~190px spacing floor.
  const pts = ridge([
    ...Array(4).fill(400),
    ...summit(400, 120, 5),
    ...summit(400, 60, 5),
    ...Array(4).fill(400),
  ]);
  const peaks = peaksOf(pts);
  assert.equal(peaks.length, 1, `crowded summits should thin to one, got ${peaks.length}`);
  assert.ok(peaks[0].prominence > 100, 'and it should be the taller one that survives');
});

test('well-separated summits all survive, and the count is capped', () => {
  const ys = [...Array(4).fill(400)];
  for (let k = 0; k < 8; k++) {
    ys.push(...summit(400, 90 + k, 6), ...Array(24).fill(400)); // ~240px apart
  }
  const peaks = peaksOf(ridge(ys));
  assert.ok(peaks.length > 1, 'separated summits should not collapse to one');
  assert.ok(peaks.length <= 5, `capped per range, got ${peaks.length}`);
});

test('peaks come back tallest-first, so the cap keeps the mountains that matter', () => {
  const ys = [...Array(4).fill(400)];
  for (const h of [40, 130, 70]) ys.push(...summit(400, h, 6), ...Array(24).fill(400));
  const proms = peaksOf(ridge(ys)).map((p) => p.prominence);
  const sorted = [...proms].sort((a, b) => b - a);
  assert.deepEqual(proms, sorted, `expected descending prominence, got ${proms}`);
});

test('facet side flips when the light crosses the vertical of the summit', () => {
  const stripX = 0; // hash = 0, so the sun bias is never overturned
  assert.ok(Math.abs(Math.sin(stripX * 0.0137)) < FACET_SUN_FLIP);
  const left = shoulderFacetSide(stripX, 100, 200);  // light left of summit
  const right = shoulderFacetSide(stripX, 300, 200); // light right of summit
  assert.notEqual(left, right, 'crossing the summit must flip the shaded face');
  assert.equal(left, 1, 'light on the left shades the right face');
  assert.equal(right, -1, 'light on the right shades the left face');
});

test('per-summit variation still produces both facet values across a range of stripX', () => {
  const lightX = 800, summitX = 200; // sun always to the right
  const seen = new Set();
  for (let stripX = 0; stripX < 20000; stripX += 17) {
    seen.add(shoulderFacetSide(stripX, lightX, summitX));
    if (seen.size === 2) break;
  }
  assert.ok(seen.has(1) && seen.has(-1), `ridges must not go uniform, got ${[...seen]}`);
});

test('omitting the light falls back to the original stripX coin-flip', () => {
  for (const stripX of [0, 50, 120, 400, 1800]) {
    const expected = Math.sin(stripX * 0.0137) >= 0 ? 1 : -1;
    assert.equal(shoulderFacetSide(stripX), expected);
    assert.equal(shoulderFacetSide(stripX, null, 100), expected);
  }
});
