// Phase 1b of the frame cost plan: the high-resolution sky is drawn at most
// once per frame. The water backdrop takes the stage's area of the output
// sky layer; the composite blits the same layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PresentingRenderer } from '../src/render/PresentingRenderer.js';

class Canvas2D {
  constructor(width, height) { this.width = width; this.height = height; }
  getContext() { return { setTransform() {}, fillRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {} }; }
}

function renderer() {
  const r = Object.create(PresentingRenderer.prototype);
  Object.assign(r, { canvas: { width: 1280, height: 720 }, residency: null, _sky: null, _skyFrame: 1 });
  return r;
}
function manager(m = [2, 0, 0, 2, 0, 0]) {
  const calls = [];
  return { calls, rangeSkyLayer: { scenicTransform: m }, drawHighResolutionSky(ctx, canvas, { transform }) { calls.push(transform); return true; } };
}
const fit = { x: 0, y: 0, width: 1280, height: 720, scale: 2 };

function withCanvas(run) {
  const previous = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = Canvas2D;
  try { return run(); } finally { globalThis.OffscreenCanvas = previous; }
}

test('the sky layer is drawn once per frame and gives the stage area in output pixels', () => withCanvas(() => {
  const r = renderer(), m = manager();
  // A 320x180 stage at scenic scale 2 in a 640x360 grid, composited at 2x.
  const a = r._skyLayerFor(m, fit, { width: 320, height: 180 });
  const b = r._skyLayerFor(m, fit, { width: 320, height: 180 });
  assert.equal(m.calls.length, 1, 'drawn once for the frame');
  assert.deepEqual(m.calls[0], [4, 0, 0, 4, 0, 0], 'the composite sky transform: fit scale times the scenic transform');
  assert.deepEqual([a.sx, a.sy, a.sw, a.sh], [0, 0, 1280, 720]);
  assert.deepEqual([a.image.width, a.image.height], [1280, 720]);
  assert.equal(a.image, b.image);
  r._skyFrame++;
  r._skyLayerFor(m, fit, { width: 320, height: 180 });
  assert.equal(m.calls.length, 2, 'a new frame draws a new sky');
}));

test('an overscanned stage widens the layer by whole pixels; the composite transform moves with it', () => withCanvas(() => {
  // The shipped Detailed case: a 1408x848 stage at scenic scale 0.5, offset
  // -32, in a 640x360 grid composited at 2x into 1280x720.
  const r = renderer(), m = manager([0.5, 0, 0, 0.5, -32, -32]);
  const a = r._skyLayerFor(m, fit, { width: 1408, height: 848 });
  assert.deepEqual([a.image.width, a.image.height], [1408, 848]);
  assert.deepEqual([a.sx, a.sy, a.sw, a.sh], [0, 0, 1408, 848]);
  assert.deepEqual([r._sky.x, r._sky.y], [-64, -64]);
  assert.deepEqual(m.calls[0], [1, 0, 0, 1, 0, 0], 'the composite transform, shifted by the layer origin');
}));

test('a rotated transform or a fractional fit keeps the backdrop drawing its own sky', () => withCanvas(() => {
  const r = renderer();
  assert.equal(r._skyLayerFor(manager([2, 0.1, 0, 2, 0, 0]), fit, { width: 320, height: 180 }), null);
  assert.equal(r._skyLayerFor(manager(), { ...fit, x: 0.5 }, { width: 320, height: 180 }), null);
}));

test('a ledger that refuses the layer leaves no layer and no charge', () => withCanvas(() => {
  const r = renderer();
  r.residency = { reserve: () => null, entries: new Map() };
  assert.equal(r._skyLayerFor(manager(), fit, { width: 320, height: 180 }), null);
  assert.equal(r._sky, null);
}));
