import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager, travelSeam } from '../src/world/BiomeManager.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';

function alphaContext(sampleX) {
  const stack = [];
  const ctx = {
    alpha: 0, blits: 0, globalAlpha: 1, globalCompositeOperation: 'source-over',
    clipRect: null, nextRect: null,
    save() { stack.push([this.globalAlpha, this.globalCompositeOperation, this.clipRect]); },
    restore() { [this.globalAlpha, this.globalCompositeOperation, this.clipRect] = stack.pop(); },
    beginPath() { this.nextRect = null; },
    rect(x, y, width, height) { this.nextRect = { x, y, width, height }; },
    clip() { this.clipRect = this.nextRect; },
    clearRect() { this.alpha = 0; },
    setTransform() {},
    drawImage(surface) {
      if (this.clipRect && (sampleX < this.clipRect.x || sampleX >= this.clipRect.x + this.clipRect.width)) return;
      const source = surface.alpha ?? surface.getContext?.('2d')?.alpha ?? 0;
      const a = source * this.globalAlpha;
      this.alpha = this.globalCompositeOperation === 'lighter'
        ? Math.min(1, this.alpha + a)
        : a + this.alpha * (1 - a);
      this.blits++;
    },
  };
  return ctx;
}

test('travel midpoint retains opaque overlap after one side composite', () => {
  const canvas = { width: 1000, height: 600 };
  const x = travelSeam(canvas.width, 'L3', .5);
  const main = alphaContext(x);
  const mixCtx = alphaContext(x);
  const mix = { width: canvas.width, height: canvas.height, getContext: () => mixCtx };
  const manager = Object.create(BiomeManager.prototype);
  manager.residency = new GraphicsResidency({ budgetBytes: 10 * 1024 ** 2 });
  const prior = globalThis.document;
  globalThis.document = { createElement: () => mix };
  try { manager._compositeTravelSides(main, canvas, { alpha: 1 }, { alpha: 1 }, 'L3', .5); }
  finally { manager._canvasBuffers?.dispose(); globalThis.document = prior; }
  assert.equal(main.alpha, 1, 'opaque A/B overlap leaked background through travel seam');
  assert.equal(main.blits, 1, 'the premultiplied side result should reach the scene once');
});

test('travel feather interpolates transparent side edges in premultiplied space', () => {
  const canvas = { width: 1000, height: 600 };
  const x = travelSeam(canvas.width, 'L3', .5);
  const main = alphaContext(x);
  const mixCtx = alphaContext(x);
  const mix = { width: canvas.width, height: canvas.height, getContext: () => mixCtx };
  const manager = Object.create(BiomeManager.prototype);
  manager.residency = new GraphicsResidency({ budgetBytes: 10 * 1024 ** 2 });
  const prior = globalThis.document;
  globalThis.document = { createElement: () => mix };
  try { manager._compositeTravelSides(main, canvas, { alpha: .2 }, { alpha: .8 }, 'L3', .5); }
  finally { manager._canvasBuffers?.dispose(); globalThis.document = prior; }
  assert.ok(Math.abs(main.alpha - .575) < 1e-9, `edge alpha ${main.alpha}`);
  assert.equal(main.blits, 1);
});
