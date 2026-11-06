import test from 'node:test';
import assert from 'node:assert/strict';
import { compileLandscapeSources } from '../src/world/alpine/RangeNarrative.js';
import { RidgeMotionHistory } from '../src/world/RidgeMotionHistory.js';

let ActiveIntervalIndex;
try { ({ ActiveIntervalIndex } = await import('../src/world/ActiveIntervalIndex.js')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const unit = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const timeline = [
  { tMs: 0, durMs: 12000, vel: .21, src: 'midi', role: 'MELODY', pitch: 48 },
  { tMs: 0, durMs: 250, vel: .34, src: 'midi', role: 'BASS', pitch: 36 },
  ...Array.from({ length: 240 }, (_, i) => ({ tMs: i * 40, durMs: i % 13 === 0 ? 2700 : 95,
    vel: .3 + (i % 5) * .12, src: i % 3 === 0 ? 'audio' : 'midi',
    role: i % 4 === 0 ? 'BASS' : 'MELODY', lane: i % 6 === 0 ? 'MIDIO' : 'MIDASUS', channel: i % 16,
    pitch: 40 + i % 39, pitchProvenance: i % 17 === 0 ? 'synthetic' : 'tracked', pitchConfidence: .73 })),
  ...[undefined, -3, NaN, Infinity, '150'].map((durMs, i) => ({ tMs: 200 + i * 80, durMs,
    vel: .62, src: 'midi', role: 'MELODY', lane: 'MIDIO', pitch: 64 })),
  { tMs: 300, durMs: 120, vel: 1, src: 'midi', role: 'RHYTHM', channel: 9, pitch: 36, kick: true },
  { tMs: 310, durMs: 170, vel: .7, src: 'audio', role: 'RHYTHM', channel: 9, pitch: 38 },
];

test('active interval lookup retains descending order across long holds, overlaps, duplicate ends and exact release boundaries', () => {
  assert.equal(typeof ActiveIntervalIndex, 'function', 'active interval index is available');
  const ends = [12000, 120, 120, 400, 800, 500, 9800, Infinity, 9999, 12000];
  const index = new ActiveIntervalIndex(ends);
  for (const at of [0, 119.999, 120, 400, 500, 800, 9800, 9999, 12000, 13000]) {
    for (let limit = 0; limit <= ends.length; limit++) {
      const actual = [];
      for (let i = index.lastBefore(limit, at); i >= 0; i = index.lastBefore(i, at)) actual.push(i);
      const expected = Array.from({ length: limit }, (_, i) => i).reverse().filter(i => ends[i] > at);
      assert.deepEqual(actual, expected, `at ${at}, before ${limit}`);
    }
  }
  assert.equal(new ActiveIntervalIndex([]).lastBefore(0, 0), -1);
});

function sourceOracle(events, at, id, casting) {
  const lanes = { midio: 'MIDIO', broshi: 'BROSHI', midasus: 'MIDASUS' };
  const roles = { midio: 'BASS', broshi: 'MELODY', midasus: 'MELODY' };
  const lane = casting[id]?.endsWith('-lane');
  const notes = events.filter(e => lane ? e.lane === lanes[id] : e.role === roles[id]);
  let activity = 0, pitchActivity = 0, pitch = 0;
  for (let i = notes.length - 1; i >= 0; i--) {
    const e = notes[i], age = at - e.tMs;
    if (age < 0) continue;
    const weight = unit(e.vel) * Math.min(1, age / 40) * unit((e.durMs + 120 - age) / 120);
    activity += weight;
    const confidence = e.pitchProvenance === 'synthetic' || !Number.isFinite(e.pitch) ? 0
      : e.src === 'midi' ? 1 : unit(e.pitchConfidence ?? .25) * (e.pitchProvenance === 'tracked' ? 1 : .25);
    const pw = weight * confidence;
    pitchActivity += pw; pitch += pw * unit((e.pitch - 36) / 60);
  }
  return { source: lane ? `lane:${lanes[id]}` : `role:${roles[id]}`, activity: unit(activity),
    pitchActivity: unit(pitchActivity), pitch01: pitchActivity ? pitch / pitchActivity : .5 };
}

test('landscape sources exactly match brute active-note accumulation after seeks and casting changes', () => {
  const events = timeline.filter(e => Number.isFinite(e.tMs) && e.tMs >= 0 && unit(e.vel) > 0)
    .map(e => ({ ...e, durMs: Math.max(90, Number.isFinite(e.durMs) ? e.durMs : 90) }))
    .sort((a, b) => a.tMs - b.tMs);
  for (const casting of [{ midio: 'bass', broshi: 'melody', midasus: 'melody' },
    { midio: 'source-lane', broshi: 'melody', midasus: 'source-lane' }]) {
    const sources = compileLandscapeSources({ timeline, durationMs: 14000, casting });
    for (const at of [12500, 0, 40, 120, 360, 199.99, 5000.125, 12119.999, 12120, 9500, 777.5]) {
      const actual = sources.sample(at).sources;
      for (const id of ['midio', 'broshi', 'midasus']) assert.deepEqual(actual[id], sourceOracle(events, at, id, casting), `${id} at ${at}`);
    }
  }
});

function midiActivityOracle(input, at) {
  const events = input.filter(e => Number.isFinite(e.tMs) && e.tMs >= 0)
    .map(e => ({ ...e, durMs: Math.max(0, e.durMs || 0) })).sort((a, b) => a.tMs - b.tMs)
    .filter(e => e.src === 'midi');
  let end = 0;
  const ends = events.map(e => { end = Math.max(end, e.tMs + e.durMs + 120); return end; });
  let i = events.length - 1;
  while (i >= 0 && events[i].tMs > at) i--;
  let midi = 0;
  for (; i >= 0 && ends[i] > at; i--) {
    const e = events[i];
    midi = Math.max(midi, unit(e.vel) * Math.min(1, (at - e.tMs) / 40) * unit((e.durMs + 120 - (at - e.tMs)) / 120));
  }
  return midi;
}

test('ridge MIDI activity preserves legacy duration normalization, future gating and release edges', () => {
  for (const extra of [[], [{ tMs: 1700, durMs: 'invalid', vel: .8, src: 'midi', role: 'MELODY', pitch: 72 }]]) {
    const input = [...timeline, ...extra];
    const history = new RidgeMotionHistory({ timeline: input, durationMs: 14000 });
    for (const at of [0, 1, 39.999, 40, 1700, 1699.999, 360, 5000.125, 12120, 13000, 500, 789.5]) {
      assert.equal(history.sample(at).activity01, midiActivityOracle(input, at), `MIDI activity at ${at}`);
    }
  }
});

test('ordered short notes retain the original source and ridge values across reverse seeks', () => {
  const input = timeline.map(e => ({ ...e, durMs: 120 }));
  const events = input.slice().sort((a, b) => a.tMs - b.tMs);
  const casting = { midio: 'bass', broshi: 'melody', midasus: 'melody' };
  const sources = compileLandscapeSources({ timeline: input, durationMs: 14000, casting });
  const history = new RidgeMotionHistory({ timeline: input, durationMs: 14000 });
  for (const at of [13999, 9000, 0, 39.999, 40, 240, 239.999, 1250.25, 360, 5000]) {
    for (const id of ['midio', 'broshi', 'midasus']) assert.deepEqual(sources.sample(at).sources[id], sourceOracle(events, at, id, casting));
    assert.equal(history.sample(at).activity01, midiActivityOracle(input, at));
  }
});

test('fractional release rounding preserves the original residual contribution below an older hold', () => {
  const input = [
    { tMs: 0, durMs: 400000, vel: .21, src: 'midi', role: 'MELODY', pitch: 48 },
    { tMs: 296807.47398701456, durMs: 391.0000676172271, vel: .34, src: 'midi', role: 'MELODY', pitch: 72 },
  ];
  const at = 297318.4740546318;
  const casting = { midio: 'bass', broshi: 'melody', midasus: 'melody' };
  const sources = compileLandscapeSources({ timeline: input, durationMs: 400000, casting });
  const expected = sourceOracle(input, at, 'broshi', casting);
  assert.equal(expected.activity, .21000000000001917, 'the original subtraction order retains this tiny positive tail');
  assert.deepEqual(sources.sample(at).sources.broshi, expected);
  const history = new RidgeMotionHistory({ timeline: input, durationMs: 400000 });
  assert.deepEqual(history.sample(at).sources.broshi, expected);
  const zeroHold = input.map((note, i) => i === 0 ? { ...note, vel: 0 } : note);
  const activity = midiActivityOracle(zeroHold, at);
  assert.ok(activity > 0 && activity < 1e-12, 'the old MIDI body scan retains the tiny residual under a zero-strength hold');
  assert.equal(new RidgeMotionHistory({ timeline: zeroHold, durationMs: 400000 }).sample(at).activity01, activity);
});

test('fractional release neighbours exactly match the original accumulation at adversarial seek positions', () => {
  let seed = 1741;
  const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; };
  const input = [
    { tMs: 0, durMs: 400000, vel: .21, src: 'midi', role: 'MELODY', pitch: 48 },
    ...Array.from({ length: 128 }, () => ({ tMs: random() * 300000, durMs: 95 + random() * 1900,
      vel: .1 + random() * .7, src: 'midi', role: 'MELODY', pitch: 36 + Math.floor(random() * 60) })),
  ];
  const events = input.slice().sort((a, b) => a.tMs - b.tMs);
  const casting = { midio: 'bass', broshi: 'melody', midasus: 'melody' };
  const sources = compileLandscapeSources({ timeline: input, durationMs: 400000, casting });
  const history = new RidgeMotionHistory({ timeline: input, durationMs: 400000 });
  for (const note of input.slice(1).reverse()) {
    const end = note.tMs + note.durMs + 120, alternateEnd = note.tMs + (note.durMs + 120);
    for (const at of [end, alternateEnd, end - end * Number.EPSILON, end + end * Number.EPSILON]) {
      const expected = sourceOracle(events, at, 'broshi', casting);
      assert.deepEqual(sources.sample(at).sources.broshi, expected, `source at ${at}`);
      assert.deepEqual(history.sample(at).sources.broshi, expected, `canonical source at ${at}`);
      assert.equal(history.sample(at).activity01, midiActivityOracle(input, at), `canonical activity at ${at}`);
    }
  }
});
