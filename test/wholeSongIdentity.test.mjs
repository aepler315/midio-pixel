// A song's look comes from the whole song, whichever way it reaches the
// show (src/audio/WholeSongIdentity.js): analysed whole first (export, stems,
// a short song), started on its opening and upgraded live, or restored from
// the analysis cache on either path. All of them must agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packBundle, unpackBundle, BUNDLE_VERSION } from '../src/audio/AnalysisBundle.js';
import { adoptFullAnalysis, asOpening } from '../src/audio/OpeningAnalysis.js';
import { buildSongProfile, PROFILE_VERSION, snapshotSongProfile } from '../src/audio/SongProfile.js';
import {
  buildSongIdentity, identityProvisional, identitySeed, provisionalIdentity,
} from '../src/audio/WholeSongIdentity.js';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { BANDS } from '../src/audio/bands.js';
import { makeNoteEvent, Role } from '../src/core/NoteEvent.js';

const DURATION = 214321.5;
// Analysis frame times are not representable in Float32, as real ones are not.
const FRAME_MS = 1000 / (44100 / 512);

function analyse(durationMs = DURATION, energy = (t, b) => 0.5 + 0.4 * Math.sin(t * 9 + b)) {
  const curves = new EnergyCurves(durationMs, 50);
  for (let i = 0; i < curves.n; i++) {
    curves.setFrame(i, BANDS.map((_, b) => Math.min(1, Math.max(0, energy(i / curves.n, b)))));
  }
  const timeline = [];
  for (let f = 5; f * FRAME_MS < durationMs; f += 47) {
    timeline.push(makeNoteEvent({ tMs: f * FRAME_MS, durMs: 240, pitch: 36 + (f % 40), vel: 0.6,
      role: [Role.MELODY, Role.RHYTHM, Role.BASS, Role.PAD][f % 4], src: 'audio' }));
  }
  const barGrid = [];
  for (let t = 0, i = 0; t < durationMs; t += 1935.48, i++) barGrid.push({ ms: t, index: i, tick: i * 4, numerator: 4, denominator: 4 });
  const data = {
    timeline, barGrid, durationMs, bpm: 124, beatPeriodMs: 483.87, confidence: 0.8, freeTime: false,
    energyCurves: curves,
    analysis: { chroma: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], tonic: 4, mode: 'minor', majorness: 0.3, tonalConfidence: 0.7, brightness: 0.44, dynamicRange: 0.6, stereoWidth: 0.5 },
    structure: durationMs > 60000 ? {
      boundariesMs: [0, 41000, 98000, 160000], boundaryStrengths: [0, 0.8, 0.5, 0.9],
      labels: ['A', 'B', 'A', 'C'], novelty: [0.1, 0.9], cutIndices: [0, 15], confidence: 0.7,
    } : null,
  };
  data.songProfile = buildSongProfile(data);
  return data;
}

const FP = { key: 'fp1_identity', frames: Uint32Array.from([1, 2, 3]), frameHz: 62.5 };
// The cache stores a profile as JSON (typed arrays become arrays), so two
// identities are the same look when their seeds and profile values agree.
const same = (a, b, message) => {
  assert.equal(a.seed, b.seed, message);
  assert.deepEqual(snapshotSongProfile(a.songProfile), snapshotSongProfile(b.songProfile), message);
};
const roundTrip = (data) => unpackBundle(JSON.parse(JSON.stringify(packBundle(data, { fingerprint: FP, name: 'song.wav' }))));

test('live-first, export-first and cache-hit plays of one song share one identity', () => {
  const whole = analyse();
  // Export first (or stems, or a short song): identified from the whole song.
  const exported = buildSongIdentity(whole);
  assert.equal(exported.songProfile, whole.songProfile);
  assert.equal(exported.seed, identitySeed(whole));

  // Live first: the opening plays provisionally, then the whole song lands.
  const opening = asOpening(analyse(15000, (t, b) => 0.2 + 0.05 * b), DURATION);
  assert.equal(opening.songIdentity, undefined);
  const live = adoptFullAnalysis(opening, analyse()).songIdentity;
  assert.deepEqual(live, exported);

  // The cache, written once the whole song is in, carries that identity...
  const restored = roundTrip({ ...whole, songIdentity: exported });
  same(buildSongIdentity(restored), exported, 'an export or short song restored from the cache');
  same(adoptFullAnalysis(asOpening(analyse(15000), DURATION), restored).songIdentity, exported,
    'a live play whose whole-song pass is a cache hit');

  // ...and a bundle without one is identified exactly as a fresh analysis is,
  // although its note times came back as Float32.
  const bare = roundTrip({ ...whole, songIdentity: null });
  assert.notEqual(bare.timeline[0].tMs, whole.timeline[0].tMs, 'the cache really does quantise times');
  same(buildSongIdentity(bare), exported);
});

test('the opening never decides the look', () => {
  const opening = asOpening(analyse(15000, () => 0.1), DURATION);
  const provisional = provisionalIdentity(opening);
  assert.equal(provisional.provisional, true);
  const whole = analyse();
  assert.notDeepEqual(provisional.seed, buildSongIdentity(whole).seed, 'a different timeline, a different seed');
  assert.equal(identityProvisional(opening), true);
  const upgraded = adoptFullAnalysis(opening, whole);
  assert.equal(identityProvisional(upgraded), false);
  assert.equal(identityProvisional({ ...upgraded, identityPending: true }), true, 'exports wait for the hand-off too');
});

test('bundles from before whole-song identities are refused', () => {
  const packed = JSON.parse(JSON.stringify(packBundle(analyse(), { fingerprint: FP })));
  assert.equal(packed.v, BUNDLE_VERSION);
  assert.ok(BUNDLE_VERSION >= 5);
  assert.equal(unpackBundle({ ...packed, v: 4 }), null, 'a v4 bundle may carry an opening identity');
});

test('an identity is kept or dropped whole, never half', () => {
  const whole = analyse();
  const identity = buildSongIdentity(whole);
  const packed = JSON.parse(JSON.stringify(packBundle({ ...whole, songIdentity: identity }, { fingerprint: FP })));
  const otherVersion = {
    ...packed,
    songIdentity: { ...packed.songIdentity, songProfile: { ...packed.songIdentity.songProfile, version: PROFILE_VERSION + 1 } },
  };
  const restored = unpackBundle(otherVersion);
  assert.ok(restored, 'the analysis still restores');
  assert.equal(restored.songIdentity, null, 'its seed does not outlive its profile');
  same(buildSongIdentity(restored), identity, 'and the identity is rebuilt from the whole song');
});

test('only the full pass freezes a Songprint, including restored and legacy identities', () => {
  const full = analyse();
  const print = { version: 1, skyline: Array.from({ length: 16 }, (_, i) => i/15),
    passages: [{ timeMs: 6000, landmark01: .67, strength: .9 }] };
  full.songprint = print;
  full.songIdentity = buildSongIdentity(full);
  assert.deepEqual(full.songIdentity.songprint, print);
  const opening = asOpening(analyse(15000), DURATION);
  assert.equal(provisionalIdentity({ ...opening, songprint: print }).songprint, undefined);
  assert.equal(packBundle({ ...opening, songprint: print }).songprint, undefined);
  const packed = JSON.parse(JSON.stringify(packBundle(full, { fingerprint: FP })));
  assert.deepEqual(packed.songprint, print);
  assert.equal(packed.songIdentity.songprint, undefined, 'store a single copy of the passage list');
  const restored = unpackBundle(packed);
  assert.deepEqual(restored.songprint, print);
  assert.deepEqual(adoptFullAnalysis(opening, restored).songIdentity.songprint, print);
  for (const malformed of [undefined, { ...print, version: 99 }, { ...print, skyline: [1] },
    { ...print, passages: [{ timeMs: DURATION + 10, landmark01: .5, strength: 1 }] }]) {
    const legacy = unpackBundle({ ...packed, songprint: malformed });
    assert.ok(legacy);
    assert.equal(Object.hasOwn(legacy, 'songprint'), false);
    assert.equal(buildSongIdentity(legacy).songprint, undefined);
  }
  assert.equal(unpackBundle({ ...packed, songprint: null }).songprint, null, 'measured, insufficient evidence');
});
