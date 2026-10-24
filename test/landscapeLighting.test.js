import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { sceneUniforms } from '../src/world/alpine/TerrainMaterial.js';
import { rangeMusicState } from '../src/world/alpine/RangeFrame.js';
import { STORM_GLSL } from '../src/world/alpine/RangeStorm.js';
import { createForest } from '../src/world/alpine/ForestGL.js';
import { createSceneMaterial } from '../src/world/alpine/TerrainMaterial.js';
import { RockStageGL } from '../src/world/alpine/RockStageGL.js';

function receiver(viewExtra = {}) {
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, .1, 100000);
  camera.position.set(0, 1000, 1000); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const scene = Object.assign(Object.create(RangeScene.prototype), { THREE, camera });
  const uniforms = sceneUniforms(THREE, { uHeightRange: { value: new THREE.Vector2(0, 2000) } });
  const view = { camera: { eyeStartM: [0, 1000, 1000], eyeEndM: [0, 1000, 1000], targetStartM: [0, 0, 0], targetEndM: [0, 0, 0], fovYDeg: 40 }, ...viewExtra };
  const frame = { timeMs: 0, progress01: 0, music: rangeMusicState({}), qualityLevel: 0,
    scenicViewport: { nominalHeight: 720 }, light: { celestial: { xFrac: .7, yFrac: .08, body: 'sun', colorHex: '#ffffff', intensity: 1.6 },
      night01: 0, ambientMultiplier: 1, sky: { top: '#334455', horizon: '#778899', air: '#556677' } } };
  const render = (light = {}, extra = {}) => { scene._setUniforms({ uniforms, view }, { ...frame, ...extra, light: { ...frame.light, ...light } }); return uniforms; };
  return { render, frame };
}

test('receiver ambient fades once without darkening sky radiance or accumulating across frames', () => {
  const { render } = receiver();
  const day = render(), sky = day.uSkyZenith.value.toArray(), horizon = day.uSkyHorizon.value.toArray();
  const night = render({ night01: 1, ambientMultiplier: .35 });
  assert.deepEqual(night.uSkyZenith.value.toArray(), sky, 'reflected sky remains the authored sky');
  assert.deepEqual(night.uSkyHorizon.value.toArray(), horizon);
  assert.ok(Math.abs(night.uAmbientScale.value - .875) < 1e-12);
  assert.ok(Math.abs(render({ night01: 1, ambientMultiplier: .35 }).uAmbientScale.value - .875) < 1e-12);
  assert.equal(render().uAmbientScale.value, 2.5);
});

test('biome motif changes environment colors while resolved physical key radiance stays intact', () => {
  const { render } = receiver();
  const neutral = render().uLightColor.value.toArray();
  const tinted = render({}, { motif: { hueDeg: 140, intensity01: .7 } });
  assert.deepEqual(tinted.uLightColor.value.toArray(), neutral);
  assert.deepEqual(neutral, [1.6, 1.6, 1.6]);
});

test('foliage transmission belongs only to an active solar key and gaps retain zero direct radiance', () => {
  const { render, frame } = receiver();
  assert.equal(render().uSolarTransmission?.value, .18);
  assert.equal(render({ celestial: { ...frame.light.celestial, body: 'moon', intensity: .25 } }).uSolarTransmission.value, 0);
  const gap = render({ celestial: { ...frame.light.celestial, body: null, intensity: 0 } });
  assert.equal(gap.uSolarTransmission.value, 0);
  assert.deepEqual(gap.uLightColor.value.toArray(), [0, 0, 0]);
});

test('stage fill dims at night while retaining its separate foreground legibility calibration', () => {
  const palette = Object.fromEntries(['rockLit', 'rockShade', 'wetRock', 'moss', 'soil', 'lichen', 'water', 'waterDeep'].map(k => [k, '#334455']));
  const roles = Object.fromEntries(['stage', 'stageWet', 'soil'].map(k => [k, { texture: null }]));
  const stage = new RockStageGL(THREE, { palette, textures: { roles }, rules: {} });
  const geometry = { positions: new Float32Array(), normals: new Float32Array(), surfaces: new Float32Array(), uv: new Float32Array(), indices: new Uint32Array(), pools: [] };
  const apply = ambientMultiplier => stage.update(geometry, { width: 100, height: 100, frame: { timeMs: 0, light: { ambientMultiplier }, emitters: [] } });
  apply(1); const day = stage.uniforms.uAmbientScale.value;
  apply(.35); const night = stage.uniforms.uAmbientScale.value;
  assert.ok(night < day && night > day * .35, 'foreground gets a sheltered ambient bound');
  apply(.35); assert.equal(stage.uniforms.uAmbientScale.value, night, 'fill does not compound');
  apply(1); assert.equal(stage.uniforms.uAmbientScale.value, day);
  stage.dispose();
});


test('moonlit terrain retains sheltered receiver fill when the coda removes direct light', () => {
  const { render, frame } = receiver();
  const sky = render().uSkyZenith.value.toArray();
  const moon = { ...frame.light.celestial, body: 'moon', intensity: 0 };
  const light = { celestial: moon, night01: 1, ambientMultiplier: .35,
    state: { sun: { visibility: 0 }, moon: { visibility: 1 } } };
  const night = render(light);
  assert.deepEqual(night.uLightColor.value.toArray(), [0, 0, 0], 'the spent direct key remains off');
  assert.deepEqual(night.uSkyZenith.value.toArray(), sky, 'receiver fill does not brighten the authored sky');
  assert.ok(Math.abs(night.uAmbientScale.value - 1.93125) < 1e-12, 'the visible moon shelters terrain fill');
  assert.equal(render(light).uAmbientScale.value, night.uAmbientScale.value, 'fill does not compound');
  const gap = render({ ...light, celestial: { ...moon, body: null },
    state: { sun: { visibility: 0 }, moon: { visibility: 0 } } });
  assert.ok(Math.abs(gap.uAmbientScale.value - .875) < 1e-12, 'an absent moon earns no extra fill');
  assert.equal(render().uAmbientScale.value, 2.5, 'daylight keeps its existing fill');
});

test('terrain fill follows continuous celestial visibility through the active-body handover', () => {
  const { render, frame } = receiver();
  const shared = { night01: 1, ambientMultiplier: .35,
    state: { sun: { visibility: 0 }, moon: { visibility: 1 } } };
  const before = render({ ...shared, celestial: { ...frame.light.celestial, body: 'sun', intensity: 0 } }).uAmbientScale.value;
  const after = render({ ...shared, celestial: { ...frame.light.celestial, body: 'moon', intensity: 0 } }).uAmbientScale.value;
  assert.ok(before > .875, 'visible moon fill is already present before the active body changes');
  assert.equal(before, after, 'the body label cannot introduce a receiver-light jump');
});

test('sheltered moon ambient is tracked separately from the shadowed sky receiver fill', () => {
  const { render } = receiver();
  const light = { night01: 1, ambientMultiplier: .35,
    state: { sun: { visibility: 0 }, moon: { visibility: 1 } } };
  const atNight = render(light);
  assert.ok(Math.abs(atNight.uMoonAmbientScale?.value - 1.05625) < 1e-12);
  assert.ok(Math.abs(render(light, { storm: { amount: 1, flash: 0, break01: 0, wet01: 1 } }).uMoonAmbientScale.value - 1.05625 * .85) < 1e-12);
  assert.equal(render().uMoonAmbientScale.value, 0, 'daylight has no extra moon component');
  assert.equal(render({ ...light, state: { sun: { visibility: 0 }, moon: { visibility: 0 } } }).uMoonAmbientScale.value, 0);
});


// Execute the production GLSL helper on CPU; only adapt GLSL vector syntax.
// Expected photometric/chromaticity properties below do not mirror its formula.
function receiverFillCpu() {
  const match = STORM_GLSL.match(/vec3 receiverFill\(vec3 hemi, float minimum\) \{([\s\S]*?)\n {2}\}/);
  assert.ok(match, 'production shared receiver helper exists');
  const body = match[1].replace(/\bfloat /g, 'let ')
    .replace('hemi / luminance * minimum', 'hemi.map(channel => channel / luminance * minimum)');
  const fn = new Function('hemi', 'minimum', 'dot', 'vec3', 'any', 'isnan', 'isinf', body);
  return (hemi, minimum) => fn(hemi, minimum,
    (a, b) => a.reduce((n, value, i) => n + value * b[i], 0),
    (...values) => values.length === 1 ? Array(3).fill(values[0]) : values,
    values => values.some(Boolean),
    value => Array.isArray(value) ? value.map(Number.isNaN) : Number.isNaN(value),
    value => Array.isArray(value) ? value.map(x => Math.abs(x) === Infinity) : Math.abs(value) === Infinity);
}

test('Black static receiver floor opts in without altering sky, key, ambient, storm or exposure', () => {
  const paths = [[[0, 1000, 1000]]];
  const baseline = receiver().render({}, { storm: { amount: .8, flash: 0, break01: .5, wet01: .7 } });
  const actual = receiver({ id: 'black-mountains-catawba', cameraPaths: paths }).render({}, { storm: { amount: .8, flash: 0, break01: .5, wet01: .7 } });
  assert.equal(actual.uReceiverFillMin?.value, .32);
  for (const key of ['uLightColor', 'uSkyZenith', 'uSkyHorizon', 'uAirColor', 'uAmbientScale', 'uMoonAmbientScale', 'uExposure', 'uSolarTransmission', 'uStorm']) {
    assert.deepEqual(actual[key].value, baseline[key].value, key);
  }
  for (const extra of [{}, { id: 'black-mountains-catawba' }, { id: 'black-mountains-catawba', cameraPaths: [[]] },
    { id: 'black-mountains-catawba', cameraPaths: paths, tour: { durationMs: 8000, poseAt: () => ({ eyeM: [0, 1000, 1000], targetM: [0, 0, 0], fovYDeg: 40 }) } }, { id: 'shenandoah-stony-man-west', cameraPaths: paths }]) {
    assert.equal(receiver(extra).render().uReceiverFillMin?.value, 0, JSON.stringify(extra));
  }
});

test('shared receiver fill preserves disabled/bright radiance and low-light chromaticity without a black-source invention', () => {
  const fill = receiverFillCpu(), luma = rgb => rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  for (const rgb of [[.01, .02, .03], [.4, .5, .6], [0, 0, 0]]) assert.deepEqual(fill(rgb, 0), rgb);
  assert.deepEqual(fill([.4, .5, .6], .16), [.4, .5, .6]);
  for (const rgb of [[.01, .02, .03], [.03, .01, .005], [1e-39, 2e-39, 3e-39]]) {
    const out = fill(rgb, .16);
    assert.ok(out.every(Number.isFinite));
    assert.ok(Math.abs(luma(out) - .16) < 1e-12);
    assert.ok(out.every((v, i) => v >= rgb[i]));
    assert.ok(Math.abs(out[0] / out[1] - rgb[0] / rgb[1]) < 1e-12);
    assert.ok(Math.abs(out[2] / out[1] - rgb[2] / rgb[1]) < 1e-12);
  }
  assert.deepEqual(fill([0, 0, 0], .16), [0, 0, 0]);
  for (const rgb of [[NaN, .1, .1], [Infinity, .1, .1]]) assert.deepEqual(fill(rgb, .16), [0, 0, 0]);
  for (const minimum of [NaN, Infinity, -1]) assert.deepEqual(fill([.01, .02, .03], minimum), [.01, .02, .03]);
});

test('assembled terrain and every tree color material share fill uniforms/helper while water bypasses it', () => {
  const uniforms = sceneUniforms(THREE, {});
  const terrain = createSceneMaterial(THREE, uniforms);
  const row = new Float32Array([0, 0, 100, 20, 6, 2, .5, 2]);
  const forest = createForest(THREE, { meshDetail: row, mesh: row, billboard: row, count: 3, stride: 8 }, uniforms);
  try {
    assert.equal(uniforms.uReceiverFillMin?.value, 0);
    assert.equal(forest.uniforms.uReceiverFillMin, uniforms.uReceiverFillMin, 'trees consume the terrain receiver setting');
    const helper = STORM_GLSL.match(/vec3 receiverFill\([\s\S]*?\n {2}\}/)?.[0];
    assert.ok(helper);
    assert.ok(terrain.fragmentShader.includes(helper));
    assert.match(terrain.fragmentShader, /if \(!water\) hemi = receiverFill\(hemi, uReceiverFillMin\);/);
    const materials = new Set(forest.byBand.near.map(mesh => mesh.material));
    assert.ok(materials.size >= 3, 'mesh, detail and billboard color variants assembled');
    for (const m of materials) {
      assert.ok(m.fragmentShader.includes(helper));
      assert.match(m.fragmentShader, /hemi = receiverFill\(hemi, uReceiverFillMin\);/);
      assert.equal(m.uniforms.uReceiverFillMin, uniforms.uReceiverFillMin);
    }
    uniforms.uReceiverFillMin.value = .16;
    assert.equal(forest.uniforms.uReceiverFillMin.value, .16);
  } finally { forest.dispose(); terrain.dispose(); }
});


test('Black second calibration raises measured dim and clear upward receivers while brighter irradiance stays exact', () => {
  const minimum = receiver({ id: 'black-mountains-catawba', cameraPaths: [[[0, 1000, 1000]]] }).render().uReceiverFillMin.value;
  const fill = receiverFillCpu();
  // Rounded clear64 upward hemisphere from captured sky zenith times ambient.
  // The second calibration may change this daylight sample; no parity claim.
  for (const irradiance of [[.05, .07, .10], [.070560651276078, .238110329741318, .708918931050773]]) {
    const out = fill(irradiance, minimum);
    assert.ok(out.every((v, i) => v > irradiance[i]));
    assert.ok(Math.abs(out[0] * .2126 + out[1] * .7152 + out[2] * .0722 - .32) < 1e-12);
  }
  assert.deepEqual(fill([.4, .5, .6], minimum), [.4, .5, .6]);
});
