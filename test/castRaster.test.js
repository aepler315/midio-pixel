// How the cast's lights land on the pixel grid (CastRaster.js): a light
// keeps its brightness wherever it falls between pixel centres, and a line
// is never a hairline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boxGauss, spot, spriteHalo, spriteExtent, ribbonCoverage, erf, CAST_RASTER_GLSL,
  SPRITE_MIN_SIGMA, THREAD_SIGMA, THREAD_HALF_PX, HALO,
} from '../src/world/alpine/CastRaster.js';

/** Total a sprite deposits on the grid with its centre at (ox, oy) px from
 *  a pixel centre, and its brightest pixel. */
function deposit(fn, ox, oy, extent) {
  let sum = 0, peak = 0;
  for (let y = -Math.ceil(extent) - 1; y <= Math.ceil(extent) + 1; y++) {
    for (let x = -Math.ceil(extent) - 1; x <= Math.ceil(extent) + 1; x++) {
      const v = fn(x - ox, y - oy);
      sum += v; peak = Math.max(peak, v);
    }
  }
  return { sum, peak };
}

test('erf matches its known values', () => {
  for (const [x, v] of [[0, 0], [0.5, 0.5204999], [1, 0.8427008], [2, 0.9953223], [-1, -0.8427008]]) assert.ok(Math.abs(erf(x) - v) < 2e-7, `${x}`);
});

test('a light deposits the same energy wherever it falls between pixel centres', () => {
  // The old single-sampled core of a fixed-line light (0.11 px) swung x9 in
  // energy with sub-pixel phase, and motes vanished; filtered, nothing moves.
  for (const sigma of [0.05, 0.11, 0.39, SPRITE_MIN_SIGMA, 1.5, 4]) {
    const expected = 2 * Math.PI * sigma * sigma;
    const extent = 0.5 + 3 * Math.max(sigma, SPRITE_MIN_SIGMA);
    let lo = Infinity, hi = -Infinity, peakHi = 0, peakLo = Infinity;
    for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
      const { sum, peak } = deposit((dx, dy) => spot(dx, dy, sigma), i / 10, j / 10, extent);
      lo = Math.min(lo, sum); hi = Math.max(hi, sum); peakHi = Math.max(peakHi, peak); peakLo = Math.min(peakLo, peak);
    }
    assert.ok(Math.abs(hi - expected) / expected < 2e-3 && Math.abs(lo - expected) / expected < 2e-3, `sigma ${sigma}: ${lo}..${hi} vs ${expected}`);
    assert.ok(peakHi <= 1 + 1e-6, 'never brighter than its design peak');
    // Spread over a few pixels, it glides instead of hopping between them.
    if (sigma <= SPRITE_MIN_SIGMA) assert.ok(peakLo / peakHi > 0.3, `sigma ${sigma}: peak ${peakLo}..${peakHi}`);
  }
});

test('a wide light keeps its designed profile at pixel centres', () => {
  const sigma = 4;
  for (const d of [0, 1, 3, 6]) assert.ok(Math.abs(spot(d, 0, sigma) - Math.exp(-d * d / (2 * sigma * sigma))) < 0.01, `${d}`);
});

test('a sprite halo keeps its energy and fits its quad at any size', () => {
  for (const R of [0.65, 1.47, 2.65, 8.8, 17.7]) {
    const extent = spriteExtent(R);
    assert.ok(extent >= R && extent >= 0.5 + 3 * Math.max(HALO.s2 * R, SPRITE_MIN_SIGMA) - 1e-9);
    const expected = 2 * Math.PI * R * R * (HALO.w1 * HALO.s1 ** 2 + HALO.w2 * HALO.s2 ** 2);
    for (const [ox, oy] of [[0, 0], [0.5, 0.5], [0.25, 0.8]]) {
      let sum = 0;
      for (let y = -Math.ceil(extent); y <= Math.ceil(extent); y++) for (let x = -Math.ceil(extent); x <= Math.ceil(extent); x++) {
        if (Math.abs(x - ox) <= extent && Math.abs(y - oy) <= extent) sum += spriteHalo(x - ox, y - oy, R);
      }
      assert.ok(Math.abs(sum - expected) / expected < 0.01, `R ${R} at ${ox},${oy}: ${sum} vs ${expected}`);
    }
  }
});

test('a thread is at least 1.5 px wide and as bright per unit length at any offset', () => {
  // Brightness summed across the line: one pixel's worth, wherever its
  // centre falls between pixel rows.
  for (let o = 0; o <= 1; o += 0.05) {
    let sum = 0;
    for (let x = -6; x <= 6; x++) sum += ribbonCoverage(x - o);
    assert.ok(Math.abs(sum - 1) < 1e-5, `offset ${o}: ${sum}`);
  }
  // Full width at half the peak, sampled finely.
  const peak = ribbonCoverage(0);
  let half = 0;
  while (ribbonCoverage(half) > peak / 2) half += 0.001;
  assert.ok(2 * half >= 1.5, `width ${2 * half}`);
  // The ribbon reaches far enough out that nothing visible is cut off.
  assert.ok(ribbonCoverage(THREAD_HALF_PX) < 0.01 * peak);
  assert.equal(THREAD_HALF_PX, 0.5 + 3 * THREAD_SIGMA);
  assert.ok(Math.abs(boxGauss(0.3, 2) - boxGauss(-0.3, 2)) < 1e-12, 'symmetric');
});

test('the shader twin uses the same filter and constants', () => {
  for (const k of ['0.3275911', '1.061405429', `max(sigma, ${SPRITE_MIN_SIGMA.toFixed(3)})`, `boxGauss(across, ${THREAD_SIGMA.toFixed(3)})`,
    `${HALO.w1.toFixed(3)} * spot(d, ${HALO.s1.toFixed(3)} * R)`, `${HALO.w2.toFixed(3)} * spot(d, ${HALO.s2.toFixed(3)} * R)`, '6.2831853 * sigma * sigma']) {
    assert.ok(CAST_RASTER_GLSL.includes(k), `GLSL lacks ${k}`);
  }
  const code = CAST_RASTER_GLSL.replace(/\/\/[^\n]*/g, '');
  for (const word of ['cast', 'sample', 'filter', 'flat', 'smooth', 'input', 'output']) assert.doesNotMatch(code, new RegExp(`\\b${word}\\b`));
});
