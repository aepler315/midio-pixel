// Aerial perspective, optical half (softenScale): generateSilhouette bakes
// far layers at reduced pixel resolution then stretches the bitmap back up,
// letting the browser's own bilinear upscale soften silhouette edges --
// once at strip-build time, never per frame. The one invariant that matters
// most: the vector ridge data (heights/step/amplitude) that ridgeYAt,
// dance-column offsets, landmark placement, and the live-drawn ridge-volume
// shading all read must be COMPLETELY UNAFFECTED by softenScale, so those
// consumers stay exactly aligned to the true skyline regardless of how soft
// the baked pixels are.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** A minimal fake 2D context that records just enough to prove the bake
 *  path taken (drawImage calls, final canvas size) without needing a real
 *  canvas backend. */
class FakeCtx {
  constructor(owner) {
    this.owner = owner;
    this.drawImageCalls = [];
    this.fillStyle = null;
    this.strokeStyle = null;
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this.lineWidth = 1;
    this.lineJoin = 'miter';
    this.lineCap = 'butt';
    this._scaleX = 1;
    this._scaleY = 1;
  }
  scale(sx, sy) { this._scaleX = sx; this._scaleY = sy; }
  beginPath() {}
  moveTo() {}
  lineTo() {}
  closePath() {}
  fill() {}
  stroke() {}
  save() {}
  restore() {}
  createLinearGradient() { return { addColorStop() {} }; }
  createRadialGradient() { return { addColorStop() {} }; }
  drawImage(src, ...rest) { this.drawImageCalls.push({ src, rest }); }
}

globalThis.document = {
  createElement: () => {
    const canvas = { width: 0, height: 0 };
    canvas.getContext = () => (canvas._ctx || (canvas._ctx = new FakeCtx(canvas)));
    return canvas;
  },
};

const { generateSilhouette } = await import('../src/world/SilhouetteGenerator.js');

test('softenScale=1 (default) bakes directly -- no extra upscale canvas or drawImage call', () => {
  const strip = generateSilhouette({ seed: 1, width: 400, height: 150, color: '#335577' });
  assert.equal(strip.width, 400);
  assert.equal(strip.height, 150);
  assert.equal(strip.getContext('2d').drawImageCalls.length, 0,
    'no upscale drawImage should happen at softenScale=1');
});

test('softenScale<1 returns a canvas at the full requested size, reached via one upscale drawImage', () => {
  const strip = generateSilhouette({
    seed: 2, width: 400, height: 150, color: '#335577', softenScale: 0.4,
  });
  // The RETURNED canvas is always the full logical size -- every consumer
  // (drawTiledStrip, dance-column slicing, landmark placement) depends on
  // strip.width/height matching what was requested, softened or not.
  assert.equal(strip.width, 400);
  assert.equal(strip.height, 150);
  const ctx = strip.getContext('2d');
  assert.equal(ctx.drawImageCalls.length, 1, 'exactly one upscale blit');
  const call = ctx.drawImageCalls[0];
  // Stretched to the full logical size, not the reduced bake size.
  assert.deepEqual(call.rest, [0, 0, 400, 150]);
  // The blitted source is a DIFFERENT (smaller) canvas than the one returned.
  assert.notEqual(call.src, strip);
  assert.ok(call.src.width < 400 && call.src.height < 150,
    `bake source should be smaller than the final size, got ${call.src.width}x${call.src.height}`);
});

test('the vector ridge geometry is byte-identical regardless of softenScale', () => {
  const opts = { seed: 7, width: 600, height: 220, color: '#446688', profile: 'alpine', character: 'range' };
  const crisp = generateSilhouette({ ...opts, softenScale: 1 });
  const soft = generateSilhouette({ ...opts, softenScale: 0.35 });
  assert.equal(crisp.ridge.step, soft.ridge.step);
  assert.equal(crisp.ridge.baseline, soft.ridge.baseline);
  assert.equal(crisp.ridge.amplitude, soft.ridge.amplitude);
  assert.equal(crisp.ridge.height, soft.ridge.height);
  assert.equal(crisp.ridge.heights.length, soft.ridge.heights.length);
  for (let i = 0; i < crisp.ridge.heights.length; i++) {
    assert.equal(crisp.ridge.heights[i], soft.ridge.heights[i],
      `height sample ${i} diverged between softened and crisp bakes`);
  }
});

test('softenScale is clamped to a sane floor -- a pathological value never yields a zero-size bake', () => {
  assert.doesNotThrow(() => {
    const strip = generateSilhouette({ seed: 3, width: 200, height: 80, color: '#000', softenScale: 0.001 });
    assert.equal(strip.width, 200);
    assert.equal(strip.height, 80);
  });
});

test('softenScale > 1 is clamped down to full resolution, never upsampled past the bake', () => {
  const strip = generateSilhouette({ seed: 4, width: 300, height: 100, color: '#123456', softenScale: 3 });
  assert.equal(strip.getContext('2d').drawImageCalls.length, 0,
    'softenScale above 1 must behave exactly like 1 (no upscale pass)');
});
