import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { RidgeMotionHistory, createRidgeMusicSampler } from '../src/world/RidgeMotionHistory.js';
import { atmosphereMusic } from '../src/world/alpine/RangeAtmosphere.js';
import { shaftSource } from '../src/world/alpine/SunShaftGL.js';

const channels = ['energy', 'bass', 'treble', 'kick', 'snare', 'melody', 'lift'];
function curves(value = .8) {
  const c = new EnergyCurves(14000);
  c.bands.forEach(b => b.fill(value));
  c.rmsBands = c.bands.map(b => new Float32Array(b.length).fill(value ? .01 : 0));
  return c;
}
const note = (tMs, kind, vel = .9, pitch = 72) => ({ tMs, durMs: 180, src: 'audio', vel,
  role: kind === 'melody' ? 'MELODY' : 'RHYTHM', pitch: kind === 'melody' ? pitch : kind === 'snare' ? 38 : 36,
  kick: kind === 'kick', pitchProvenance: kind === 'melody' ? 'tracked' : 'unpitched', pitchConfidence: 1 });
const history = (timeline, options = {}) => new RidgeMotionHistory({ energyCurves: curves(), timeline,
  durationMs: 14000, ...options });
const sample = (owner, timeMs, options = {}) => {
  assert.equal(typeof owner.sampleEffects, 'function', 'the owning generation exposes its effects response');
  return owner.sampleEffects(timeMs, { seed: 42, ...options });
};
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`);

test('a past seek keeps the provisional snare instead of taking the final analysis kick', () => {
  const previous = history([note(1000, 'snare')]), primary = history([note(1000, 'kick')]);
  const sampler = createRidgeMusicSampler({ previous, primary, handoffStartMs: 3000 });
  const before = sample(previous, 1050);
  assert.ok(before.snare > .4 && before.kick === 0);
  assert.deepEqual(sample(sampler, 1050), before);
  assert.ok(sample(primary, 1050).kick > .4);
});

test('handoff interpolates channels and merges the same onset into one stable trajectory', () => {
  const previous = history([note(3000, 'snare'), note(3100, 'melody', .4, 72)]);
  const primary = history([note(3000, 'kick'), note(3100, 'melody', .9, 74)]);
  const sampler = createRidgeMusicSampler({ previous, primary, handoffStartMs: 3000 });
  const a = sample(previous, 3250), b = sample(primary, 3250), mixed = sample(sampler, 3250);
  for (const key of channels) near(mixed[key], (a[key] + b[key]) / 2, key);
  assert.equal(mixed.accents.length, 3, 'one shared melody onset and the two differently classified drums');
  const melody = mixed.accents.find(e => e.kind === 'melody');
  const oldMelody = a.accents.find(e => e.kind === 'melody'), newMelody = b.accents.find(e => e.kind === 'melody');
  assert.equal(oldMelody.seed, newMelody.seed, 'a pitch refinement must not move the same onset across the sky');
  assert.equal(melody.seed, oldMelody.seed);
  near(melody.strength, (oldMelody.strength + newMelody.strength) / 2, 'shared onset strength');
  near(mixed.accents.find(e => e.kind === 'snare').strength, a.accents.find(e => e.kind === 'snare').strength / 2, 'old snare fades');
  near(mixed.accents.find(e => e.kind === 'kick').strength, b.accents.find(e => e.kind === 'kick').strength / 2, 'new kick enters');
  assert.ok(Object.isFrozen(mixed) && Object.isFrozen(mixed.accents) && mixed.accents.every(Object.isFrozen));
});

test('handoff boundaries are continuous and a silent final generation releases old effects', () => {
  const previous = history([note(2900, 'snare')]), primary = history([], { energyCurves: curves(0) });
  const sampler = createRidgeMusicSampler({ previous, primary, handoffStartMs: 3000 });
  assert.deepEqual(sample(sampler, 3000), sample(previous, 3000));
  assert.deepEqual(sample(sampler, 3500), sample(primary, 3500));
  const a = sample(previous, 3250), middle = sample(sampler, 3250);
  for (const key of channels) near(middle[key], a[key] / 2, key);
  near(middle.accents[0].strength, a.accents[0].strength / 2, 'old event releases');
  for (const [timeMs, owner] of [[3000.001, previous], [3499.999, primary]]) {
    const actual = sample(sampler, timeMs), reference = sample(owner, timeMs);
    for (const key of channels) assert.ok(Math.abs(actual[key] - reference[key]) < 1e-7, key);
  }
  const silent = sample(sampler, 3500);
  for (const key of channels) assert.equal(silent[key], 0, key);
  assert.deepEqual(silent.accents, []);
});

test('owned source copies survive caller mutation before the first effects query', () => {
  const timeline = [note(1000, 'snare')], c = curves();
  const retained = history(timeline, { energyCurves: c });
  const reference = history(timeline.map(e => ({ ...e })), { energyCurves: curves() });
  timeline[0].pitch = 36; timeline[0].kick = true; timeline[0].vel = .1;
  c.bands.forEach(b => b.fill(0)); c.rmsBands.forEach(b => b.fill(0));
  assert.deepEqual(sample(retained, 1050), sample(reference, 1050));
  assert.ok(sample(retained, 1050).snare > .4);
});

test('reverse seeks and repeated paused draws preserve both generations inside handoff', () => {
  const previous = history([note(1000, 'snare'), note(3000, 'snare')]);
  const primary = history([note(1000, 'kick'), note(3000, 'kick')]);
  const options = { previous, primary, handoffStartMs: 3000 };
  const played = createRidgeMusicSampler(options), fresh = createRidgeMusicSampler(options);
  for (const at of [0, 1050, 3000, 3200, 3499.5, 5000, 1050, 3250]) sample(played, at);
  for (const at of [1050, 3250, 3499.5, 3500, 3250]) assert.deepEqual(sample(played, at), sample(fresh, at));
});

test('owned calm cues attenuate effects and expire deterministically', () => {
  const cue = { type: 'calm', tMs: 1000, strength: 1 };
  const timeline = [note(1100, 'snare'), note(12000, 'snare')];
  const cued = history(timeline, { conductorCues: [cue] }), normal = history(timeline);
  cue.strength = 0;
  assert.ok(sample(cued, 1150).snare < sample(normal, 1150).snare);
  assert.ok(sample(cued, 1150).snare > 0);
  assert.deepEqual(sample(cued, 12050), sample(normal, 12050));
  assert.deepEqual(sample(cued, 1150, { calmLevel: 0 }), sample(normal, 1150, { calmLevel: 0 }));
});

test('a dense handoff keeps a fair six-event budget without future trajectories', () => {
  const kinds = ['kick', 'snare', 'melody'];
  const previous = history(Array.from({ length: 18 }, (_, i) => note(2800 + i * 20, kinds[i % 3])));
  const primary = history(Array.from({ length: 18 }, (_, i) => note(2810 + i * 20, kinds[i % 3])));
  const sampler = createRidgeMusicSampler({ previous, primary, handoffStartMs: 3000 });
  const effects = sample(sampler, 3050);
  assert.ok(effects.accents.length <= 6);
  assert.deepEqual(new Set(effects.accents.map(e => e.kind)), new Set(kinds));
  assert.ok(effects.accents.every(e => e.ageSec >= 0 && e.seed >= 0 && e.seed <= 1 && e.strength > 0 && e.strength <= 1));
  for (const kind of kinds) assert.ok(effects.accents.filter(e => e.kind === kind).length <= 2);
});

test('coincident melodic notes share one onset trajectory without gaining strength at handoff', () => {
  const previous = history([note(3000, 'melody', .7, 72), note(3000, 'melody', .8, 76)]);
  const primary = history([note(3000, 'melody', .6, 74)]);
  const sampler = createRidgeMusicSampler({ previous, primary, handoffStartMs: 3000 });
  const a = sample(previous, 3250), b = sample(primary, 3250), mixed = sample(sampler, 3250);
  assert.equal(a.accents.length, 1, 'a chord is one shared physical onset');
  assert.ok(a.accents[0].strength > .79 && a.accents[0].strength <= .8);
  assert.equal(mixed.accents.length, 1);
  near(mixed.accents[0].strength, (a.accents[0].strength + b.accents[0].strength) / 2, 'no duplicate contribution');
});

test('the mist and shafts replay the same score values for the same heard frame', () => {
  const owner = history([note(1000, 'kick'), note(1500, 'melody', .8)]);
  const light = { celestial: { body: 'sun', visibility: 1, intensity: 1.6, xFrac: .5, yFrac: .2 } };
  const at = timeMs => {
    const effects = sample(owner, timeMs);
    return { air: { ...atmosphereMusic(effects) }, shaft: shaftSource({ light, storm: { amount: 0 }, effects }).musicGain };
  };
  const first = [1100, 1600, 4000].map(at);
  at(9000); // play on, then seek back
  assert.deepEqual([1100, 1600, 4000].map(at), first);
  assert.ok(first.some(v => v.air.mistGlow > 0), 'heard music reaches the air');
});
