import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileMood, moodColor, moodAlpha, MOOD_STOPS, MOOD_ALPHA } from '../src/world/alpine/MoodScore.js';
import { sampleEffectsMusic, blendEffectsMusic } from '../src/world/alpine/EffectsMusic.js';
import { sampleSkyPerformance } from '../src/world/alpine/SkyPerformance.js';

const RATE = 50;
/** Synthetic curves: `shape(tSec)` -> { level, bright } (0..1 each). */
function curves(seconds, shape) {
  const n = seconds * RATE;
  const bands = Array.from({ length: 7 }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const { level, bright } = shape(i / RATE);
    for (let b = 0; b < 7; b++) bands[b][i] = level * (b >= 5 ? bright : b <= 2 ? 1 - bright : .5);
  }
  return { rateHz: RATE, bands, rmsBands: bands.map(b => b.map(v => v * .1)),
    globalEnergyNorm: (t) => { const i = Math.min(n - 1, Math.floor(t * RATE / 1000)); return shape(i / RATE).level; } };
}
const beats = (seconds, hz) => Array.from({ length: Math.floor(seconds * hz) }, (_, i) => ({ tMs: i * 1000 / hz, vel: .8, role: 'RHYTHM', pitch: 36, kick: true }));
const key = (seconds, majorness, confidence) => Array.from({ length: seconds + 1 }, (_, s) => ({ tMs: s * 1000, tonic: 0,
  mode: majorness < 0 ? 'minor' : 'major', majorness, confidence }));

test('a sparse, dark, minor passage reads blue; a full, bright, major one reads warm', () => {
  const sad = compileMood({ energyCurves: curves(30, () => ({ level: .15, bright: .1 })), tonalityTimeline: key(30, -.9, .6),
    timeline: beats(30, .5), durationMs: 30000 }).at(25000);
  const happy = compileMood({ energyCurves: curves(30, () => ({ level: .85, bright: .7 })), tonalityTimeline: key(30, .9, .6),
    timeline: beats(30, 6), durationMs: 30000 }).at(25000);
  assert.ok(sad.mood01 < .25, `sad mood ${sad.mood01}`);
  assert.ok(happy.mood01 > .75, `happy mood ${happy.mood01}`);
  assert.ok(sad.rgb[2] > sad.rgb[0], 'blue dominates the sad hue');
  assert.ok(happy.rgb[0] > happy.rgb[2], 'red/orange dominates the happy hue');
});

test('an unsure key gives way to the spectrum instead of swinging the hue', () => {
  const shape = () => ({ level: .8, bright: .65 });
  const trusted = compileMood({ energyCurves: curves(20, shape), tonalityTimeline: key(20, -1, .9), timeline: beats(20, 5), durationMs: 20000 }).at(18000);
  const unsure = compileMood({ energyCurves: curves(20, shape), tonalityTimeline: key(20, -1, .02), timeline: beats(20, 5), durationMs: 20000 }).at(18000);
  assert.ok(unsure.mood01 > trusted.mood01 + .2, `${unsure.mood01} vs ${trusted.mood01}`);
});

test('the mood is causal and turns like weather', () => {
  // Dark and empty for 10 s, then bright and full.
  const shape = (t) => (t < 10 ? { level: .1, bright: .1 } : { level: .9, bright: .7 });
  const score = compileMood({ energyCurves: curves(30, shape), timeline: [], durationMs: 30000 });
  const before = score.at(9900), just = score.at(10100), later = score.at(20000);
  assert.ok(Math.abs(just.mood01 - before.mood01) < .02, 'no step at the change');
  assert.ok(later.mood01 > before.mood01 + .3, 'the hue follows within seconds');
  // Same inputs, same answer: a pure function of heard time.
  assert.deepEqual(score.at(15000), score.at(15000));
});

test('silence settles cool, and no analysis means no grade', () => {
  const silent = compileMood({ energyCurves: curves(20, () => ({ level: 0, bright: .5 })), durationMs: 20000 }).at(19000);
  assert.ok(silent.mood01 < .4);
  assert.equal(compileMood({}).at(1000).alpha, 0);
});

test('the colour spectrum and strength stay in range', () => {
  assert.deepEqual(moodColor(0), [...MOOD_STOPS[0].rgb]);
  assert.deepEqual(moodColor(1), [...MOOD_STOPS.at(-1).rgb]);
  for (let m = 0; m <= 1; m += .05) for (const f of [0, .5, 1]) {
    const a = moodAlpha(m, f);
    assert.ok(a >= MOOD_ALPHA.min - 1e-9 && a <= MOOD_ALPHA.max + 1e-9, `alpha ${a}`);
  }
  assert.ok(moodAlpha(0, 0) > moodAlpha(.5, .5), 'stronger away from neutral');
});

test('hats become their own short accent and never displace kicks or melody', () => {
  const timeline = [
    ...Array.from({ length: 16 }, (_, i) => ({ tMs: 1000 + i * 60, vel: .9, role: 'RHYTHM', pitch: 42 })),
    { tMs: 1500, vel: 1, role: 'RHYTHM', pitch: 36, kick: true },
    { tMs: 1600, vel: 1, role: 'MELODY', pitch: 64, pitchConfidence: 1, pitchProvenance: 'tracked' },
  ];
  const effects = sampleEffectsMusic({ timeMs: 1980, timeline, energyCurves: curves(5, () => ({ level: .6, bright: .5 })) });
  const kinds = effects.accents.map(a => a.kind);
  assert.equal(kinds.filter(k => k === 'hat').length, 2, 'hats capped at two');
  assert.ok(kinds.includes('kick') && kinds.includes('melody'), kinds.join(','));
  assert.ok(effects.hat > 0, 'hat channel live');
  const blended = blendEffectsMusic(effects, effects, .5);
  assert.ok(Number.isFinite(blended.hat) && blended.accents.some(a => a.kind === 'hat'));
  const sky = sampleSkyPerformance(effects);
  assert.ok(sky.glints.some(g => g > 0));
  assert.ok(sky.sweeps.every(s => s.kind !== 'hat'), 'hats never sweep the horizon');
});
