import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { sceneUniforms } from '../src/world/alpine/TerrainMaterial.js';
import { rangeMusicState } from '../src/world/alpine/RangeFrame.js';

function receiver() {
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, .1, 100000);
  camera.position.set(0, 1000, 1000); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const scene = Object.assign(Object.create(RangeScene.prototype), { THREE, camera });
  const uniforms = sceneUniforms(THREE, { uHeightRange: { value: new THREE.Vector2(0, 2000) } });
  const view = { camera: { eyeStartM: [0, 1000, 1000], eyeEndM: [0, 1000, 1000], targetStartM: [0, 0, 0], targetEndM: [0, 0, 0], fovYDeg: 40 } };
  const frame = { timeMs: 0, progress01: 0, music: rangeMusicState({}), qualityLevel: 0,
    scenicViewport: { nominalHeight: 720 }, light: { celestial: { xFrac: .7, yFrac: .08, body: 'sun', colorHex: '#ffffff', intensity: 1.6 },
      night01: 0, ambientMultiplier: 1, sky: { top: '#334455', horizon: '#778899', air: '#556677' } } };
  return { scene, uniforms, draw: (extra = {}) => scene._setUniforms({ uniforms, view }, { ...frame, ...extra }) };
}

test('cinematic receivers opt in per frame and switch back without accumulating environment changes', () => {
  const { scene, uniforms: u, draw } = receiver();
  draw();
  assert.equal(u.uCinematic?.value.x, 0, 'classic is the default shader branch');
  const sky = u.uSkyZenith.value.toArray(), key = u.uLightColor.value.toArray();
  scene.cinematicPixel = true;
  draw();
  assert.equal(u.uCinematic.value.x, 1);
  assert.ok(u.uCinematic.value.y < 1, 'the cinematic receiver reduces diffuse fill');
  assert.ok(u.uCinematic.value.z < .5, 'occluded receivers lose more direct key');
  assert.deepEqual(u.uSkyZenith.value.toArray(), sky, 'the reflected environment retains its authored radiance');
  assert.deepEqual(u.uLightColor.value.toArray(), key, 'the actual celestial radiance stays authoritative');
  const first = u.uCinematic.value.toArray();
  draw();
  assert.deepEqual(u.uCinematic.value.toArray(), first);
  scene.cinematicPixel = false;
  draw();
  assert.deepEqual(u.uCinematic.value.toArray(), [0, 1, .5, .18]);
  assert.deepEqual(u.uSkyZenith.value.toArray(), sky);
});

test('cinematic profile keeps night and storm fill readable and normalizes invalid state', async () => {
  const { cinematicLightingProfile } = await import('../src/world/alpine/CinematicLighting.js');
  const day = cinematicLightingProfile({ enabled: true, night01: 0 });
  const night = cinematicLightingProfile({ enabled: true, night01: 1 });
  const storm = cinematicLightingProfile({ enabled: true, night01: 0, storm01: 1 });
  assert.ok(day.light[1] < .85 && day.light[2] < .3);
  assert.ok(night.light[1] >= .94 && night.light[2] >= .4, 'night keeps its sheltered fill and bounce');
  assert.ok(storm.light[1] > day.light[1], 'dense cloud does not suffer an extra contrast crush');
  for (const options of [{}, { enabled: true, night01: NaN, storm01: Infinity }, { enabled: true, night01: -9, storm01: 5 }]) {
    const p = cinematicLightingProfile(options);
    assert.ok([...p.light, ...p.air].every(Number.isFinite));
  }
  assert.deepEqual(cinematicLightingProfile().light, [0, 1, .5, .18]);
});

test('cinematic air protects near contrast while far layers still converge and cloud sea stays whole', async () => {
  const { cinematicAirAmount, cinematicMistAmount } = await import('../src/world/alpine/CinematicLighting.js');
  assert.equal(cinematicAirAmount({ distanceM: 0, density: 1 / 55000 }), 0);
  assert.equal(cinematicAirAmount({ distanceM: 500, density: 1 / 55000 }), 0);
  const near = cinematicAirAmount({ distanceM: 5000, density: 1 / 55000 });
  const far = cinematicAirAmount({ distanceM: 150000, density: 1 / 55000 });
  assert.ok(near > 0 && near < .08);
  assert.ok(far > .8 && far <= .96);
  assert.equal(cinematicMistAmount({ amount: .8, distanceM: 100, fill: 1 }), .8, 'intentional cloud sea remains opaque');
  assert.ok(cinematicMistAmount({ amount: .8, distanceM: 100, fill: 0 }) < .1);
  assert.ok(cinematicMistAmount({ amount: .8, distanceM: 10000, fill: 0 }) > .4);
  assert.ok(cinematicMistAmount({ amount: .999, distanceM: 10000, fill: 0 }) > .97, 'density adjustment keeps the optical-depth limit of a deep bank');
});

test('cinematic grade retains neutral highlights and finite near-black separation', async () => {
  const { cinematicGrade } = await import('../src/world/alpine/CinematicLighting.js');
  assert.deepEqual(cinematicGrade([0, 0, 0]), [0, 0, 0]);
  const deep = cinematicGrade([.02, .04, .07]);
  assert.ok(deep[0] < deep[1] && deep[1] < deep[2] && deep.every(x => x > 0 && Number.isFinite(x)));
  const snow = cinematicGrade([.9, .92, .95]);
  assert.ok(snow.every(x => x > .85 && x <= 1), 'snow keeps highlight headroom');
  assert.ok(Math.max(...cinematicGrade([.99, .99, .99])) - Math.min(...cinematicGrade([.99, .99, .99])) < .025);
});

test('cinematic mist color uses cool near sky radiance and restores luminous far banks', async () => {
  const { cinematicMistColor } = await import('../src/world/alpine/CinematicLighting.js');
  const mist = [.3, .32, .35], sky = [.04, .12, .25];
  const near = cinematicMistColor(mist, sky, 500);
  assert.ok(near[0] < .04 && near[1] < .10 && near[2] < .20, 'foreground mist becomes materially deeper');
  assert.ok(near[2] > near[0] * 3, 'the near tint inherits the cool sky');
  assert.deepEqual(cinematicMistColor(mist, sky, 18000), mist, 'distant banks retain their original luminous color');
  assert.deepEqual(cinematicMistColor([0, 0, 0], sky, 500), [0, 0, 0], 'a black mist source invents no light');
  assert.deepEqual(cinematicMistColor(mist, [0, 0, 0], 500), [0, 0, 0], 'a black near environment invents no light');
  for (const distance of [0, 1800, 4000, 10000, 18000, 1e6, NaN]) {
    const c = cinematicMistColor(mist, sky, distance);
    c.forEach((x, i) => assert.ok(Number.isFinite(x) && x >= 0 && x <= mist[i]));
  }
});
