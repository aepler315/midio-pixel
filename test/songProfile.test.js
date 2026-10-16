import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { Role } from '../src/core/NoteEvent.js';
import {
  buildSongProfile, snapshotSongProfile, profileFromSnapshot, PROFILE_VERSION,
} from '../src/audio/SongProfile.js';
import { extractWatchFeatures } from '../src/world/WorldScore.js';
import { buildSongDNA } from '../src/world/dna/SongDNA.js';

function curves({ durationMs = 60000, energyAt } = {}) {
  const ec = new EnergyCurves(durationMs, 50);
  for (let i = 0; i < ec.n; i++) {
    const t01 = ec.n > 1 ? i / (ec.n - 1) : 0;
    const e = energyAt ? energyAt(t01) : 0.4;
    ec.setFrame(i, [e, e * 0.8, e * 0.6, e * 0.5, e * 0.3, e * 0.2, e * 0.1]);
  }
  return ec;
}

test('silence, a very short clip, and missing structure are intentional fallbacks, not confident reads', () => {
  const silent = buildSongProfile({ durationMs: 0 });
  assert.equal(silent.version, PROFILE_VERSION);
  assert.ok(silent.confidence.overall < 0.4);
  assert.equal(silent.pulse.interpretation, 'free');
  assert.equal(silent.tonal.source, 'spectral-fallback');
  assert.equal(silent.sections.length, 0);
  assert.equal(silent.contrast.source, 'dynamics');

  const brief = buildSongProfile({ durationMs: 80, bpm: 0, freeTime: true });
  assert.equal(brief.pulse.freeTime, true);
  assert.equal(brief.confidence.tempo, 0);
  assert.ok(brief.confidence.key <= 0.15);
});

test('onset rate uses detected timestamps; ridge landmarks stay a phrase feature', () => {
  const durationMs = 60000;
  const onsets = [];
  for (let t = 0; t < durationMs; t += 250) onsets.push({ tMs: t, vel: 0.8, kick: t % 1000 === 0 });
  const profile = buildSongProfile({
    durationMs,
    bpm: 96,
    analysis: { rhythm: { eventDensity: 0.8, pulseRegularity: 0.9, confidence: 0.95 } },
  });
  assert.equal(profile.watch.onset, 0.8);
  assert.equal(profile.watch.pulse, 0.9);
  assert.equal(profile.events.onsetSource, 'onsets');
  assert.equal(profile.events.landmarks, 4);

  const fromTimes = buildSongProfile({
    durationMs,
    bpm: 120,
    timeline: onsets.map((o) => ({ ...o, role: Role.RHYTHM, channel: 9, pitch: 36 })),
  });
  assert.equal(fromTimes.events.onsetSource, 'timeline');
  assert.ok(fromTimes.events.eventRateHz > 2);
  assert.ok(fromTimes.watch.onset > 0.3);
  assert.equal(fromTimes.events.landmarks, fromTimes.watch.landmarks);
});

test('free-time does not invent a pulse; half/double tempo is named, not rewritten', () => {
  const free = buildSongProfile({ durationMs: 90000, bpm: 0, freeTime: true, confidence: 0 });
  assert.equal(free.pulse.interpretation, 'free');
  assert.equal(free.pulse.confidence, 0);
  assert.equal(free.watch.bpm, 0);

  const doubled = buildSongProfile({ durationMs: 90000, bpm: 176, confidence: 0.5, beatPeriodMs: 341 });
  assert.equal(doubled.pulse.interpretation, 'double');
  assert.equal(doubled.pulse.bpm, 176);
  assert.equal(doubled.pulse.altBpm, 88);
  assert.equal(doubled.watch.bpm, 176);

  const half = buildSongProfile({ durationMs: 90000, bpm: 64, confidence: 0.5 });
  assert.equal(half.pulse.interpretation, 'half');
  assert.equal(half.pulse.altBpm, 128);
});

test('adjacent sections compare energy; label diversity is not contrast', () => {
  const durationMs = 120000;
  const ec = curves({
    durationMs,
    energyAt: (t) => (t < 0.5 ? 0.12 : 0.82),
  });
  const labeled = buildSongProfile({
    durationMs,
    bpm: 100,
    energyCurves: ec,
    structure: {
      boundariesMs: [0, 60000, 120000],
      labels: ['A', 'A', 'A'],
      confidence: 0.7,
    },
  });
  const diverse = buildSongProfile({
    durationMs,
    bpm: 100,
    energyCurves: ec,
    structure: {
      boundariesMs: [0, 60000, 120000],
      labels: ['A', 'B', 'C'],
      confidence: 0.7,
    },
  });
  assert.equal(labeled.contrast.source, 'adjacent-energy');
  assert.ok(Math.abs(labeled.watch.contrast - diverse.watch.contrast) < 1e-9,
    'minting extra labels must not manufacture contrast');
  assert.ok(labeled.sections[0].energy < labeled.sections[1].energy);
  assert.ok(labeled.sections[0].energy < 0.35, 'a quiet half must stay quiet, not stretch to a climax');
  assert.ok(labeled.sections[1].energy > 0.55);
});

test('a drum-only timeline is rhythmic, not a key', () => {
  const timeline = [];
  for (let t = 0; t < 30000; t += 200) {
    timeline.push({ tMs: t, durMs: 80, pitch: 36, vel: 0.8, role: Role.RHYTHM, channel: 9, program: 0 });
  }
  const profile = buildSongProfile({ durationMs: 30000, bpm: 120, timeline, confidence: 0.8 });
  assert.equal(profile.tonal.source, 'spectral-fallback');
  assert.ok(profile.confidence.key <= 0.2);
  assert.ok(profile.events.onsets.length >= 4);
  const dna = buildSongDNA({ durationMs: 30000, bpm: 120, timeline });
  assert.equal(dna.hasTonalTimeline, false);
});

test('audio chroma is preferred over event-lane pitch; MIDI authored pitch still wins', () => {
  const audio = buildSongProfile({
    durationMs: 60000,
    bpm: 100,
    analysis: { tonic: 9, mode: 'minor', tonalConfidence: 0.8, brightness: 0.4 },
    timeline: Array.from({ length: 20 }, (_, i) => ({
      tMs: i * 500, durMs: 90, pitch: 36, vel: 0.6, role: Role.RHYTHM, channel: 0, program: -1,
    })),
  });
  assert.equal(audio.tonal.source, 'audio-chroma');
  assert.equal(audio.tonal.tonic, 9);
  assert.equal(audio.family.confidence, 0.25);
  const dna = buildSongDNA({
    durationMs: 60000, bpm: 100, profile: audio, analysis: audio.tonal,
    timeline: Array.from({ length: 20 }, (_, i) => ({
      tMs: i * 500, durMs: 90, pitch: 36, vel: 0.6, role: Role.RHYTHM, channel: 0, program: -1,
    })),
  });
  assert.equal(dna.tonicPc, 9);
  assert.equal(dna.isMajor, false);
  assert.ok(dna.keyConfidence > 0.5);

  const midi = buildSongDNA({
    durationMs: 60000,
    bpm: 120,
    timeline: Array.from({ length: 40 }, (_, i) => ({
      tMs: i * 400, durMs: 300, pitch: [60, 64, 67, 72][i % 4], vel: 0.6,
      role: Role.MELODY, channel: 0, program: 0,
    })),
    analysis: { tonic: 9, mode: 'minor', tonalConfidence: 0.99 },
  });
  assert.equal(midi.tonicPc, 0);
  assert.equal(midi.isMajor, true);
});

test('phase-opposed stereo is recorded, not treated as a crash or a key fact', () => {
  const profile = buildSongProfile({
    durationMs: 4000,
    analysis: { stereoWidth: -0.2, tonalConfidence: 0.05, tonic: 0, mode: 'major' },
  });
  assert.equal(profile.tonal.stereoWidth, -0.2);
  assert.equal(profile.tonal.source, 'spectral-fallback');
});

test('the profile is frozen and versioned; extractWatchFeatures is the watch slice', () => {
  const profile = buildSongProfile({ durationMs: 60000, bpm: 96 });
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.watch), true);
  assert.throws(() => { profile.watch.onset = 1; });
  const watch = extractWatchFeatures({ durationMs: 60000, bpm: 96 });
  assert.equal(watch.onset, profile.watch.onset);
  assert.equal(watch.drive, profile.watch.drive);
});

test('a snapshot round-trips; a mismatched version is refused', () => {
  const live = buildSongProfile({
    durationMs: 80000,
    bpm: 110,
    confidence: 0.7,
    analysis: { rhythm: { eventDensity: 0.4, pulseRegularity: 0.6, confidence: 0.7 } },
  });
  const snap = snapshotSongProfile(live);
  assert.equal(snap.version, PROFILE_VERSION);
  assert.ok(!snap.energyCurves);
  const back = profileFromSnapshot(snap);
  assert.equal(back.watch.onset, live.watch.onset);
  assert.equal(profileFromSnapshot({ ...snap, version: PROFILE_VERSION + 1 }), null);
});

test('SongDNA no longer imports WorldScore — the extraction cycle is gone', () => {
  const src = readFileSync(new URL('../src/world/dna/SongDNA.js', import.meta.url), 'utf8');
  assert.equal(/WorldScore/.test(src), false);
  assert.match(src, /SongProfile/);
});
