// Holding the show back until the song has actually started.
//
// The load-bearing properties are the three that stop this from becoming a
// nuisance: it must not mute a song that opens loud, it must never re-mute
// mid-song, and it must give up on its own if the analysis misreads a track.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningDirector, OPENING_FLOOR, MAX_HOLD_MS } from '../src/sim/OpeningDirector.js';

const STEP_SEC = 1 / 60;
const STEP_MS = 1000 / 60;

/** Energy curves whose song-relative level is a function of time. */
function curves(levelAt) {
  return { globalEnergyNorm: (ms) => levelAt(ms) };
}

/** Run `ms` of song through the director, returning it. */
function run(dir, ec, ms, from = 0) {
  for (let t = from; t < from + ms; t += STEP_MS) dir.update(t, STEP_SEC, ec);
  return dir;
}

test('a song that fades in is held back while it is still quiet', () => {
  // Twenty seconds of near-silence rising slowly.
  const ec = curves((ms) => Math.min(1, ms / 40000));
  const dir = run(new OpeningDirector(), ec, 5000);
  assert.equal(dir.holding, true, 'five seconds in, this song has not started');
  assert.ok(dir.gain < 0.5, `world should still be restrained, got ${dir.gain}`);
});

test('...and opens up once the music actually arrives', () => {
  const ec = curves((ms) => (ms < 12000 ? 0.05 : 0.8));
  const dir = run(new OpeningDirector(), ec, 20000);
  assert.equal(dir.holding, false, 'the song has plainly started by now');
  assert.ok(dir.gain > 0.95, `world should be fully open, got ${dir.gain}`);
});

test('a song that opens at full blast is never held', () => {
  const ec = curves(() => 0.9);
  const dir = new OpeningDirector();
  let minGain = 1;
  run(dir, ec, 4000);
  // Sampled across the opening: it should release essentially at once.
  const d2 = new OpeningDirector();
  for (let t = 0; t < 4000; t += STEP_MS) {
    d2.update(t, STEP_SEC, ec);
    if (t > 2500) minGain = Math.min(minGain, d2.gain);
  }
  assert.equal(dir.holding, false, 'a cold-open banger must not be muzzled');
  assert.ok(minGain > 0.9, `should be open within a couple of seconds, got ${minGain}`);
});

test('the hush never comes back once the song has arrived', () => {
  // Loud opening, then a genuinely quiet passage two minutes in.
  const ec = curves((ms) => (ms > 60000 && ms < 90000 ? 0.02 : 0.8));
  const dir = run(new OpeningDirector(), ec, 100000);
  assert.equal(dir.holding, false, 'a quiet verse is CalmDirector\'s business, not ours');
  assert.ok(dir.gain > 0.95, `must not re-mute mid-song, got ${dir.gain}`);
});

test('a stray transient in an ambient intro does not count as the song starting', () => {
  // One brief spike, then back to near-silence.
  const ec = curves((ms) => (ms > 3000 && ms < 3200 ? 0.9 : 0.03));
  const dir = run(new OpeningDirector(), ec, 8000);
  assert.equal(dir.holding, true, 'one hit is not the song getting going');
});

test('the hold expires on its own, however quiet the track reads', () => {
  const ec = curves(() => 0); // pathological: never registers as started
  const dir = run(new OpeningDirector(), ec, MAX_HOLD_MS + 4000);
  assert.equal(dir.holding, false, 'a misread must cost seconds, not the whole song');
  assert.ok(dir.gain > 0.9, `and it must fully recover, got ${dir.gain}`);
});

test('no energy curves means no hold at all -- MIDI and demo are unchanged', () => {
  const dir = new OpeningDirector();
  dir.update(0, STEP_SEC, null);
  assert.equal(dir.holding, false);
  assert.equal(dir.gain, 1, 'must be byte-identical to today from the first frame');
});

test('the gain stays inside its bounds and only ever eases', () => {
  const ec = curves((ms) => (ms < 6000 ? 0.02 : 0.9));
  const dir = new OpeningDirector();
  let prev = dir.gain;
  for (let t = 0; t < 20000; t += STEP_MS) {
    dir.update(t, STEP_SEC, ec);
    assert.ok(dir.gain >= OPENING_FLOOR - 1e-6 && dir.gain <= 1 + 1e-9, `out of range: ${dir.gain}`);
    assert.ok(Math.abs(dir.gain - prev) < 0.05, `gain jumped by ${Math.abs(dir.gain - prev)} -- must ease`);
    prev = dir.gain;
  }
});

test('status reports what it is doing', () => {
  const dir = new OpeningDirector();
  assert.match(dir.status, /holding/);
  dir.update(0, STEP_SEC, null);
  assert.match(dir.status, /open/);
});

test('a song with no dynamic range is never held -- there is no intro to protect', () => {
  // Below FLAT_SPREAD_MIN, globalEnergyNorm blends back toward the raw
  // absolute level, which on a compressed master can sit under any fixed
  // threshold for the whole song. Holding on that would mute a track that
  // was never quiet, right up to the backstop.
  const ec = {
    globalEnergyNorm: () => 0.3,
    calibration: () => ({ lo: 0.28, hi: 0.32, spread: 0.04 }),
  };
  const dir = run(new OpeningDirector(), ec, 3000);
  assert.equal(dir.holding, false, 'a flat song has no fade-in to wait out');
  assert.ok(dir.gain > 0.95, `and must open promptly, got ${dir.gain}`);
});

test('a genuinely dynamic song is still held on the same evidence', () => {
  const ec = {
    globalEnergyNorm: (ms) => (ms < 10000 ? 0.05 : 0.8),
    calibration: () => ({ lo: 0.05, hi: 0.9, spread: 0.85 }),
  };
  const dir = run(new OpeningDirector(), ec, 4000);
  assert.equal(dir.holding, true, 'real dynamics, real fade-in, real hold');
});
