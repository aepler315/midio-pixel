import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { sceneUniforms, SCENE_FRAG } from '../src/world/alpine/TerrainMaterial.js';

async function receiver() {
  const [{ RangeScene }, { rangeMusicState }] = await Promise.all([
    import('../src/world/alpine/RangeScene.js'), import('../src/world/alpine/RangeFrame.js'),
  ]);
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, .1, 100000);
  camera.position.set(0, 1000, 1000); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const scene = Object.assign(Object.create(RangeScene.prototype), { THREE, camera });
  const uniforms = sceneUniforms(THREE, { uHeightRange: { value: new THREE.Vector2(0, 2000) } });
  const view = { camera: { eyeStartM: [0, 1000, 1000], eyeEndM: [0, 1000, 1000], targetStartM: [0, 0, 0], targetEndM: [0, 0, 0], fovYDeg: 40 } };
  const frame = { timeMs: 9000, progress01: .3, music: rangeMusicState({}), qualityLevel: 4,
    scenicViewport: { nominalHeight: 720 }, light: { celestial: { xFrac: .7, yFrac: .08, body: 'sun', colorHex: '#ffffff', intensity: 1.6 },
      night01: 0, ambientMultiplier: 1, sky: { top: '#334455', horizon: '#778899', air: '#556677' } } };
  return { uniforms, draw: effects => scene._setUniforms({ uniforms, view }, { ...frame, effects }) };
}

// Execute the production GLSL's scalar math, with GLSL built-ins given their
// scalar semantics. This catches broken envelopes/advection without a GPU.
function shaderScalar(name, args, type = 'float') {
  const match = SCENE_FRAG.match(new RegExp(`${type} ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\s*\\}`));
  assert.ok(match, `production water shader must provide ${name}`);
  const body = match[1].replace(/\bfloat\s+/g, 'let ').replace(/\b(pow|exp|max|min|cos|sin)\(/g, 'Math.$1(');
  return new Function(...args, 'clamp', 'smoothstep', 'mix', body);
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

test('water receives distinct musical channels even when the quality ladder sheds its mirror', async () => {
  assert.ok(sceneUniforms(THREE, {}).uWaterMusic, 'surface music must have per-view uniforms');
  const { uniforms: u, draw } = await receiver();
  draw({ energy: 1, bass: 1, kick: .75, treble: 1, snare: 1, melody: 1, lift: .6 });
  assert.ok(u.uWaterMusic, 'surface music must bind without a mirror pass');
  assert.ok(u.uWaterMusic.value.toArray().every((value, i) => Math.abs(value - [1, .75, 1.6, .6][i]) < 1e-12));
  assert.equal(u.uMirrorAmount.value, 0);
  assert.equal(u.uDeformAmp.value, 0, 'water music does not deform the terrain');
  draw({ energy: NaN, bass: Infinity, kick: -2, treble: 10, snare: -3, melody: NaN, lift: 5 });
  assert.deepEqual(u.uWaterMusic.value.toArray(), [0, 0, .65, 1]);
});

test('water accent slots retain newest valid events and reconstruct without capture history', async () => {
  assert.ok(sceneUniforms(THREE, {}).uWaterAccent, 'accent fronts need bounded per-view storage');
  const { uniforms: u, draw } = await receiver();
  const effects = Object.freeze({ bass: .5, accents: Object.freeze([
    Object.freeze({ ageSec: 3, strength: .4, kind: 'kick', seed: .3 }),
    Object.freeze({ ageSec: .5, strength: .8, kind: 'snare', seed: .2 }),
    Object.freeze({ ageSec: .1, strength: 2, kind: 'melody', seed: .9 }),
    Object.freeze({ ageSec: 1, strength: .6, kind: 'kick', seed: .1 }),
    Object.freeze({ ageSec: 2, strength: .5, kind: 'kick', seed: .4 }),
    Object.freeze({ ageSec: -1, strength: 1, kind: 'kick', seed: .5 }),
  ]) });
  draw(effects);
  assert.ok(u.uWaterAccent, 'accent fronts need bounded uniform slots');
  const first = u.uWaterAccent.value.map(v => v.toArray());
  assert.deepEqual(first, [[.1, 1, .9, 2], [.5, .8, .2, 1], [1, .6, .1, 0], [2, .5, .4, 0]]);
  draw({ accents: [{ ageSec: 8, strength: 1, kind: 'kick', seed: 0 }] });
  assert.ok(u.uWaterAccent.value.every(v => v.y === 0), 'expired accents cannot survive a seek');
  draw(effects);
  assert.deepEqual(u.uWaterAccent.value.map(v => v.toArray()), first);
  draw();
  assert.deepEqual(u.uWaterMusic.value.toArray(), [0, 0, 0, 0]);
  assert.ok(u.uWaterAccent.value.every(v => v.y === 0), 'missing music restores the established water');
});

test('accent waves attack smoothly, travel in world metres and settle to silence', () => {
  const envelope = shaderScalar('waterAccentEnvelope', ['age']);
  assert.equal(envelope(-1, clamp, smoothstep), 0);
  assert.equal(envelope(0, clamp, smoothstep), 0);
  assert.ok(envelope(.12, clamp, smoothstep) > .7);
  assert.ok(envelope(1, clamp, smoothstep) < envelope(.12, clamp, smoothstep));
  assert.equal(envelope(4, clamp, smoothstep), 0);
  const phase = shaderScalar('waterAccentPhase', ['distanceM', 'age', 'wavelength', 'seed']);
  const start = phase(0, 0, 100, .5, clamp, smoothstep);
  assert.ok(Math.abs(phase(70, 1, 100, .5, clamp, smoothstep) - start) < 1e-12,
    'a crest moves 70 world metres in a second without screen-space swimming');
  assert.notEqual(phase(0, 1, 100, .5, clamp, smoothstep), start);
});

test('musical roughness preserves calm water and remains bounded during strong bass and kicks', () => {
  const roughness = shaderScalar('waterMusicRoughness', ['paw', 'low', 'kick']);
  assert.equal(roughness(0, 0, 0, clamp, smoothstep), .03);
  assert.equal(roughness(1, 0, 0, clamp, smoothstep), .09);
  const live = roughness(0, 1, 1, clamp, smoothstep);
  assert.ok(live > .06 && live < .09, 'hits make a readable but modest surface slope');
  assert.ok(roughness(1, 1, 1, clamp, smoothstep) < .24);
  const glint = shaderScalar('waterMusicGlint', ['cosine', 'activity', 'keyEnergy']);
  assert.equal(glint(1, 1, 0, clamp, smoothstep), 0, 'no phantom light during celestial gaps');
  assert.equal(glint(1, 0, 1, clamp, smoothstep), 0, 'silence retains the old direct highlight');
  assert.ok(glint(.99, 1, 1, clamp, smoothstep) > 0);
  assert.ok(glint(1, 1.6, 1, clamp, smoothstep) < .3);
});

test('the score thins and lights the valley mist, and silence restores it exactly', async () => {
  const { uniforms: u, draw } = await receiver();
  const snap = () => [u.uMistDensity.value, ...u.uMistColor.value.toArray()];
  draw(null);
  const quiet = snap();
  draw({ energy: 0, bass: 0, treble: 0, kick: 0, snare: 0, melody: 0, lift: 0 });
  assert.deepEqual(snap(), quiet);
  draw({ energy: 1, bass: 1, lift: 1 });
  const lifted = snap();
  assert.ok(quiet[0] > 0 && Math.abs(lifted[0] - quiet[0] * .77) < 1e-9 * quiet[0], 'thinner mist under a lift');
  assert.ok(lifted.slice(1).every((v, i) => v >= quiet[i + 1] && v <= .9), 'lit from within, still clamped');
  draw(null);
  assert.deepEqual(snap(), quiet);
});

test('the open sky water reflects rises from the horizon band toward the zenith', () => {
  // Evaluated per colour channel: the uniforms enter as scalar arguments.
  const at = shaderScalar('skyReflectAt', ['reflectedY', 'uSkyHorizon', 'uSkyZenith'], 'vec3');
  const sky = y => at(y, .6, .2, clamp, smoothstep, mix);
  assert.equal(sky(0), .3, 'horizon * .5 at a grazing reflection');
  assert.ok(Math.abs(sky(.6) - .1) < 1e-12 && sky(1) === sky(.6), 'zenith * .5 overhead');
  for (let y = .02; y <= 1; y += .02) assert.ok(sky(y) <= sky(y - .02), `monotone toward the zenith at ${y}`);
  assert.doesNotMatch(SCENE_FRAG, /mix\(uSkyZenith, uSkyHorizon, 0\.3\) \* 0\.5/, 'the fixed sky fallback is gone');
  assert.match(SCENE_FRAG, /float skyHere = fres \* \(1\.0 - uBackdropAmount\);/);
});

test('water binds the current sky backdrop at q4 with no mirror', async () => {
  const { RangeScene } = await import('../src/world/alpine/RangeScene.js');
  const uniforms = sceneUniforms(THREE, {});
  const texture = new THREE.Texture();
  uniforms.uMirror.value = new THREE.Texture();
  const scene = Object.assign(Object.create(RangeScene.prototype), { THREE, size: { width: 640, height: 360 }, mirrors: {},
    backdrop: { frame: 7, texture } });
  const p = { uniforms, mirrorLevelM: 1900 };
  scene._prepareMirror(p, { qualityLevel: 4, frameId: 7, timeMs: 1000 }, 'A', 'lake');
  assert.equal(uniforms.uBackdropAmount.value, 1);
  assert.equal(uniforms.uBackdrop.value, texture);
  assert.equal(uniforms.uMirrorAmount.value, 0);
  assert.equal(uniforms.uMirror.value, null);
  scene._prepareMirror({ uniforms, mirrorLevelM: NaN }, { qualityLevel: 0, frameId: 7, timeMs: 1016 }, 'A', 'river');
  assert.equal(uniforms.uBackdropAmount.value, 1, 'independent of the water level');
  scene._prepareMirror(p, { qualityLevel: 4, frameId: 8, timeMs: 1032 }, 'A', 'lake');
  assert.equal(uniforms.uBackdropAmount.value, 0, 'a stale copy is not bound');
  assert.equal(uniforms.uBackdrop.value, null);
});

test('lightning lifts the reflected sky in place, but never flashes a narrative frame that shows no land', async () => {
  const { RangeScene } = await import('../src/world/alpine/RangeScene.js');
  const { rangeMusicState } = await import('../src/world/alpine/RangeFrame.js');
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, .1, 100000);
  camera.position.set(0, 1000, 1000); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const scene = Object.assign(Object.create(RangeScene.prototype), { THREE, camera });
  const uniforms = sceneUniforms(THREE, { uHeightRange: { value: new THREE.Vector2(0, 2000) } });
  const view = { camera: { eyeStartM: [0, 1000, 1000], eyeEndM: [0, 1000, 1000], targetStartM: [0, 0, 0], targetEndM: [0, 0, 0], fovYDeg: 40 } };
  const sky = (storm, narrative) => {
    scene._setUniforms({ uniforms, view }, { timeMs: 9000, progress01: .3, music: rangeMusicState({}), qualityLevel: 0, storm, narrative,
      scenicViewport: { nominalHeight: 720 }, light: { celestial: { xFrac: .7, yFrac: .08, body: 'sun', colorHex: '#ffffff', intensity: 1.6 },
        night01: 0, ambientMultiplier: 1, sky: { top: '#334455', horizon: '#778899', air: '#556677' } } });
    return [...uniforms.uSkyZenith.value.toArray(), ...uniforms.uSkyHorizon.value.toArray()];
  };
  const calm = sky({ amount: 1, flash: 0, flashU: .5, break01: 0, wet01: 1 });
  const lit = sky({ amount: 1, flash: .5, flashU: .5, break01: 0, wet01: 1 });
  lit.forEach((v, i) => assert.ok(Math.abs(v - calm[i] - .06) < 1e-9, 'storm.flash * .12 on every channel'));
  const off = { relief: 0, atmosphere: 1, materials: 1, features: 1, skyDark: 0 };
  assert.deepEqual(sky({ amount: 1, flash: .5, flashU: .5, break01: 0, wet01: 1 }, off), sky({ amount: 1, flash: 0, flashU: .5, break01: 0, wet01: 1 }, off));
});

test('the forest wind follows the heard frame and is still again in silence', async () => {
  const { uniforms: u, draw } = await receiver();
  draw({ energy: 1, lift: 1, bass: 1 });
  assert.ok(Math.abs(u.uWind.value.x - 1.8) < 1e-12 && u.uWind.value.y === 0);
  draw({ energy: 0, bass: 0, treble: 0, kick: 0, snare: 0, melody: 0, lift: 0 });
  assert.deepEqual(u.uWind.value.toArray(), [1, 0]);
  draw({ energy: .5 });
  draw(null);
  assert.deepEqual(u.uWind.value.toArray(), [1, 0]);
});
