// Anticipatory choreography (ChoreoClock): apex-on-beat envelopes, the
// output-latency clock, and the Conductor's ahead-of-time dispatch channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apexHopY, outputLatencyMs, visualNow, CHOREO_LEAD_MS, MAX_LATENCY_MS, VISUAL_LEAD_MS,
} from '../src/core/ChoreoClock.js';
import { Conductor } from '../src/core/Conductor.js';
import { Role, makeNoteEvent } from '../src/core/NoteEvent.js';

test('apexHopY: the hop APEX (full height) lands exactly on the anchor', () => {
  const anchor = 3000, rise = 80, h = 30;
  assert.equal(apexHopY(anchor - rise, anchor, rise, h), 0);
  assert.equal(apexHopY(anchor + rise, anchor, rise, h), 0);
  assert.ok(Math.abs(apexHopY(anchor, anchor, rise, h) - h) < 1e-9, 'apex ON the beat');
  // The apex is the max over the whole span.
  let peakT = null, peak = -1;
  for (let t = anchor - rise; t <= anchor + rise; t += 1) {
    const y = apexHopY(t, anchor, rise, h);
    if (y > peak) { peak = y; peakT = t; }
  }
  assert.equal(peakT, anchor);
});

test('outputLatencyMs is defensive: absent fields, NaN, and absurd values are contained', () => {
  assert.equal(outputLatencyMs(null), 0);
  assert.equal(outputLatencyMs({}), 0);
  assert.equal(outputLatencyMs({ baseLatency: NaN, outputLatency: undefined }), 0);
  assert.ok(Math.abs(outputLatencyMs({ baseLatency: 0.01, outputLatency: 0.15 }) - 160) < 1e-6);
  assert.equal(outputLatencyMs({ baseLatency: 5, outputLatency: 5 }), 350, 'clamped: a glitch must never throw choreography seconds off');
});

test('visualNow subtracts a clamped lag from the song clock', () => {
  assert.equal(visualNow(1000, 0), 1000);
  assert.equal(visualNow(1000, 150), 850);
  assert.equal(visualNow(1000, 9999), 650, 'lag clamps at 350');
  assert.equal(visualNow(1000, NaN), 1000);
});

test('subscribeAhead delivers each event exactly once, leadMs early, with its true tMs', () => {
  const c = new Conductor();
  const mk = (tMs, role) => makeNoteEvent({ tMs, pitch: 60, vel: 0.8, role, src: 'midi' });
  c.load({ timeline: [mk(1000, Role.MELODY), mk(1500, Role.BASS), mk(2000, Role.MELODY)], barGrid: [], durationMs: 3000 });

  const ahead = [], onTime = [];
  c.subscribeAhead(Role.MELODY, 200, (e) => ahead.push(e.tMs));
  c.on(Role.MELODY, (e) => onTime.push(e.tMs));

  c.dispatchUpTo(700);
  assert.deepEqual(ahead, [], 'nothing within the 200ms horizon yet');
  c.dispatchUpTo(800);
  assert.deepEqual(ahead, [1000], 'the 1000ms note arrives at 800 -- 200ms early, true tMs intact');
  assert.deepEqual(onTime, [], 'the on-time channel has not seen it yet');
  c.dispatchUpTo(800); // re-dispatching the same instant must not double-fire
  assert.deepEqual(ahead, [1000]);
  c.dispatchUpTo(2600);
  assert.deepEqual(ahead, [1000, 2000], 'role filter holds: the BASS event never leaks in');
  assert.deepEqual(onTime, [1000, 2000]);
});

test('subscribeAhead: "*" hears every role, reset() re-arms the cursor, unsubscribe stops delivery', () => {
  const c = new Conductor();
  const mk = (tMs, role) => makeNoteEvent({ tMs, pitch: 40, vel: 0.5, role, src: 'midi' });
  c.load({ timeline: [mk(500, Role.BASS), mk(900, Role.PAD)], barGrid: [], durationMs: 2000 });
  const got = [];
  const off = c.subscribeAhead('*', CHOREO_LEAD_MS, (e) => got.push(`${e.role}@${e.tMs}`));
  c.dispatchUpTo(1000);
  assert.deepEqual(got, ['BASS@500', 'PAD@900']);
  c.reset();
  c.dispatchUpTo(1000);
  assert.deepEqual(got, ['BASS@500', 'PAD@900', 'BASS@500', 'PAD@900'], 'reset re-arms the ahead cursor');
  off();
  c.reset();
  c.dispatchUpTo(1000);
  assert.equal(got.length, 4, 'unsubscribed: no further delivery');
});

test('the ahead frontier never trails the on-time frontier (lead >= 0 invariant)', () => {
  const c = new Conductor();
  const mk = (tMs) => makeNoteEvent({ tMs, pitch: 60, vel: 0.8, role: Role.MELODY, src: 'midi' });
  c.load({ timeline: Array.from({ length: 50 }, (_, i) => mk(i * 100)), barGrid: [], durationMs: 6000 });
  const aheadSeen = new Set();
  c.subscribeAhead(Role.MELODY, 120, (e) => aheadSeen.add(e.tMs));
  c.on(Role.MELODY, (e) => {
    assert.ok(aheadSeen.has(e.tMs), `on-time delivery of ${e.tMs} must already be known to the ahead channel`);
  });
  for (let t = 0; t <= 6000; t += 37) c.dispatchUpTo(t); // ragged step cadence on purpose
});

test('VISUAL_LEAD_MS is a positive lead the ahead-dispatch horizon still covers', () => {
  assert.ok(VISUAL_LEAD_MS > 0, 'a lead of 0 would leave every frame arriving a compositor hop late');
  assert.ok(VISUAL_LEAD_MS < MAX_LATENCY_MS);
  assert.ok(CHOREO_LEAD_MS > VISUAL_LEAD_MS,
    'the world is stepped VISUAL_LEAD_MS ahead, so the ahead channel must still deliver before that');
});
