import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RainbowBrush } from '../src/render/RainbowBrush.js';

function fakeCtx2d() {
  const compositeOps = [];
  let fillRectCalls = 0;
  return {
    compositeOps,
    get fillRectCalls() { return fillRectCalls; },
    save() {}, restore() {},
    fillRect() { fillRectCalls++; },
    set globalCompositeOperation(v) { compositeOps.push(v); },
    set globalAlpha(v) {},
    set fillStyle(v) {},
  };
}

test('draw() composites the trail additively', () => {
  // Dabs stack additively during a dense flurry of jumps, melting into
  // soft light instead of an opaque patchwork.
  const brush = new RainbowBrush();
  brush.update(0, true, 100, 500);
  brush.update(16, true, 110, 495);

  const ctx = fakeCtx2d();
  brush.draw(ctx, 100, 300, 16, 1);
  assert.ok(ctx.compositeOps.includes('lighter'), 'draw uses additive compositing');
});

test('draw() culls dabs that have scrolled off-screen', () => {
  // Up to 320 dabs can be live at once; during a fast passage a dense
  // flurry's trail can scroll well outside the visible frame.
  const canvasWidth = 800;

  const near = new RainbowBrush();
  near.update(0, true, 400, 500);
  near.update(16, true, 410, 495);
  const nearCtx = fakeCtx2d();
  near.draw(nearCtx, 0, 0, 16, 1, canvasWidth); // worldX=0, originX=0 -- dabs land on-screen

  const far = new RainbowBrush();
  far.update(0, true, 50000, 500);
  far.update(16, true, 50010, 495);
  const farCtx = fakeCtx2d();
  far.draw(farCtx, 0, 0, 16, 1, canvasWidth);

  assert.ok(nearCtx.fillRectCalls > 0, 'on-screen dabs should draw');
  assert.equal(farCtx.fillRectCalls, 0, 'off-screen dabs should be culled');
});

test('draw() with no canvasWidth given draws everything regardless of scroll distance', () => {
  const brush = new RainbowBrush();
  brush.update(0, true, 50000, 500);
  brush.update(16, true, 50010, 495);
  const ctx = fakeCtx2d();
  brush.draw(ctx, 0, 0, 16, 1); // canvasWidth omitted -- defaults to Infinity
  assert.ok(ctx.fillRectCalls > 0);
});
