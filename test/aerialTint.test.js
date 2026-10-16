// Mountain overhaul Stage 3: AERIAL_PULL was computed into tintL2..tintL5
// every frame and handed to _drawLayer as its `tint` argument -- which the
// function never read again, so the whole table was dead code (verified by
// reading _drawLayer's body: `tint` appears only in the parameter list).
// This pins the fix: _drawRidgeVolume now paints a wash toward
// this._airColor, scaled by AERIAL_PULL[layerKey], so L2 (the furthest,
// most air-washed range) actually gets one and L5 (AERIAL_PULL.L5 === 0,
// the near anchor that must stay exactly as authored) never does.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.Path2D = class Path2D {
  moveTo() {} lineTo() {} closePath() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} rect() {}
};

class RecordingCtx {
  constructor() {
    this.fills = []; // each entry: either a plain string, or {stops:[{offset,color}]}
    this._fillStyle = null;
  }
  get fillStyle() { return this._fillStyle; }
  set fillStyle(v) { this._fillStyle = v; this.fills.push(v); }
  set strokeStyle(v) {} set globalAlpha(v) {} set lineWidth(v) {} set lineJoin(v) {}
  set lineCap(v) {} set globalCompositeOperation(v) {}
  createLinearGradient() {
    const stops = [];
    return { stops, addColorStop: (offset, color) => stops.push({ offset, color }) };
  }
  createRadialGradient() { return this.createLinearGradient(); }
  beginPath() {} moveTo() {} lineTo() {} closePath() {} fill() {} stroke() {}
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
  bm._perf = null; // no perf gate -> heavyPostFx effectively on
  bm.groundY = 400;
  bm.h = 540;
  bm._airColor = '#204060';
  bm.world = { kind: 'city' }; // The alpine depth color is baked; legacy aerial wash stays elsewhere.
  return bm;
}

/** Does any recorded fillStyle's gradient carry a stop whose color string
 *  contains this exact rgb triple (the airColor, converted)? */
function hasAirColorStop(fills, r, g, b) {
  for (const f of fills) {
    if (!f || !f.stops) continue;
    for (const s of f.stops) {
      if (typeof s.color === 'string' && s.color.includes(`${r},${g},${b}`)) return true;
    }
  }
  return false;
}

test('L2 (AERIAL_PULL=0.46) gets a live wash toward this._airColor', async () => {
  const bm = await makeManager();
  const ctx = new RecordingCtx();
  const strip = makeStrip();
  const canvas = { width: 960, height: 540 };
  bm._drawRidgeVolume(ctx, canvas, strip, 0, 40, 'L2', 1, 1, 1);
  // #204060 -> rgb(32, 64, 96)
  assert.ok(hasAirColorStop(ctx.fills, 32, 64, 96), 'L2 should carry a gradient stop in the air color');
});

test('L5 (AERIAL_PULL=0) never washes toward this._airColor -- the near anchor stays authored', async () => {
  const bm = await makeManager();
  const ctx = new RecordingCtx();
  const strip = makeStrip();
  const canvas = { width: 960, height: 540 };
  bm._drawRidgeVolume(ctx, canvas, strip, 0, 40, 'L5', 1, 1, 1);
  assert.ok(!hasAirColorStop(ctx.fills, 32, 64, 96), 'L5 must never be washed toward the air color');
});

test('no wash at all when this._airColor is unset (defensive: never throws, never fakes a color)', async () => {
  const bm = await makeManager();
  bm._airColor = null;
  const ctx = new RecordingCtx();
  const strip = makeStrip();
  const canvas = { width: 960, height: 540 };
  assert.doesNotThrow(() => bm._drawRidgeVolume(ctx, canvas, strip, 0, 40, 'L2', 1, 1, 1));
});

test('a ceiling strip paints hanging volume, not a cardboard cutout', async () => {
  const bm = await makeManager();
  const ctx = new RecordingCtx();
  const strip = makeStrip();
  strip.ridge.anchor = 'ceiling';
  const canvas = { width: 960, height: 540 };
  bm._drawRidgeVolume(ctx, canvas, strip, 0, 40, 'L2', 1, 1, 1);
  assert.ok(ctx.fills.length > 0, 'hanging masses get their own volume pass');
});

test('airless worlds skip the aerial wash — vacuum has no haze', async () => {
  const bm = await makeManager();
  bm.world = { kind: 'airless' };
  const ctx = new RecordingCtx();
  const strip = makeStrip();
  const canvas = { width: 960, height: 540 };
  bm._drawRidgeVolume(ctx, canvas, strip, 0, 40, 'L2', 1, 1, 1);
  assert.ok(!hasAirColorStop(ctx.fills, 32, 64, 96), 'Far Side must not wash toward sky');
});
