// Contract C3: CameraDirector reports the universe pull-back it subtracted
// from zoom as `camera.universeDip`; the Renderer adds it back on Range views,
// whose own lens would otherwise lose part of its push-in. Until the camera
// reports a dip this is a no-op.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageZoomFor } from '../src/render/Renderer.js';

const RANGE = { enabled: true, active: true, arrival: 1 };

test('an active Range view cancels the universe dip', () => {
  assert.ok(Math.abs(stageZoomFor({ zoom: 0.95, universeDip: 0.05 }, RANGE) - 1) < 1e-12);
});

test('the dip is restored in proportion to the view\'s arrival', () => {
  const half = stageZoomFor({ zoom: 0.95, universeDip: 0.05 }, { ...RANGE, arrival: 0.5 });
  assert.ok(Math.abs(half - 0.975) < 1e-12);
});

test('without a Range view the pull-back stays', () => {
  assert.equal(stageZoomFor({ zoom: 0.95, universeDip: 0.05 }, null), 0.95);
  assert.equal(stageZoomFor({ zoom: 0.95, universeDip: 0.05 }, { ...RANGE, active: false }), 0.95);
  assert.equal(stageZoomFor({ zoom: 0.95, universeDip: 0.05 }, { ...RANGE, enabled: false }), 0.95);
});

test('a camera without universeDip (before CameraDirector reports it) keeps its zoom', () => {
  assert.equal(stageZoomFor({ zoom: 0.95 }, RANGE), 0.95);
  assert.equal(stageZoomFor({ zoom: 0.8, universeDip: 0 }, RANGE), 0.8);
  assert.equal(stageZoomFor({ zoom: 1 }, null), 1);
});
