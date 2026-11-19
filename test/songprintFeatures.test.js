import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSongprintPCM, songprintChroma, songprintFromChroma } from '../src/audio/Songprint.js';

const motif = [0, 7, 3, 10, 2, 9, 1, 5, 0, 4, 7, 2, 10, 3, 4, 7, 1, 6, 2, 10, 3, 8, 0, 9];
const stepwise = [0, 1, 2, 4, 5, 3, 2, 1, 2, 4, 6, 7, 8, 9, 8, 7, 9, 11, 10, 8, 7, 6, 4, 3];

// Four frames per beat, with a quieter fifth riding the lead note. Each
// fixture is an independent performance; the extractor receives no labels.
function chroma(notes, shift = 0, fifth = .25) {
  return notes.flatMap(note => {
    const row = new Float32Array(12);
    row[(note + shift) % 12] = 1;
    row[(note + 7 + shift) % 12] = fifth;
    return Array(4).fill(row);
  });
}

const atTime = (record, ms) => record.passages.find(p => p.timeMs === ms);
const difference = (a, b) => Math.hypot(...a.map((v, i) => v - b[i])) / Math.sqrt(a.length);

test('a changed recording returns to the same passage coordinate after an extra intro and key change', () => {
  const first = songprintFromChroma(chroma([...motif, ...stepwise, ...motif, ...stepwise]));
  const second = songprintFromChroma(chroma([...stepwise, ...motif, ...stepwise, ...motif], 5, .16));
  const a = atTime(first, 6000), b = atTime(second, 18000);
  assert.ok(a.strength > .9 && b.strength > .9);
  assert.ok(Math.abs(a.landmark01 - b.landmark01) < .06);
  assert.equal(a.landmark01, atTime(first, 30000).landmark01);
  assert.ok(Math.abs(a.landmark01 - atTime(first, 18000).landmark01) > .12);
});

test('terrain skyline and local coordinates are stable under transposition and deterministic on replay', () => {
  const notes = [...motif, ...stepwise, ...motif, ...stepwise];
  const original = songprintFromChroma(chroma(notes)), transposed = songprintFromChroma(chroma(notes, 8));
  assert.deepEqual(original, songprintFromChroma(chroma(notes)));
  assert.ok(difference(original.skyline, transposed.skyline) < 1e-9);
  assert.deepEqual(original.passages.map(p => p.timeMs), transposed.passages.map(p => p.timeMs));
  for (let i = 0; i < original.passages.length; i++) {
    assert.ok(Math.abs(original.passages[i].landmark01 - transposed.passages[i].landmark01) < 1e-7);
  }
  // Independent reference from the Songprint 3.1 signed recurrence worker,
  // followed by the documented 16-height musical-interval projection.
  const reference = [.99796274, .10295045, .07281140, .27908112, .32100351, .27316528, .54349057, .71890357,
    .58768311, .75219236, .08699761, .73209363, .69153272, .20221957, .43219546, .68940807];
  assert.ok(difference(original.skyline, reference) < 1e-7);
  assert.equal(original.skyline.length, 16);
  assert.ok(original.skyline.every(x => x >= 0 && x <= 1));
  const other = songprintFromChroma(chroma([...stepwise, ...stepwise, ...stepwise, ...stepwise]));
  assert.ok(difference(original.skyline, other.skyline) > .1);
});

test('a passage requires a second non-overlapping occurrence, and static audio supplies no landmarks', () => {
  const single = songprintFromChroma(chroma(motif));
  assert.deepEqual(single.passages, []);
  assert.equal(songprintFromChroma(chroma(Array(70).fill(0))), null);
  assert.equal(analyzeSongprintPCM(new Float32Array(11025 * 13)), null);
  assert.equal(songprintFromChroma(chroma(motif.slice(0, 20))), null);
});

test('sample-derived chroma retains the heard offset and resists uniform gain', () => {
  const rate = 11025, hop = 1378, length = 2 * motif.length * 4 * hop;
  const notes = [...motif, ...motif];
  const input = Float32Array.from({ length }, (_, i) => {
    const hz = 220 * 2 ** (notes[Math.floor(i / (4 * hop))] / 12);
    const phase = 2 * Math.PI * hz * (i % (4 * hop)) / rate;
    return .6 * Math.cos(phase) + .2 * Math.cos(2 * phase);
  });
  const padded = new Float32Array(input.length + rate);
  padded.set(input.map(x => .25 * x), rate);
  const a = songprintChroma(input), b = songprintChroma(padded);
  assert.equal(b.offsetMs - a.offsetMs, 1000);
  assert.equal(a.hopMs, 1000 * hop / rate);
  assert.deepEqual(a.frames, b.frames);
  const print = analyzeSongprintPCM(input), later = analyzeSongprintPCM(padded);
  assert.deepEqual(print.skyline, later.skyline);
  assert.ok(print.passages.length > 0);
  assert.deepEqual(later.passages, print.passages.map(p => ({ ...p, timeMs: p.timeMs + 1000 })));
});
