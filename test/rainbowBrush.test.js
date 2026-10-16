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

test('draw() falls back to source-over compositing under reducedFlash', () => {
  // Dabs stack additively during a dense flurry of jumps and can overlap
  // ImpactFX/RippleFX layers at the same landing point -- reducedFlash must
  // fall the whole trail back to normal compositing, not just cap alpha.
  const brush = new RainbowBrush();
  brush.update(0, true, 100, 500);
  brush.update(16, true, 110, 495);

  const normalCtx = fakeCtx2d();
  brush.draw(normalCtx, 100, 300, 16, 1, false);
  assert.ok(normalCtx.compositeOps.includes('lighter'), 'normal draw uses additive compositing');

  const reducedCtx = fakeCtx2d();
  brush.draw(reducedCtx, 100, 300, 16, 1, true);
  assert.ok(!reducedCtx.compositeOps.includes('lighter'), 'reducedFlash must not use additive compositing');
  assert.ok(reducedCtx.compositeOps.includes('source-over'), 'reducedFlash falls back to source-over');
});

test('draw() culls dabs that have scrolled off-screen', () => {
  // Up to 320 dabs can be live at once; during a fast passage a dense
  // flurry's trail can scroll well outside the visible frame.
  const canvasWidth = 800;

  const near = new RainbowBrush();
  near.update(0, true, 400, 500);
  near.update(16, true, 410, 495);
  const nearCtx = fakeCtx2d();
  near.draw(nearCtx, 0, 0, 16, 1, false, canvasWidth); // worldX=0, originX=0 -- dabs land on-screen

  const far = new RainbowBrush();
  far.update(0, true, 50000, 500);
  far.update(16, true, 50010, 495);
  const farCtx = fakeCtx2d();
  far.draw(farCtx, 0, 0, 16, 1, false, canvasWidth);

  assert.ok(nearCtx.fillRectCalls > 0, 'on-screen dabs should draw');
  assert.equal(farCtx.fillRectCalls, 0, 'off-screen dabs should be culled');
});

test('draw() with no canvasWidth given draws everything regardless of scroll distance', () => {
  const brush = new RainbowBrush();
  brush.update(0, true, 50000, 500);
  brush.update(16, true, 50010, 495);
  const ctx = fakeCtx2d();
  brush.draw(ctx, 0, 0, 16, 1, false); // canvasWidth omitted -- defaults to Infinity
  assert.ok(ctx.fillRectCalls > 0);
});
