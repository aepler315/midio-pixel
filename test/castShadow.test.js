// Mountain overhaul Stage 5: a near range darkens the already-drawn farther
// range in a band above the near range's own crest -- multiply-blended,
// clipped to the far body, strength tied to how low the active sun/moon
// currently sits (this._castShadowStrength, set once per frame in draw()).
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.Path2D = class Path2D {
  moveTo() {} lineTo() {} closePath() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} rect() {}
};

class RecordingCtx {
  constructor() {
    this.fillCalls = 0;
    this.compositeOps = [];
    this._fillStyle = null;
    this._globalCompositeOperation = 'source-over';
  }
  get fillStyle() { return this._fillStyle; }
  set fillStyle(v) { this._fillStyle = v; }
  get globalCompositeOperation() { return this._globalCompositeOperation; }
  set globalCompositeOperation(v) { this._globalCompositeOperation = v; this.compositeOps.push(v); }
  set strokeStyle(v) {} set globalAlpha(v) {} set lineWidth(v) {} set lineJoin(v) {}
  set lineCap(v) {}
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

function makeStrip({ width = 2048, step = 4, height = 320, phase = 0 } = {}) {
  const n = Math.floor(width / step) + 1;
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) heights[i] = Math.sin(i * 0.05 + phase) * 0.5 + Math.sin(i * 0.13 + 1.7 + phase) * 0.3;
  const blendCount = Math.max(1, Math.floor(n * 0.12));
  for (let i = 0; i < blendCount; i++) {
    const idx = n - blendCount + i;
    const t = i / blendCount;
    const tt = t * t * (3 - 2 * t);
    heights[idx] = heights[idx] * (1 - tt) + heights[0] * tt;
  }
  return { width, height, ridge: { heights, step, baseline: 0.70, amplitude: 0.34, height } };
}

async function makeManager({ strength = 0.18 } = {}) {
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
  bm._perf = null; // heavyPostFx effectively on
  bm.groundY = 400;
  bm.h = 540;
  bm._castShadowStrength = strength;
  bm._drawHeightMul = { from: 1, to: 1 };
  bm.strips = new Map([
    ['stock', {
      L2: makeStrip({ phase: 0 }), L3: makeStrip({ phase: 0.7 }),
      L4: makeStrip({ phase: 1.4 }), L5: makeStrip({ phase: 2.1 }),
    }],
  ]);
  bm.stripsFor = (key) => bm.strips.get(key);
  return bm;
}

const A = { name: 'stock', terrainEnergy: 1 };
const canvas = { width: 960, height: 540 };

test('a low, near-horizon light casts a visible shadow between two ranges', async () => {
  const bm = await makeManager({ strength: 0.18 });
  const ctx = new RecordingCtx();
  bm._drawCastShadow(ctx, canvas, 'L2', 'L3', 0, 0, A, A, 1);
  assert.ok(ctx.fillCalls > 0, 'expected a shadow fill');
  assert.ok(ctx.compositeOps.includes('multiply'), 'the shadow must be multiply-blended');
});

test('zero shadow strength (sun at zenith) draws nothing', async () => {
  const bm = await makeManager({ strength: 0 });
  const ctx = new RecordingCtx();
  bm._drawCastShadow(ctx, canvas, 'L2', 'L3', 0, 0, A, A, 1);
  assert.equal(ctx.fillCalls, 0, 'no shadow should be drawn at zero strength');
});

test('respects the heavyPostFx perf gate', async () => {
  const bm = await makeManager({ strength: 0.18 });
  bm._perf = { heavyPostFx: false };
  const ctx = new RecordingCtx();
  bm._drawCastShadow(ctx, canvas, 'L2', 'L3', 0, 0, A, A, 1);
  assert.equal(ctx.fillCalls, 0, 'must shed on the heavyPostFx-off rung');
});

test('never throws on a missing strip or profile', async () => {
  const bm = await makeManager({ strength: 0.18 });
  const ctx = new RecordingCtx();
  const missing = { name: 'nope', terrainEnergy: 1 };
  assert.doesNotThrow(() => bm._drawCastShadow(ctx, canvas, 'L2', 'L3', 0, 0, missing, missing, 1));
});
