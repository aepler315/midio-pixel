// E3: device evidence separates rAF callback cadence from frames that were
// actually presented, and keeps pauses, hidden tabs, failed presentations
// and song changes from posing as steady delivered frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFrameDelivery, FrameDeliveryAggregator } from '../tools/lib/frame-delivery-metrics.mjs';

const hz60 = 1000 / 60;
/** 60 Hz callbacks; a frame is presented on every `every`-th callback. */
function run({ seconds = 2, every = 2, start = 0, generation = 1, firstId = 1, paused = () => false, hidden = () => false, failed = () => false, capFps = 30 } = {}) {
  const out = [];
  let id = firstId - 1, last = null;
  for (let i = 0; i < seconds * 60; i++) {
    const wallMs = start + i * hz60;
    const fresh = i % every === 0 && !failed(i);
    if (fresh) id++;
    out.push({ wallMs, generation, frameId: fresh ? id : last ?? null, presented: fresh || last != null, paused: paused(i), hidden: hidden(i), capFps });
    if (fresh) last = id;
  }
  return out;
}

test('a 30 FPS cap on 60 Hz callbacks reports 60 Hz callbacks and 30 FPS delivery', () => {
  const s = summarizeFrameDelivery(run());
  assert.ok(Math.abs(s.callbacks.medianMs - hz60) < .01);
  assert.ok(Math.abs(s.delivered.medianMs - 2 * hz60) < .01);
  assert.ok(Math.abs(s.delivered.fps - 30) < .5);
  assert.ok(Math.abs(s.callbacks.fps - 60) < .5);
  assert.equal(s.repeatedFrames, 60, 'a repeated (generation, frameId) is not a new frame');
  assert.deepEqual(s.capFps, [30]);
});

test('paused and hidden stretches are excluded and never count as one long delivered interval', () => {
  const samples = [
    ...run({ seconds: 1 }),
    ...run({ seconds: 3, start: 1000, firstId: 31, paused: () => true }).map(x => ({ ...x, presented: false, frameId: 30 })),
    ...run({ seconds: 1, start: 4000, firstId: 31 }),
    ...run({ seconds: 2, start: 5000, firstId: 61, hidden: () => true }),
    ...run({ seconds: 1, start: 7000, firstId: 121 }),
  ];
  const s = summarizeFrameDelivery(samples);
  assert.ok(s.delivered.maxMs < 40, `no pause/hidden gap counted as a frame interval (max ${s.delivered.maxMs})`);
  assert.ok(s.callbacks.maxMs < 20, 'callback cadence also breaks at the boundary');
  assert.equal(s.excluded.paused, 180);
  assert.equal(s.excluded.hidden, 120);
  assert.equal(s.delivered.stallsOver100ms, 0);
});

test('failed presentations are counted; the visible gap they cause stays in delivered intervals', () => {
  const s = summarizeFrameDelivery(run({ seconds: 2, every: 1, failed: (i) => i >= 30 && i < 40 }).map((x, i) => (i >= 30 && i < 40 ? { ...x, presented: false } : x)));
  assert.equal(s.failedPresentations, 10);
  assert.ok(s.delivered.maxMs > 10 * hz60, 'the listener saw a frozen frame for that long');
});

test('a song-generation change resets deduplication and interval state', () => {
  const a = run({ seconds: 1, generation: 1, firstId: 1 });
  // The new song's presentation restarts its frame ids at 1.
  const b = run({ seconds: 1, start: 1000 + 500, generation: 2, firstId: 1 });
  const s = summarizeFrameDelivery([...a, ...b]);
  assert.equal(s.generationChanges, 1);
  assert.ok(s.delivered.maxMs < 40, 'the load gap between songs is not a delivered interval');
  assert.equal(s.deliveredFrames, 60, 'reused ids under a new generation are new frames');
});

test('ten-minute runs are bounded: intervals are capped and truncation is reported', () => {
  const agg = new FrameDeliveryAggregator({ maxIntervals: 1000 });
  for (const x of run({ seconds: 600, every: 1 })) agg.push(x);
  const s = agg.summary();
  assert.ok(s.callbacks.intervals <= 1000 && s.callbacks.intervals >= 500, 'retained intervals are bounded');
  assert.equal(s.callbacks.frames, 35999, 'interval counts stay exact');
  assert.equal(s.truncated, true);
  assert.equal(s.deliveredFrames, 36000, 'counts stay exact even when retained intervals are capped');
});

test('empty and all-excluded inputs summarize without inventing frames', () => {
  assert.equal(summarizeFrameDelivery([]).delivered, null);
  const s = summarizeFrameDelivery(run({ seconds: 1, hidden: () => true }));
  assert.equal(s.delivered, null);
  assert.equal(s.deliveredFrames, 0);
});
