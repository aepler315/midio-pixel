// A fingerprint earns its place by two properties, and both are testable
// without a real recording: it must survive the transformations a codec and a
// speaker apply, and sliding it must recover WHERE a fragment sits in a song.
// Everything else about it is an implementation detail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprintBuffer, fingerprintMono, fingerprintKey, bitErrorRate, bestAlignment, sameRecording,
  bandEdges, toMono, resampleMono, MATCH_BER, FP_BITS, FP_RATE, FP_WINDOW,
} from '../src/audio/SongFingerprint.js';

const RATE = 44100;

/**
 * A deterministic pseudo-song.
 *
 * BROADBAND on purpose. An earlier version of this used three sine partials,
 * which left roughly thirty of the thirty-three bands holding nothing but
 * numerical residue -- and the sign of a difference of two empty bands is a
 * coin flip that any perturbation re-flips. That made the fingerprint look
 * catastrophically noise-fragile when what was actually being measured was
 * the behaviour of empty bands. Music occupies 300-2000 Hz; a test signal
 * that does not is testing something else.
 *
 * So: a harmonic stack over a changing fundamental (fills the range with
 * structure that MOVES between sections), plus shaped noise (fills the gaps
 * between harmonics), plus transients.
 */
function makeSong(seconds, seed = 1) {
  const n = Math.floor(seconds * RATE);
  const out = new Float32Array(n);
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const sections = Math.max(1, Math.floor(seconds / 2));
  const roots = [];
  const tilts = [];
  for (let i = 0; i < sections; i++) { roots.push(90 + rnd() * 70); tilts.push(0.5 + rnd()); }
  // One noise sequence, low-passed, so successive samples are correlated the
  // way real broadband musical content is rather than being white.
  let nz = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const sec = Math.min(sections - 1, Math.floor(t / 2));
    const root = roots[sec], tilt = tilts[sec];
    let v = 0;
    // Harmonics up to ~3kHz: every band in the fingerprint's range gets one.
    for (let h = 2; h <= 30; h++) {
      const f = root * h;
      if (f < 250 || f > 3000) continue;
      v += Math.sin(2 * Math.PI * f * t + h) * (0.35 / Math.pow(h, tilt));
    }
    nz += 0.25 * ((rnd() * 2 - 1) - nz);
    v += nz * 0.28;
    const phase = (t * 2) % 1;
    if (phase < 0.02) v += 0.4 * (1 - phase / 0.02) * (rnd() * 2 - 1);
    out[i] = v * 0.5;
  }
  return out;
}

test('band edges are strictly increasing and cover the chosen range', () => {
  const edges = bandEdges(FP_RATE, FP_WINDOW);
  assert.equal(edges.length, FP_BITS + 2, 'N bits need N+1 bands and N+2 edges');
  for (let i = 1; i < edges.length; i++) {
    assert.ok(edges[i] > edges[i - 1], `edge ${i} (${edges[i]}) must exceed ${edges[i - 1]}`);
  }
});

test('degenerate low sample rates still produce distinct bands', () => {
  // At 8kHz with a big window the log-spaced edges collide; every bit in a
  // collided pair would be a constant and the fingerprint would carry no
  // information at all.
  const edges = bandEdges(4000, FP_WINDOW);
  for (let i = 1; i < edges.length; i++) assert.ok(edges[i] > edges[i - 1]);
});

test('toMono averages the channels', () => {
  const stub = {
    numberOfChannels: 2,
    length: 3,
    getChannelData: (c) => (c === 0 ? new Float32Array([1, 0, -1]) : new Float32Array([0, 1, -1])),
  };
  const mono = toMono(stub);
  assert.ok(Math.abs(mono[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(mono[1] - 0.5) < 1e-6);
  assert.ok(Math.abs(mono[2] + 1) < 1e-6);
});

test('the same audio fingerprints identically', () => {
  const a = fingerprintMono(makeSong(6), RATE);
  const b = fingerprintMono(makeSong(6), RATE);
  assert.ok(a.frames.length > 10, 'six seconds should give plenty of frames');
  assert.deepEqual(Array.from(a.frames), Array.from(b.frames));
  assert.equal(fingerprintKey(a.frames), fingerprintKey(b.frames));
});

test('different songs get different keys and an uncorrelated bit error rate', () => {
  const a = fingerprintMono(makeSong(6, 1), RATE);
  const b = fingerprintMono(makeSong(6, 99), RATE);
  assert.notEqual(fingerprintKey(a.frames), fingerprintKey(b.frames));
  const ber = bitErrorRate(a.frames, b.frames);
  // Independent bits agree half the time, so ~0.5 is the "unrelated" reading.
  // The number to defend is that it sits far above the match threshold.
  assert.ok(ber > MATCH_BER + 0.1, `unrelated audio should be far from matching, got ${ber}`);
});

test('a volume change barely changes the fingerprint', () => {
  // Every bit is the sign of a difference of energies, and scaling multiplies
  // every term by the same factor, so the signs are invariant in exact
  // arithmetic. Not bit-identical, though: energies are sums of squares, and
  // at 0.15 scale a difference that was already within rounding of zero can
  // land on the other side of it. Near-zero is the honest claim.
  const song = makeSong(6);
  const quiet = Float32Array.from(song, (v) => v * 0.15);
  const ber = bitErrorRate(fingerprintMono(song, RATE).frames, fingerprintMono(quiet, RATE).frames);
  assert.ok(ber < 0.02, `scaling should be near-invariant, got ${ber}`);
});

test('the same audio at a different sample rate fingerprints the same', () => {
  // Everything is resampled to FP_RATE first, so a 44.1k rip and a 32k rip of
  // one master land on the same sequence rather than on two unrelated ones.
  const song = makeSong(8);
  const at32k = resampleMono(song, RATE, 32000);
  const ber = bitErrorRate(fingerprintMono(song, RATE).frames, fingerprintMono(at32k, 32000).frames);
  assert.ok(ber < MATCH_BER, `a resampled copy should match, got ${ber}`);
});

test('it survives a filter of the kind a codec or a speaker applies', () => {
  // A gentle one-pole tilt: absolute band energies all move, and a
  // fingerprint built on absolute energy would be destroyed. The local
  // slope signs mostly survive.
  const song = makeSong(8);
  const filtered = new Float32Array(song.length);
  let y = 0;
  for (let i = 0; i < song.length; i++) { y += 0.35 * (song[i] - y); filtered[i] = y + 0.5 * song[i]; }
  const a = fingerprintMono(song, RATE);
  const b = fingerprintMono(filtered, RATE);
  const ber = bitErrorRate(a.frames, b.frames);
  assert.ok(ber < MATCH_BER, `filtered audio should still match, got ${ber}`);
  assert.ok(sameRecording(a.frames, b.frames));
});

test('additive noise degrades it gracefully rather than destroying it', () => {
  const song = makeSong(8);
  let s = 7;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const noisy = Float32Array.from(song, (v) => v + (rnd() * 2 - 1) * 0.04);
  const ber = bitErrorRate(fingerprintMono(song, RATE).frames, fingerprintMono(noisy, RATE).frames);
  assert.ok(ber < MATCH_BER, `noisy audio should still match, got ${ber}`);
});

test('an excerpt is located at the right offset in the full song', () => {
  // This is the property that makes syncing possible: the winning offset is
  // not just evidence of a match, it is the playback position.
  const song = makeSong(20);
  const startSec = 8;
  const excerpt = song.subarray(startSec * RATE, (startSec + 4) * RATE);
  const ref = fingerprintMono(song, RATE);
  const probe = fingerprintMono(excerpt, RATE);
  const { offsetFrames, ber } = bestAlignment(ref.frames, probe.frames);
  const foundSec = offsetFrames / ref.frameHz;
  assert.ok(ber < 0.08, `an exact excerpt should align almost perfectly, got ${ber}`);
  assert.ok(Math.abs(foundSec - startSec) < 0.2, `expected ~${startSec}s, found ${foundSec.toFixed(2)}s`);
});

test('a noisy excerpt still lands at the right offset', () => {
  const song = makeSong(20);
  const startSec = 12;
  const raw = song.subarray(startSec * RATE, (startSec + 5) * RATE);
  let s = 3;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const excerpt = Float32Array.from(raw, (v) => v * 0.6 + (rnd() * 2 - 1) * 0.03);
  const ref = fingerprintMono(song, RATE);
  const probe = fingerprintMono(excerpt, RATE);
  const { offsetFrames, ber } = bestAlignment(ref.frames, probe.frames);
  const foundSec = offsetFrames / ref.frameHz;
  assert.ok(ber < MATCH_BER, `got ${ber}`);
  assert.ok(Math.abs(foundSec - startSec) < 0.3, `expected ~${startSec}s, found ${foundSec.toFixed(2)}s`);
});

test('an excerpt of a different song does not claim a match', () => {
  const ref = fingerprintMono(makeSong(20, 1), RATE);
  const probe = fingerprintMono(makeSong(4, 42), RATE);
  const { ber } = bestAlignment(ref.frames, probe.frames);
  assert.ok(ber > MATCH_BER, `a wrong song must not match, got ${ber}`);
  assert.equal(sameRecording(ref.frames, probe.frames), false);
});

test('too-short and empty inputs are handled, not thrown on', () => {
  assert.equal(fingerprintMono(new Float32Array(0), RATE).frames.length, 0);
  assert.equal(fingerprintMono(new Float32Array(100), RATE).frames.length, 0);
  assert.equal(resampleMono(new Float32Array(0), RATE).length, 0);
  assert.equal(bestAlignment(new Uint32Array(0), new Uint32Array(0)).ber, 1);
  assert.equal(bitErrorRate(new Uint32Array(0), new Uint32Array(0)), 1);
  assert.equal(sameRecording(null, null), false);
});

test('a probe longer than the reference does not match by accident', () => {
  const short = fingerprintMono(makeSong(3), RATE);
  const long = fingerprintMono(makeSong(10), RATE);
  assert.equal(bestAlignment(short.frames, long.frames).ber, 1);
});

test('the key is printable, prefixed, and length-sensitive', () => {
  const a = fingerprintMono(makeSong(6), RATE);
  const key = fingerprintKey(a.frames);
  assert.match(key, /^fp1_[0-9a-f]{24}$/);
  assert.notEqual(key, fingerprintKey(a.frames.subarray(0, a.frames.length - 1)));
});

function stereoBuffer(left, right) {
  return { length: left.length, duration: left.length / RATE, sampleRate: RATE,
    numberOfChannels: 2, getChannelData: (c) => c ? right : left };
}

test('opposite-phase stereo retains recording identity rather than collapsing to silence', () => {
  const a = makeSong(2, 1), b = makeSong(2, 99);
  const inverted = (v) => Float32Array.from(v, (x) => -x);
  const fa = fingerprintBuffer(stereoBuffer(a, inverted(a)));
  const fb = fingerprintBuffer(stereoBuffer(b, inverted(b)));
  assert.notEqual(fa.key, fb.key);
  assert.deepEqual(fa.frames, fingerprintBuffer(stereoBuffer(a, a)).frames);
});

test('silent and too-short recordings cannot supply an authoritative cache key', () => {
  for (const n of [10, RATE * 2]) {
    const silence = new Float32Array(n);
    assert.equal(fingerprintBuffer(stereoBuffer(silence, silence)).key, null);
  }
});


test('near-silent fingerprints cannot reuse an audible recording analysis', () => {
  const quiet = Float32Array.from(makeSong(2), (x) => x * 2 ** -60);
  assert.equal(fingerprintBuffer(stereoBuffer(quiet, quiet)).key, null);
});
