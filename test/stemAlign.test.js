import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVocalStemName, vocalActivity, syllableOnsets, alignBlocks } from '../src/lyrics/StemAlign.js';

test('isVocalStemName: matches vox/vocal/voice/sing, case-insensitively, and rejects unrelated names', () => {
  assert.ok(isVocalStemName('Vocals.wav'));
  assert.ok(isVocalStemName('lead_vox.wav'));
  assert.ok(isVocalStemName('VOICE_2.mp3'));
  assert.ok(isVocalStemName('backing_singer.wav'));
  assert.ok(!isVocalStemName('bass.wav'));
  assert.ok(!isVocalStemName('drums.wav'));
  assert.ok(!isVocalStemName(''));
  assert.ok(!isVocalStemName(null));
});

test('vocalActivity: empty/invalid input returns an empty envelope without throwing', () => {
  assert.equal(vocalActivity(null, 44100).values.length, 0);
  assert.equal(vocalActivity(new Float32Array(0), 44100).values.length, 0);
  assert.equal(vocalActivity(new Float32Array(100), 0).values.length, 0);
});

test('vocalActivity: a loud burst reads higher than a silent one at ~50 frames/sec', () => {
  const sampleRate = 44100;
  const durationSec = 1;
  const data = new Float32Array(sampleRate * durationSec);
  // Loud in the first half, silent in the second.
  for (let i = 0; i < data.length / 2; i++) data[i] = Math.sin(i * 0.3) * 0.8;
  const env = vocalActivity(data, sampleRate);
  assert.ok(env.values.length > 40 && env.values.length < 60, `expected ~50 frames, got ${env.values.length}`);
  assert.equal(Math.round(env.hopMs), 20);
  const firstHalf = env.values.slice(0, Math.floor(env.values.length / 2));
  const secondHalf = env.values.slice(Math.floor(env.values.length / 2));
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  assert.ok(avg(firstHalf) > avg(secondHalf) * 5, 'loud half must read much higher than silent half');
});

function makeEnvelope(spikeFramesMs, totalMs, hopMs = 20) {
  const n = Math.ceil(totalMs / hopMs);
  const values = new Float32Array(n).fill(0.01);
  for (const ms of spikeFramesMs) {
    const idx = Math.round(ms / hopMs);
    if (idx >= 0 && idx < n) values[idx] = 1;
  }
  return { values, hopMs };
}

test('syllableOnsets: empty/flat envelope yields no onsets', () => {
  assert.deepEqual(syllableOnsets({ values: new Float32Array(0), hopMs: 20 }), []);
  assert.deepEqual(syllableOnsets(null), []);
  const flat = { values: new Float32Array(50).fill(0.2), hopMs: 20 };
  assert.deepEqual(syllableOnsets(flat), []);
});

test('syllableOnsets: picks one onset per well-separated spike, in ascending order', () => {
  const env = makeEnvelope([100, 400, 900, 1500], 2000);
  const onsets = syllableOnsets(env);
  assert.equal(onsets.length, 4);
  for (let i = 1; i < onsets.length; i++) assert.ok(onsets[i] > onsets[i - 1]);
  // Each detected onset must land within one hop of its intended spike.
  const targets = [100, 400, 900, 1500];
  onsets.forEach((t, i) => assert.ok(Math.abs(t - targets[i]) <= 20));
});

test('syllableOnsets: two spikes closer than the 120ms refractory collapse to one onset', () => {
  const env = makeEnvelope([100, 150], 1000); // 50ms apart -- under the refractory
  const onsets = syllableOnsets(env);
  assert.equal(onsets.length, 1);
});

test('alignBlocks: no onsets leaves every block untimed at zero confidence', () => {
  const blocks = [{ lines: ['hello there'] }, { lines: ['general kenobi'] }];
  const out = alignBlocks(blocks, []);
  assert.equal(out.length, 2);
  for (const b of out) {
    assert.equal(b.startMs, null);
    assert.equal(b.endMs, null);
    assert.equal(b.confidence, 0);
  }
});

test('alignBlocks: empty blocks input returns empty output', () => {
  assert.deepEqual(alignBlocks([], [0, 100, 200]), []);
  assert.deepEqual(alignBlocks(null, [0, 100, 200]), []);
});

test('alignBlocks: assigns monotonically non-decreasing, non-overlapping start/end times across blocks', () => {
  const blocks = [
    { lines: ['a simple line here'] },      // ~5 syllables
    { lines: ['another longer line indeed'] }, // ~7 syllables
    { lines: ['short one'] },                // ~2 syllables
  ];
  const onsets = Array.from({ length: 40 }, (_, i) => i * 200); // 40 evenly spaced onsets, 200ms apart
  const out = alignBlocks(blocks, onsets);
  assert.equal(out.length, 3);
  for (const b of out) {
    assert.ok(Number.isFinite(b.startMs));
    assert.ok(Number.isFinite(b.endMs));
    assert.ok(b.endMs >= b.startMs);
    assert.equal(b.confidence, 0.3);
  }
  // Non-overlapping / monotone: each block's start is not before the
  // previous block's start, and its end matches the next block's start.
  for (let i = 1; i < out.length; i++) assert.ok(out[i].startMs >= out[i - 1].startMs);
  assert.equal(out[0].endMs, out[1].startMs);
  assert.equal(out[1].endMs, out[2].startMs);
  // The last block's end trails the final onset by the refractory period.
  assert.equal(out[2].endMs, onsets[onsets.length - 1] + 120);
});

test('alignBlocks: preserves any pre-existing fields on the input blocks (e.g. kind/text from labelBlocks)', () => {
  const blocks = [{ lines: ['verse line'], kind: 'verse', text: 'verse line' }];
  const out = alignBlocks(blocks, [0, 500]);
  assert.equal(out[0].kind, 'verse');
  assert.equal(out[0].text, 'verse line');
});
