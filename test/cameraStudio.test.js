import test from 'node:test';
import assert from 'node:assert/strict';

const studio = await import('../src/world/alpine/CameraStudio.js').catch(() => null);
const pose = { eyeM: [0, 2000, 10000], targetM: [0, 0, 0], fovYDeg: 40, tour: true };
const at = (settings, timeMs, options = {}) => studio.applyCameraStudio(pose, { enabled: true, ...settings },
  { timeMs, referencePose: pose, fullCoverage: true, ...options });

test('Camera Studio normalizes stored settings without accepting invalid numeric or enum values', () => {
  assert.ok(studio, 'Camera Studio engine is available');
  const raw = { enabled: 'false', distance: -8, fovDeg: Infinity, direction: 'north', preset: 'unknown', overshoot: 20 };
  const out = studio.normalizeCameraStudioSettings(raw);
  assert.equal(out.enabled, false);
  assert.equal(out.distance, .35);
  assert.equal(out.fovDeg, 35);
  assert.equal(out.direction, 'cw');
  assert.equal(out.preset, 'rail');
  assert.equal(out.overshoot, .5);
  assert.equal(raw.distance, -8);
  assert.ok(Object.isFrozen(out));
});

test('a delayed spring moves past its push destination then settles and holds exactly', () => {
  assert.ok(studio, 'Camera Studio engine is available');
  const settings = { preset: 'push', delaySec: 2, durationSec: 4, holdSec: 3, overshoot: .4 };
  const radius = t => Math.hypot(...at(settings, t).pose.eyeM);
  assert.equal(radius(0), radius(1999));
  assert.equal(radius(6000), radius(8999));
  let nearest = Infinity;
  for (let t = 2000; t < 6000; t += 20) nearest = Math.min(nearest, radius(t));
  assert.ok(nearest < radius(6000) * .99, 'overshoot travels past the push destination');
  assert.ok(radius(6000) < radius(0) * .9, 'push changes physical distance');
});

test('orbit direction reverses the physical camera path around its focus', () => {
  assert.ok(studio, 'Camera Studio engine is available');
  const cw = at({ preset: 'orbit', direction: 'cw' }, 5000).pose;
  const ccw = at({ preset: 'orbit', direction: 'ccw' }, 5000).pose;
  assert.ok(Math.abs(cw.eyeM[0]) > 100);
  assert.ok(Math.abs(cw.eyeM[0] + ccw.eyeM[0]) < 1e-8);
  assert.deepEqual(cw.targetM, pose.targetM);
  assert.deepEqual(ccw.targetM, pose.targetM);
});

test('static framing stays fixed while rail framing follows the authored pose', () => {
  assert.ok(studio, 'Camera Studio engine is available');
  const next = { ...pose, eyeM: [1000, 2000, 10000], targetM: [1000, 0, 0] };
  const fixed = studio.applyCameraStudio(next, { enabled: true, preset: 'static' },
    { fullCoverage: true, timeMs: 45000, referencePose: pose }).pose;
  assert.deepEqual(fixed, at({ preset: 'static' }, 0).pose);
  const moving = studio.applyCameraStudio(next, { enabled: true, preset: 'rail' }, { fullCoverage: true }).pose;
  assert.ok(Math.abs(moving.eyeM[0] - 1000) < 1e-8);
  assert.ok(Math.abs(moving.targetM[0] - 1000) < 1e-8);
});

test('static pruned views keep their exact eye and aim while distance and lens only crop inward', () => {
  assert.ok(studio, 'Camera Studio engine is available');
  for (const distance of [.5, 1.8]) {
    const result = at({ preset: 'orbit', distance, fovDeg: 70, azimuthDeg: 80, elevation: 20, focusX: .2 }, 42000,
      { fullCoverage: false });
    assert.deepEqual(result.pose.eyeM, pose.eyeM);
    assert.deepEqual(result.pose.targetM, pose.targetM);
    assert.ok(result.pose.fovYDeg <= 40);
    assert.equal(result.status.capability, 'crop');
    assert.equal(result.status.positionEnabled, false);
  }
  assert.ok(at({ distance: .5 }, 0, { fullCoverage: false }).pose.fovYDeg < 30);
});

test('Studio retains terrain and musical deformation clearance above the moved eye', () => {
  assert.ok(studio, 'Camera Studio engine is available');
  const out = at({ preset: 'static', distance: .35, elevation: -15 }, 0,
    { heightAt: () => 3000, waterLevelM: 3100 }).pose;
  assert.ok(out.eyeM[1] >= 3500, `clear terrain, water, deformation and trees: ${out.eyeM[1]}`);
  assert.ok(Math.hypot(...out.eyeM.map((v, i) => v - out.targetM[i])) > 1);
});

test('camera sampling is independent of frame rate, seeks and serialized export settings', () => {
  assert.ok(studio, 'Camera Studio engine is available');
  const settings = studio.normalizeCameraStudioSettings({ enabled: true, preset: 'sweep', delaySec: 1.2, overshoot: .3 });
  const expected = at(settings, 13725).pose;
  for (const t of [50000, 0, 4800, 13725, 2000]) at(settings, t);
  assert.deepEqual(at(JSON.parse(JSON.stringify(settings)), 13725).pose, expected);
  assert.deepEqual(at(settings, 13725).pose, expected);
});
