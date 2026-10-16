// Ridge resolution.
//
// _drawDancingStrip blits the silhouette in vertical slices, each at its own
// offset and scale. The slice width IS the sampling resolution of the dance:
// neighbouring slices differ by the offset curve's slope times that width,
// and the difference lands as a hard vertical step in the skyline. At the old
// fixed 64px those steps terraced the mountains visibly -- the ridges looked
// low-resolution because they were.
//
// The width is now a quality setting. These pin the two things that has to
// keep true at any width: the live crest polyline still lands exactly where
// the blit paints, and a change of width is never served from a stale cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { danceOffsetSmooth, danceScaleSmooth } from '../src/world/GeoCrest.js';
import { danceOffset, DANCE_COL_W, DANCE_LAYERS } from '../src/world/MountainChoreo.js';
import { PerfGovernor, MAX_LEVEL } from '../src/render/PerfGovernor.js';

const cfg = DANCE_LAYERS.L2;

test('column boundaries are the ground truth, at every width', () => {
  // This is the contract that lets the crest stroke sit ON the blitted
  // silhouette instead of floating near it. It has to hold at EVERY width,
  // because the width varies with the perf level.
  for (const colW of [16, 32, 64, DANCE_COL_W]) {
    for (let b = 0; b < 900; b += colW) {
      const smooth = danceOffsetSmooth(b, 4.2, 0.5, 0.3, cfg, 0, colW);
      const truth = danceOffset(b, 4.2, 0.5, 0.3, cfg, 0);
      assert.ok(Math.abs(smooth - truth) < 1e-9,
        `colW=${colW} boundary=${b}: crest ${smooth} vs blit ${truth}`);
    }
  }
});

test('every slice width divides the strip evenly', () => {
  // A width that does not leaves a ragged narrow column at the end of every
  // tile, carrying its own offset -- a discontinuity reintroduced once per
  // tile, which is exactly what the shear exists to remove. 20px was tried
  // and did this (2048/20 = 102.4).
  const g = new PerfGovernor();
  for (let level = 0; level <= MAX_LEVEL; level++) {
    g.level = level;
    assert.equal(2048 % g.danceColumnWidth, 0,
      `level ${level} width ${g.danceColumnWidth} leaves a ragged column each tile`);
  }
});

test('the curve stays continuous across seams at every width', () => {
  for (const colW of [16, 20, 32, 64]) {
    let prev = danceOffsetSmooth(0, 3, 0.6, 0.4, cfg, 0, colW);
    for (let x = 0.5; x < 600; x += 0.5) {
      const v = danceOffsetSmooth(x, 3, 0.6, 0.4, cfg, 0, colW);
      assert.ok(Math.abs(v - prev) < 2, `colW=${colW} jumped ${Math.abs(v - prev)}px at x=${x}`);
      prev = v;
    }
  }
});

test('a narrower slice genuinely samples the dance more finely', () => {
  // The whole point: the staircase height is the offset curve's slope times
  // the slice width, so halving the width should roughly halve the worst
  // step between adjacent column centers.
  const worstStep = (colW) => {
    let worst = 0;
    for (let c = colW / 2; c < 4000; c += colW) {
      const a = danceOffset(c, 7.1, 0.8, 0.9, cfg, 0);
      const b = danceOffset(c + colW, 7.1, 0.8, 0.9, cfg, 0);
      worst = Math.max(worst, Math.abs(b - a));
    }
    return worst;
  };
  const coarse = worstStep(64);
  const fine = worstStep(20);
  assert.ok(fine < coarse * 0.6, `20px slices should step much less than 64px: ${fine} vs ${coarse}`);
});

test('the ladder only ever coarsens under load, never sharpens', () => {
  const g = new PerfGovernor();
  let prev = 0;
  for (let level = 0; level <= MAX_LEVEL; level++) {
    g.level = level;
    const w = g.danceColumnWidth;
    assert.ok(Number.isFinite(w) && w > 0, `level ${level} gave width ${w}`);
    assert.ok(w >= prev, `level ${level} got FINER (${w}) than level ${level - 1} (${prev})`);
    prev = w;
  }
});

test('a healthy machine renders finer than the old fixed width', () => {
  const g = new PerfGovernor();
  assert.ok(g.danceColumnWidth < DANCE_COL_W,
    'level 0 should be sharper than the old constant, or nothing was gained');
  g.level = MAX_LEVEL;
  assert.equal(g.danceColumnWidth, DANCE_COL_W,
    'the deepest rung should cost no more than the old behavior did');
});

test('scale smoothing takes the same width, and stays continuous', () => {
  // danceScaleSmooth must slice on the same grid as danceOffsetSmooth, or
  // the crest's per-column stretch and its per-column lift disagree.
  const ridge = { heights: new Float32Array(512).map((_, i) => Math.sin(i * 0.05)), step: 4, height: 320 };
  for (const colW of [20, 64]) {
    let prev = danceScaleSmooth(ridge, 0, 0.5, 0.5, cfg, colW);
    for (let x = 1; x < 400; x += 1) {
      const v = danceScaleSmooth(ridge, x, 0.5, 0.5, cfg, colW);
      assert.ok(Number.isFinite(v));
      assert.ok(Math.abs(v - prev) < 0.05, `colW=${colW} scale jumped at x=${x}`);
      prev = v;
    }
  }
});

test('the crest geometry actually reflects the width the blit will use', () => {
  // End-to-end on the real method: the threading is only worth anything if
  // _crestPoints and _drawDancingStrip resolve the same number. The cache key
  // carries the width too -- the cache is cleared per frame, so this cannot
  // go stale today, but keying it means a future caller that reuses it across
  // a shed cannot be served geometry for the wrong resolution.
  const makeStrip = () => {
    const n = 513;
    const heights = new Float32Array(n);
    for (let i = 0; i < n; i++) heights[i] = Math.sin(i * 0.05) * 0.5 + Math.sin(i * 0.13 + 1.7) * 0.3;
    return { width: 2048, height: 320, ridge: { heights, step: 4, baseline: 0.70, amplitude: 0.34, height: 320 } };
  };
  return import('../src/world/BiomeManager.js').then(({ BiomeManager }) => {
    const mk = (colW) => {
      const bm = Object.create(BiomeManager.prototype);
      bm._crestCache = new Map();
      bm.tSec = 3;
      bm._danceKickMs = 0;
      bm._danceKickAmp = 1;
      bm.orogenyGrowth = 0;
      bm.pullback01 = 0;
      bm._danceGroove = 0.7;
      bm._danceSustain = 0.5;
      bm._eqSmoothed = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
      bm._geoFeatures = [];
      bm.fever = 0;
      bm.groundY = 400;
      bm.h = 540;
      bm._perf = { danceColumnWidth: colW };
      return bm;
    };
    const canvas = { width: 960, height: 540 };
    const strip = makeStrip();
    const fine = mk(20)._crestPoints(canvas, strip, 100, 40, 'L2', 1, 1);
    const coarse = mk(64)._crestPoints(canvas, strip, 100, 40, 'L2', 1, 1);
    assert.ok(fine && coarse, 'both should produce geometry');
    assert.equal(fine.pts.length, coarse.pts.length, 'same sampling of the screen');
    const differs = fine.pts.some((p, i) => Math.abs(p.y - coarse.pts[i].y) > 0.01);
    assert.ok(differs, 'the crest ignored the slice width -- the threading is not connected');
  });
});
