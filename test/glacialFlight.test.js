import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glacierStateAt, glacierSample, glacierErrors, applyGlacierUniforms } from '../src/world/alpine/GlacierField.js';
import { sceneUniforms, SCENE_VERT } from '../src/world/alpine/TerrainMaterial.js';
import * as THREE from 'three';
import { cameraPoseAt, cameraRailErrors } from '../src/world/terrain/SceneTravel.js';

const ice = { axisStartM: [0, 10000], axisEndM: [0, -10000], halfWidthM: 4000,
  surfaceStartM: 1000, surfaceEndM: 1700, maxThicknessM: 1100 };

test('retreat is monotonic, held by song time, and finishes without refreezing', () => {
  let last = -1;
  for (let timeMs = 0; timeMs <= 60000; timeMs += 100) {
    const a = glacierStateAt({ timeMs, durationMs: 60000 });
    assert.ok(a.retreat01 >= last);
    assert.deepEqual(a, glacierStateAt({ timeMs, durationMs: 60000 }));
    last = a.retreat01;
  }
  assert.equal(glacierStateAt({ timeMs: 0, durationMs: 60000 }).retreat01, 0);
  assert.equal(glacierStateAt({ timeMs: 60000, durationMs: 60000 }).retreat01, 1);
  assert.equal(glacierStateAt({ timeMs: -5, durationMs: 60000 }).retreat01, 0);
  assert.equal(glacierStateAt({ timeMs: 90000, durationMs: 60000 }).retreat01, 1);
  assert.deepEqual(glacierStateAt({ timeMs: 27000, durationMs: 60000 }), glacierStateAt({ timeMs: 27000, durationMs: 60000 }));
});

test('unknown duration and nonfinite input give a finite stable preview', () => {
  const p = glacierStateAt({ timeMs: NaN, durationMs: 0 });
  assert.equal(p.retreat01, .5);
  assert.deepEqual(p, glacierStateAt({ timeMs: 99999, durationMs: Infinity }));
});

test('glacier fills low ground, leaves high summits and outside land untouched', () => {
  assert.deepEqual(glacierErrors(ice), []);
  assert.ok(glacierSample(ice, 0, 0, 600, 0).thicknessM > 500);
  assert.equal(glacierSample(ice, 0, 0, 2400, 0).thicknessM, 0);
  assert.equal(glacierSample(ice, 9000, 0, 600, 0).thicknessM, 0);
  assert.equal(glacierSample(null, 0, 0, 600, 0).thicknessM, 0);
  assert.equal(glacierSample(ice, 0, 0, 600, 1).surfaceM, 600);
  assert.equal(glacierSample(ice, 0, 0, 600, 0).recovery01, 0);
  assert.equal(glacierSample(ice, 0, 0, 600, 1).recovery01, 1);
});

test('local ice only thins and its terminus retreats from the southern end', () => {
  for (const z of [-8000, 0, 8000]) {
    let last = Infinity;
    for (let i = 0; i <= 100; i++) {
      const s = glacierSample(ice, 0, z, 500, i / 100);
      assert.ok(s.thicknessM <= last + 1e-7);
      assert.ok(s.thicknessM >= 0 && s.thicknessM <= ice.maxThicknessM);
      last = s.thicknessM;
    }
  }
  assert.equal(glacierSample(ice, 0, 8000, 500, .5).thicknessM, 0);
  assert.ok(glacierSample(ice, 0, -8000, 500, .5).thicknessM > 0);
  assert.ok(glacierSample(ice, 0, 8000, 500, .5).recovery01 > 0);
});

test('bad glacial metadata is rejected before shader upload', () => {
  assert.match(glacierErrors({ ...ice, axisEndM: ice.axisStartM }).join(' '), /axis/);
  assert.match(glacierErrors({ ...ice, halfWidthM: 0 }).join(' '), /halfWidthM/);
  assert.match(glacierErrors({ ...ice, maxThicknessM: Infinity }).join(' '), /maxThicknessM/);
});

test('glacial uniforms are bounded and completely disabled on the next ordinary view', () => {
  const u = sceneUniforms(THREE, {});
  applyGlacierUniforms(u, ice, { retreat01: .45 });
  assert.equal(u.uGlacierEnabled.value, 1);
  assert.equal(u.uGlacierRetreat.value, .45);
  assert.deepEqual(u.uGlacierStart.value.toArray(), ice.axisStartM);
  applyGlacierUniforms(u, null, { retreat01: .8 });
  assert.equal(u.uGlacierEnabled.value, 0);
  assert.throws(() => applyGlacierUniforms(u, { ...ice, halfWidthM: 0 }, {}), /halfWidthM/);
  assert.ok(SCENE_VERT.includes('glacierAt(position)'), 'the scenic/depth shared vertex shader fills valleys');
});

const camera = { eyeStartM: [0, 1700, 0], eyeEndM: [5000, 1900, -5000],
  targetStartM: [0, 700, -15000], targetEndM: [3000, 800, -22000], fovYDeg: 35,
  eyeArcM: [1200, 100, 0], targetArcM: [-500, 0, -1000] };

test('curved flight reaches the same endpoints and independently reveals at midpoint', () => {
  const p = u => cameraPoseAt({ id: 'flight', camera }, u);
  assert.deepEqual(p(0).eyeM, camera.eyeStartM);
  assert.deepEqual(p(1).eyeM, camera.eyeEndM);
  assert.deepEqual(p(.5).eyeM, [3700, 1900, -2500]);
  assert.deepEqual(p(.5).targetM, [1000, 750, -19500]);
  assert.deepEqual(cameraRailErrors(camera), []);
});

test('curve validation finds interior look-vector collapse including between sample stations', () => {
  const u = .12345;
  const arc = -1000 / (4 * u * (1 - u));
  const bad = { eyeStartM: [0, 500, 0], eyeEndM: [0, 500, 0],
    targetStartM: [1000, 500, 0], targetEndM: [1000, 500, 0], targetArcM: [arc, 0, 0], fovYDeg: 35 };
  assert.ok(cameraRailErrors(bad).length > 0);
  assert.ok(cameraRailErrors({ ...camera, eyeArcM: [NaN, 0, 0] }).length > 0);
});
