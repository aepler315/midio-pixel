import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignPan, panAt, intertwinedPairs } from '../src/core/PanAnalysis.js';

function voice(channel, pan, notes) {
  return { track: { channel, pan }, notes };
}

function notesEvery(count, stepMs, durMs = 200) {
  return Array.from({ length: count }, (_, i) => ({ startMs: i * stepMs, durMs }));
}

test('opposite-panned, overlapping tracks are flagged dynamic (intertwined)', () => {
  const left = voice(0, -0.8, notesEvery(20, 500));
  const right = voice(1, 0.8, notesEvery(20, 500));
  const panByChannel = assignPan([left, right]);
  assert.equal(panByChannel.get(0).dynamic, true);
  assert.equal(panByChannel.get(1).dynamic, true);
  assert.equal(panByChannel.get(0).partnerChannel, 1);
  assert.equal(panByChannel.get(1).partnerChannel, 0);
});

test('same-side panned tracks are never flagged, even if they overlap', () => {
  const left1 = voice(0, -0.8, notesEvery(20, 500));
  const left2 = voice(1, -0.7, notesEvery(20, 500));
  const panByChannel = assignPan([left1, left2]);
  assert.equal(panByChannel.get(0).dynamic, false);
  assert.equal(panByChannel.get(1).dynamic, false);
});

test('opposite-panned tracks that never play together are not flagged', () => {
  // left plays only in [0, 10000); right only starts at 60000 — no overlap.
  const left = voice(0, -0.8, notesEvery(20, 500));
  const right = voice(1, 0.8, notesEvery(20, 500).map((n) => ({ ...n, startMs: n.startMs + 60000 })));
  const panByChannel = assignPan([left, right]);
  assert.equal(panByChannel.get(0).dynamic, false);
  assert.equal(panByChannel.get(1).dynamic, false);
});

test('near-center pan does not count as "panned" and is never flagged', () => {
  const a = voice(0, -0.1, notesEvery(20, 500));
  const b = voice(1, 0.1, notesEvery(20, 500));
  const panByChannel = assignPan([a, b]);
  assert.equal(panByChannel.get(0).dynamic, false);
  assert.equal(panByChannel.get(1).dynamic, false);
});

test('a track with no notes contributes no channel entry', () => {
  const empty = voice(0, -0.8, []);
  const panByChannel = assignPan([empty]);
  assert.equal(panByChannel.has(0), false);
});

test('a lone panned track (no partner) stays static at its authored pan', () => {
  const solo = voice(0, 0.6, notesEvery(10, 400));
  const panByChannel = assignPan([solo]);
  assert.equal(panByChannel.get(0).dynamic, false);
  assert.equal(panByChannel.get(0).pan, 0.6);
});

test('panAt: static channel returns its authored pan at any time', () => {
  const entry = { pan: 0.6, dynamic: false };
  assert.equal(panAt(entry, 0, 100000), 0.6);
  assert.equal(panAt(entry, 100000, 100000), 0.6);
});

test('panAt: missing entry (unmapped channel) is dead center', () => {
  assert.equal(panAt(undefined, 5000, 100000), 0);
});

test('panAt: dynamic channel eases from center at t=0 to full pan by song end', () => {
  const entry = { pan: -0.8, dynamic: true };
  assert.equal(panAt(entry, 0, 100000), 0);
  assert.ok(Math.abs(panAt(entry, 100000, 100000) - (-0.8)) < 1e-9);
  const mid = panAt(entry, 50000, 100000);
  // Smoothstep at t=0.5 is exactly 0.5, so pan should be halfway to target.
  assert.ok(Math.abs(mid - (-0.4)) < 1e-9);
});

test('panAt: dynamic channel pan magnitude grows monotonically with song progress', () => {
  const entry = { pan: 0.9, dynamic: true };
  const samples = [0, 10000, 25000, 50000, 75000, 100000].map((t) => panAt(entry, t, 100000));
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i] >= samples[i - 1] - 1e-9, `pan should not shrink: ${samples}`);
  }
  assert.equal(samples[0], 0);
});

test('intertwinedPairs de-duplicates and normalizes channel order', () => {
  const left = voice(3, -0.9, notesEvery(20, 500));
  const right = voice(1, 0.9, notesEvery(20, 500));
  const panByChannel = assignPan([left, right]);
  const pairs = intertwinedPairs(panByChannel);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0], { channelA: 1, channelB: 3 });
});

test('three mutually-opposed channels: every qualifying channel still ends up dynamic', () => {
  // A hard-left, B and C both hard-right and both overlap A.
  const a = voice(0, -0.9, notesEvery(20, 500));
  const b = voice(1, 0.9, notesEvery(20, 500));
  const c = voice(2, 0.85, notesEvery(20, 500));
  const panByChannel = assignPan([a, b, c]);
  assert.equal(panByChannel.get(0).dynamic, true);
  assert.equal(panByChannel.get(1).dynamic, true);
  assert.equal(panByChannel.get(2).dynamic, true);
});
