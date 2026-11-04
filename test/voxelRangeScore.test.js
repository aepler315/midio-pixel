import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SongBeatTransport } from '../src/sim/SongBeatTransport.js';
import { createVoxelRangeScore } from '../src/world/alpine/VoxelRangeScore.js';

const sections = [{ startMs: 0, endMs: 2000 }, { startMs: 2000, endMs: 8000 }];
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test('each musical section builds its own share of the mountain', () => {
  const score = createVoxelRangeScore({ sections, durationMs: 8000 });
  assert.ok(score.progressAt(0) > 0 && score.progressAt(0) < .1);
  close(score.progressAt(2000), .5125);
  assert.equal(score.progressAt(7500), 1);
  assert.equal(score.progressAt(8000), 1);
});

test('tempo changes retime the reveal inside a section and survive a seek round trip', () => {
  const beatTransport = new SongBeatTransport({ beatPeriodMs: 500, confidence: 1,
    localTempo: [{ tMs: 1000, beatPeriodMs: 250, confidence: 1 }] });
  const score = createVoxelRangeScore({ sections, durationMs: 8000, beatTransport });
  // The first half by time is two of the first section's six beats.
  close(score.progressAt(1000), .1875);
  score.progressAt(4200);
  score.progressAt(0);
  close(score.progressAt(1000), .1875);
  close(score.progressAt(2000), .5125);
});

test('free-time and uncertain tempo use elapsed time', () => {
  const localTempo = [{ tMs: 1000, beatPeriodMs: 250, confidence: 1 }];
  for (const options of [{ freeTime: true, confidence: 1 }, { confidence: .1 }]) {
    const beatTransport = new SongBeatTransport({ beatPeriodMs: 500, localTempo, ...options });
    const score = createVoxelRangeScore({ sections, durationMs: 8000, beatTransport });
    close(score.progressAt(1000), .26875);
  }
});

test('decorative cuts stay inside the same growth segment', () => {
  const score = createVoxelRangeScore({ sections: [
    { startMs: 0, endMs: 1500 },
    { startMs: 1500, endMs: 2000, provenance: 'decorative' },
    { startMs: 2000, endMs: 8000, provenance: 'detected' },
  ], durationMs: 8000 });
  close(score.progressAt(1500), .390625);
  close(score.progressAt(2000), .5125);
});

test('growth holds through uncovered intervals and can begin without analyzed sections', () => {
  const score = createVoxelRangeScore({ sections: [
    { startMs: 1000, endMs: 2000 }, { startMs: 2500, endMs: 4000 },
  ], durationMs: 8000 });
  assert.equal(score.progressAt(750), score.progressAt(0));
  assert.equal(score.progressAt(2250), score.progressAt(2000));
  assert.equal(score.progressAt(4000), 1);

  const fallback = createVoxelRangeScore({ durationMs: 8000 });
  assert.ok(fallback.progressAt(2000) > fallback.progressAt(0));
  assert.ok(fallback.progressAt(6000) > fallback.progressAt(2000));
  assert.equal(fallback.progressAt(8000), 1);
  assert.equal(fallback.progressAt(-1), fallback.progressAt(0));
});
