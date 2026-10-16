// CueDirector: the forward-only dispatcher for the conductor track's live
// cues. Same never-skip/never-repeat contract as Conductor.dispatchUpTo,
// plus a seek contract the timeline dispatcher doesn't need to care about
// (the mountain seekbar can scrub backward past cues that already fired).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CueDirector } from '../src/sim/CueDirector.js';
import { CueKind } from '../src/core/ConductorTrack.js';

const cue = (tMs, kind = CueKind.FEVER, value = 1) => ({ tMs, kind, value, bucket: 8 });

function drain(director, steps) {
  const seen = [];
  for (const t of steps) {
    director.clearFrameFlags();
    director.update(t);
    seen.push(director.fired.map((c) => c.tMs));
  }
  return seen;
}

test('an empty cue sheet is inert', () => {
  const d = new CueDirector();
  d.update(10000);
  assert.deepEqual(d.fired, []);
  assert.equal(d.total, 0);
  assert.equal(d.remaining, 0);
});

test('cues fire once each, in order, on the first step at or past their time', () => {
  const d = new CueDirector([cue(1000), cue(2000), cue(3000)]);
  assert.deepEqual(drain(d, [500, 1000, 1500, 2500, 3000]), [
    [], [1000], [], [2000], [3000],
  ]);
  assert.equal(d.remaining, 0);
});

test('a cue never fires twice, even across many steps at the same instant', () => {
  const d = new CueDirector([cue(1000)]);
  assert.deepEqual(drain(d, [1000, 1000, 1000, 5000]), [[1000], [], [], []]);
});

test('a long step never skips the cues it jumped over', () => {
  // A backgrounded tab or a breakpoint produces exactly this: one huge step.
  const d = new CueDirector([cue(100), cue(200), cue(300)]);
  d.update(10000);
  assert.deepEqual(d.fired.map((c) => c.tMs), [100, 200, 300]);
});

test('simultaneous cues all fire on the same step', () => {
  const d = new CueDirector([
    cue(1000, CueKind.DROP), cue(1000, CueKind.FLOURISH), cue(1000, CueKind.SHAKE),
  ]);
  d.update(1000);
  assert.deepEqual(d.fired.map((c) => c.kind), [CueKind.DROP, CueKind.FLOURISH, CueKind.SHAKE]);
});

test('clearFrameFlags empties the one-shot list without disturbing the cursor', () => {
  const d = new CueDirector([cue(1000), cue(2000)]);
  d.update(1000);
  assert.equal(d.fired.length, 1);
  d.clearFrameFlags();
  assert.equal(d.fired.length, 0);
  d.update(2000);
  assert.deepEqual(d.fired.map((c) => c.tMs), [2000], 'the second cue must still be pending');
});

// --- The seek contract ----------------------------------------------------

test('seeking backward makes already-fired cues live again', () => {
  const d = new CueDirector([cue(1000), cue(2000), cue(3000)]);
  d.update(3000);
  assert.equal(d.remaining, 0);

  d.seekTo(1500);
  assert.equal(d.remaining, 2, 'the cues past 1500 belong to the music being replayed');
  d.clearFrameFlags();
  d.update(2000);
  assert.deepEqual(d.fired.map((c) => c.tMs), [2000]);
});

test('seeking forward skips the cues jumped over rather than dumping them at once', () => {
  const d = new CueDirector([cue(1000), cue(2000), cue(3000)]);
  d.seekTo(2500);
  d.clearFrameFlags();
  d.update(2600);
  assert.deepEqual(d.fired, [], 'scrubbed-past cues belong to a moment that did not happen');
  d.update(3000);
  assert.deepEqual(d.fired.map((c) => c.tMs), [3000]);
});

test('seeking clears any cues left pending from the step it interrupted', () => {
  const d = new CueDirector([cue(1000)]);
  d.update(1000);
  assert.equal(d.fired.length, 1);
  d.seekTo(5000);
  assert.deepEqual(d.fired, [], 'a stale fire must not be applied after the playhead moved');
});

test('seeking to the exact time of a cue treats it as already played', () => {
  // Matches Conductor.dispatchUpTo's own <= frontier: seeking to t means the
  // playhead IS at t, so everything at t has been reached.
  const d = new CueDirector([cue(1000), cue(2000)]);
  d.seekTo(1000);
  assert.equal(d.remaining, 1);
});

test('countOf reports the sheet total per kind regardless of playback position', () => {
  const d = new CueDirector([
    cue(1000, CueKind.METEORS), cue(2000, CueKind.METEORS), cue(3000, CueKind.LIGHTNING),
  ]);
  d.update(5000);
  assert.equal(d.countOf(CueKind.METEORS), 2);
  assert.equal(d.countOf(CueKind.LIGHTNING), 1);
  assert.equal(d.countOf(CueKind.APOTHEOSIS), 0);
  assert.equal(d.total, 3);
});
