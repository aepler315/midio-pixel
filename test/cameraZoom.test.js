import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CameraDirector, zoomTargetForOffFrame, ZOOM_MARGIN_FRAC, ZOOM_MIN } from '../src/render/CameraDirector.js';

const STAGE_W = 1280;

test('everyone comfortably inside frame -> zoom target is 1 (no pull-back)', () => {
  assert.equal(zoomTargetForOffFrame([200, 640, 1000], STAGE_W), 1);
});

test('a character right at the margin edge is still considered fine', () => {
  const margin = STAGE_W * ZOOM_MARGIN_FRAC;
  assert.equal(zoomTargetForOffFrame([margin, STAGE_W - margin], STAGE_W), 1);
});

test('a character right at the true stage edge already asks for the hardest pull-back -- the ramp finishes before they actually exit the frame', () => {
  assert.equal(zoomTargetForOffFrame([0], STAGE_W), ZOOM_MIN);
  assert.equal(zoomTargetForOffFrame([STAGE_W], STAGE_W), ZOOM_MIN);
});

test('pull-back never exceeds ZOOM_MIN even far past the margin', () => {
  assert.equal(zoomTargetForOffFrame([-STAGE_W * 5], STAGE_W), ZOOM_MIN);
});

test('the worst-offending character drives the target, not an average', () => {
  const margin = STAGE_W * ZOOM_MARGIN_FRAC;
  // Both still within the margin band (x in [0, margin]) -- neither has
  // gone fully off-stage, just further into the ramp toward the edge.
  const mild = zoomTargetForOffFrame([margin * 0.8], STAGE_W);
  const severe = zoomTargetForOffFrame([margin * 0.8, margin * 0.1], STAGE_W);
  assert.ok(severe < mild, 'the more severe overshoot must win, not get averaged away');
  assert.ok(severe < 1 && severe > ZOOM_MIN, `severe should be a partial pull-back, got ${severe}`);
});

test('no characters or no stage width -> 1 (never divides by zero / never pulls back for nothing)', () => {
  assert.equal(zoomTargetForOffFrame([], STAGE_W), 1);
  assert.equal(zoomTargetForOffFrame(null, STAGE_W), 1);
  assert.equal(zoomTargetForOffFrame([9999], 0), 1);
});

test('CameraDirector.zoom eases toward the target over time -- never snaps in one frame', () => {
  const cam = new CameraDirector();
  cam.setZoomTarget([-STAGE_W], STAGE_W); // maximal pull-back
  cam.update(1 / 60, 0, false);
  assert.ok(cam.zoom < 1, 'should have started easing out');
  assert.ok(cam.zoom > ZOOM_MIN, 'should not reach the target in a single 1/60s frame');
});

test('CameraDirector.zoom converges to ZOOM_MIN given enough time at max pull-back', () => {
  const cam = new CameraDirector();
  cam.setZoomTarget([-STAGE_W], STAGE_W);
  for (let i = 0; i < 600; i++) cam.update(1 / 60, 0, false);
  assert.ok(Math.abs(cam.zoom - ZOOM_MIN) < 1e-6, `expected convergence to ${ZOOM_MIN}, got ${cam.zoom}`);
});

test('CameraDirector.zoom eases back to 1 once the target returns to normal', () => {
  const cam = new CameraDirector();
  cam.setZoomTarget([-STAGE_W], STAGE_W);
  for (let i = 0; i < 600; i++) cam.update(1 / 60, 0, false);
  cam.setZoomTarget([STAGE_W / 2], STAGE_W); // back on frame
  for (let i = 0; i < 600; i++) cam.update(1 / 60, 0, false);
  assert.ok(Math.abs(cam.zoom - 1) < 1e-6, `expected convergence back to 1, got ${cam.zoom}`);
});

test('reduced motion shrinks the zoom travel rather than disabling it', () => {
  const camNormal = new CameraDirector();
  camNormal.setZoomTarget([-STAGE_W], STAGE_W);
  for (let i = 0; i < 30; i++) camNormal.update(1 / 60, 0, false);

  const camReduced = new CameraDirector();
  camReduced.setZoomTarget([-STAGE_W], STAGE_W);
  for (let i = 0; i < 30; i++) camReduced.update(1 / 60, 0, true);

  const travelNormal = 1 - camNormal.zoom;
  const travelReduced = 1 - camReduced.zoom;
  assert.ok(travelReduced > 0, 'reduced motion should still move, just less');
  assert.ok(travelReduced < travelNormal, 'reduced motion must travel less than normal motion');
});

test('an excursion-excluded character does not count -- caller filters before calling setZoomTarget', () => {
  // This is really documenting the calling contract (Simulation.js excludes
  // midasus.voyage.active / broshi.burrow.active characters before ever
  // building the screenXs array), since the pure function itself has no way
  // to know about excursions -- it only ever sees what it's given.
  assert.equal(zoomTargetForOffFrame([STAGE_W / 2], STAGE_W), 1);
});
