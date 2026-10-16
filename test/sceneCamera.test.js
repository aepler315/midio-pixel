// Range v2 Task 4: the constrained camera rail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraPoseAt, cameraRailErrors, cameraBasis, projectPoint, boxMayBeVisible } from '../src/world/terrain/SceneTravel.js';

const view = {
  id: 'rail',
  camera: { eyeStartM: [0, 1500, 0], eyeEndM: [2000, 1500, -1000], targetStartM: [0, 700, -20000], targetEndM: [2000, 700, -21000], fovYDeg: 35 },
};

test('endpoint and midpoint poses follow the authored rail', () => {
  assert.deepEqual(cameraPoseAt(view, 0), { eyeM: [0, 1500, 0], targetM: [0, 700, -20000], fovYDeg: 35 });
  assert.deepEqual(cameraPoseAt(view, 1), { eyeM: [2000, 1500, -1000], targetM: [2000, 700, -21000], fovYDeg: 35 });
  const mid = cameraPoseAt(view, 0.5);
  assert.deepEqual(mid.eyeM, [1000, 1500, -500]);
  assert.deepEqual(mid.targetM, [1000, 700, -20500]);
});

test('progress is clamped to the rail', () => {
  assert.deepEqual(cameraPoseAt(view, -3), cameraPoseAt(view, 0));
  assert.deepEqual(cameraPoseAt(view, 7), cameraPoseAt(view, 1));
  assert.deepEqual(cameraPoseAt(view, NaN), cameraPoseAt(view, 0));
});

test('the camera keeps world-up: its right vector is horizontal', () => {
  for (const u of [0, 0.3, 1]) {
    const { right, up, forward } = cameraBasis(cameraPoseAt(view, u));
    assert.ok(Math.abs(right[1]) < 1e-12, 'no roll');
    assert.ok(up[1] > 0, 'up points up');
    const dot = right[0] * forward[0] + right[1] * forward[1] + right[2] * forward[2];
    assert.ok(Math.abs(dot) < 1e-12);
  }
});

test('invalid rails are rejected, not rendered', () => {
  const bad = (camera, re) => {
    assert.match(cameraRailErrors(camera).join('\n'), re);
    assert.throws(() => cameraPoseAt({ id: 'x', camera }, 0), /invalid camera rail/);
  };
  bad({ ...view.camera, fovYDeg: 2 }, /fovYDeg/);
  bad({ ...view.camera, fovYDeg: 170 }, /fovYDeg/);
  bad({ ...view.camera, targetStartM: [0, 1500, 0] }, /coincide/);
  bad({ ...view.camera, targetEndM: [2000, -50000, -1000] }, /straight up or down/);
  // Valid ends, degenerate middle: opposite horizontal look vectors.
  bad({ eyeStartM: [0, 1500, 0], targetStartM: [1000, 1500, 0], eyeEndM: [1000, 1500, 0], targetEndM: [0, 1500, 0], fovYDeg: 35 }, /coincide at rail/);
  // Valid ends, a middle that looks straight down.
  bad({ eyeStartM: [0, 1500, 0], targetStartM: [1000, 0, 0], eyeEndM: [0, 1500, 0], targetEndM: [-1000, 0, 0], fovYDeg: 35 }, /straight up or down at rail/);
  bad({ ...view.camera, eyeEndM: [1, 2] }, /eyeEndM/);
  assert.deepEqual(cameraRailErrors(null), ['camera missing']);
});

test('aspect ratio changes framing, never the geographic position', () => {
  const pose = cameraPoseAt(view, 0.4);
  const p = [3000, 1200, -9000];
  const wide = projectPoint(pose, 2.07, p), narrow = projectPoint(pose, 390 / 844, p);
  assert.equal(wide.depth, narrow.depth);
  assert.equal(wide.y, narrow.y);
  assert.ok(Math.abs(wide.x * 2.07 - narrow.x * (390 / 844)) < 1e-12);
  assert.deepEqual(cameraPoseAt(view, 0.4), pose);
});

test('frustum test keeps boxes in view and drops boxes behind the eye', () => {
  const pose = cameraPoseAt(view, 0);
  assert.equal(boxMayBeVisible(pose, 16 / 9, { min: [-500, 0, -10500], max: [500, 2000, -9500] }), true);
  assert.equal(boxMayBeVisible(pose, 16 / 9, { min: [-500, 0, 2000], max: [500, 2000, 3000] }), false);
  assert.equal(boxMayBeVisible(pose, 16 / 9, { min: [30000, 0, -1000], max: [31000, 2000, 0] }), false);
  assert.equal(projectPoint(pose, 1, [0, 1500, 100]), null);
});
