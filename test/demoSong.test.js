// The song behind 'Play a sample': buildDemoSong()'s authored score, its PCM
// render (DemoSongRender.js) and the energy curves main.js synthesizes from
// the same timeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoSong, expectedChoreography, DEMO_BPM, DEMO_DURATION_MS, SECTIONS } from '../src/core/DemoSong.js';
import { renderDemoSongPcm, renderDemoSongToAudioBuffer, DEMO_SAMPLE_RATE } from '../src/audio/DemoSongRender.js';
import { synthesizeEnergyCurves } from '../src/core/EnergyCurvesSynth.js';
import { HypeDirector } from '../src/sim/HypeDirector.js';
import { Lane } from '../src/core/Casting.js';

const song = buildDemoSong();
const expect = expectedChoreography(song);
// The curves main.js builds for the sample, from the same score.
const energy = synthesizeEnergyCurves(song.timeline, song.durationMs);

test('the score is a real song: 48 bars at 120, with every named section', () => {
  assert.equal(song.bpm, DEMO_BPM);
  assert.equal(song.durationMs, DEMO_DURATION_MS);
  assert.equal(song.barGrid.length, 48);
  assert.ok(SECTIONS.length >= 8);
  // The named sections tile the song from its first bar to its last: main.js
  // turns them into the structure's labels and boundaries.
  assert.equal(song.sections, SECTIONS);
  let bar = 0;
  for (const s of song.sections) {
    assert.equal(s.bar0, bar, `${s.id} starts where the section before it ends`);
    bar += s.bars;
  }
  assert.equal(bar, song.barGrid.length);
  assert.ok(song.timeline.length > 200, `sparse score? ${song.timeline.length} events`);
  const lanes = new Set(song.timeline.map((e) => e.lane).filter(Boolean));
  assert.ok(lanes.has(Lane.BROSHI) && lanes.has(Lane.MIDASUS) && lanes.has(Lane.MIDIO),
    'the bass, melody and lead parts must each own a lane');
});

test('the authored drop is visible to HypeDirector from energy, not only from the cue', () => {
  // A director that is never cued: this is what a raw-audio drop of the
  // same mix has to look like.
  const h = new HypeDirector();
  const dropAt = expect.drops[0];
  const dt = 1 / 120;
  for (let t = 0; t <= dropAt + 1500; t += 1000 / 120) h.update(t, dt, energy);
  assert.ok(h.dropCount >= 1, 'quiet-then-loud mix never registered as a drop');
  assert.ok(Math.abs(h.dropAtMs - dropAt) < 1500,
    `energy drop at ${h.dropAtMs}ms, authored drop at ${dropAt}ms`);
});

test('the rendered audio peaks on kicks and is quiet in the break', () => {
  const pcm = renderDemoSongPcm(song, { sampleRate: 22050, stereo: false });
  const sr = pcm.sampleRate;
  const rms = (fromMs, toMs) => {
    const a = Math.floor(fromMs / 1000 * sr);
    const b = Math.min(pcm.length, Math.floor(toMs / 1000 * sr));
    let s = 0, n = 0;
    for (let i = a; i < b; i++) { s += pcm.left[i] * pcm.left[i]; n++; }
    return n ? Math.sqrt(s / n) : 0;
  };
  const kick = expect.kicks.find((k) => k.tMs > 32000 && k.tMs < 34000);
  assert.ok(kick, 'expected a drop-bar kick');
  const kickRms = rms(kick.tMs, kick.tMs + 80);
  const breakWin = expect.restWindows[0];
  const breakRms = rms(breakWin.fromMs + 400, breakWin.fromMs + 1600);
  assert.ok(kickRms > 0.05, `kick is inaudible (rms ${kickRms})`);
  assert.ok(kickRms > breakRms * 2,
    `drop kick (${kickRms.toFixed(3)}) should dwarf the break (${breakRms.toFixed(3)})`);
});

test('renderDemoSongToAudioBuffer renders at the fixed 44100 Hz, not the context\'s rate', () => {
  const calls = [];
  const ctx = {
    sampleRate: 48000,
    createBuffer(channels, length, sampleRate) {
      calls.push([channels, length, sampleRate]);
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { numberOfChannels: channels, length, sampleRate, getChannelData: (i) => data[i] };
    },
  };
  const buf = renderDemoSongToAudioBuffer(ctx, song);
  assert.equal(DEMO_SAMPLE_RATE, 44100);
  assert.deepEqual(calls, [[2, Math.ceil((DEMO_DURATION_MS / 1000) * 44100), 44100]]);
  assert.equal(buf.sampleRate, 44100);
  // The two channels hold the stereo PCM render at that rate, left then right.
  const pcm = renderDemoSongPcm(song, { sampleRate: 44100, stereo: true });
  const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  assert.ok(!bytes(pcm.left).equals(bytes(pcm.right)), 'the mix is stereo, so swapped channels would show');
  assert.ok(bytes(buf.getChannelData(0)).equals(bytes(pcm.left)), 'channel 0 is the left mix');
  assert.ok(bytes(buf.getChannelData(1)).equals(bytes(pcm.right)), 'channel 1 is the right mix');
});
