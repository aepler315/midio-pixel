import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  columnarHeightField, generateSilhouette, ridgeYAt, drawTiledStrip,
} from '../src/world/SilhouetteGenerator.js';

test('columnarHeightField is deterministic and stays in 0..1', () => {
  const n = 256, step = 8, width = n * step;
  const a = columnarHeightField(n, step, 42, width);
  const b = columnarHeightField(n, step, 42, width);
  assert.equal(a.length, n);
  for (let i = 0; i < n; i++) {
    assert.equal(a[i], b[i]);
    assert.ok(a[i] >= 0 && a[i] <= 1, `height out of range at ${i}: ${a[i]}`);
  }
});

test('columnar fields have shafts and bays, not a flat wall', () => {
  const n = 512, step = 4, width = n * step;
  const h = columnarHeightField(n, step, 99, width, null, {
    bayPx: 96, colFrac: 0.18, colH: 0.90, archAmp: 0.22,
  });
  let lo = 1, hi = 0;
  for (const v of h) { if (v < lo) lo = v; if (v > hi) hi = v; }
  assert.ok(hi - lo > 0.2, `columnar range too flat: ${lo.toFixed(3)}..${hi.toFixed(3)}`);
});

class RecordingCtx {
  constructor() {
    this.fillStyleLog = [];
    this._fillStyle = null;
    this.strokeStyle = null;
    this.globalAlpha = 1;
    this.lineWidth = 1;
    this.lineJoin = 'miter';
    this.lineCap = 'butt';
    this.globalCompositeOperation = 'source-over';
    this.draws = [];
  }
  get fillStyle() { return this._fillStyle; }
  set fillStyle(v) { this._fillStyle = v; this.fillStyleLog.push(v); }
  createLinearGradient() { return { addColorStop() {} }; }
  beginPath() {}
  moveTo() {}
  lineTo() {}
  closePath() {}
  fill() {}
  stroke() {}
  save() {}
  restore() {}
  scale() {}
  drawImage(img, x, y) { this.draws.push({ x, y, w: img.width, h: img.height }); }
}

globalThis.document = {
  createElement: () => {
    const ctx = new RecordingCtx();
    return {
      width: 0, height: 0,
      getContext: () => ctx,
    };
  },
};

test('a ceiling bake hangs from the top of the strip', () => {
  const strip = generateSilhouette({
    seed: 7, width: 512, height: 200, color: '#335577',
    shadeMode: 'rendered', profile: 'rolling', anchor: 'ceiling',
    amplitude: 0.3, baseline: 0.2,
  });
  assert.equal(strip.ridge.anchor, 'ceiling');
  const y = ridgeYAt(strip, 0);
  assert.ok(y >= 0 && y < strip.height * 0.7, `ceiling ridgeYAt should be near the top, got ${y}`);
});

test('a ground bake still stands on the baseline', () => {
  const strip = generateSilhouette({
    seed: 7, width: 512, height: 200, color: '#335577',
    shadeMode: 'rendered', profile: 'rolling', anchor: 'ground',
    amplitude: 0.3, baseline: 0.7,
  });
  assert.equal(strip.ridge.anchor, 'ground');
  const y = ridgeYAt(strip, 0);
  assert.ok(y > strip.height * 0.2, `ground ridgeYAt should sit in the lower half, got ${y}`);
});

test('drawTiledStrip places a ceiling strip at the top of the frame', () => {
  const strip = generateSilhouette({
    seed: 3, width: 256, height: 120, color: '#224433',
    shadeMode: 'classic', profile: 'columnar', anchor: 'ceiling',
  });
  const ctx = new RecordingCtx();
  drawTiledStrip(ctx, strip, 0, 800, 540, 12);
  assert.ok(ctx.draws.length > 0);
  assert.equal(ctx.draws[0].y, 12);
});

test('drawTiledStrip places a ground strip on the bottom of the frame', () => {
  const strip = generateSilhouette({
    seed: 3, width: 256, height: 120, color: '#224433',
    shadeMode: 'classic', profile: 'rolling', anchor: 'ground',
  });
  const ctx = new RecordingCtx();
  drawTiledStrip(ctx, strip, 0, 800, 540, 12);
  assert.ok(ctx.draws.length > 0);
  assert.equal(ctx.draws[0].y, 540 - 120 + 12);
});
