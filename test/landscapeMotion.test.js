import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HORIZON_RANGES, horizonCrest, crestHeightAt } from '../src/world/terrain/HorizonRidge.js';
import { loadRangeProfiles } from '../src/world/terrain/RangeLibrary.js';
import { sampleHorizonRidge } from '../src/world/alpine/RidgeMotion.js';
import { horizonEqPoints } from '../src/world/alpine/RidgeComposition.js';
import { rangeMusicState, calibrateRangeMusic, sceneDeformation } from '../src/world/alpine/RangeFrame.js';
import { ridgeEnvelope } from '../src/world/alpine/Ridge.js';
import { ridgeKickEnv } from '../src/world/MountainChoreo.js';

const viewport = { width: 1280, height: 720 };
const crest = { heights: new Float32Array([1, 1]), stepM: 1, windowM: 1, travelM: 0 };
const music = ({ bands = Array(7).fill(0), activity01 = 1, kick01 = 0 } = {}) => ({ bands, activity01, kick01, sources: {} });
const sample = (input = {}, state = music()) => sampleHorizonRidge({ viewport, crest, history: { sample: () => state }, ...input });
const at = (s, x) => s.points.find(p => Math.abs(p.x - x) < 1e-6).y;

test('geographic default travels left three times the frozen reviewed speed with finite endpoints', async () => {
  for (const id of HORIZON_RANGES) {
    const profile = (await loadRangeProfiles(id)).L2;
    const before = horizonCrest(profile, { speedMul: 3, zoom: 1.2 });
    const after = horizonCrest(profile);
    assert.ok(Math.abs(after.travelM / after.windowM / (before.travelM / before.windowM) - 3) < 1e-8, id);
    assert.ok(after.travelM + after.windowM <= profile.spacingM * (profile.angles.length - 1) + 1e-6, id);
    const shift = .01 * after.travelM / after.windowM;
    assert.ok(Math.abs(crestHeightAt(after, .4, .5) - crestHeightAt(after, .41, .5 - shift)) < 1e-6, id);
    assert.equal(crestHeightAt(after, 1, 1), after.heights.at(-1));
  }
});

test('EQ advection moves a bass landmark left at three times the reviewed coefficient', () => {
  const tuning = { crestWavePx: 0, sourceLiftPx: 0, kickLiftPx: 0 };
  const state = music({ bands: [0, 1, 0, 0, 0, 0, 0] });
  const a = sample({ advectionPx: 0, tuning }, state);
  const b = sample({ advectionPx: 1 / .0054, tuning }, state);
  assert.ok(Math.abs(at(b, 0) - (316.8 - 172.8 * (1 / 14 + .5))) < 1e-8, 'one band arrives at the left edge over the shared lift');
  assert.ok(at(b, 0) < at(a, 0) - 80, 'positive worldX advances the local peak left');
});

test('broad crest carrier scales once with viewport height', () => {
  const time = Math.PI / (2 * .8) * 1000;
  assert.ok(Math.abs(at(sample({ heardTimeMs: time }), 0) - (316.8 - 3)) < 1e-8);
  const half = sample({ viewport: { width: 1280, height: 360 }, heardTimeMs: time });
  assert.ok(Math.abs(at(half, 0) - (158.4 - 1.5)) < 1e-8);
  const fallback = sample({ crest: null, heardTimeMs: time });
  assert.ok(Math.abs(at(fallback, 0) - (432 - 4.5)) < 1e-8);
});

test('genuine kick adds 24px crest lift with unchanged attack and exponential settle', () => {
  const neutral = sample({}, music({ activity01: 0 }));
  for (const age of [0, 40, 80, 420, 1200]) {
    const kick01 = ridgeKickEnv(age) * .8;
    const s = sample({ tuning: { crestWavePx: 0 } }, music({ kick01 }));
    assert.ok(Math.abs(at(neutral, 0) - at(s, 0) - 24 * kick01) < 1e-8, `age ${age}`);
  }
  assert.ok(ridgeKickEnv(420) < ridgeKickEnv(80));
});

test('ridge stays smoothly above 0.12H under loud waves and kick while silence rests', () => {
  const loud = music({ bands: Array(7).fill(1), kick01: 1 });
  const y = activity => at(sample({ heardTimeMs: 0, tuning: { maxHeightFrac: .6 } }, music({ bands: Array(7).fill(activity), kick01: activity })), 0);
  assert.ok(sample({ tuning: { maxHeightFrac: .6 } }, loud).points.every(p => p.y >= 86.4));
  assert.ok(y(.99) > y(1), 'saturated peaks still move smoothly instead of hard clipping');
  assert.ok(Math.abs((y(.991) - y(.99)) - (y(.992) - y(.991))) < .1);
  assert.deepEqual(sample({ heardTimeMs: 2000 }, music({ activity01: 0 })).points, sample({}, music({ activity01: 0 })).neutralPoints);
});

test('composition preflight uses identical geometry with effective tuning and evaluated kick', () => {
  const state = music({ bands: [.1, .7, .2, .3, .5, .4, .8], kick01: .6 });
  const tuning = { advection: .0036, phaseRate: 3.2 };
  const painted = sample({ heardTimeMs: 900, advectionPx: 198, tuning }, state);
  const preflight = horizonEqPoints({ ...viewport, crest, bands: state.bands, activity01: state.activity01, kick01: state.kick01, tSec: .9, tuning });
  assert.deepEqual(preflight, painted.points);
});

test('bass flex outweighs treble flex at equal energy and silent floors cannot animate terrain', () => {
  const bass = rangeMusicState({ env: { groove: .5, sustain: .78 }, activity01: .5 });
  const treble = rangeMusicState({ env: { groove: .5, sustain: .1 }, activity01: .5 });
  assert.ok(Math.abs(bass.amplitudeM - 28.84) < 1e-8);
  assert.ok(bass.amplitudeM > treble.amplitudeM * 2);
  const silent = rangeMusicState({ env: ridgeEnvelope(), activity01: 0, evaluatedKick01: 0, structural01: 1, tSec: 12 });
  assert.equal(sceneDeformation(silent, 100, 300, 1800, [0, 2000]), 0);
});

test('calibration uses stable 106.7m reference and activity target; low relief caps never normalize quiet to loud', () => {
  const full = rangeMusicState({ env: { groove: 1, sustain: 1, scaleMul: 1.3, kickMul: 1, gesture: 1 }, evaluatedKick01: 1, melody: { activity: 1, pitch01: 1 }, structural01: 1, activity01: 1 });
  const high = calibrateRangeMusic(full, { depthM: 5000, heightRange: [0, 4000] });
  assert.ok(Math.abs(high.projectedBoundPx - 20) < 1e-8);
  const quiet = rangeMusicState({ env: { groove: .1, sustain: .1 }, activity01: .1 });
  const options = { depthM: 40000, heightRange: [0, 30] };
  const q = calibrateRangeMusic(quiet, options), l = calibrateRangeMusic(full, options);
  assert.ok(Math.abs(q.amplitudeM / quiet.amplitudeM - l.amplitudeM / full.amplitudeM) < 1e-12, 'same cap reference gain preserves amplitude dynamics');
  assert.ok(q.totalBoundM < l.totalBoundM / 10);
  assert.ok(Math.abs(l.totalBoundM - 1.95) < 1e-8);
  assert.equal(sceneDeformation(high, 1000, 2000, 4000, [0, 4000], 0), 0);
});

// Headroom must not make moon metrics depend on the incidental geographic crop.
test('headroom metrics use uncropped authored source stations across geographic travel', () => {
  const state = music({ bands: Array(7).fill(1), kick01: 1 });
  const input = { tuning: { maxHeightFrac: .6 }, heardTimeMs: 1000 };
  const source = { heights: new Float32Array([.1, 1, .5]), stepM: 1, windowM: .5, travelM: 1.5 };
  const a = sample({ ...input, crest: source, songP: .1 }, state);
  const b = sample({ ...input, crest: source, songP: .8, advectionPx: 5000 }, state);
  assert.equal(a.boundPx, b.boundPx, 'fixed design bound cannot shrink with the geographic crop');
  assert.equal(a.displacement01, b.displacement01);
  assert.equal(a.velocity01, b.velocity01);
  const lower = sample({ ...input, crest: { ...source, heights: new Float32Array([.1, .3, .5]) } }, state);
  assert.ok(lower.displacement01 > a.displacement01, 'authored lower crests retain more headroom; metrics do not substitute summit height');
});

test('source framing controls horizontal travel while the broad carrier keeps its own slow tempo', async () => {
  const { BiomeManager } = await import('../src/world/BiomeManager.js');
  for (const [id, relative] of [['rainier', 2], ['tetons', 2], ['sierra-whitney', 3]]) {
    const profile = (await loadRangeProfiles(id)).L2;
    const manager = new BiomeManager({ conductor: { timeline: [], barGrid: [], onBar: () => () => {}, on: () => () => {} },
      durationMs: 1000, canvasWidth: 1280, canvasHeight: 720, groundY: 625, songSeed: 1, worldId: 'range',
      songTerrain: { horizon: { range: { id }, profile } } });
    const before = horizonCrest(profile, { speedMul: 3 });
    assert.ok(Math.abs(manager._horizonCrest.travelM / manager._horizonCrest.windowM / (before.travelM / before.windowM) - relative) < 1e-8);
    assert.ok(Math.abs(manager._horizonTuning.advection - .0018 * relative) < 1e-12);
    assert.equal(manager._horizonTuning.phaseRate, .8);
    assert.equal(manager._horizonCrest.relativeSpeedMul, relative);
    manager.dispose();
  }
});
