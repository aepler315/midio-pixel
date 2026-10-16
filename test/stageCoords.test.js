import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientToStageCoords } from '../src/ui/StageCoords.js';

const STAGE_W = 1280, STAGE_H = 720;

test('clientToStageCoords is exact when the box already matches the 16:9 stage aspect', () => {
  const rect = { left: 0, top: 0, width: 1280, height: 720 };
  const p = clientToStageCoords(320, 180, rect, STAGE_W, STAGE_H);
  assert.ok(Math.abs(p.x - 320) < 1e-9);
  assert.ok(Math.abs(p.y - 180) < 1e-9);
});

test('pillarboxed box (wider than 16:9): a click at the true visible center maps to stage center', () => {
  // 2000x900 window: object-fit:contain pillarboxes 200px bars on each side.
  const rect = { left: 0, top: 0, width: 2000, height: 900 };
  const p = clientToStageCoords(1000, 450, rect, STAGE_W, STAGE_H);
  assert.ok(Math.abs(p.x - STAGE_W / 2) < 1e-6, `expected stage-x 640, got ${p.x}`);
  assert.ok(Math.abs(p.y - STAGE_H / 2) < 1e-6, `expected stage-y 360, got ${p.y}`);
});

test('pillarboxed box: a click at the true visible quarter-point maps to the stage quarter-point, not further', () => {
  const rect = { left: 0, top: 0, width: 2000, height: 900 };
  // True content spans x in [200, 1800] (1600px wide); the point 1/4 of the
  // way across that content is at client-x = 200 + 0.25*1600 = 600.
  const p = clientToStageCoords(600, 450, rect, STAGE_W, STAGE_H);
  assert.ok(Math.abs(p.x - STAGE_W * 0.25) < 1e-6, `expected stage-x 320, got ${p.x}`);
});

test('pillarboxed box: the OLD naive (box-fraction) mapping would have been wrong -- this guards the regression', () => {
  const rect = { left: 0, top: 0, width: 2000, height: 900 };
  // The naive bug: ((clientX - left) / rect.width) * STAGE_W, ignoring bars.
  const naiveX = (600 / 2000) * STAGE_W; // = 384, NOT 320
  const p = clientToStageCoords(600, 450, rect, STAGE_W, STAGE_H);
  assert.ok(Math.abs(p.x - naiveX) > 30, 'the fix must diverge meaningfully from the old naive math');
});

test('pillarboxed box: a click inside the letterbox bar itself returns null (no stage content there)', () => {
  const rect = { left: 0, top: 0, width: 2000, height: 900 };
  const p = clientToStageCoords(50, 450, rect, STAGE_W, STAGE_H); // deep in the left bar
  assert.equal(p, null);
});

test('letterboxed box (taller than 16:9): bars on top/bottom, center still maps correctly', () => {
  // 900x1000 window is narrower-per-height than 16:9 -> letterboxed vertically.
  const rect = { left: 0, top: 0, width: 900, height: 1000 };
  const p = clientToStageCoords(450, 500, rect, STAGE_W, STAGE_H);
  assert.ok(Math.abs(p.x - STAGE_W / 2) < 1e-6);
  assert.ok(Math.abs(p.y - STAGE_H / 2) < 1e-6);
});

test('letterboxed box: a click in the top bar returns null', () => {
  const rect = { left: 0, top: 0, width: 900, height: 1000 };
  const p = clientToStageCoords(450, 10, rect, STAGE_W, STAGE_H);
  assert.equal(p, null);
});

test('an offset (non-zero left/top) box is handled correctly, not just a viewport-origin box', () => {
  const rect = { left: 137, top: 42, width: 2000, height: 900 };
  const p = clientToStageCoords(137 + 1000, 42 + 450, rect, STAGE_W, STAGE_H);
  assert.ok(Math.abs(p.x - STAGE_W / 2) < 1e-6);
  assert.ok(Math.abs(p.y - STAGE_H / 2) < 1e-6);
});

test('a zero-size box returns null defensively', () => {
  assert.equal(clientToStageCoords(10, 10, { left: 0, top: 0, width: 0, height: 0 }, STAGE_W, STAGE_H), null);
  assert.equal(clientToStageCoords(10, 10, null, STAGE_W, STAGE_H), null);
});
