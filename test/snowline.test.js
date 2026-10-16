// Mountain overhaul Stage 4: a per-column snow cap riding the same h01
// (relative column height) Stage 2 already computes for the live crest --
// a summit whose own h01 clears the active section's snowLine01 threshold
// gets capped, one that doesn't stays bare. This pins _drawRidgeVolume's
// fill behavior directly: a snowLine01 of 1 (the default -- no variant,
// e.g. a non-alpine world or a profile with no section data) must draw NO
// cap at all, while a low threshold (a bright, energetic section) must
// draw one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LerpCache } from '../src/utils/color.js';

globalThis.Path2D = class Path2D {
  moveTo() {} lineTo() {} closePath() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} rect() {}
};

class RecordingCtx {
  constructor() {
    this.fillCalls = 0;
    this.fillStyles = [];
    this._fillStyle = null;
  }
  get fillStyle() { return this._fillStyle; }
  set fillStyle(v) { this._fillStyle = v; this.fillStyles.push(v); }
  set strokeStyle(v) {} set globalAlpha(v) {} set lineWidth(v) {} set lineJoin(v) {}
  set lineCap(v) {} set globalCompositeOperation(v) {}
  createLinearGradient() {
    const stops = [];
    return { stops, addColorStop: (offset, color) => stops.push({ offset, color }) };
  }
  createRadialGradient() { return this.createLinearGradient(); }
  beginPath() {} moveTo() {} lineTo() {} closePath() {} fill() { this.fillCalls++; } stroke() {}
  save() {} restore() {} clip() {} rect() {} arc() {} ellipse() {}
  quadraticCurveTo() {} bezierCurveTo() {} translate() {} rotate() {} scale() {}
  drawImage() {} fillRect() {} clearRect() {} strokeRect() {}
}

function makeStrip({ width = 2048, step = 4, height = 320 } = {}) {
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
  return { width, height, ridge: { heights, step, baseline: 0.70, amplitude: 0.34, height } };
}

async function makeManager() {
  const { BiomeManager } = await import('../src/world/BiomeManager.js');
  const bm = Object.create(BiomeManager.prototype);
  bm._crestCache = new Map();
  bm.tSec = 3;
  bm._danceKickMs = -Infinity;
  bm._danceKickAmp = 0;
  bm.orogenyGrowth = 0;
  bm.pullback01 = 0;
  bm._danceGroove = 0.4;
  bm._danceSustain = 0.3;
  bm._eqSmoothed = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
  bm._geoFeatures = [];
  bm._perf = null; // no perf gate -> phenomenaFull/heavyPostFx effectively on
  bm.groundY = 400;
  bm.h = 540;
  bm._airColor = '#204060';
  bm.lerpCache = new LerpCache();
  return bm;
}

function countFillsCalled(ctx, fn) {
  const before = ctx.fillCalls;
  fn();
  return ctx.fillCalls - before;
}

test('snowLine01=1 (default, no variant) draws no extra fill beyond the existing lit/shade/aerial passes', async () => {
  const bmA = await makeManager();
  const bmB = await makeManager();
  const stripA = makeStrip();
  const stripB = makeStrip();
  const canvas = { width: 960, height: 540 };
  const ctxA = new RecordingCtx();
  const ctxB = new RecordingCtx();
  // snowLine01 omitted (defaults to 1) vs explicitly 1 -- both must match.
  const callsDefault = countFillsCalled(ctxA, () => bmA._drawRidgeVolume(ctxA, canvas, stripA, 0, 40, 'L2', 1, 1, 1));
  const callsExplicit = countFillsCalled(ctxB, () => bmB._drawRidgeVolume(ctxB, canvas, stripB, 0, 40, 'L2', 1, 1, 1, 1));
  assert.equal(callsDefault, callsExplicit, 'snowLine01=1 must be a true no-op vs the default');
});

test('a low snowLine01 (bright, energetic section) draws at least one extra cap fill', async () => {
  const bm1 = await makeManager();
  const bm2 = await makeManager();
  const strip1 = makeStrip();
  const strip2 = makeStrip();
  const canvas = { width: 960, height: 540 };
  const ctxNoSnow = new RecordingCtx();
  const ctxSnow = new RecordingCtx();
  const callsNoSnow = countFillsCalled(ctxNoSnow, () => bm1._drawRidgeVolume(ctxNoSnow, canvas, strip1, 0, 40, 'L2', 1, 1, 1, 1));
  // SNOWLINE_MIN floor is 0.55 -- well below the tallest column's h01 (which
  // is exactly 1 by columnHeights01's own min-max normalization), so this
  // strip is guaranteed to have at least one column that clears it.
  const callsSnow = countFillsCalled(ctxSnow, () => bm2._drawRidgeVolume(ctxSnow, canvas, strip2, 0, 40, 'L2', 1, 1, 1, 0.55));
  assert.ok(callsSnow > callsNoSnow, `expected extra fill(s) for the capped range: ${callsNoSnow} -> ${callsSnow}`);
});

test('snow color is pulled toward this._airColor, never plain white, when airColor is set', async () => {
  const bm = await makeManager();
  const ctx = new RecordingCtx();
  const strip = makeStrip();
  const canvas = { width: 960, height: 540 };
  bm._drawRidgeVolume(ctx, canvas, strip, 0, 40, 'L2', 1, 1, 1, 0.55);
  assert.ok(!ctx.fillStyles.includes('#f5f9ff'), 'the raw, un-mixed snow white should never be used directly when an air color is set');
});

test('never throws with no strip.ridge, an extreme snowLine01, or perf gates off', async () => {
  const bm = await makeManager();
  bm._perf = { phenomenaFull: false, heavyPostFx: false };
  const ctx = new RecordingCtx();
  const strip = makeStrip();
  const canvas = { width: 960, height: 540 };
  assert.doesNotThrow(() => bm._drawRidgeVolume(ctx, canvas, strip, 0, 40, 'L2', 1, 1, 1, 0));
  assert.doesNotThrow(() => bm._drawRidgeVolume(ctx, canvas, { ...strip, ridge: null }, 0, 40, 'L2', 1, 1, 1, 0.5));
});
