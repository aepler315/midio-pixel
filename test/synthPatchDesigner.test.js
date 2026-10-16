import { test } from 'node:test';
import assert from 'node:assert/strict';
import { designSynthPatches } from '../src/audio/SynthPatchDesigner.js';
import { Role } from '../src/core/NoteEvent.js';

function note({
  tMs, durMs = 200, pitch = 60, vel = 0.6, role = Role.MELODY, channel = 0,
}) {
  return {
    tMs, durMs, pitch, vel, role, kick: false, src: 'midi', channel, pan: 0, program: -1, lane: null,
  };
}

test('designSynthPatches returns nothing for an empty or drum-only timeline', () => {
  assert.deepEqual(designSynthPatches([], 10000), {});
  const drumsOnly = [
    note({ tMs: 0, pitch: 36, role: Role.RHYTHM, channel: 9 }),
    note({ tMs: 500, pitch: 38, role: Role.RHYTHM, channel: 9 }),
  ];
  assert.deepEqual(designSynthPatches(drumsOnly, 10000), {});
});

test('a bright, dense, staccato melody channel and a warm, sparse, legato pad channel land on different patches', () => {
  const timeline = [];
  // Channel 0: high-register, loud, short, densely-packed staccato lead.
  for (let i = 0; i < 40; i++) {
    timeline.push(note({
      tMs: i * 150, durMs: 60, pitch: 84 + (i % 3), vel: 0.9, role: Role.MELODY, channel: 0,
    }));
  }
  // Channel 1: low-register, quiet, long, sparse legato pad.
  for (let i = 0; i < 6; i++) {
    timeline.push(note({
      tMs: i * 4000, durMs: 3800, pitch: 40, vel: 0.25, role: Role.PAD, channel: 1,
    }));
  }
  const patches = designSynthPatches(timeline, 24000);
  const lead = patches[0], pad = patches[1];
  assert.ok(lead && pad, 'both channels should get a patch');

  // Brighter/edgier lead vs warmer pad.
  assert.equal(lead.type, 'sawtooth');
  assert.ok(['sine', 'triangle'].includes(pad.type));
  assert.ok(lead.cutoffHz > pad.cutoffHz, `lead cutoff ${lead.cutoffHz} should exceed pad cutoff ${pad.cutoffHz}`);

  // Staccato lead snaps in/out faster than the sustained pad.
  assert.ok(lead.attack < pad.attack);
  assert.ok(lead.release < pad.release);

  // Only the sustained, legato line earns vibrato.
  assert.equal(lead.vibratoDepthCents, 0);
  assert.ok(pad.vibratoDepthCents > 0);
});

test('a chordal (overlapping) channel gets a unison voice; a monophonic line does not', () => {
  const timeline = [];
  // Channel 0: a block chord every bar -- 3 simultaneous notes, 4 times.
  for (let i = 0; i < 4; i++) {
    const t0 = i * 2000;
    timeline.push(note({ tMs: t0, durMs: 1800, pitch: 48, channel: 0 }));
    timeline.push(note({ tMs: t0, durMs: 1800, pitch: 52, channel: 0 }));
    timeline.push(note({ tMs: t0, durMs: 1800, pitch: 55, channel: 0 }));
  }
  // Channel 1: a single-note monophonic run, never overlapping.
  for (let i = 0; i < 12; i++) {
    timeline.push(note({ tMs: i * 300, durMs: 120, pitch: 64, channel: 1 }));
  }
  const patches = designSynthPatches(timeline, 8000);
  assert.ok(patches[0].unisonGain > 0, 'chordal channel should get a unison voice');
  assert.equal(patches[1].unisonGain, 0, 'monophonic channel should stay clean');
});

test('BASS role always resolves to a low-passed, non-bright oscillator type', () => {
  const timeline = [];
  for (let i = 0; i < 16; i++) {
    timeline.push(note({ tMs: i * 400, durMs: 350, pitch: 33, vel: 0.8, role: Role.BASS, channel: 2 }));
  }
  const { 2: bass } = designSynthPatches(timeline, 6400);
  assert.ok(['sawtooth', 'square'].includes(bass.type));
});

test('designSynthPatches is a pure function of the timeline: identical input yields identical patches', () => {
  const timeline = [
    note({ tMs: 0, pitch: 60, channel: 0 }),
    note({ tMs: 300, pitch: 64, channel: 0 }),
    note({ tMs: 600, pitch: 67, channel: 0 }),
  ];
  const a = designSynthPatches(timeline, 3000);
  const b = designSynthPatches(structuredClone(timeline), 3000);
  assert.deepEqual(a, b);
});
