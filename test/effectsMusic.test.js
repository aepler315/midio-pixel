import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { RidgeMotionHistory } from '../src/world/RidgeMotionHistory.js';

import { compileRangeNarrative } from '../src/world/alpine/RangeNarrative.js';
import { compileLandscapeScore } from '../src/world/alpine/LandscapeScore.js';

let sampleEffectsMusic, lastAudibleMs, physicalFloor, sectionTrust;
try { ({ sampleEffectsMusic, lastAudibleMs, physicalFloor, sectionTrust } = await import('../src/world/alpine/EffectsMusic.js')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const sample = options => {
  assert.equal(typeof sampleEffectsMusic, 'function', 'shared effects response is available');
  return sampleEffectsMusic(options);
};
const channels = ['energy', 'bass', 'treble', 'kick', 'snare', 'melody', 'lift'];
function curves(bands = Array(7).fill(.7), rms = .01) {
  const c = new EnergyCurves(6000);
  c.bands.forEach((b, i) => b.fill(bands[i]));
  c.rmsBands = c.bands.map(b => new Float32Array(b.length).fill(rms));
  return c;
}
const midi = (tMs, kind, vel = .9) => ({ tMs, durMs: 180, src: 'midi', vel,
  role: kind === 'melody' ? 'MELODY' : 'RHYTHM', pitch: kind === 'melody' ? 72 : kind === 'snare' ? 38 : 36,
  kick: kind === 'kick', pitchProvenance: 'authored' });
const active = { pressureEnergy01: .8, bassPressure01: .7, bands: [.8, .7, .4, .3, .5, .6, .7],
  kick01: .5, activity01: .8, motionPresence01: 1, motionMelody: { activity: .6, pitch01: .7 } };

test('canonical audibility silences stale normalized bands and noisy onsets', () => {
  const timeline = [midi(1000, 'kick'), midi(1000, 'snare')].map(e => ({ ...e, src: 'audio' }));
  const loud = sample({ timeMs: 1040, ridgeSample: active, timeline });
  const silent = sample({ timeMs: 1040, ridgeSample: { ...active, activity01: 0, motionPresence01: 0 }, timeline });
  assert.ok(loud.energy > .5 && loud.bass > .4 && loud.kick > .4);
  for (const key of channels) assert.equal(silent[key], 0, key);
  assert.deepEqual(silent.accents, []);
});

test('bass and treble retain distinct frequency roles', () => {
  const low = sample({ timeMs: 2000, energyCurves: curves([.9, .8, 0, 0, 0, 0, 0]) });
  const high = sample({ timeMs: 2000, energyCurves: curves([0, 0, 0, 0, .7, .8, .9]) });
  assert.ok(low.bass > .5 && low.treble < .05);
  assert.ok(high.treble > .5 && high.bass < .05);
});

test('fallback physical noise stays silent while quiet recordings and MIDI without curves respond', () => {
  const timeline = [{ ...midi(1000, 'kick'), src: 'audio' }];
  const noise = sample({ timeMs: 1040, timeline, energyCurves: curves(Array(7).fill(.8), 1e-6) });
  for (const key of channels) assert.equal(noise[key], 0, key);
  assert.deepEqual(noise.accents, []);
  const quiet = sample({ timeMs: 1040, timeline, energyCurves: curves(Array(7).fill(.3), .0001) });
  assert.ok(quiet.energy > 0 && quiet.kick > .4);
  const authored = sample({ timeMs: 1040, timeline: [midi(1000, 'kick'), midi(1000, 'melody')] });
  assert.ok(authored.energy > 0 && authored.kick > .4 && authored.melody > .4);
  assert.equal(sample({ timeMs: 5000, timeline: [midi(1000, 'kick')] }).energy, 0);
});

test('fast rhythm accents peak at their real onset and decay independently', () => {
  const timeline = [midi(1000, 'kick'), midi(1000, 'snare'), midi(1000, 'melody')];
  const at = sample({ timeMs: 1000, timeline });
  const after = sample({ timeMs: 1300, timeline });
  assert.ok(at.kick > .7 && at.snare > .7 && at.melody > .5);
  assert.ok(after.snare < after.kick, 'snare light settles faster than the kick body');
  assert.ok(after.melody > after.snare, 'melodic light has a separate longer release');
  assert.ok(after.kick < at.kick);
});

test('future notes and future curve frames never leak into effects', () => {
  const c = curves(Array(7).fill(0));
  c.bands.forEach(b => b.fill(1, 50));
  const timeline = [midi(1000, 'kick')];
  const before = sample({ timeMs: 999.9, timeline, energyCurves: c });
  for (const key of channels) assert.equal(before[key], 0, key);
  assert.deepEqual(before.accents, []);
});

test('dense overlapping events stay bounded, preserve kinds and freeze a small replay snapshot', () => {
  const timeline = Array.from({ length: 2000 }, (_, i) => midi(i, ['kick', 'snare', 'melody'][i % 3], i % 2 ? .2 : 1));
  const result = sample({ timeMs: 2000, ridgeSample: active, timeline, seed: 42 });
  for (const key of channels) assert.ok(Number.isFinite(result[key]) && result[key] >= 0 && result[key] <= 1, key);
  assert.ok(result.accents.length > 0 && result.accents.length <= 6);
  assert.deepEqual(new Set(result.accents.map(a => a.kind)), new Set(['kick', 'snare', 'melody']));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.accents) && result.accents.every(Object.isFrozen));
  assert.ok(result.accents.every(a => Number.isFinite(a.seed) && a.seed >= 0 && a.seed <= 1
    && a.ageSec >= 0 && a.strength > 0 && a.strength <= 1));
});

test('direct seek, reverse seek and repeated paused draws reproduce identical responses', () => {
  const timeline = [midi(1000, 'kick'), midi(1100, 'snare'), midi(1200, 'melody'), midi(2100, 'kick')];
  const c = curves();
  const history = new RidgeMotionHistory({ energyCurves: c, timeline, durationMs: 6000 });
  const at = timeMs => sample({ timeMs, timeline, energyCurves: c, ridgeSample: history.sample(timeMs), seed: 9 });
  const wanted = at(1325.125);
  for (const t of [2000, 1325.125, 0, 3000, 1325.125]) at(t);
  assert.deepEqual(at(1325.125), wanted);
  assert.deepEqual(at(1325.125), wanted);
  assert.deepEqual(sample({ timeMs: 1325.125, timeline: timeline.map(e => ({ ...e })),
    energyCurves: c, ridgeSample: history.sample(1325.125), seed: 9 }), wanted);
});

test('only a trusted increase in section energy earns a brief lift', () => {
  const sections = [{ startMs: 0, endMs: 2000, meanEnergy: .2, relEnergy01: .2, provenance: 'detected' },
    { startMs: 2000, endMs: 4000, meanEnergy: .8, relEnergy01: .9, provenance: 'detected' },
    { startMs: 4000, endMs: 6000, meanEnergy: .9, relEnergy01: 1, provenance: 'decorative' }];
  const read = (timeMs, ss = sections) => sample({ timeMs, ridgeSample: active, sections: ss }).lift;
  assert.equal(read(1999), 0);
  assert.ok(read(2300) > .4);
  assert.equal(read(4300), 0);
  assert.equal(read(2300, [sections[0], { ...sections[1], meanEnergy: .1 }]), 0);
});

test('calm attenuates response without extinguishing real hits, and previews stay still', () => {
  const options = { timeMs: 1040, ridgeSample: active, timeline: [midi(1000, 'kick')] };
  const normal = sample(options), calm = sample({ ...options, calmLevel: 1 });
  assert.ok(calm.kick > .1 && calm.kick < normal.kick);
  assert.ok(calm.energy > .1 && calm.energy < normal.energy);
  const preview = sample({ ...options, preview: true });
  for (const key of channels) assert.equal(preview[key], 0, key);
  assert.deepEqual(preview.accents, []);
});

test('malformed numbers never become draw coordinates or unbounded channels', () => {
  const result = sample({ timeMs: NaN, seed: Infinity, calmLevel: NaN,
    ridgeSample: { activity01: Infinity, motionPresence01: NaN, pressureEnergy01: NaN,
      bassPressure01: -1, kick01: Infinity, bands: [NaN, Infinity], motionMelody: { activity: Infinity } },
    timeline: [{ tMs: NaN }, { ...midi(0, 'kick'), vel: Infinity }, { ...midi(-1, 'snare'), vel: 1 }],
    sections: [{ startMs: NaN, meanEnergy: Infinity }] });
  for (const key of channels) assert.ok(Number.isFinite(result[key]) && result[key] >= 0 && result[key] <= 1, key);
  assert.ok(result.accents.every(a => Number.isFinite(a.ageSec) && Number.isFinite(a.seed) && Number.isFinite(a.strength)));
});

test('MIDI fallback retains a long authored sustain beyond the accent window and settles at note off', () => {
  const timeline = [{ ...midi(1000, 'melody'), role: 'BASS', durMs: 8000 }];
  const sustained = sample({ timeMs: 7000, timeline });
  assert.ok(sustained.energy > .5 && sustained.bass > .5);
  assert.deepEqual(sustained.accents, [], 'a sustain never invents another onset');
  const ended = sample({ timeMs: 9500, timeline });
  for (const key of channels) assert.equal(ended[key], 0, key);
});

test('one section trust rule: decorative and zero-confidence none, inferred half, the rest full', () => {
  assert.equal(sectionTrust({ provenance: 'decorative', confidence: 1 }), 0);
  assert.equal(sectionTrust({ provenance: 'detected', confidence: 0 }), 0);
  assert.equal(sectionTrust({ provenance: 'inferred', confidence: 0 }), 0);
  assert.equal(sectionTrust({ provenance: 'inferred', confidence: .4 }), .5);
  assert.equal(sectionTrust({ provenance: 'detected', confidence: .7 }), 1);
  assert.equal(sectionTrust({ provenance: 'authored' }), 1);
  assert.equal(sectionTrust(null), 0);
  // Lift scales by it, and the landscape score keeps exactly the trusted phrases.
  const base = { startMs: 0, endMs: 2000, meanEnergy: .2, relEnergy01: .2, provenance: 'detected' };
  const rise = { startMs: 2000, endMs: 4000, meanEnergy: .8, relEnergy01: .9 };
  const lift = provenance => sample({ timeMs: 2300, ridgeSample: active, sections: [base, { ...rise, provenance, confidence: .5 }] }).lift;
  assert.ok(Math.abs(lift('inferred') - lift('detected') / 2) < 1e-9);
  assert.equal(lift('decorative'), 0);
  const all = ['detected', 'inferred', 'decorative', 'authored'].map((provenance, i) => ({ startMs: i * 1000, endMs: i * 1000 + 1000,
    provenance, confidence: i === 3 ? 0 : .5, motifId: provenance }));
  assert.deepEqual(compileLandscapeScore({ sections: all, durationMs: 4000 }).phrases.map(p => p.motifId), ['detected', 'inferred']);
});

test('the cadence is the end of the last frame the shared silence gate hears', () => {
  const c = curves(Array(7).fill(.5), .02);
  const tail = Math.ceil(4000 / 20);
  c.bands.forEach(b => b.fill(0, tail));
  c.rmsBands.forEach(b => b.fill(0, tail));
  assert.equal(lastAudibleMs(c, 6000), 4000);
  assert.equal(lastAudibleMs(c, 6000), 4000, 'cached');
  c.rmsBands = c.rmsBands.map(b => Float32Array.from(b, (v, i) => i >= 150 ? 1e-7 : v));
  assert.equal(lastAudibleMs(c, 6000), 3000, 'replaced bands rebuild; quiet noise below the physical floor is silence');
  assert.equal(lastAudibleMs(curves(), 6000), 6000, 'music to the last frame');
  assert.equal(lastAudibleMs(null, 6000), 6000);
  assert.equal(lastAudibleMs({ globalEnergyNorm: () => .5 }, 6000), 6000, 'no frame data, no evidence');
  assert.equal(lastAudibleMs(c, 60000), 60000, 'curves that stop short of the song cannot place its end');
  assert.equal(lastAudibleMs(c, 0), 0);
  const plain = curves(Array(7).fill(.5));
  plain.rmsBands = null;
  plain.bands.forEach(b => b.fill(0, 100));
  assert.equal(lastAudibleMs(plain, 6000), 2000, 'normalized fallback without physical RMS');
});

test('the narrative and the effects share one physical silence floor', () => {
  for (const level of [1e-5, .0005, .02]) {
    const c = new EnergyCurves(120000);
    for (let i = 0; i < c.n; i++) c.setFrame(i, Array(7).fill(i < 3000 ? .01 : .8));
    c.rmsBands = Array.from({ length: 7 }, () => Float32Array.from({ length: c.n }, (_, i) => i < 3000 ? level : .1));
    assert.equal(compileRangeNarrative({ durationMs: 120000, energyCurves: c }).silenceFloor, physicalFloor(c), `rms ${level}`);
  }
});
