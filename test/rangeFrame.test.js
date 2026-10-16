// Range v2 Task 6: the immutable frame snapshot and shared deformation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRangeFrame, viewportState, sceneDeformation, rangeMusicState } from '../src/world/alpine/RangeFrame.js';
import { LerpCache } from '../src/utils/color.js';
import { compileRangeNarrative } from '../src/world/alpine/RangeNarrative.js';

test('narrative frames remove all emitters and retain source activity at final heard time', () => {
  const sim = fakeSim(90);
  const schedule = compileRangeNarrative({ durationMs: 100000, timeline: [
    { tMs: 0, durMs: 100000, vel: 1, role: 'BASS', lane: 'MIDIO', src: 'midi', pitch: 72 },
  ], casting: { midio: 'lead-lane', broshi: 'melody', midasus: 'melody' } });
  sim.rangeNarrativeAt = at => schedule.sample(at);
  const f = buildRangeFrame({ frameId: 1, sim, pose, scenicViewport: vp(1280, 720, 1280, 720), groundViewport: vp(1280, 720, 1280, 720) });
  assert.equal(f.narrative.revelation, 1);
  assert.ok(f.emitters.every(e => !e.visible && e.presence === 0));
  assert.ok(f.music.source.melodicM > 0, 'lead lane transfers even when its role is BASS');
  sim.biomes.tSec = 0;
  const opening = buildRangeFrame({ frameId: 2, sim, pose });
  assert.equal(opening.narrative.revelation, 0);
  assert.equal(opening.light.sky.top, '#fff3db');
});

function fakeSim(tSec = 30, { reducedFlash = false, preview = false } = {}) {
  const profile = { name: 'RAINFOREST', sky: ['#102030', '#304050', '#607080'] };
  const bars = [];
  const mgr = {
    tSec, reducedFlash, terrainPreview: preview, durationMs: 180000, _dayNightCycleMs: 240000,
    energyCurves: { globalEnergyNorm: (t) => 0.5 + 0.4 * Math.sin(t / 4000) },
    currentBlend: { from: 'RAINFOREST', to: 'RAINFOREST', t: 1 },
    world: { response: null }, light: { colorHex: '#c8d8ff', intensity: 0.8 },
    _danceKickMs: tSec * 1000 - 120, _danceKickAmp: 0.8,
    _profile: () => profile, _rotated: (c) => c, lerpCache: new LerpCache(), _airColor: '#556677',
    _ridgeEnvelope: () => ({ groove: 0.6, sustain: 0.5, scaleMul: 1.1, kickMul: 0.7, gesture: 0.2 }),
    groundField: { visibleBars: (worldX, originX, w) => { bars.push(w); return [{ x: 0, width: 20, y: 540, glow: 0 }, { x: 20, width: 20, y: 544 }]; } },
  };
  return {
    biomes: mgr, songSeed: 42, perf: { level: 2 }, stageW: 1280,
    midio: { groundY: 540 }, broshi: { renderX: 300, groundY: 540, hopY: 12, hue: 30, burrow: { depth: 0 } },
    midasus: { p: { x: 800, y: 300 }, yFloor: 520, hue: 300, voyage: { depth: 0.5 } },
    _bars: bars,
  };
}
const pose = { worldX: 1000, midioX: 400, midioDrawX: 402, midioY: 500 };
const vp = (w, h, bw, bh) => viewportState({ logicalWidth: w, logicalHeight: h, backingWidth: bw, backingHeight: bh, overscanPx: 64 });
const scenes = new Map([['RAINFOREST', { view: { id: 'nc-ross-lake-north' }, fallbackReason: null }]]);

test('camera lens respects both accessibility settings in the shared frame', () => {
  const at = (flags = {}) => {
    const sim = fakeSim(20, flags);
    sim.reducedMotion = !!flags.reducedMotion;
    sim.biomes.sections = [{ startMs: 0, relEnergy01: .3 }, { startMs: 20000, role: 'chorus', relEnergy01: .9 }];
    return buildRangeFrame({ frameId: 1, sim, pose }).cameraEffects;
  };
  assert.ok(at().halfAngleScale < .95);
  assert.equal(at({ reducedFlash: true }).halfAngleScale, 1);
  assert.equal(at({ reducedMotion: true }).halfAngleScale, 1);
});

test('glacier journey spans the song and reconstructs independently of quality and DPR', () => {
  const at = (t, quality = 0) => {
    const sim = fakeSim(t); sim.perf.level = quality;
    return buildRangeFrame({ frameId: 1, sim, pose, scenicViewport: vp(1280, 720, 1280 * (quality + 1), 720), groundViewport: vp(1280, 720, 1280, 720) });
  };
  assert.equal(at(0).glacier.retreat01, 0);
  assert.equal(at(180).glacier.retreat01, 1);
  let previous = 0;
  for (let t = 0; t <= 180; t += 5) {
    const state = at(t).glacier;
    assert.ok(state.retreat01 >= previous);
    assert.deepEqual(state, at(t, 6).glacier);
    previous = state.retreat01;
  }
  at(160); at(1);
  assert.deepEqual(at(80).glacier, at(80).glacier);
});

test('the same instant yields the same frozen snapshot', () => {
  const a = buildRangeFrame({ frameId: 1, sim: fakeSim(), pose, scenicViewport: vp(1408, 848, 1920, 1080), groundViewport: vp(1408, 848, 1920, 1080), sceneAssignments: scenes });
  const b = buildRangeFrame({ frameId: 1, sim: fakeSim(), pose, scenicViewport: vp(1408, 848, 1920, 1080), groundViewport: vp(1408, 848, 1920, 1080), sceneAssignments: scenes });
  assert.deepEqual(a, b);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.groundBars) && Object.isFrozen(a.groundBars[0]) && Object.isFrozen(a.music));
  assert.throws(() => { 'use strict'; a.progress01 = 0; });
  assert.equal(a.viewFromId, 'nc-ross-lake-north');
  assert.deepEqual(a.emitters, [], 'listening never publishes personal lights, even for legacy actor-shaped inputs');
});

test('seeking back and forth reconstructs the same frame state', () => {
  const at = (t) => buildRangeFrame({ frameId: 7, sim: fakeSim(t), pose, scenicViewport: vp(1408, 848, 1408, 848), groundViewport: vp(1408, 848, 1408, 848), sceneAssignments: scenes });
  const first = at(61.5);
  at(150); at(2);
  assert.deepEqual(at(61.5), first);
});

test('resolution, DPR and quality never move the geographic camera', () => {
  const sim = fakeSim(80);
  const low = buildRangeFrame({ frameId: 1, sim, pose, scenicViewport: vp(1408, 848, 704, 424), groundViewport: vp(1408, 848, 704, 424) });
  sim.perf.level = 6;
  const high = buildRangeFrame({ frameId: 1, sim, pose, scenicViewport: vp(1408, 848, 3840, 2160), groundViewport: vp(1408, 848, 3840, 2160) });
  assert.equal(low.progress01, high.progress01);
  assert.notEqual(low.qualityLevel, high.qualityLevel);
});

test('preview and missing assignments are explicit', () => {
  const f = buildRangeFrame({ frameId: 1, sim: fakeSim(10, { preview: true }), pose, scenicViewport: vp(1, 1, 1, 1), groundViewport: vp(1, 1, 1, 1) });
  assert.equal(f.progress01, 0.5);
  assert.equal(f.viewFromId, null);
});

test('the support curve comes from visibleBars at the ground viewport width', () => {
  const sim = fakeSim();
  const f = buildRangeFrame({ frameId: 1, sim, pose, scenicViewport: vp(1600, 900, 1600, 900), groundViewport: vp(1408, 848, 1408, 848) });
  assert.deepEqual(sim._bars, [1408]);
  assert.deepEqual(f.groundBars.map((b) => b.y), [540, 544]);
});

test('deformation is bounded, holds valleys still and is a pure function of time', () => {
  const m = rangeMusicState({ env: { groove: 1, sustain: 1, scaleMul: 1.22, kickMul: 1 }, tSec: 12, kickAgeMs: 50, kickAmp: 1 });
  const range = [400, 2800];
  const bound = m.amplitudeM + m.kickM;
  for (let i = 0; i < 200; i++) {
    const x = i * 97 - 9000, z = i * 53 - 4000, y = 400 + (i * 13) % 2400;
    assert.ok(Math.abs(sceneDeformation(m, x, z, y, range)) <= bound + 1e-9);
  }
  assert.equal(sceneDeformation(m, 100, 200, 400, range), 0, 'valley floor holds');
  assert.ok(bound < 60, `macro geology kept: ${bound} m`);
  assert.deepEqual(rangeMusicState({ env: { groove: 1, sustain: 1, scaleMul: 1.22, kickMul: 1 }, tSec: 12, kickAgeMs: 50, kickAmp: 1 }), m);
  const reduced = rangeMusicState({ env: { groove: 1, sustain: 1, scaleMul: 1.22, kickMul: 1 }, tSec: 12, kickAgeMs: 50, kickAmp: 1, reducedFlash: true });
  assert.equal(reduced.amplitudeM, m.amplitudeM, 'reduced flash is a lighting policy');
  assert.equal(sceneDeformation(null, 0, 0, 0, range), 0);
});

test('frame retains resolved approached celestial anchor and converts it through recorded ground transform', () => {
  const sim=fakeSim();
  sim.biomes.celestialState=Object.freeze({activeBody:'moon',sun:{visibility:0,directGain:0},moon:Object.freeze({xFrac:.7,yFrac:.08,altitude01:.9,visibility:1,directGain:.25,colorHex:'#ccddee',radiusFrac:.02}),night01:1,ambientMultiplier:.35});
  sim.biomes._scenicLight={x:896,y:57.6,intensity:.2,colorHex:'#ccddee',dirX:0,dirY:1};
  const scenic=viewportState({logicalWidth:1280,logicalHeight:720,transform:[1,0,0,1,-64,-64]});
  const ground=viewportState({logicalWidth:1280,logicalHeight:720,transform:[2,0,0,2,-64,20]});
  const frame=buildRangeFrame({frameId:1,sim,pose,scenicViewport:scenic,groundViewport:ground});
  assert.equal(frame.light.state,sim.biomes.celestialState);
  assert.equal(frame.light.celestial.xFrac,.7);assert.equal(frame.light.celestial.yFrac,.08);
  assert.equal(frame.light.ambientMultiplier,.35);
  assert.ok(Math.abs(frame.light.ground.x-448)<1e-9);assert.ok(Math.abs(frame.light.ground.y+13.2)<1e-9);
});
