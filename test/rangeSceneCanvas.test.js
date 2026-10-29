// The Range scene's WebGL drawing buffer is shared by every render of a
// frame: partitions and the cast at the scene grid, water at output size,
// the rock stage at its own size. It used to be resized to each render's
// exact size -- two reallocations (and the GPU synchronisation they imply)
// every frame a lake was in view. It now only grows, renders land in its
// top-left region, and it shrinks once after a sustained period of slack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RangeScene, CANVAS_TRIM_FRAMES } from '../src/world/alpine/RangeScene.js';

function sceneDouble() {
  const calls = [];
  const renderer = {
    setSize(w, h) { calls.push(['size', w, h]); this.viewport = [0, 0, w, h]; },
    setViewport(...v) { this.viewport = v; },
    setScissor(...v) { this.scissor = v; },
    setScissorTest(on) { calls.push(['scissorTest', on]); },
    clear() { calls.push(['clear', this.scissor]); },
  };
  const scene = Object.create(RangeScene.prototype);
  Object.assign(scene, { renderer, canvas: { width: 0, height: 0 }, canvasSize: null });
  return { scene, renderer, calls };
}

test('alternating render sizes never reallocate the drawing buffer once it fits both', () => {
  const { scene, renderer, calls } = sceneDouble();
  for (let frame = 0; frame < 20; frame++) {
    scene._trimCanvas();
    scene._setCanvasSize(352, 212); // partitions
    scene._setCanvasSize(352, 212); // cast
    scene._setCanvasSize(1408, 848); // water at output size
  }
  assert.deepEqual(calls.filter(c => c[0] === 'size'), [['size', 352, 212], ['size', 1408, 848]]);
  // A small render lands in the top-left of the larger buffer: in GL's
  // bottom-left convention that is the buffer's top rows.
  scene._setCanvasSize(352, 212);
  assert.deepEqual(renderer.viewport, [0, 848 - 212, 352, 212]);
  assert.deepEqual(scene.canvasRegion, { x: 0, y: 0, width: 352, height: 212 });
  assert.deepEqual(scene.imageRect(scene.canvas), { x: 0, y: 0, width: 352, height: 212 });
  assert.deepEqual(scene.imageRect({ width: 8, height: 4 }), { x: 0, y: 0, width: 8, height: 4 }, 'other images are whole');
});

test('the region clear is scissored to the render, not the whole buffer', () => {
  const { scene, calls } = sceneDouble();
  scene._setCanvasSize(1408, 848);
  scene._setCanvasSize(352, 212);
  calls.length = 0;
  scene._clearCanvas();
  assert.deepEqual(calls, [['scissorTest', true], ['clear', [0, 848 - 212, 352, 212]], ['scissorTest', false]]);
});

test('a buffer left larger than every render shrinks once after sustained slack', () => {
  const { scene, calls } = sceneDouble();
  const frame = (sizes) => { scene._trimCanvas(); for (const [w, h] of sizes) scene._setCanvasSize(w, h); };
  frame([[352, 212], [1408, 848]]);
  // The output got smaller (a heavier quality rung): water now at 704x424.
  for (let i = 0; i < CANVAS_TRIM_FRAMES - 1; i++) frame([[352, 212], [704, 424]]);
  assert.equal(calls.filter(c => c[0] === 'size').length, 2, 'no shrink before the slack window');
  frame([[352, 212], [704, 424]]);
  frame([[352, 212], [704, 424]]);
  assert.deepEqual(calls.filter(c => c[0] === 'size').at(-1), ['size', 704, 424]);
  assert.deepEqual(scene.canvasSize, { width: 704, height: 424 });
  const reallocations = calls.filter(c => c[0] === 'size').length;
  for (let i = 0; i < 3 * CANVAS_TRIM_FRAMES; i++) frame([[352, 212], [704, 424]]);
  assert.equal(calls.filter(c => c[0] === 'size').length, reallocations, 'steady afterwards');
  // A single frame that needs the full size resets the slack count.
  for (let i = 0; i < CANVAS_TRIM_FRAMES - 1; i++) frame([[352, 212]]);
  frame([[352, 212], [704, 424]]);
  for (let i = 0; i < CANVAS_TRIM_FRAMES - 1; i++) frame([[352, 212]]);
  assert.deepEqual(scene.canvasSize, { width: 704, height: 424 });
});
