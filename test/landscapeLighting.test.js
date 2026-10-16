import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { sceneUniforms } from '../src/world/alpine/TerrainMaterial.js';
import { rangeMusicState } from '../src/world/alpine/RangeFrame.js';
import { RockStageGL } from '../src/world/alpine/RockStageGL.js';

function receiver() {
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, .1, 100000);
  camera.position.set(0, 1000, 1000); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const scene = Object.assign(Object.create(RangeScene.prototype), { THREE, camera });
  const uniforms = sceneUniforms(THREE, { uHeightRange: { value: new THREE.Vector2(0, 2000) } });
  const view = { camera: { eyeStartM: [0, 1000, 1000], eyeEndM: [0, 1000, 1000], targetStartM: [0, 0, 0], targetEndM: [0, 0, 0], fovYDeg: 40 } };
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
