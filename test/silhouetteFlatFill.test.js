// Regression test for the hard-vertical-line-during-dance bug (see
// MountainChoreo.js:28-36 and SilhouetteGenerator.js:179-199 for the full
// diagnosis): shadeMode 'rendered' used to bake a 5-stop vertical gradient
// into the strip bitmap, which then got sliced into independently-offset
// dance columns -- each column showing a different vertical slice of that
// gradient, producing a hard shade step at every column boundary. The fix
// replaced the bake with a flat fill (screen-space shading now lives in
// BiomeManager._drawRidgeVolume instead). This test proves the body fill is
// really flat: a single solid color, not a gradient object, so there is no
// per-row color variation left for a column offset to expose as a seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
  }
  get fillStyle() { return this._fillStyle; }
  set fillStyle(v) { this._fillStyle = v; this.fillStyleLog.push(v); }
  createLinearGradient() { this._gradientsCreated = (this._gradientsCreated || 0) + 1; return { addColorStop() {} }; }
  createRadialGradient() { this._gradientsCreated = (this._gradientsCreated || 0) + 1; return { addColorStop() {} }; }
  beginPath() {}
  moveTo() {}
  lineTo() {}
  closePath() {}
  fill() {}
  stroke() {}
  save() {}
  restore() {}
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

const { generateSilhouette } = await import('../src/world/SilhouetteGenerator.js');

test('rendered shadeMode fills the body with a single flat color, not a baked gradient', () => {
  const strip = generateSilhouette({
    seed: 5, width: 512, height: 200, color: '#335577',
    shadeMode: 'rendered', profile: 'rolling',
  });
  const ctx = strip.getContext('2d');
  // No gradient object was ever built for the body fill (a couple of
  // specular strokes are allowed, but they are plain rgba strings, not
  // gradients).
  assert.equal(ctx._gradientsCreated ?? 0, 0, 'no gradient should be created for the flat-fill body');
  // The body fill (the very first fillStyle set, before the fill() call
  // that paints the mountain shape) must be a plain color string.
  assert.ok(ctx.fillStyleLog.length > 0, 'fillStyle was set at least once');
  const bodyFill = ctx.fillStyleLog[0];
  assert.equal(typeof bodyFill, 'string', 'body fill must be a flat color string, not a CanvasGradient');
});

test('the flat fill is deterministic per seed (same color every time -- no per-row variation to key off)', () => {
  const a = generateSilhouette({ seed: 9, width: 256, height: 160, color: '#446688', shadeMode: 'rendered' });
  const b = generateSilhouette({ seed: 9, width: 256, height: 160, color: '#446688', shadeMode: 'rendered' });
  const fillA = a.getContext('2d').fillStyleLog[0];
  const fillB = b.getContext('2d').fillStyleLog[0];
  assert.equal(fillA, fillB);
});

test('classic shadeMode is untouched -- still fills with the raw color, unaffected by the rendered-mode fix', () => {
  const strip = generateSilhouette({
    seed: 3, width: 256, height: 160, color: '#abcdef', shadeMode: 'classic',
  });
  const ctx = strip.getContext('2d');
  assert.equal(ctx.fillStyleLog[0], '#abcdef');
  assert.equal(ctx._gradientsCreated ?? 0, 0);
});
