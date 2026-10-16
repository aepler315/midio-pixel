import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { CanvasBuffers, resizeStageCanvas } from '../src/render/CanvasResidency.js';

test('post buffers reserve before allocation, release on resize/dispose, and skip denied effects', () => {
  const r = new GraphicsResidency({ budgetBytes: 1000 });
  let made = 0;
  const pool = new CanvasBuffers({ residency: r, makeCanvas: () => { made++; return { width: 0, height: 0 }; } });
  const heat = pool.ensure('heat', 10, 10);
  assert.equal(r.usedBytes, 400); assert.equal(made, 1);
  assert.equal(pool.ensure('heat', 10, 10), heat);
  assert.equal(pool.ensure('bloom', 20, 20), null);
  assert.equal(made, 1, 'denial allocates nothing');
  assert.equal(pool.ensure('heat', 5, 5).width, 5);
  assert.equal(heat.width, 0); assert.equal(r.usedBytes, 100);
  pool.dispose(); pool.dispose(); assert.equal(r.usedBytes, 0);
});

test('the stage is charged and cannot grow beyond available memory', () => {
  const r = new GraphicsResidency({ budgetBytes: 2000 }), stage = { width: 10, height: 10 };
  assert.equal(resizeStageCanvas(stage, 20, 20, r), true);
  assert.equal(r.usedBytes, 1600);
  r.reserve({ key: 'held', bytes: 300, evictable: false });
  assert.equal(resizeStageCanvas(stage, 30, 30, r), false);
  assert.deepEqual(stage, { width: 20, height: 20 });
  assert.equal(r.usedBytes, 1900);
  assert.equal(resizeStageCanvas(stage, 5, 5, r), true);
  assert.equal(r.usedBytes, 400);
});

test('shedding a post effect releases its pixels and frees room for scene assets', () => {
  const r = new GraphicsResidency({ budgetBytes: 1000 });
  const pool = new CanvasBuffers({ residency: r, makeCanvas: () => ({ width: 0, height: 0 }) });
  const heat = pool.ensure('heat', 10, 10);
  assert.equal(r.canFit(800), false);
  pool.release('heat');
  assert.equal(heat.width, 0); assert.equal(r.usedBytes, 0);
  assert.ok(r.reserve({ key: 'scene', bytes: 800 }));
});

test('multi-buffer effects reserve the complete group before allocating any canvas', () => {
  const r = new GraphicsResidency({ budgetBytes: 700 });
  let made = 0;
  const pool = new CanvasBuffers({ residency: r, makeCanvas: () => { made++; return { width: 0, height: 0 }; } });
  assert.equal(pool.ensure('bloom', 10, 10, 2), null);
  assert.equal(made, 0); assert.equal(r.usedBytes, 0);
  r.budgetBytes = 1000;
  const buffers = pool.ensure('bloom', 10, 10, 2);
  assert.equal(buffers.length, 2); assert.equal(r.usedBytes, 800);
  pool.release('bloom'); assert.equal(r.usedBytes, 0);
  assert.ok(buffers.every(c => c.width === 0));
});
