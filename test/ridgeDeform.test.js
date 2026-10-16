// Mountain overhaul Stage 2 (ridge deformation): summits sharpen on the
// kick, flanks swell on sustained energy, foot-anchored so bases stay
// glued to the ground. Pins columnHeights01/columnHeight01At (which column
// is this range's own tallest), danceScale (the per-column vertical scale,
// >=1 always -- a column may only grow, never sink below its bake), and
// danceScaleSmooth (the live crest's smooth counterpart, matching
// danceOffsetSmooth's own cosine-blend-at-column-centers contract).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DANCE_LAYERS, DANCE_COL_W, columnHeights01, columnHeight01At, danceScale,
} from '../src/world/MountainChoreo.js';
import { danceScaleSmooth } from '../src/world/GeoCrest.js';

// Same synthetic-ridge fixture geoCrest.test.js uses (band-limited, so the
// continuity checks below test the interpolation, not raw noise jitter).
function makeRidge({ width = 2048, step = 4 } = {}) {
  const n = Math.floor(width / step) + 1;
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) heights[i] = Math.sin(i * 0.05) * 0.5 + Math.sin(i * 0.13 + 1.7) * 0.3;
  const blendCount = Math.max(1, Math.floor(n * 0.12));
  for (let i = 0; i < blendCount; i++) {
    const idx = n - blendCount + i;
    const t = i / blendCount;
    const tt = t * t * (3 - 2 * t);
    heights[idx] = heights[idx] * (1 - tt) + heights[0] * tt;
  }
  return { heights, step, baseline: 0.70, amplitude: 0.34, height: 320 };
}

test('columnHeights01 spans 0..1 and is memoized on the ridge object', () => {
  const ridge = makeRidge();
  const cols = columnHeights01(ridge);
  assert.ok(cols.length > 0);
  let lo = Infinity, hi = -Infinity;
  for (const v of cols) { assert.ok(v >= 0 && v <= 1); if (v < lo) lo = v; if (v > hi) hi = v; }
  assert.equal(lo, 0, 'the flattest column should read exactly 0');
  assert.equal(hi, 1, 'the tallest column should read exactly 1');
  assert.equal(columnHeights01(ridge), cols, 'a second call must return the SAME array (memoized)');
});

test('columnHeight01At matches columnHeights01 at column-aligned x and wraps for any real x', () => {
  const ridge = makeRidge();
  const cols = columnHeights01(ridge);
  for (let c = 0; c < cols.length; c++) {
    assert.equal(columnHeight01At(ridge, c * DANCE_COL_W), cols[c]);
  }
  // Wraps seamlessly past the ridge's own width, and for negative x.
  assert.equal(columnHeight01At(ridge, cols.length * DANCE_COL_W), cols[0]);
  assert.equal(columnHeight01At(ridge, -DANCE_COL_W), cols[cols.length - 1]);
});

test('danceScale never shrinks a column below its bake -- always >= 1', () => {
  const cfg = DANCE_LAYERS.L5; // largest gains of the four layers
  for (let h01 = 0; h01 <= 1; h01 += 0.1) {
    for (let transient = 0; transient <= 1; transient += 0.25) {
      for (let sustain = 0; sustain <= 1; sustain += 0.25) {
        const s = danceScale(h01, transient, sustain, cfg);
        assert.ok(s >= 1, `danceScale must never go below 1, got ${s}`);
        assert.ok(Number.isFinite(s));
      }
    }
  }
});

test('danceScale is bounded by the layer\'s own sharpen+swell gain (no runaway growth)', () => {
  for (const key of Object.keys(DANCE_LAYERS)) {
    const cfg = DANCE_LAYERS[key];
    const maxPossible = 1 + cfg.sharpen + cfg.swell;
    let worst = 0;
    for (let h01 = 0; h01 <= 1; h01 += 0.05) {
      for (let t = 0; t <= 1; t += 0.5) {
        for (let s = 0; s <= 1; s += 0.5) {
          worst = Math.max(worst, danceScale(h01, t, s, cfg));
        }
      }
    }
    assert.ok(worst <= maxPossible + 1e-9, `${key}: worst-case scale ${worst} exceeds gain budget ${maxPossible}`);
  }
});

test('danceScaleSmooth equals danceScale(columnHeight01At(...)) exactly at column centers', () => {
  const ridge = makeRidge();
  const cfg = DANCE_LAYERS.L4;
  for (let c = 0; c < 6; c++) {
    const center = c * DANCE_COL_W + DANCE_COL_W / 2;
    const smooth = danceScaleSmooth(ridge, center, 0.6, 0.3, cfg);
    const raw = danceScale(columnHeight01At(ridge, center), 0.6, 0.3, cfg);
    assert.ok(Math.abs(smooth - raw) < 1e-9, `mismatch at column ${c} center`);
  }
});

test('danceScaleSmooth is continuous across every column seam (no seam step)', () => {
  const ridge = makeRidge();
  const cfg = DANCE_LAYERS.L5; // largest gains -- worst case for a visible step
  let prev = danceScaleSmooth(ridge, 0, 1, 1, cfg);
  for (let x = 1; x < 4096; x += 3) {
    const v = danceScaleSmooth(ridge, x, 1, 1, cfg);
    // A scale-multiplier step of 0.05 across one screen pixel is already
    // imperceptible; this is a continuity guard, not a tight bound --
    // it exists to catch a seam (a genuine step reappearing), not to pin
    // the exact curve shape.
    assert.ok(Math.abs(v - prev) < 0.05, `seam discontinuity near x=${x}: ${prev} -> ${v}`);
    prev = v;
  }
});

test('danceScaleSmooth wraps seamlessly across the ridge edge, like ridgeYSmooth', () => {
  const ridge = makeRidge();
  const cfg = DANCE_LAYERS.L3;
  const width = ridge.heights.length * ridge.step;
  const near = danceScaleSmooth(ridge, width - 0.1, 0.5, 0.5, cfg);
  const wrapped = danceScaleSmooth(ridge, 0.1, 0.5, 0.5, cfg);
  assert.ok(Math.abs(near - wrapped) < 0.05, 'the wrap point must not show a seam either');
});

// Foot-anchoring: this mirrors BiomeManager._crestPoints' own algebra
// exactly (yRDeformed = dh - (dh - yR) * localScale) rather than reaching
// into a private method -- BiomeManager needs a canvas/DOM to construct,
// so the invariant is pinned here at the formula level, which is what
// actually guarantees "the foot never moves" regardless of scale.
function footAnchoredY(dh, yR, localScale) {
  const heightAboveFoot = dh - yR;
  return dh - heightAboveFoot * localScale;
}

test('foot-anchored deformation never moves the foot, at any scale', () => {
  const dh = 340;
  for (let scale = 1; scale <= 1.3; scale += 0.05) {
    // yR === dh means "at the very foot" (zero height above it).
    assert.equal(footAnchoredY(dh, dh, scale), dh, `foot moved at scale=${scale}`);
  }
});

test('foot-anchored deformation only ever raises the crest, never lowers it below its own bake', () => {
  const dh = 340;
  for (let yR = 0; yR <= dh; yR += 17) {
    for (let scale = 1; scale <= 1.3; scale += 0.05) {
      const deformed = footAnchoredY(dh, yR, scale);
      assert.ok(deformed <= yR + 1e-9, `a summit must rise (smaller screen y) or stay put, not sink: yR=${yR} scale=${scale} -> ${deformed}`);
    }
  }
});

test('overlay passes interpolate the section height multiplier, never switch it', () => {
  // Per-section heightMul crossfades between two values. The main layer pass
  // handles that by drawing BOTH sides and alpha-blending them, so its
  // geometry is continuous. The three overlay passes -- the distant wave, the
  // inter-range cast shadow, and the occlusion geometry -- draw a SINGLE
  // geometry, so they picked one side with `t > 0.5 ? heightMulB : heightMulA`.
  //
  // That steps the whole overlay the instant t crosses the midpoint. Measured
  // in the browser across a real song's section boundaries: up to 86px on L2
  // (mean crest displacement; peaks move further still), once per section.
  // That is a ridge visibly teleporting every ten seconds or so.
  //
  // Source-level because the failure lives in a canvas draw path -- but the
  // property is exact: no consumer of _drawHeightMul may choose a side.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src/world/BiomeManager.js'), 'utf8');
  assert.ok(!/heightMul\s*=\s*t\s*>\s*0\.5\s*\?/.test(src),
    'an overlay is switching heightMul at the crossfade midpoint instead of interpolating');
  const lerped = src.match(/const heightMul = lerp\(heightMulA, heightMulB, t\)/g) || [];
  assert.equal(lerped.length, 3,
    `expected all three overlay passes to interpolate, found ${lerped.length}`);
});
