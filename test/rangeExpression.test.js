import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeMusicState, sceneDeformation, calibrateRangeMusic, sampleRangeMelody } from '../src/world/alpine/RangeFrame.js';
import { buildReceiverMask, sampleReceiverMask } from '../src/world/alpine/TerrainMesh.js';
import CATALOG from '../src/world/terrain/sceneCatalogData.js';

const env = { groove: .5, sustain: .5, scaleMul: 1, kickMul: .4, gesture: 0 };
const base = { env, tSec: 12 };
const at = (m, x = 340, z = 250, y = 1400) => sceneDeformation(m, x, z, y, [200, 2000]);

test('rhythm, sustain, gesture, melody and section each move terrain independently', () => {
  const reference = rangeMusicState(base);
  const changed = [
    rangeMusicState({ ...base, kickAgeMs: 50, kickAmp: 1 }),
    rangeMusicState({ ...base, env: { ...env, sustain: 1 } }),
    rangeMusicState({ ...base, env: { ...env, gesture: 1 } }),
    rangeMusicState({ ...base, melody: { activity: 1, pitch01: .8, pan: -.7 } }),
    rangeMusicState({ ...base, structural01: 1 }),
  ];
  for (const m of changed) assert.notEqual(at(m), at(reference));
  assert.notEqual(at(changed[2], 0, 0, 1100) / at(changed[2], 0, 0, 1900), at(reference, 0, 0, 1100) / at(reference, 0, 0, 1900), 'gesture changes summit shape');
  const left = rangeMusicState({ ...base, melody: { activity: 1, pitch01: .8, pan: -1 } });
  const right = rangeMusicState({ ...base, melody: { activity: 1, pitch01: .8, pan: 1 } });
  assert.notEqual(at(left), at(right));
});

test('melody sampling is causal, confidence gated and independent of dispatch/seek history', () => {
  const timeline = [
    { tMs: 1000, durMs: 1000, role: 'MELODY', vel: .8, pitch: 72, pan: -.5, src: 'midi' },
    { tMs: 2200, durMs: 200, role: 'PAD', vel: 1, pitch: 90, src: 'audio' },
    { tMs: 2500, durMs: 1000, role: 'MELODY', vel: 1, pitch: 84, pitchConfidence: .1, src: 'audio' },
  ];
  assert.equal(sampleRangeMelody(timeline, 999).activity, 0);
  assert.ok(sampleRangeMelody(timeline, 1500).activity > .5);
  assert.equal(sampleRangeMelody(timeline, 2200).activity, 0);
  assert.ok(sampleRangeMelody(timeline, 2800).activity < .2);
  const seek = sampleRangeMelody(timeline, 1500);
  sampleRangeMelody(timeline, 5000); sampleRangeMelody(timeline, 200);
  assert.deepEqual(sampleRangeMelody(timeline, 1500), seek);
});

test('view-depth calibration stays bounded by geology in every approved view', () => {
  const music = rangeMusicState({ ...base, env: { ...env, sustain: 1, gesture: 1 }, kickAgeMs: 50, kickAmp: 1, structural01: 1 });
  for (const view of CATALOG.views.filter(v => v.status === 'approved')) {
    const m = calibrateRangeMusic(music, { view, progress01: .5, heightRange: [200, 2000], nominalHeight: 720 });
    assert.ok(m.totalBoundM <= 117 + 1e-8);
    assert.ok(m.projectedBoundPx >= 3, `${view.id}: ${m.projectedBoundPx}px`);
    for (let i = 0; i < 120; i++) assert.ok(Math.abs(at(m, i * 901, -i * 333, 200 + (i * 31) % 1800)) <= m.totalBoundM + 1e-6);
  }
  const tiny = calibrateRangeMusic(music, { depthM: 40000, fovYDeg: 40, heightRange: [0, 30], nominalHeight: 720 });
  assert.ok(tiny.totalBoundM <= 1.95 + 1e-8);
});

test('higher lakes and shores pin every channel with a common source-space receiver', () => {
  const W = 11, data = new Uint8Array(W * W * 4);
  data[(5 * W + 5) * 4 + 3] = 255;
  const mask = buildReceiverMask({ width: W, height: W, data });
  const music = rangeMusicState({ ...base, env: { ...env, gesture: 1 }, kickAgeMs: 60, kickAmp: 1, structural01: 1 });
  for (const [x, z] of [[5, 5], [4, 5], [6, 6]]) {
    const receiver = sampleReceiverMask(mask, x, z);
    assert.equal(receiver, 0);
    assert.equal(sceneDeformation(music, x, z, 1400, [200, 2000], receiver), 0);
  }
  assert.ok(sampleReceiverMask(mask, 8, 5) > 0);
  assert.equal(sampleReceiverMask(mask, 10, 10), 1);
});

test('reduced motion suppresses geometry; reduced flash leaves geometry intact', () => {
  const full = rangeMusicState({ ...base, kickAgeMs: 50, kickAmp: 1 });
  assert.deepEqual(rangeMusicState({ ...base, kickAgeMs: 50, kickAmp: 1, reducedFlash: true }), full);
  const reduced = rangeMusicState({ ...base, kickAgeMs: 50, kickAmp: 1, reducedMotion: true });
  assert.equal(at(reduced), 0);
});

test('the production GLSL field matches CPU terrain/root displacement for every channel', async () => {
  const { DEFORM_GLSL } = await import('../src/world/alpine/TerrainMaterial.js');
  // Evaluate the exact scalar body embedded in all production vertex shaders,
  // rather than a hand-written imitation of the shader formula.
  const body = DEFORM_GLSL.match(/float deformField\(float h, float along, float across\) \{([\s\S]*?)\n {2}\}/)[1];
  const names = ['uDeformAmp', 'uDeformKick', 'uDeformStructural', 'uDeformMelodic', 'uDeformGesture', 'uDeformK', 'uDeformPhase', 'uMelodyK', 'uMelodyPhase'];
  const glslField = new Function('h', 'along', 'across', ...names, 'sin', body);
  for (let i = 0; i < 250; i++) {
    const m = rangeMusicState({ env: { ...env, sustain: (i % 23) / 23, gesture: (i % 17) / 17 }, tSec: i * .037,
      kickAgeMs: i % 700, kickAmp: .9, melody: { activity: (i % 13) / 13, pitch01: (i % 31) / 31, pan: Math.sin(i) }, structural01: .8 });
    const x = i * 237 - 8000, z = i * -619 + 3500, y = 200 + (i * 79) % 1800, receiver = (i % 11) / 10;
    const expected = receiver * glslField((y - 200) / 1800, x * m.waveDir[0] + z * m.waveDir[1], x * m.melodyDir[0] + z * m.melodyDir[1],
      m.amplitudeM, m.kickM, m.structuralM, m.melodicM, m.gestureM, m.waveK, m.phaseRad, m.melodyK, m.melodyPhaseRad, Math.sin);
    assert.ok(Math.abs(sceneDeformation(m, x, z, y, [200, 2000], receiver) - expected) < 1e-9);
  }
  assert.match(DEFORM_GLSL, /texture\(uReceiver/);
  const { SCENE_VERT, createDepthMaterial } = await import('../src/world/alpine/TerrainMaterial.js');
  assert.ok(SCENE_VERT.includes(DEFORM_GLSL));
  const THREE = await import('../src/vendor/range/three-range.module.js');
  const depth = createDepthMaterial(THREE, {});
  assert.ok(depth.vertexShader.includes(DEFORM_GLSL));
  depth.dispose();
});

test('source receiver interpolation matches the GPU texture at elevated lake samples', async () => {
  const THREE = await import('../src/vendor/range/three-range.module.js');
  const { createSurfaceTexture, terrainUniforms } = await import('../src/world/alpine/TerrainGL.js');
  // One tile contains an elevated flattened lake and higher dry terrain.
  const W = 9, heightsM = new Float32Array(W * W).fill(1400), flowBytes = new Uint8Array(W * W);
  flowBytes[4 * W + 4] = 255;
  const data = { cells: 8, grid: { width: W, height: W, originM: [0, 0], cellSizeM: 10 },
    tiles: new Map([['0', { ix: 0, iz: 0, stride: 1, samples: W, heightsM, flowBytes }]]),
    manifest: { boundsM: { min: [0, 200, 0], max: [80, 2000, 80] } } };
  const s = createSurfaceTexture(THREE, data);
  assert.equal(s.receiverTexture.image.data[4 * W + 4], 0);
  assert.equal(s.receiverTexture.image.data[3 * W + 4], 0, 'shore pins too');
  const u = terrainUniforms(THREE, data, s);
  assert.equal(u.uReceiver.value, s.receiverTexture);
  assert.equal(s.receiverTexture.minFilter, THREE.LinearFilter);
  assert.equal(s.receiverTexture.generateMipmaps, false, 'no mask erosion at distant LOD');
  s.receiverTexture.onUpdate();
  assert.equal(s.receiverTexture.image.data, null, 'CPU mask released after upload');
  s.texture.dispose(); s.receiverTexture.dispose();
});

test('RangeScene sends every calibrated channel to the shared terrain/forest uniforms', async () => {
  const THREE = await import('../src/vendor/range/three-range.module.js');
  const { RangeScene } = await import('../src/world/alpine/RangeScene.js');
  const { sceneUniforms } = await import('../src/world/alpine/TerrainMaterial.js');
  const view = CATALOG.views.find(v => v.status === 'approved');
  const m = rangeMusicState({ ...base, env: { ...env, gesture: .7 }, melody: { activity: .8, pitch01: .6, pan: -.4 }, kickAmp: .9, kickAgeMs: 40, structural01: .5 });
  const u = sceneUniforms(THREE, { uHeightRange: { value: new THREE.Vector2(200, 2000) } });
  const scene = Object.assign(Object.create(RangeScene.prototype), { THREE, camera: new THREE.PerspectiveCamera() });
  const frame = { music: m, progress01: .5, scenicViewport: { nominalHeight: 720 }, timeMs: 12000, qualityLevel: 0,
    light: { celestial: { xFrac: .5, yFrac: .3, body: 'sun', intensity: 1, altitude01: .4, colorHex: '#ffffff' }, night01: 0 } };
  scene._setUniforms({ view, uniforms: u, rules: {}, waterLevelM: 1400 }, frame);
  const calibrated = calibrateRangeMusic(m, { view, heightRange: [200, 2000], progress01: .5, nominalHeight: 720 });
  for (const [key, field] of [['uDeformAmp', 'amplitudeM'], ['uDeformKick', 'kickM'], ['uDeformGesture', 'gestureM'], ['uDeformMelodic', 'melodicM'], ['uDeformStructural', 'structuralM'], ['uMelodyK', 'melodyK'], ['uMelodyPhase', 'melodyPhaseRad']]) assert.equal(u[key].value, calibrated[field]);
  assert.deepEqual(u.uMelodyDir.value.toArray(), calibrated.melodyDir);
});

test('repeated choruses keep the same visible motif while geography remains home', async () => {
  const { rangeSectionMotif } = await import('../src/world/alpine/RangeFrame.js');
  const verse = { label: 0, startMs: 0, relEnergy01: .3, heightMul: .9 };
  const chorus = { label: 1, startMs: 30000, relEnergy01: .8, heightMul: 1.1 };
  const repeat = { ...chorus, startMs: 90000 };
  const a = rangeSectionMotif(chorus, verse, 40000, 42);
  const b = rangeSectionMotif(repeat, verse, 100000, 42);
  assert.deepEqual(a, b, 'repeated label restores light and wave recipe');
  const v = rangeSectionMotif(verse, verse, 40000, 42);
  assert.notEqual(a.hueDeg, v.hueDeg);
  const ma = rangeMusicState({ ...base, motif: a }), mv = rangeMusicState({ ...base, motif: v });
  assert.notEqual(at(ma), at(mv), 'musical recipe reaches terrain without a biome change');
  const beginning = rangeSectionMotif(chorus, verse, chorus.startMs, 42);
  assert.equal(beginning.angle, v.angle, 'boundary starts continuously');
});
