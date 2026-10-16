// Range v2 Task 6: heard time -> rail progress is a pure adapter over the
// scanned skylines' finite travel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sceneProgressAt, SCENE_STRIP_WIDTH, SCENE_REFERENCE_WINDOW, SCENE_ROOM, SCENE_PREVIEW_PROGRESS } from '../src/world/terrain/SceneTravel.js';
import { terrainScrollPx } from '../src/world/terrain/ProfileTravel.js';

const curves = (fn) => ({ globalEnergyNorm: fn });
const pulse = curves((t) => 0.5 + 0.45 * Math.sin(t / 3000));
const legacy = (tMs, c, durationMs, reducedFlash = false, response = null) => terrainScrollPx({
  tSec: tMs / 1000, curves: c, durationMs, stripWidth: SCENE_STRIP_WIDTH, reducedFlash, response,
  depth: 1, fit: { viewWidth: SCENE_REFERENCE_WINDOW, maxDepth: 1 },
}) / SCENE_ROOM;

test('the canonical strip and room match the plan', () => {
  assert.equal(SCENE_STRIP_WIDTH, 8192);
  assert.equal(SCENE_REFERENCE_WINDOW, 1280);
  assert.equal(SCENE_ROOM, 6912);
});

test('progress equals the legacy fitted scroll over the room at known times', () => {
  for (const t of [0, 1000, 45000, 119000, 180000]) {
    const u = sceneProgressAt({ timeMs: t, curves: pulse, durationMs: 180000 });
    assert.equal(u, Math.min(1, Math.max(0, legacy(t, pulse, 180000))));
    assert.ok(u >= 0 && u <= 1);
  }
});

test('a silent song still travels, monotonically', () => {
  const silent = curves(() => 0);
  let prev = -1;
  for (let t = 0; t <= 200000; t += 10000) {
    const u = sceneProgressAt({ timeMs: t, curves: silent, durationMs: 200000 });
    assert.ok(u >= prev);
    prev = u;
  }
  assert.ok(prev > 0);
});

test('a long loud track is fitted to the rail and never leaves it', () => {
  const loud = curves(() => 0.4);
  const dur = 20 * 60000;
  assert.ok(sceneProgressAt({ timeMs: dur, curves: loud, durationMs: dur }) <= 1);
  assert.ok(sceneProgressAt({ timeMs: dur, curves: loud, durationMs: dur }) > 0.9, 'uses most of the rail');
  assert.equal(sceneProgressAt({ timeMs: dur * 2, curves: loud, durationMs: dur }), 1);
});

test('reduced flash follows the legacy halved travel', () => {
  const u = sceneProgressAt({ timeMs: 60000, curves: pulse, durationMs: 180000, reducedFlash: true });
  assert.equal(u, Math.min(1, Math.max(0, legacy(60000, pulse, 180000, true))));
  assert.ok(u < sceneProgressAt({ timeMs: 60000, curves: pulse, durationMs: 180000 }) + 1e-12);
});

test('seeking back and forth lands on the same progress (no accumulation)', () => {
  const at = (t) => sceneProgressAt({ timeMs: t, curves: pulse, durationMs: 180000 });
  const first = at(70000);
  at(170000); at(5000); at(120000);
  assert.equal(at(70000), first);
  // A replacement curve object for the same song gives the same answer.
  assert.equal(sceneProgressAt({ timeMs: 70000, curves: curves((t) => 0.5 + 0.45 * Math.sin(t / 3000)), durationMs: 180000 }), first);
});

test('unknown duration previews the rail midpoint', () => {
  assert.equal(sceneProgressAt({ timeMs: 5000, curves: pulse, durationMs: 0 }), SCENE_PREVIEW_PROGRESS);
  assert.equal(sceneProgressAt({ timeMs: 5000, curves: pulse, durationMs: NaN }), 0.5);
  assert.equal(sceneProgressAt({ timeMs: -50, curves: pulse, durationMs: 1000 }), sceneProgressAt({ timeMs: 0, curves: pulse, durationMs: 1000 }));
});

test('view depth to a box is never more than its distance, and smaller off axis', async () => {
  const { viewDepthToBox, distanceToBox } = await import('../src/world/terrain/SceneTravel.js');
  const pose = { eyeM: [0, 0, 0], targetM: [0, 0, -100] };
  const ahead = { min: [-5, -5, -1005], max: [5, 5, -995] };
  const side = { min: [995, -5, -1005], max: [1005, 5, -995] };
  assert.ok(Math.abs(viewDepthToBox(pose, ahead) - 995) < 1e-9);
  assert.ok(viewDepthToBox(pose, side) < distanceToBox(pose.eyeM, side) * 0.75);
  assert.ok(viewDepthToBox(pose, ahead) <= distanceToBox(pose.eyeM, ahead) + 1e-9);
});
