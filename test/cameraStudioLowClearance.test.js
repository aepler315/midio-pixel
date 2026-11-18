import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCameraStudio, cameraStudioTour } from '../src/world/alpine/CameraStudio.js';

const settings = { enabled: true, preset: 'rail', distance: 1, fovDeg: 35 };
const pose = { eyeM: [0, 84, 1000], targetM: [0, 84, 0], tour: true, fovYDeg: 35 };

test('Follow rail preserves an authored low flight with verified terrain and water', () => {
  const out = applyCameraStudio(pose, settings, { fullCoverage: true, heightAt: () => 0, waterLevelM: 20 });
  assert.deepEqual(out.pose.eyeM, pose.eyeM);
  assert.equal(out.clearanceM, 64);
  const unknown = applyCameraStudio(pose, settings, { fullCoverage: true, heightAt: () => NaN, waterLevelM: 20 });
  assert.ok(unknown.pose.eyeM[1] >= 500);
});

test('both endpoints of a final partial segment clear an intervening ridge', () => {
  const tour = { durationMs: 150, poseAt: t => ({ ...pose, eyeM: [t * 10, 84, 1000], targetM: [t * 10, 84, 0] }) };
  const heightAt = x => x >= 1230 && x <= 1270 ? 200 : 0;
  const studio = cameraStudioTour(tour, settings, { heightAt, waterLevelM: 20 });
  for (let t = 123; t <= 127; t++) assert.ok(studio.poseAt(t).eyeM[1] >= 264);
  assert.equal(studio.poseAt(0).eyeM[1], 84);
});
