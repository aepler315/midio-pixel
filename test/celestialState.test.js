import test from 'node:test';
import assert from 'node:assert/strict';
import * as ridge from '../src/world/alpine/RidgeMotion.js';
import { computeLight } from '../src/render/LightField.js';
import { convertLightBetween } from '../src/world/alpine/LightSpace.js';
const celestial = await import('../src/world/CelestialState.js').catch(() => ({}));
const viewport = { width: 1280, height: 720 };
const sample = (displacement01, velocity01 = 0) => ({ displacement01, velocity01 });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('relative ridge displacement cancels equal motion and preserves disagreement and velocity sign', () => {
  assert.equal(typeof ridge.sampleRidgeRelationship, 'function');
  const relationship = (space, dance, extra = {}) => ridge.sampleRidgeRelationship({ space, dance, nominalViewport: viewport, moonVisibility: 1, ...extra });
  assert.deepEqual(relationship(sample(.6,.3), sample(.6,.3)), { dxPx: 0, dyPx: 0 });
  assert.deepEqual(relationship(sample(1,1), sample(0)), { dxPx: 2, dyPx: 3 });
  assert.deepEqual(relationship(sample(0), sample(1,1)), { dxPx: -2, dyPx: -3 });
  const half = relationship(sample(1,1), sample(0), { moonVisibility: .5 });
  assert.deepEqual(half, { dxPx: 1, dyPx: 1.5 });
  assert.deepEqual(relationship(sample(1,1), sample(0), { reducedMotion: true }), { dxPx: 0, dyPx: 0 });
  const huge = relationship(sample(100,100), sample(-100,-100), { nominalViewport: { height: 1440 } });
  assert.ok(Math.hypot(huge.dxPx, huge.dyPx) <= 12);
});

test('resolved approached body is the light anchor; both gaps have no direct key even with reduced flash', () => {
  assert.equal(typeof celestial.resolveCelestialState, 'function');
  for (const timeMs of [21000,45000,71000,96000]) {
    const state = celestial.resolveCelestialState({ timeMs, cycleMs: 100000, viewport, approach: { progress01: .75 }, moonOffset: { dxPx: 2, dyPx: 3 } });
    const light = computeLight({ canvasWidth: 1280, canvasHeight: 720, celestialState: state, reducedFlash: true });
    if ([45000,96000].includes(timeMs)) {
      assert.equal(state.activeBody, null); assert.equal(state.sun.directGain, 0); assert.equal(state.moon.directGain, 0); assert.equal(light.intensity, 0);
    } else {
      const body = state[state.activeBody];
      close(light.x, body.xFrac * 1280); close(light.y, body.yFrac * 720);
      assert.ok(body.yFrac < .12 + (state.activeBody === 'moon' ? 3/720 : 0));
      assert.ok(light.intensity > 0);
    }
    assert.ok(Object.isFrozen(state) && Object.isFrozen(state.moon));
  }
});

test('moon offsets apply after approach, stay bounded and reconstruct across seek/pause/export order', () => {
  assert.equal(typeof celestial.resolveCelestialState, 'function');
  const at = (timeMs, extra={}) => celestial.resolveCelestialState({ timeMs, cycleMs: 100000, viewport, approach: { progress01: .9 }, ...extra });
  const neutral = at(71000), moving = at(71000, { moonOffset: { dxPx: 2, dyPx: 3 } });
  close((moving.moon.xFrac-neutral.moon.xFrac)*1280, 2);
  close((moving.moon.yFrac-neutral.moon.yFrac)*720, 3);
  const bound = at(71000, { moonOffset: { dxPx: 600, dyPx: 800 } });
  close(Math.hypot((bound.moon.xFrac-neutral.moon.xFrac)*1280,(bound.moon.yFrac-neutral.moon.yFrac)*720), 6);
  assert.deepEqual(at(71000, { reducedMotion: true, moonOffset: { dxPx: 2, dyPx: 3 } }), neutral);
  at(99000); at(1000); assert.deepEqual(at(71000, { moonOffset: { dxPx: 2, dyPx: 3 } }), moving);
  close(neutral.ambientMultiplier, .35);
});

test('recorded scenic and ground affine transforms agree at the device anchor across DPR, zoom, roll, portrait and overscan', () => {
  for (const [sx,sy,roll,margin,offset] of [[1,1,0,64,0],[2,2,.15,64,80],[.7,1.4,-.2,96,20],[1.1,2.3,.08,64,140]]) {
    const matrix = (x,y,tx,ty) => [x*Math.cos(roll),y*Math.sin(roll),-x*Math.sin(roll),y*Math.cos(roll),tx,ty];
    const scenic=matrix(sx*.72,sy*.72,-margin,margin/2), ground=matrix(sx,sy,-margin+12,-margin+offset);
    const map=(m,p)=>({x:m[0]*p.x+m[2]*p.y+m[4],y:m[1]*p.x+m[3]*p.y+m[5]});
    const light={x:333,y:121,dirX:.3,dirY:.8,intensity:.25};
    const actual=convertLightBetween(light,scenic,ground);
    const a=map(scenic,light), b=map(ground,actual);
    close(a.x,b.x);close(a.y,b.y); assert.equal(actual.intensity,.25);
  }
});

test('terrain/forest/water key keeps the projected celestial ray at low altitude with no upward direction floor', async () => {
  const THREE = await import('three');
  const { RangeScene } = await import('../src/world/alpine/RangeScene.js');
  const { sceneUniforms } = await import('../src/world/alpine/TerrainMaterial.js');
  const { rangeMusicState } = await import('../src/world/alpine/RangeFrame.js');
  const camera = new THREE.PerspectiveCamera(40,16/9,.1,100000);
  camera.position.set(0,1000,1000); camera.lookAt(0,0,0); camera.updateMatrixWorld();
  const scene = Object.assign(Object.create(RangeScene.prototype), { THREE, camera });
  const u=sceneUniforms(THREE,{uHeightRange:{value:new THREE.Vector2(0,2000)}});
  const view={camera:{eyeStartM:[0,1000,1000],eyeEndM:[0,1000,1000],targetStartM:[0,0,0],targetEndM:[0,0,0],fovYDeg:40}};
  const frame={timeMs:0,progress01:0,music:rangeMusicState({}),light:{celestial:{xFrac:.92,yFrac:.58,body:'sun',colorHex:'#ffffff',intensity:.02},night01:0},scenicViewport:{nominalHeight:720},qualityLevel:0};
  scene._setUniforms({uniforms:u,view},frame);
  const point=camera.position.clone().addScaledVector(u.uLightDir.value,10000).project(camera);
  close(point.x,.84);close(point.y,-.16);
});

test('a moonless night is darkness: the night fill drops and the low sun turns red', async () => {
  const { resolveCelestialState, MOONLESS_AMBIENT_CUT } = await import('../src/world/CelestialState.js');
  const { songSkyClock } = await import('../src/world/DayNight.js');
  const clock = songSkyClock(120000);
  const viewport = { width: 1280, height: 720 };
  const dark = resolveCelestialState({ timeMs: 0, cycleMs: clock, viewport });
  assert.equal(dark.darkness01, 1);
  assert.ok(Math.abs(dark.ambientMultiplier - 0.35 * (1 - MOONLESS_AMBIENT_CUT)) < 1e-9);
  const noon = resolveCelestialState({ timeMs: 60000, cycleMs: clock, viewport, sunColor: '#fff3df' });
  assert.equal(noon.darkness01, 0);
  assert.equal(noon.sun.colorHex, '#fff3df');
  const low = resolveCelestialState({ timeMs: clock.sunriseMs + 1500, cycleMs: clock, viewport, sunColor: '#fff3df' });
  const red = parseInt(low.sun.colorHex.slice(1, 3), 16), blue = parseInt(low.sun.colorHex.slice(5, 7), 16);
  assert.ok(red > 200 && blue < 120, low.sun.colorHex);
});
