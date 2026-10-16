// A bundle is only useful if what comes back out drives the show the same way
// what went in did. So these round-trip a realistically-shaped analysis and
// check the values every downstream consumer actually reads, plus the two
// failure modes that would be dangerous if they were silent: a version this
// build cannot read, and a truncated payload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  packBundle, unpackBundle, bundleFrames, bytesToB64, b64ToBytes, BUNDLE_VERSION,
} from '../src/audio/AnalysisBundle.js';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { BANDS, FLAT_WEIGHTS } from '../src/audio/bands.js';
import { makeNoteEvent, Role } from '../src/core/NoteEvent.js';
import { PROFILE_VERSION } from '../src/audio/SongProfile.js';
import { Lane } from '../src/core/Casting.js';

const DURATION = 180000;

function makeAnalysis() {
  const curves = new EnergyCurves(DURATION, 50);
  for (let i = 0; i < curves.n; i++) {
    const t = i / curves.n;
    curves.setFrame(i, BANDS.map((_, b) => Math.min(1, Math.max(0, 0.5 + 0.4 * Math.sin(t * 9 + b)))));
  }
  const timeline = [];
  for (let t = 0; t < DURATION; t += 500) {
    timeline.push(makeNoteEvent({
      tMs: t, durMs: 240, pitch: 36 + ((t / 500) % 40), vel: 0.3 + ((t / 500) % 5) / 10,
      role: [Role.MELODY, Role.RHYTHM, Role.BASS, Role.PAD][(t / 500) % 4],
      kick: (t / 500) % 4 === 0, src: 'audio', channel: (t / 500) % 7, pan: (((t / 500) % 5) - 2) / 2,
      lane: [Lane.MIDASUS, null, Lane.BROSHI, null][(t / 500) % 4],
    }));
  }
  const barGrid = [];
  for (let t = 0, i = 0; t < DURATION; t += 2000, i++) {
    barGrid.push({ ms: t, index: i, tick: i * 3, numerator: 3, denominator: 4 });
  }
  return {
    timeline, barGrid, durationMs: DURATION,
    bpm: 124.5, beatPeriodMs: 481.9, confidence: 0.82, freeTime: false,
    energyCurves: curves,
    analysis: { chroma: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], tonic: 4, mode: 'minor', majorness: 0.3, tonalConfidence: 0.7, brightness: 0.44, dynamicRange: 0.6, stereoWidth: 0.5 },
    tonalityTimeline: [
      { tMs: 0, tonic: 4, mode: 'minor', majorness: -0.6, confidence: 0.3 },
      { tMs: 30000, tonic: 9, mode: 'major', majorness: 0.7, confidence: 0.8 },
    ],
    structure: {
      boundariesMs: [0, 30000, 62000, 121000],
      boundaryStrengths: [0, 0.84, 0.42, 0.91],
      labels: ['A', 'B', 'A', 'C'], novelty: [0.1, 0.9], cutIndices: [0, 15], confidence: 0.66,
      fineBoundariesMs: [45000], fineBoundaryEvidence: [{ timeMs: 45000, strength: 0.58, source: 'ssm', scale: 'fine' }],
    },
    stems: [{ name: 'drums.wav', lane: null }],
  };
}

const FP = { key: 'fp1_0123456789abcdef01234567', frames: Uint32Array.from([1, 2, 3, 0xffffffff, 0x80000000]), frameHz: 62.5 };

test('base64 round-trips arbitrary bytes including the padding cases', () => {
  for (const len of [0, 1, 2, 3, 4, 5, 255, 256]) {
    const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff);
    assert.deepEqual(Array.from(b64ToBytes(bytesToB64(bytes))), Array.from(bytes), `length ${len}`);
  }
});

test('scalars survive the round trip', () => {
  const out = unpackBundle(packBundle(makeAnalysis(), { fingerprint: FP }));
  assert.equal(out.durationMs, DURATION);
  assert.equal(out.bpm, 124.5);
  assert.equal(out.freeTime, false);
  assert.ok(Math.abs(out.confidence - 0.82) < 1e-6);
  assert.equal(out.fromBundle, true, 'a restored analysis must be identifiable as one');
});

test('the bar grid comes back with its times and indices', () => {
  const src = makeAnalysis();
  const out = unpackBundle(packBundle(src, { fingerprint: FP }));
  assert.equal(out.barGrid.length, src.barGrid.length);
  assert.equal(out.barGrid[0].ms, 0);
  assert.equal(out.barGrid[5].ms, src.barGrid[5].ms);
  assert.equal(out.barGrid[5].index, 5);
  assert.equal(out.barGrid[5].tick, src.barGrid[5].tick);
  assert.equal(out.barGrid[5].numerator, 3);
  assert.equal(out.barGrid[5].denominator, 4);
});

test('every note comes back with the fields the show reads', () => {
  const src = makeAnalysis();
  const out = unpackBundle(packBundle(src, { fingerprint: FP }));
  assert.equal(out.timeline.length, src.timeline.length);
  for (let i = 0; i < src.timeline.length; i++) {
    const a = src.timeline[i], b = out.timeline[i];
    assert.equal(b.tMs, a.tMs, `note ${i} time`);
    assert.equal(b.pitch, a.pitch, `note ${i} pitch`);
    assert.equal(b.role, a.role, `note ${i} role`);
    assert.equal(b.kick, a.kick, `note ${i} kick flag`);
    assert.equal(b.channel, a.channel, `note ${i} channel`);
    assert.equal(b.lane, a.lane, `note ${i} character lane`);
    // Velocity and pan are quantized to a byte; the step is well under
    // anything downstream distinguishes.
    assert.ok(Math.abs(b.vel - a.vel) <= 1 / 255, `note ${i} velocity`);
    assert.ok(Math.abs(b.pan - a.pan) <= 1 / 127, `note ${i} pan`);
  }
});

test('rejects a truncated note payload rather than starting a corrupted cached show', () => {
  const bundle = packBundle(makeAnalysis(), { fingerprint: FP });
  bundle.notes.lane = '';
  assert.equal(unpackBundle(bundle), null);
});

test('the energy curves answer the same questions within quantization', () => {
  // This is the field that actually drives the world, so it is checked the
  // way consumers use it -- by sampling, not by comparing internals.
  const src = makeAnalysis();
  const out = unpackBundle(packBundle(src, { fingerprint: FP }));
  assert.equal(out.energyCurves.n, src.energyCurves.n);
  assert.equal(out.energyCurves.rateHz, src.energyCurves.rateHz);
  let worstBand = 0, worstNorm = 0;
  for (let t = 0; t < DURATION; t += 997) {
    for (let b = 0; b < BANDS.length; b++) {
      worstBand = Math.max(worstBand, Math.abs(out.energyCurves.sample(b, t) - src.energyCurves.sample(b, t)));
    }
    worstNorm = Math.max(worstNorm, Math.abs(
      out.energyCurves.globalEnergyNorm(t, FLAT_WEIGHTS) - src.energyCurves.globalEnergyNorm(t, FLAT_WEIGHTS),
    ));
  }
  // A raw band sample can only be off by the quantization step itself.
  assert.ok(worstBand <= 1 / 255 + 1e-6, `raw band error should be one step, got ${worstBand}`);
  // The normalized reading is allowed slightly more: globalEnergyNorm maps
  // the song's p10..p90 onto a fixed span, which is a gain of roughly 1.3 on
  // this material, and it applies to both the sample and the percentiles it
  // is measured against. Still far below anything downstream acts on.
  assert.ok(worstNorm <= 0.02, `normalized error should stay small, got ${worstNorm}`);
});

test('structure boundaries and labels survive', () => {
  const src = makeAnalysis();
  const out = unpackBundle(packBundle(src, { fingerprint: FP }));
  assert.deepEqual(out.structure.labels, src.structure.labels);
  assert.equal(out.structure.boundariesMs.length, src.structure.boundariesMs.length);
  for (let i = 0; i < src.structure.boundariesMs.length; i++) {
    assert.equal(out.structure.boundariesMs[i], src.structure.boundariesMs[i]);
  }
  for (let i = 0; i < src.structure.boundaryStrengths.length; i++) {
    assert.ok(Math.abs(out.structure.boundaryStrengths[i] - src.structure.boundaryStrengths[i]) < 1e-6);
  }
  assert.deepEqual(out.structure.fineBoundariesMs, src.structure.fineBoundariesMs);
  assert.ok(Math.abs(out.structure.fineBoundaryEvidence[0].strength - 0.58) < 1e-6);
  assert.ok(Math.abs(out.structure.confidence - 0.66) < 1e-6);
});

test('the rolling key timeline survives so replay uses the same live key read', () => {
  const src = makeAnalysis();
  const out = unpackBundle(packBundle(src, { fingerprint: FP }));
  assert.deepEqual(out.tonalityTimeline, src.tonalityTimeline);
});

test('the analysis fingerprint block survives verbatim', () => {
  const src = makeAnalysis();
  const out = unpackBundle(packBundle(src, { fingerprint: FP }));
  assert.deepEqual(out.analysis, src.analysis);
  assert.deepEqual(out.stems, src.stems);
});

test('the acoustic fingerprint frames come back for alignment', () => {
  // Not just the key: a different rip hashes differently and can only be
  // found by aligning the sequence.
  const packed = packBundle(makeAnalysis(), { fingerprint: FP });
  assert.equal(packed.key, FP.key);
  assert.deepEqual(Array.from(bundleFrames(packed)), Array.from(FP.frames));
});

test('identity and name are carried for display and future lookup', () => {
  const packed = packBundle(makeAnalysis(), {
    fingerprint: FP, name: 'track.flac', identity: { artist: 'Someone', title: 'A Song', extra: 'dropped' },
  });
  assert.equal(packed.name, 'track.flac');
  assert.deepEqual(packed.identity, { artist: 'Someone', title: 'A Song' });
});

test('a bundle from a future version is refused, not misread', () => {
  // Silently decoding under the wrong layout would produce a show that is
  // subtly wrong with nothing to attribute it to.
  const packed = packBundle(makeAnalysis(), { fingerprint: FP });
  packed.v = BUNDLE_VERSION + 1;
  assert.equal(unpackBundle(packed), null);
  assert.equal(unpackBundle({}), null);
  assert.equal(unpackBundle(null), null);
});

test('a corrupted payload returns null rather than throwing', () => {
  const packed = packBundle(makeAnalysis(), { fingerprint: FP });
  packed.curves = { rateHz: 50, n: 100, bands: null };
  assert.equal(unpackBundle(packed), null);
});

test('an analysis with no structure or notes still round-trips', () => {
  const bare = {
    timeline: [], barGrid: [], durationMs: 1000, bpm: 0, energyCurves: null,
    analysis: null, structure: null, stems: null,
  };
  const out = unpackBundle(packBundle(bare, { fingerprint: FP }));
  assert.ok(out, 'a bare analysis is still a valid bundle');
  assert.equal(out.timeline.length, 0);
  assert.equal(out.energyCurves, null);
  assert.equal(out.structure, null);
});

test('the packed bundle is JSON-serializable and far smaller than the raw analysis', () => {
  const src = makeAnalysis();
  const packed = packBundle(src, { fingerprint: FP });
  const json = JSON.stringify(packed);
  assert.ok(json.length > 0);
  // Columnar + quantized. A naive dump of the same content re-states every
  // key name per note and every curve sample as a decimal string.
  const naive = JSON.stringify({
    timeline: src.timeline,
    bands: src.energyCurves.bands.map((b) => Array.from(b)),
  });
  assert.ok(json.length < naive.length / 3,
    `packed ${json.length} should be well under a third of naive ${naive.length}`);
  // And it must survive an actual serialize/parse cycle, which is what
  // IndexedDB and any future transport will do to it.
  assert.ok(unpackBundle(JSON.parse(json)));
});

test('song profile confidence survives a bundle round-trip; old bundles without one still unpack', () => {
  const src = makeAnalysis();
  const packed = packBundle(src, { fingerprint: FP });
  assert.equal(packed.v, BUNDLE_VERSION);
  assert.equal(packed.songProfile.version, PROFILE_VERSION);
  assert.ok(Number.isFinite(packed.songProfile.confidence.tempo));
  assert.ok(Number.isFinite(packed.songProfile.confidence.key));
  const out = unpackBundle(packed);
  assert.equal(out.songProfile.watch.bpm, src.bpm);
  assert.equal(out.confidence, src.confidence);

  const legacy = { ...packed };
  delete legacy.songProfile;
  const old = unpackBundle(legacy);
  assert.ok(old, 'a v3 bundle without a profile must still restore');
  assert.equal(old.songProfile, null);
  assert.equal(old.durationMs, src.durationMs);

  const future = { ...packed, songProfile: { ...packed.songProfile, version: packed.songProfile.version + 1 } };
  const dropped = unpackBundle(future);
  assert.ok(dropped, 'a v3 bundle with an unknown profile version must still restore');
  assert.equal(dropped.songProfile, null);
});

test('a song\'s identity (seed, opening profile, custom biome) survives, so a later play looks the same', async () => {
  const { buildSongProfile, snapshotSongProfile } = await import('../src/audio/SongProfile.js');
  const data = makeAnalysis();
  const opening = buildSongProfile({ ...data, durationMs: 15000 });
  data.songIdentity = { seed: 0xdeadbeef, songProfile: opening, customBiome: { name: 'x', palette: ['#102030'] } };
  const out = unpackBundle(JSON.parse(JSON.stringify(packBundle(data, { fingerprint: FP }))));
  assert.equal(out.songIdentity.seed, 0xdeadbeef);
  assert.deepEqual(out.songIdentity.customBiome, { name: 'x', palette: ['#102030'] });
  assert.equal(out.songIdentity.songProfile.version, opening.version);
  assert.deepEqual(out.songIdentity.songProfile, snapshotSongProfile(opening));
  const bare = unpackBundle(JSON.parse(JSON.stringify(packBundle(makeAnalysis(), { fingerprint: FP }))));
  assert.equal(bare.songIdentity, null, 'an older bundle without one still unpacks');
});
