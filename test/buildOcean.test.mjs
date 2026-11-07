import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { openingOcean01, openingOceanColor, BUILD_OCEAN_GLSL } from '../src/world/alpine/BuildOcean.js';
import { RiseGround } from '../src/world/alpine/RiseGround.js';
import { SCENE_FRAG, sceneUniforms } from '../src/world/alpine/TerrainMaterial.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { rangeMusicState } from '../src/world/alpine/RangeFrame.js';
import CATALOG from '../src/world/terrain/sceneCatalogData.js';

const colors = { water: [.035, .08, .09], sky: [.21, .31, .42], air: [.32, .40, .48] };

test('the shallow-ocean opening follows growth and finishes its material handoff at one quarter rise', () => {
  assert.equal(openingOcean01(0), 1);
  assert.equal(openingOcean01(.125), .5);
  assert.equal(openingOcean01(.25), 0);
  assert.equal(openingOcean01(1), 0);
  assert.equal(openingOcean01(undefined), 0, 'ordinary completed/legacy frames retain their materials');
  const values = Array.from({ length: 101 }, (_, i) => openingOcean01(i / 100));
  assert.ok(values.every((v, i) => v >= 0 && v <= 1 && (!i || v <= values[i - 1])));
  assert.equal(openingOcean01(.125), values[0] * .5, 'seeking reconstructs rather than integrates');
});

test('ocean color contains no world-grid, wave, noise or song random component', () => {
  const near = openingOceanColor({ ...colors, distanceM: 10, airDensity: .00002 });
  const far = openingOceanColor({ ...colors, distanceM: 100000, airDensity: .00002 });
  assert.ok(near.every(v => Number.isFinite(v) && v >= 0 && v <= 1));
  assert.notDeepEqual(near, far, 'only the continuous air path gives depth toward the horizon');
  assert.deepEqual(near, openingOceanColor({ ...colors, distanceM: 10, airDensity: .00002 }));
  assert.doesNotMatch(BUILD_OCEAN_GLSL, /texture\(|noise|fract\(|floor\(|sin\(/);
});

test('actual terrain and the analytic infinite plane share the exact opening display shader', () => {
  const data = { grid: { width: 2, height: 2, originM: [0, 0], cellSizeM: 20 },
    manifest: { boundsM: { min: [0, 100, 0], max: [20, 200, 20] } }, groundAt: () => 100 };
  const ground = new RiseGround(THREE, data, sceneUniforms(THREE, {}));
  assert.ok(SCENE_FRAG.includes(BUILD_OCEAN_GLSL));
  assert.ok(ground.material.fragmentShader.includes(BUILD_OCEAN_GLSL));
  assert.ok(ground.plane.material.fragmentShader.includes(BUILD_OCEAN_GLSL));
  assert.match(SCENE_FRAG, /openingOceanDisplay\(vRenderedWorld, cameraPosition/);
  assert.match(ground.plane.material.fragmentShader, /openingOceanDisplay\(p, cameraPosition/);
  assert.equal(ground.plane.material.depthWrite, false);
  assert.equal(ground.plane.material.depthTest, false);
  assert.match(ground.plane.material.vertexShader, /gl_Position = vec4\(position.xy, 1.0, 1.0\)/, 'the horizon does not depend on a finite world rectangle');
  ground.dispose();
});

test('opening hides material forest and ink while retaining the construction actor update', () => {
  const uniforms = sceneUniforms(THREE, { uHeightRange: { value: new THREE.Vector2(100, 2000) } });
  const visibility = [];
  let actorUpdates = 0;
  const scene = Object.assign(Object.create(RangeScene.prototype), { THREE, camera: new THREE.PerspectiveCamera(),
    _setActors() { actorUpdates++; } });
  const prepared = { view: CATALOG.views.find(v => v.status === 'approved'), uniforms, rules: {}, waterLevelM: 100,
    forest: { counts: { near: 1 }, applyVisibility(state) { visibility.push(state.shown); } } };
  const frame = { music: rangeMusicState(), progress01: .5, scenicViewport: { nominalHeight: 720 }, timeMs: 0, qualityLevel: 0,
    narrative: { relief: 1, atmosphere: 1, materials: .8, features: 1, skyDark: .5 },
    light: { celestial: { xFrac: .5, yFrac: .3, body: 'sun', intensity: 1, altitude01: .4, colorHex: '#ffffff' }, night01: 0 } };
  for (const rise01 of [0, .125, .25, 1]) {
    scene._setUniforms(prepared, { ...frame, rise01 });
    const land = 1 - openingOcean01(rise01);
    assert.equal(uniforms.uNarrative.value.z, .8 * land);
    assert.equal(uniforms.uNarrativeInk.value, (1 - .8) * .5 * land);
    assert.equal(uniforms.uFarForest.value.x > 0, land > .01);
  }
  assert.deepEqual(visibility, [false, true, true, true]);
  assert.equal(actorUpdates, 4, 'ocean material transition does not remove the cast operation');
});

test('a featureless opening does not spend a lake mirror pass before its materials arrive', () => {
  const uniforms = sceneUniforms(THREE, {});
  let requests = 0;
  const scene = Object.assign(Object.create(RangeScene.prototype), { size: { width: 320, height: 180 },
    _ensureMirror() { requests++; return null; }, _bindBackdrop() {}, releaseMirror() {} });
  const prepared = { uniforms, mirrorLevelM: 100 };
  for (const rise01 of [0, .25, 1]) {
    uniforms.uLandRise.value.set(1 - rise01, rise01 < 1 ? 100 : 0);
    scene._prepareMirror(prepared, { rise01, timeMs: rise01 * 1000, qualityLevel: 0 }, 'A', 'ocean');
  }
  assert.equal(requests, 2, 'ordinary water mirrors remain eligible after the ocean handoff');
});
