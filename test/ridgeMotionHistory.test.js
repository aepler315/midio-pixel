import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpaceRidge } from '../src/world/SpaceRidge.js';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
let api = {};
try { api = await import('../src/world/RidgeMotionHistory.js'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
let geometry = {};
try { geometry = await import('../src/world/alpine/RidgeMotion.js'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const make = (options = {}) => { assert.equal(typeof api.RidgeMotionHistory, 'function', 'canonical source-owned history is available'); return new api.RidgeMotionHistory(options); };
function curves(value = .8, rms = .01, rate = 86.1328) {
  const c = new EnergyCurves(12000, rate);
  c.bands.forEach(b => b.fill(value));
  c.rmsBands = c.bands.map(b => new Float32Array(b.length).fill(rms));
  return c;
}
const note = { tMs: 100, durMs: 200, vel: .8, role: 'MELODY', src: 'midi', pitch: 72 };

test('fresh SpaceRidge samples match playback at identical heard time', () => {
  // Catches frame-history authority in the real painter, even before the new API exists.
  const played = new SpaceRidge(45), seeked = new SpaceRidge(45);
  const h = typeof api.RidgeMotionHistory === 'function' ? make({ energyCurves: curves(), durationMs: 12000 }) : null;
  if (h) { played.history = h; seeked.history = h; }
  for (let t = 20; t <= 4000; t += 20) played.update(t, .02, Array(7).fill(.8));
  seeked.update(4000, .02, Array(7).fill(.8));
  assert.deepEqual(seeked._samples({ width: 1280, height: 720 }), played._samples({ width: 1280, height: 720 }));
});

test('canonical history matches sequential playback, pause, fresh seek and export', () => {
  const input = { energyCurves: curves(), timeline: [{ ...note, src: 'audio', role: 'RHYTHM', kick: true }], durationMs: 12000, generation: 'song:opening' };
  const played = make(input), fresh = make(input);
  for (let t = 0; t < 4873; t += 1000 / 120) played.sample(t);
  assert.deepEqual(played.sample(4873), fresh.sample(4873));
  assert.deepEqual(played.sample(4873), played.sample(4873));
  assert.ok(played.sample(4873).bands[0] > .7);
  assert.ok(Object.isFrozen(played.sample(4873).bands));
  assert.ok(played.checkpointCount <= 8, 'compact two-second checkpoints, not frame/node history');
});

test('off-grid heard time never reads the next source frame or future onset', () => {
  const c = curves(0, .01, 100); c.bands.forEach(b => b[3] = 1);
  const h = make({ energyCurves: c, durationMs: 12000, timeline: [{ ...note, src: 'audio', tMs: 30, role: 'RHYTHM', kick: true }] });
  assert.deepEqual(h.sample(29).bands, Array(7).fill(0));
  assert.equal(h.sample(29).kick01, 0);
  assert.ok(h.sample(39).bands[0] > 0, 'causal residual includes arrived source sample at 30ms');
});

test('new kicks retain a continuous ridge tail instead of resetting it at the onset', () => {
  for (const spacing of [40, 250, 500]) {
    const h = make({ durationMs: 2000, timeline: [0, spacing].map(tMs => ({
      tMs, durMs: 100, vel: 1, src: 'midi', role: 'RHYTHM', kick: true,
    })) });
    const before = h.sample(spacing - .0001).kick01;
    const onset = h.sample(spacing).kick01;
    assert.ok(before > .2, 'the preceding kick still has a visible tail');
    assert.ok(Math.abs(onset - before) < .00001,
      `${spacing}ms kick spacing reset a retained response from ${before} to ${onset}`);
  }
});

test('a weaker overlapping kick preserves the stronger tail and the original single-hit accent', () => {
  const first = { tMs: 0, durMs: 100, vel: 1, src: 'midi', role: 'RHYTHM', kick: true };
  const single = make({ durationMs: 4000, timeline: [first] });
  for (const [at, want] of [[0, 0], [40, .5], [80, 1], [420, .36787944117144233]]) {
    assert.ok(Math.abs(single.sample(at).kick01 - want) < 1e-12, `single hit at ${at}ms`);
  }
  const overlap = make({ durationMs: 4000, timeline: [first, { ...first, tMs: 100, vel: .2 }] });
  assert.ok(overlap.sample(180).kick01 > .74, 'a weaker hit cannot replace the stronger releasing body');
  assert.equal(overlap.sample(180).kickMs, 100, 'event metadata still identifies the newest kick');
  assert.ok(overlap.sample(3000).kick01 > 0, 'release has no arbitrary time cutoff');
  assert.ok(overlap.sample(3000).kick01 < .001, 'the retained body still settles');
});

test('dense kick overlap stays bounded and reproduces after sparse queries, cold seeks and handoff', () => {
  const timeline = Array.from({ length: 90 }, (_, i) => ({ tMs: 37 + i * 13.5, durMs: 20,
    vel: i % 3 === 0 ? 1 : .2, src: 'midi', role: 'RHYTHM', kick: true }));
  const input = { timeline, durationMs: 4000 };
  const played = make(input), cold = make(input);
  for (let at = 0; at < 2000; at += 1000 / 120) {
    const value = played.sample(at).kick01;
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `unbounded overlap at ${at}ms: ${value}`);
  }
  for (const at of [1295.125, 37, 644.5, 2000, 36.999, 900.25]) {
    assert.equal(played.sample(at).kick01, cold.sample(at).kick01, `query-order dependence at ${at}ms`);
  }
  assert.equal(cold.sample(36.999).kick01, 0, 'the first future kick cannot contribute');
  const silence = make({ durationMs: 4000 });
  const handoff = api.createRidgeMusicSampler({ previous: played, primary: silence, handoffStartMs: 1000 });
  assert.equal(handoff.sample(1250).kick01, played.sample(1250).kick01 / 2);
  const frozen = geometry.sampleHorizonRidge({ viewport: { width: 1280, height: 720 },
    history: played, heardTimeMs: 644.5, reducedMotion: true });
  assert.deepEqual(frozen.points, frozen.neutralPoints, 'dense kicks do not bypass reduced motion');
});

test('physical noise is silent while quiet sustained music keeps its response', () => {
  const noise = make({ energyCurves: curves(.8, 1e-6), durationMs: 12000 });
  const quiet = make({ energyCurves: curves(.2, .0001), durationMs: 12000 });
  assert.equal(noise.sample(2000).activity01, 0); assert.equal(noise.sample(2000).bands[0], 0);
  assert.ok(quiet.sample(2000).activity01 > 0); assert.ok(quiet.sample(2000).bands[0] > .1);
});

test('authored MIDI tails survive absent bands and shared sources do not gain synthetic pitch', () => {
  const h = make({ timeline: [note, { ...note, pitchProvenance: 'synthetic', pitchConfidence: 1, src: 'audio', role: 'BASS' }], durationMs: 1000 });
  assert.ok(h.sample(350).activity01 > 0); assert.equal(h.sample(421).activity01, 0);
  const s = h.sample(200).sources;
  assert.equal(s.broshi.source, s.midasus.source); assert.equal(s.broshi.activity, .8);
  assert.equal(s.midio.pitchActivity, 0);
});

test('immutable snapshots and recorded handoff reproduce playback, restart and export inside the blend', () => {
  const c = curves(.2); const previous = make({ energyCurves: c, durationMs: 12000, generation: '42:opening' });
  c.bands.forEach(b => b.fill(.9));
  const primary = make({ energyCurves: c, durationMs: 12000, generation: '42:final' });
  const sampler = api.createRidgeMusicSampler({ primary, previous, handoffStartMs: 3000 });
  const reconstructed = api.createRidgeMusicSampler({ primary, previous, handoffStartMs: 3000 });
  assert.deepEqual(sampler.stateKey, { primaryGeneration: '42:final', previousGeneration: '42:opening', handoffStartMs: 3000, handoffDurationMs: 500 });
  assert.deepEqual(sampler.sample(3250), reconstructed.sample(3250));
  assert.ok(Math.abs(sampler.sample(3250).bands[0] - .55) < .001);
  assert.ok(previous.sample(4000).bands[0] < .21, 'later source mutation cannot alter the provisional history');
  assert.notDeepEqual(api.createRidgeMusicSampler({ primary }).stateKey, sampler.stateKey);
});

test('paint geometry and neutral measurements share seeded points and reduced motion freezes geometry', () => {
  const history = make({ energyCurves: curves(), durationMs: 12000 });
  assert.equal(typeof geometry.sampleSpaceRidge, 'function');
  const seededGeometry = new SpaceRidge(45);
  const input = { viewport: { width: 1280, height: 720 }, seededGeometry, history, heardTimeMs: 4000 };
  const s = geometry.sampleSpaceRidge(input);
  assert.ok(s.displacement01 > 0); assert.ok(s.points.every((p, i) => i === 0 || p.x >= s.points[i - 1].x + 3));
  seededGeometry.history = history; seededGeometry.update(4000, .02, []);
  assert.deepEqual(seededGeometry._samples(input.viewport).pts, s.points);
  const frozen = geometry.sampleSpaceRidge({ ...input, reducedMotion: true });
  assert.deepEqual(frozen.points, frozen.neutralPoints); assert.equal(frozen.velocity01, 0);
  assert.deepEqual(frozen.points, geometry.sampleSpaceRidge({ ...input, reducedMotion: true, heardTimeMs: 9000 }).points);
  const silent = make({ durationMs: 12000 });
  const dance = geometry.sampleHorizonRidge({ ...input, history: silent, advectionPx: 80, songP: .5 });
  assert.deepEqual(dance.points, dance.neutralPoints, 'silence has no decorative musical wave');
});

test('noise-derived source notes and kicks cannot animate otherwise silent musical geometry', () => {
  const history = make({ energyCurves: curves(.9, 1e-6), durationMs: 12000,
    timeline: [{ ...note, src: 'audio', role: 'BASS', tMs: 1000, durMs: 1000 }, { ...note, src: 'audio', role: 'RHYTHM', tMs: 1000, kick: true }] });
  const sample = history.sample(1080);
  assert.equal(sample.kick01, 0); assert.equal(sample.sources.midio.activity, 0);
  const dance = geometry.sampleHorizonRidge({ viewport: { width: 1280, height: 720 }, history, heardTimeMs: 1080 });
  assert.deepEqual(dance.points, dance.neutralPoints);
});

test('canonical musical displacement releases after silence and missing band arrays stay finite', () => {
  const c = curves(.8, .01, 50);
  c.bands.forEach(b => b.fill(0, 50)); c.rmsBands.forEach(b => b.fill(0, 50));
  c.bands[6] = new Float32Array(); c.rmsBands[6] = new Float32Array();
  const h = make({ energyCurves: c, durationMs: 12000 });
  assert.ok(h.sample(900).spaceLevels[0] > .3);
  assert.equal(h.sample(900).bands[6], 0);
  assert.ok(h.sample(11000).spaceLevels[0] < .0001);
  assert.ok(h.sample(11000).spaceDepths.every(Number.isFinite));
});

test('SpaceRidge lighting accents reconstruct from causal threshold crossings after a cold seek', () => {
  const c = curves(0, .01, 50); c.bands.forEach(b => b.fill(1, 50, 65));
  const h = make({ energyCurves: c, durationMs: 12000 });
  const first = h.sample(1100);
  assert.ok(first.spaceFlash01?.[0] > 0, 'a threshold crossing supplies its bounded flash envelope');
  assert.deepEqual(first.spaceFlash01, make({ energyCurves: c, durationMs: 12000 }).sample(1100).spaceFlash01);
  assert.equal(h.sample(2000).spaceFlash01[0], 0);
});

test('song-owned stateKey and both ridge samples survive real simulation seek and export reconstruction inside the blend', async () => {
  const { Simulation } = await import('../src/sim/Simulation.js');
  const { Conductor } = await import('../src/core/Conductor.js');
  const { ParamBus } = await import('../src/core/ParamBus.js');
  const { buildRangeFrame } = await import('../src/world/alpine/RangeFrame.js');
  const previous = make({ energyCurves: curves(.2), durationMs: 12000, generation: 'session:opening' });
  const primary = make({ energyCurves: curves(.9), durationMs: 12000, generation: 'session:final' });
  const ridgeMusicSession = api.createRidgeMusicSampler({ previous, primary, handoffStartMs: 3000 });
  const makeSim = () => {
    const conductor = new Conductor(); conductor.load({ timeline: [], durationMs: 12000, bpm: 120, barGrid: [] });
    const sim = new Simulation(conductor, new ParamBus(), { energyCurves: curves(.9), songSeed: 45, ridgeMusicSession });
    sim.biomes.pumpStripPrewarm = () => {}; return sim;
  };
  const played = makeSim(), seeked = makeSim(), exported = makeSim();
  try {
    for (let at = 0; at <= 3250; at += 10) played.step(10, at);
    seeked.startAt(3250); exported.startAt(3250);
    const frames = [played, seeked, exported].map(sim => buildRangeFrame({ frameId: 1, sim,
      pose: { worldX: 80, midioX: 220, midioY: 625 } }));
    assert.deepEqual(frames[0].ridges.stateKey, ridgeMusicSession.stateKey);
    assert.deepEqual(frames[0].ridges, frames[1].ridges);
    assert.deepEqual(frames[0].ridges, frames[2].ridges);
    assert.equal(frames[0].music.activity01, frames[2].music.activity01);
    assert.equal(frames[0].music.kick01, ridgeMusicSession.sample(3250).kick01);
    const pausedPoints = seeked.biomes._horizonEqPoints({ width: 1280, height: 720 }, 80);
    assert.deepEqual(pausedPoints, seeked.biomes._horizonEqPoints({ width: 1280, height: 720 }, 80));
    assert.deepEqual(pausedPoints, frames[1].ridges.dance.points);
  } finally { [played, seeked, exported].forEach(s => s.dispose()); }
});

test('repeated heard-time queries reuse the immutable sample rather than advance a filter', () => {
  const h = make({ energyCurves: curves(), durationMs: 12000 });
  assert.equal(h.sample(4373), h.sample(4373));
});

test('actual simulation poses reconstruct asymmetric ridge bands after cold and backward seeks', async () => {
  const { Simulation } = await import('../src/sim/Simulation.js');
  const { Conductor } = await import('../src/core/Conductor.js');
  const { ParamBus } = await import('../src/core/ParamBus.js');
  const { buildRangeFrame } = await import('../src/world/alpine/RangeFrame.js');
  const source = curves(.05, .01, 50); source.bands[0].fill(.9);
  const session = api.createRidgeMusicSampler({ primary: make({ energyCurves: source, durationMs: 12000 }) });
  const makeSim = () => {
    const c = new Conductor(); c.load({ timeline: [], durationMs: 12000, bpm: 120, barGrid: [] });
    const sim = new Simulation(c, new ParamBus(), { energyCurves: source, songSeed: 45, ridgeMusicSession: session });
    sim.biomes.pumpStripPrewarm = () => {}; return sim;
  };
  const played = makeSim(), seeked = makeSim();
  const frame = sim => buildRangeFrame({ frameId: 1, sim, pose: sim.lerpState(1) });
  try {
    for (let at = 0; at <= 4000; at += 10) played.step(10, at);
    seeked.startAt(4000);
    assert.notEqual(played.worldX, seeked.worldX, 'exercise different real spatial origins');
    assert.deepEqual(frame(played).ridges.dance.points, frame(seeked).ridges.dance.points);
    seeked.startAt(9000); seeked.startAt(4000);
    assert.deepEqual(frame(played).ridges, frame(seeked).ridges);
    for (const sim of [played, seeked]) sim.biomes._horizonCrest = { heights: Float32Array.of(.4, 1, .2, .8), windowM: 2, travelM: 1, stepM: 1 };
    assert.deepEqual(frame(played).ridges.dance.points, frame(seeked).ridges.dance.points);
    assert.deepEqual(played.biomes._horizonEqPoints({ width: 1280, height: 720 }, played.worldX),
      seeked.biomes._horizonEqPoints({ width: 1280, height: 720 }, seeked.worldX));
  } finally { played.dispose(); seeked.dispose(); }
});

test('physical pressure releases at a silence edge without snapping either geometry or calibration', async () => {
  const { rangeMusicState, calibrateRangeMusic, sceneDeformation } = await import('../src/world/alpine/RangeFrame.js');
  const { ridgeEnvelope } = await import('../src/world/alpine/Ridge.js');
  const c = curves(.8, .01, 50);
  c.bands.forEach(b => b.fill(0, 50)); c.rmsBands.forEach(b => b.fill(0, 50));
  const h = make({ energyCurves: c, durationMs: 12000 });
  const musicAt = t => {
    const s = h.sample(t);
    return rangeMusicState({ env: ridgeEnvelope({ energy: s.pressureEnergy01, bass: s.bassPressure01 }),
      activity01: s.activity01, motionPresence01: s.motionPresence01, calibrationActivity01: s.pressureEnergy01,
      evaluatedKick01: s.kick01, tSec: t / 1000 });
  };
  const samples = [999.9, 1000].map(t => h.sample(t));
  assert.ok(samples[0].motionPresence01 > .99);
  assert.ok(Math.abs(samples[0].motionPresence01 - samples[1].motionPresence01) < .001);
  for (const calibrate of [m => m, m => calibrateRangeMusic(m, { depthM: 800, heightRange: [0, 2000] })]) {
    const ys = [999.9, 1000].map(t => sceneDeformation(calibrate(musicAt(t)), 1200, 0, 2000, [0, 2000]));
    assert.ok(Math.abs(ys[0] - ys[1]) < .1, `silence discontinuity ${ys}`);
  }
  const after = musicAt(7000);
  assert.equal(after.motionPresence01, 0);
  assert.equal(sceneDeformation(after, 1200, 0, 2000, [0, 2000]), 0);
  const cold = make({ energyCurves: c, durationMs: 12000 });
  for (let t = 0; t < 1600; t += 17) h.sample(t);
  assert.deepEqual(h.sample(1553), cold.sample(1553));
  assert.ok(h.sample(1100).motionPresence01 > h.sample(1553).motionPresence01);
});

test('physical presence stays neutral for noise but follows quiet music, MIDI tails and recorded handoff', () => {
  const noise = make({ energyCurves: curves(.8, 1e-6), durationMs: 12000 });
  const quiet = make({ energyCurves: curves(.2, .0001), durationMs: 12000 });
  assert.equal(noise.sample(1000).motionPresence01, 0);
  assert.ok(quiet.sample(1000).motionPresence01 > .99);
  const midi = make({ timeline: [note, { ...note, tMs: 550 }], durationMs: 2000 });
  assert.equal(midi.sample(99).motionPresence01, 0);
  assert.ok(midi.sample(400).motionPresence01 > .8, 'audible note tail sustains presence');
  assert.ok(midi.sample(700).motionPresence01 > midi.sample(540).motionPresence01, 'second onset interrupts release');
  const sampler = api.createRidgeMusicSampler({ previous: noise, primary: quiet, handoffStartMs: 2000 });
  const expected = (noise.sample(2250).motionPresence01 + quiet.sample(2250).motionPresence01) / 2;
  assert.equal(sampler.sample(2250).motionPresence01, expected);
});

test('authored calm cue value uses the same strength contract as live conductor dispatch', () => {
  const c = curves(0, .01, 50); c.bands.forEach(b => b.fill(1, 250));
  const plain = make({ energyCurves: c, durationMs: 12000 });
  const zeroCue = make({ energyCurves: c, durationMs: 12000, conductorCues: [{ kind: 'calm', tMs: 5000, value: 0 }] });
  assert.deepEqual(zeroCue.sample(5500).spaceLevels, plain.sample(5500).spaceLevels);
});

test('paused SpaceRidge draw respects a newly enabled reduced-motion policy', () => {
  const history = make({ energyCurves: curves(), durationMs: 12000 });
  const ridge = new SpaceRidge(45); ridge.history = history; ridge.update(4000, .02, []);
  let drawn = null;
  const ctx = new Proxy({ globalAlpha: 1, moveTo(x, y) { drawn ??= { x, y }; }, createLinearGradient() { return { addColorStop() {} }; } },
    { get(obj, key) { return key in obj ? obj[key] : () => {}; } });
  ridge.draw(ctx, { width: 1280, height: 720 }, '#ffffff', 4, false, 1, 0, true, 0);
  const neutral = geometry.sampleSpaceRidge({ viewport: { width: 1280, height: 720 }, seededGeometry: ridge, history, heardTimeMs: 4000, reducedMotion: true }).points[0];
  assert.deepEqual(drawn, { x: neutral.x, y: neutral.y });
});

test('real-mountain pressure retains its broad raw-source window independently of fast EQ and kick accents', () => {
  const c = curves(0, .01, 50); c.bands.forEach(b => b.fill(1, 150));
  const h = make({ energyCurves: c, durationMs: 12000, timeline: [{ ...note, tMs: 3000, role: 'RHYTHM', src: 'audio', kick: false }] });
  const s = h.sample(3050);
  assert.ok(s.bands[0] > .4);
  assert.ok(s.bassPressure01 > 0 && s.bassPressure01 < .06, 'pressure is a broad trailing raw read, not twice-smoothed fast EQ');
  assert.equal(s.kick01, 0); assert.ok(s.rhythmAccent01 > .4, 'genuine non-kick rhythm still sharpens summits');
});

test('final analysis received on the picker binds the chosen immutable response before first playback', () => {
  const c = curves(0, .01, 50); c.bands.forEach(b => b.fill(1, 150));
  const data = { energyCurves: c, durationMs: 12000, timeline: [] };
  const defaultInput = api.upgradeRidgeMusicSession(data, data, null, 'new-load:final');
  data.ridgeResponse = { smoothingMs: 2000 };
  const chosen = api.ensureRidgeMusicSession(data);
  assert.ok(Math.abs(chosen.sample(3050).bassPressure01 - .03) < 1e-9);
  assert.notDeepEqual(chosen.stateKey, defaultInput.stateKey, 'a distinct response snapshot has a distinct generation input');
  assert.equal(api.ensureRidgeMusicSession(data), chosen, 'restart retains the selected response and stateKey');
});

test('SpaceRidge tuning changes the painted lift while retaining its authored neutral shape and normalized metric', () => {
  const history = make({ energyCurves: curves(), durationMs: 12000 });
  const input = { viewport: { width: 1280, height: 720 }, seededGeometry: new SpaceRidge(45), heardTimeMs: 4000, history };
  const normal = geometry.sampleSpaceRidge(input), taller = geometry.sampleSpaceRidge({ ...input, tuning: { musicHeightFrac: .22, sourceLiftPx: 20 } });
  assert.deepEqual(taller.neutralPoints, normal.neutralPoints);
  assert.ok(Math.abs((taller.neutralPoints[10].y - taller.points[10].y) - 2 * (normal.neutralPoints[10].y - normal.points[10].y)) < 1e-9);
  assert.equal(taller.displacement01, normal.displacement01);
});

test('recorded analysis handoff preserves shared provisional ownership and deduplicates real source identities inside a changed-lane blend', () => {
  const previous = make({ durationMs: 12000, generation: 'ownership:opening', timeline: [{ ...note, durMs: 9000 }] });
  const primary = make({ durationMs: 12000, generation: 'ownership:final', timeline: [{ ...note, role: 'PAD', lane: 'MIDASUS', pitch: 84, durMs: 9000 }] });
  const sampler = api.createRidgeMusicSampler({ primary, previous, handoffStartMs: 3000 });
  assert.deepEqual(sampler.stateKey, { primaryGeneration: 'ownership:final', previousGeneration: 'ownership:opening', handoffStartMs: 3000, handoffDurationMs: 500 });
  const before = sampler.sample(200);
  assert.equal(before.sources.midasus.source, 'role:MELODY');
  assert.equal(before.sources.broshi.source, before.sources.midasus.source);
  assert.equal(before, previous.sample(200), 'pre-schedule seeks return the complete original immutable snapshot');
  assert.equal(sampler.sample(3000), previous.sample(3000));
  const middle = sampler.sample(3250);
  assert.equal(middle.sources.midasus.source, null, 'a blend of distinct source identities cannot claim either single owner');
  assert.deepEqual(middle.sources.midasus.contributors.map(c => [c.source, c.activity]), [['role:MELODY', .4], ['lane:MIDASUS', .4]]);
  assert.equal(middle.sources.midasus.activity, .8);
  assert.equal(middle.sources.broshi.activity, .4);
  const activeSources = Object.values(middle.sourceContributions).filter(s => s.activity > 0);
  assert.deepEqual(activeSources.map(s => [s.source, s.activity]), [['role:MELODY', .4], ['lane:MIDASUS', .4]], 'shared role contribution is counted once across both aliases');
  assert.equal(activeSources.reduce((sum, s) => sum + s.activity, 0), .8);
  assert.ok(Object.isFrozen(middle.sourceContributions) && Object.isFrozen(middle.sources.midasus.contributors));
  const fresh = api.createRidgeMusicSampler({ primary, previous, handoffStartMs: 3000 });
  assert.deepEqual(fresh.stateKey, sampler.stateKey); assert.deepEqual(fresh.sample(3250), middle);
  assert.equal(sampler.sample(3500), primary.sample(3500), 'final ownership is restored exactly at completion');
});

test('actual physical melodic geometry releases across silence while raw source ownership is gated', async () => {
  const { Simulation } = await import('../src/sim/Simulation.js');
  const { Conductor } = await import('../src/core/Conductor.js');
  const { ParamBus } = await import('../src/core/ParamBus.js');
  const { buildRangeFrame, sceneDeformation } = await import('../src/world/alpine/RangeFrame.js');
  const c = curves(.8, .01, 50); c.bands.forEach(b => b.fill(0, 50)); c.rmsBands.forEach(b => b.fill(0, 50));
  const timeline = [{ tMs: 100, durMs: 1000, vel: 1, src: 'audio', role: 'BASS', pitch: 84, pitchConfidence: 1, pitchProvenance: 'tracked' }];
  const h = make({ energyCurves: c, durationMs: 12000, timeline });
  const conductor = new Conductor(); conductor.load({ timeline, durationMs: 12000, bpm: 120, barGrid: [] });
  const sim = new Simulation(conductor, new ParamBus(), { energyCurves: c, songSeed: 45, ridgeMusicSession: h });
  sim.biomes.pumpStripPrewarm = () => {};
  const at = t => { sim.startAt(t); return buildRangeFrame({ sim, pose: sim.lerpState(1) }).music.source; };
  try {
    const a = at(999.9), b = at(1000);
    assert.ok(a.melodicM > 1);
    assert.ok(Math.abs(sceneDeformation(a, 1200, 900, 1500, [0, 2000]) - sceneDeformation(b, 1200, 900, 1500, [0, 2000])) < .1);
    assert.equal(h.sample(1000).sources.midio.pitchActivity, 0, 'raw source remains noise-gated');
    assert.equal(at(7000).melodicM, 0);
    assert.deepEqual(h.sample(1553), make({ energyCurves: c, durationMs: 12000, timeline }).sample(1553));
    const noise = make({ energyCurves: curves(.8, 1e-6), durationMs: 12000, timeline });
    assert.equal(noise.sample(900).motionMelody.activity, 0);
    const blend = api.createRidgeMusicSampler({ primary: noise, previous: h, handoffStartMs: 500 });
    assert.equal(blend.sample(750).motionMelody.activity, h.sample(750).motionMelody.activity / 2);
  } finally { sim.dispose(); }
});
