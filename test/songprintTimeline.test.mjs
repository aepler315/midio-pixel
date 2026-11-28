import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSongprintPCM } from '../src/audio/Songprint.js';
import { copySongprint } from '../src/audio/SongprintData.js';
import { copySongprintTimeline, songprintTimeline, TIMELINE_STEP_MS } from '../src/audio/SongprintTimeline.js';

const RATE = 11025;
const hz = midi => 440 * 2 ** ((midi - 69) / 12);
// Chords as sums of sines; level and timbre per section.
function render(sections) {
  const out = [];
  for (const { seconds, chords, level, overtones = 1 } of sections) {
    const n = seconds * RATE, per = n / chords.length;
    for (let i = 0; i < n; i++) {
      const chord = chords[Math.floor(i / per)];
      let v = 0;
      for (const note of chord) for (let h = 1; h <= overtones; h++) v += Math.sin(2 * Math.PI * hz(note) * h * i / RATE) / h;
      out.push(level * v / chord.length);
    }
  }
  return Float32Array.from(out);
}
const cMajor = [[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]];
const clusters = [[60, 61, 66], [62, 63, 68], [59, 60, 65], [61, 62, 67]];

test('the timeline follows heard time: level, key, a section change and its harmony', () => {
  const pcm = render([
    { seconds: 24, chords: cMajor, level: .08 },
    { seconds: 24, chords: clusters, level: .5, overtones: 4 },
  ]);
  const print = analyzeSongprintPCM(pcm);
  const t = print.timeline;
  assert.equal(t.stepMs, TIMELINE_STEP_MS);
  assert.equal(t.loudness.length, 24);
  const mean = (a, i, j) => a.slice(i, j).reduce((x, y) => x + y) / (j - i);
  assert.ok(mean(t.loudness, 14, 22) - mean(t.loudness, 2, 10) > .5, 'loud second half');
  assert.ok(mean(t.brightness, 14, 22) > mean(t.brightness, 2, 10), 'overtones brighten');
  assert.ok(mean(t.tension, 14, 22) - mean(t.tension, 2, 10) > .2, 'clusters are tense');
  const peak = t.novelty.indexOf(Math.max(...t.novelty));
  assert.ok(Math.abs(peak - 12) <= 1, `novelty peaks at the change (${peak})`);
});

test('a major progression reads as its key and major colour', () => {
  const t = songprintTimeline(render([{ seconds: 32, chords: cMajor, level: .3 }]),
    Array.from({ length: 256 }, (_, f) => { const r = new Float32Array(12); for (const n of cMajor[Math.floor(f / 16) % 4]) r[n % 12] = 1; return r; }));
  assert.equal(t.key.tonic, 0);
  assert.equal(t.key.major, true);
  assert.ok(t.major.slice(2, -2).every(v => v > .5));
});

test('the timeline survives a bundle copy and malformed data is dropped', () => {
  const print = analyzeSongprintPCM(render([{ seconds: 30, chords: cMajor, level: .2 }, { seconds: 10, chords: clusters, level: .4 }]));
  const copy = copySongprint(print, 40000);
  assert.deepEqual(copy.timeline, print.timeline);
  assert.equal(copySongprintTimeline({ ...print.timeline, tension: print.timeline.tension.slice(1) }), null);
  assert.equal(copySongprintTimeline({ ...print.timeline, key: { ...print.timeline.key, tonic: 12 } }), null);
  assert.equal(copySongprintTimeline(print.timeline, 10000), null, 'longer than the recording');
  assert.equal(copySongprint({ ...print, timeline: { version: 9 } }, 40000).timeline, undefined);
});

test('the 2D descriptor survives a short recording without a Songprint timeline', () => {
  const pcm = render([{ seconds: 14, chords: cMajor, level: .4 }]);
  const print = analyzeSongprintPCM(pcm, { fable: true });
  assert.equal(print.timeline, undefined);
  assert.ok(copySongprint(print, 14000)?.fable?.slices > 0);
});
