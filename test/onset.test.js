import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectRhythmOnsets, estimateTempo, extractPseudoLane, estimateSustainMs, mixBandEnvelopes,
  globalBandReferences, normalizeBands, estimateTempoCurve, buildDriftAwareBarGrid, bandEnvelope,
} from '../src/audio/OnsetDetector.js';
import { Role } from '../src/core/NoteEvent.js';
import { summarizeRhythmOnsets } from '../src/audio/RhythmProfile.js';
import { buildSongProfile } from '../src/audio/SongProfile.js';
import { clamp } from '../src/utils/math.js';

function silentBands(n) {
  return Array.from({ length: 7 }, () => new Float32Array(n));
}

test('detectRhythmOnsets finds periodic kicks and hats, classified correctly', () => {
  const rate = 86;
  const n = Math.round(rate * 8);
  const bands = silentBands(n);
  const periodFrames = Math.round(rate * 0.5); // 500ms period

  const kickFrames = [];
  for (let f = 0; f < n; f += periodFrames) {
    bands[0][f] = 0.9; bands[1][f] = 0.6;
    kickFrames.push(f);
  }
  const hatFrames = [];
  for (let f = Math.round(periodFrames / 2); f < n; f += periodFrames) {
    bands[5][f] = 0.7; bands[6][f] = 0.5;
    hatFrames.push(f);
  }

  const { onsets } = detectRhythmOnsets(bands, bands, rate, 1);
  const kicks = onsets.filter((o) => o.kick);
  const hats = onsets.filter((o) => o.type === 'HAT');

  assert.ok(kicks.length >= kickFrames.length - 2, `expected ~${kickFrames.length} kicks, got ${kicks.length}`);
  for (const k of kicks) assert.equal(k.pitch, 36);
  assert.ok(hats.length >= hatFrames.length - 2, `expected ~${hatFrames.length} hats, got ${hats.length}`);
  for (const h of hats) assert.equal(h.pitch, 42);
});

test('estimateTempo recovers BPM and a confident score from a periodic onset envelope', () => {
  const rate = 86;
  const bpmTrue = 128;
  const periodFrames = Math.round((rate * 60) / bpmTrue);
  const n = rate * 20;
  const O = new Float32Array(n);
  const kickFrames = [];
  for (let f = 0; f < n; f += periodFrames) { O[f] = 1; kickFrames.push(f); }

  const tempo = estimateTempo(O, rate, kickFrames);
  assert.ok(Math.abs(tempo.bpm - bpmTrue) < 3, `expected ~${bpmTrue}bpm, got ${tempo.bpm}`);
  assert.ok(tempo.confidence > 0.25, `expected confident tempo, got ${tempo.confidence}`);
  assert.equal(tempo.freeTime, false);
});

test('estimateTempo reports low confidence / freeTime on pure noise', () => {
  const rate = 86;
  const n = rate * 10;
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const O = Float32Array.from({ length: n }, () => rand());
  const tempo = estimateTempo(O, rate, []);
  assert.ok(tempo.confidence < 0.6); // noise shouldn't produce a strongly confident periodicity
});

test('extractPseudoLane emits MELODY notes from a varying MID band', () => {
  const rate = 86;
  const n = rate * 6;
  const bands = silentBands(n);
  for (let f = 0; f < n; f += Math.round(rate * 0.4)) {
    bands[3][f] = 0.8;
    bands[2][f] = 0.2;
    bands[4][f] = 0.4;
  }
  const notes = extractPseudoLane(bands, rate, { bandIndices: [2, 3, 4], pitchLo: 60, pitchHi: 96, role: Role.MELODY });
  assert.ok(notes.length > 3);
  for (const n2 of notes) {
    assert.ok(n2.pitch >= 60 && n2.pitch <= 96);
    assert.equal(n2.role, Role.MELODY);
  }
});

test('extractPseudoLane events carry their analysis frame for downstream pitch/duration refinement', () => {
  const rate = 86;
  const n = rate * 4;
  const bands = silentBands(n);
  for (let f = 0; f < n; f += Math.round(rate * 0.5)) bands[3][f] = 0.9;
  const notes = extractPseudoLane(bands, rate, { bandIndices: [2, 3, 4], pitchLo: 60, pitchHi: 96, role: Role.MELODY });
  assert.ok(notes.length > 0);
  for (const note of notes) {
    assert.ok(Number.isInteger(note.frame) && note.frame >= 0 && note.frame < n);
    assert.ok(Math.abs((note.frame / rate) * 1000 - note.tMs) < 1e-6, 'frame and tMs must agree');
  }
});

test('estimateSustainMs: a long plateau sustains, a transient spike stays near the floor, both clamped', () => {
  const rate = 86;
  const env = new Float32Array(rate * 4);
  // A 1s plateau starting at frame 43 (0.5s), then silence.
  for (let f = 43; f < 43 + rate; f++) env[f] = 0.8;
  const sustained = estimateSustainMs(env, rate, 43);
  assert.ok(Math.abs(sustained - 1000) < 120, `expected ~1000ms sustain, got ${sustained}`);

  // A single-frame spike.
  const spikeEnv = new Float32Array(rate * 2);
  spikeEnv[20] = 0.9;
  assert.equal(estimateSustainMs(spikeEnv, rate, 20), 120, 'a transient clamps to the minimum');

  // A plateau longer than the cap clamps to maxMs.
  const wall = new Float32Array(rate * 6);
  wall.fill(0.7);
  assert.equal(estimateSustainMs(wall, rate, 0), 1600);
});

test('mixBandEnvelopes averages exactly the requested bands', () => {
  const bands = silentBands(10);
  bands[2].fill(0.4);
  bands[3].fill(0.8);
  const mix = mixBandEnvelopes(bands, [2, 3]);
  for (const v of mix) assert.ok(Math.abs(v - 0.6) < 1e-6);
});

test('bandEnvelope keeps an opposite-phase stereo source audible', () => {
  // A signed L+R average would make this exactly zero despite both speakers
  // carrying a healthy tone. Analysis must combine channel power instead.
  const n = 2048;
  const left = new Float32Array(n), right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = 0.7 * Math.sin((2 * Math.PI * 220 * i) / 44100);
    right[i] = -left[i];
  }
  const buffer = {
    numberOfChannels: 2,
    getChannelData: (channel) => (channel === 0 ? left : right),
  };
  const env = bandEnvelope(buffer, 2);
  assert.ok(env.every((v) => v > 0.2), `phase-safe RMS should stay audible, got ${[...env]}`);
});

test('a fractional-frame beat period stays on grid for four minutes at common sample rates', () => {
  for (const sampleRate of [44100, 48000]) {
    const rate = sampleRate / 512;
    const tau = rate * 0.5; // exact 120 BPM, intentionally non-integer
    const grid = buildDriftAwareBarGrid(0, 240000, 4, rate, [{ startFrame: 0, tau, confidence: 1 }], tau);
    assert.equal(grid.length, 120, `${sampleRate}Hz should yield 120 four-beat bars`);
    assert.ok(Math.abs(grid[119].ms - 238000) < 1e-6,
      `${sampleRate}Hz bar 120 drifted to ${grid[119].ms}ms instead of 238000ms`);
  }
});

test('a 3/4 audio bar grid advances its musical tick by three beats', () => {
  const grid = buildDriftAwareBarGrid(0, 12000, 3, 100, [{ startFrame: 0, tau: 50, confidence: 1 }], 50);
  assert.equal(grid[0].tick, 0);
  assert.equal(grid[1].tick, 3);
  assert.equal(grid[2].tick, 6);
});

// --- True dynamics for EnergyCurves (globalBandReferences) ---------------

test('globalBandReferences: a band that only ever whispers gets a real (not full-scale) reference', () => {
  const rate = 86;
  const n = rate * 10;
  const loud = new Float32Array(n).fill(0.8); // one band roars the whole time
  const quiet = new Float32Array(n).fill(0.05); // another only ever whispers
  const [refLoud, refQuiet] = globalBandReferences([loud, quiet]);
  assert.ok(Math.abs(refLoud - 0.8) < 0.05, `expected the loud band's own reference near its true level, got ${refLoud}`);
  // Floored at 25% of the loudest band's reference -- not left to read its
  // own whisper as "full scale for this band".
  assert.ok(Math.abs(refQuiet - 0.25 * refLoud) < 0.01, `expected the sparse-band floor, got ${refQuiet}`);
});

test('globalBandReferences: the reference tracks the true 95th-percentile level, not a decayed max', () => {
  const rate = 86;
  const env = new Float32Array(rate * 20);
  for (let i = 0; i < env.length; i++) env[i] = i < rate * 15 ? 0.1 : 0.9; // quiet 15s, then loud
  const [ref] = globalBandReferences([env]);
  assert.ok(ref > 0.8, `expected the reference to reflect the loud stretch's true level, got ${ref}`);
});

test('quiet-intro / loud-chorus: EnergyCurves built from raw+reference reads them proportionally, unlike an AGC-normalized fill', () => {
  const rate = 86;
  const introFrames = rate * 15, chorusFrames = rate * 15;
  const raw = [new Float32Array(introFrames + chorusFrames)];
  for (let i = 0; i < introFrames; i++) raw[0][i] = 0.05; // a real whisper
  for (let i = introFrames; i < raw[0].length; i++) raw[0][i] = 0.9; // a real wall of sound
  const normAgc = normalizeBands(raw, rate); // the OLD path's per-band running-max AGC

  const [ref] = globalBandReferences(raw);
  const trueIntro = clamp(raw[0][10] / ref, 0, 1);
  const trueChorus = clamp(raw[0][introFrames + 10] / ref, 0, 1);
  assert.ok(trueChorus > trueIntro * 5, `true dynamics: chorus (${trueChorus}) must read far louder than the intro (${trueIntro})`);

  // The AGC path is exactly the failure mode this replaces: both sections
  // normalize toward 1 against their OWN local follower, erasing the gap
  // true dynamics preserve.
  const agcIntro = normAgc[0][introFrames - 10];
  const agcChorus = normAgc[0][introFrames + rate * 5]; // well after the AGC has caught up to the louder section
  assert.ok(agcIntro > 0.5, `AGC: the intro alone should have decayed its own follower down to near its own peak, got ${agcIntro}`);
  assert.ok(Math.abs(agcChorus - agcIntro) < 0.5, `AGC: intro and chorus should read similarly against their own local followers, got intro ${agcIntro} vs chorus ${agcChorus}`);
});

// --- The groove profile supervising the classifier ------------------------
//
// detectRhythmOnsets splits KICK/HAT/SNARE on fixed band shares -- one set of
// numbers for every listener and every genre. A warm GrooveFingerprint gets
// to override that with what the player themselves calls low and high. The
// non-negotiable property is that a cold profile changes nothing at all.

import { GrooveFingerprint, ROLE_LOW, ROLE_HIGH } from '../src/sim/GrooveFingerprint.js';

/** Band envelopes with a hit every `every` frames, shaped by `shape`. */
function pulseBands(frames, every, shape) {
  const raw = Array.from({ length: 7 }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    const hit = i % every === 0;
    for (let b = 0; b < 7; b++) raw[b][i] = (hit ? shape[b] : shape[b] * 0.02) + 1e-4;
  }
  return raw;
}

test('a cold groove profile classifies byte-identically to no profile at all', () => {
  const raw = pulseBands(600, 20, [0.7, 0.6, 0.2, 0.1, 0.05, 0.03, 0.02]);
  const norm = normalizeBands(raw, 86);
  const plain = detectRhythmOnsets(norm, raw, 86, 1);
  const cold = detectRhythmOnsets(norm, raw, 86, 1, new GrooveFingerprint());
  assert.equal(cold.onsets.length, plain.onsets.length);
  for (let i = 0; i < plain.onsets.length; i++) {
    assert.equal(cold.onsets[i].type, plain.onsets[i].type, `onset ${i} must not change`);
    assert.equal(cold.onsets[i].kick, plain.onsets[i].kick);
  }
});

test('a warm profile can reclassify a hit the fixed thresholds call a SNARE', () => {
  // A mid-heavy hit: low share ~0.33 and high share ~0.25 both miss the fixed
  // cutoffs, so the built-in rule files it as SNARE. A player who has spent
  // the song tapping F on exactly this sound means it as their kick.
  const shape = [0.20, 0.15, 0.25, 0.25, 0.12, 0.08, 0.05];
  const raw = pulseBands(600, 20, shape);
  const norm = normalizeBands(raw, 86);

  const plain = detectRhythmOnsets(norm, raw, 86, 1);
  assert.ok(plain.onsets.length > 0, 'fixture should produce onsets');
  assert.ok(plain.onsets.every((o) => o.type === 'SNARE'), 'the fixed rule hears snares here');

  const fp = new GrooveFingerprint();
  for (let i = 0; i < 40; i++) fp.observe({ role: ROLE_LOW, bands: shape, tMs: i * 100, energyNorm: 0.5 });
  for (let i = 0; i < 40; i++) {
    fp.observe({ role: ROLE_HIGH, bands: [0.02, 0.03, 0.05, 0.1, 0.3, 0.8, 0.7], tMs: i * 100, energyNorm: 0.5 });
  }

  const taught = detectRhythmOnsets(norm, raw, 86, 1, fp);
  assert.ok(taught.onsets.some((o) => o.kick), 'the player taught it that this is their kick');
});

// ── Meter detection ────────────────────────────────────────────────
//
// estimateTempo's downbeat search used to assume 4 beats/bar unconditionally
// -- `for (let m = 0; m < 4; m++)` -- so 4/4 was not just the default, it was
// the only reachable answer. A 3/4 waltz got bars 33% too long, throwing off
// every downstream consumer of the bar grid.

test('estimateTempo reads a 3/4 waltz (accented downbeat) as 3 beats/bar', () => {
  const rate = 86, bpm = 150, tau = Math.round((rate * 60) / bpm);
  const n = rate * 60;
  const O = new Float32Array(n);
  const kickFrames = [];
  let beat = 0;
  for (let f = 0; f < n; f += tau, beat++) {
    O[f] = beat % 3 === 0 ? 1.0 : 0.3; // strong downbeat, weaker 2 and 3
    if (beat % 3 === 0) kickFrames.push(f);
  }
  const tempo = estimateTempo(O, rate, kickFrames);
  assert.equal(tempo.beatsPerBar, 3);
  assert.ok(Math.abs(tempo.barPeriodMs - tau / rate * 1000 * 3) < 5);
});

test('estimateTempo keeps the 4/4 default when the kick pattern does not clearly favor 3', () => {
  const rate = 86, bpm = 128, tau = Math.round((rate * 60) / bpm);
  const n = rate * 60;
  // Every beat carries a kick, equally -- nothing in the signal distinguishes
  // downbeat 3 from downbeat 4, so the safer, far more common default must win.
  const O = new Float32Array(n);
  const kickFrames = [];
  for (let f = 0; f < n; f += tau) { O[f] = 1; kickFrames.push(f); }
  const tempo = estimateTempo(O, rate, kickFrames);
  assert.equal(tempo.beatsPerBar, 4);
});

// ── Harmonic disambiguation must not override a confident autocorrelation ──
//
// kickGridExplainScore bins kicks into a static modulo-tau histogram, which
// implicitly assumes the true beat period is an exact integer number of
// frames. It never is: a real tempo rounds to the nearest frame, and that
// sub-frame rounding error accumulates linearly with the song's length. Over
// a long, steady track the phase sweeps most of the way around the bin, so
// even the CORRECT tau's own kicks land all over the histogram and score as
// poorly "explained" as noise -- while a harmonic candidate the raw signal
// doesn't actually support can score higher purely by chance. Unguarded,
// that flipped tauFinal to a tau near-zero autocorrelation supports, which is
// how a clean, steady 120 BPM click over four minutes was reported as ~235
// BPM at zero confidence (silently falling back to free-time, kick-reactive
// jumps for a track that has a perfectly steady beat grid).

test('estimateTempo holds a steady 120 BPM over a full four-minute song instead of aliasing to a phantom harmonic', () => {
  const rate = 44100 / 512; // real analysis rate, not the test suite's rounded 86 -- the bug only shows up with the true fractional period
  const bpmTrue = 120;
  const periodFrames = (rate * 60) / bpmTrue; // real, non-integer period
  const durSec = 240;
  const n = Math.round(rate * durSec);
  const O = new Float32Array(n);
  const kickFrames = [];
  for (let f = 0; f < n; f += periodFrames) {
    const fi = Math.round(f);
    O[fi] = 1;
    kickFrames.push(fi);
  }

  const tempo = estimateTempo(O, rate, kickFrames);
  assert.ok(Math.abs(tempo.bpm - bpmTrue) < 1, `expected ~${bpmTrue}bpm, got ${tempo.bpm}`);
  assert.ok(tempo.confidence > 0.8, `expected a confident tempo read, got ${tempo.confidence}`);
  assert.equal(tempo.freeTime, false, 'a perfectly steady beat must never fall back to free-time');
});

// ── Drift-aware bar grid ────────────────────────────────────────────
//
// AudioAdapter used to extrapolate ONE beatPeriodMs, taken from a single
// global autocorrelation search, across the entire song. A live or acoustic
// recording's tempo routinely drifts a little over its length; extrapolating
// a fixed period lets that drift accumulate LINEARLY with duration instead
// of bounding it to whatever one window drifted by.

/** A song whose true tempo rises linearly from `bpmLo` to `bpmHi` over its
 *  length, with an onset on every beat (matching real spectral-flux shape --
 *  not just downbeats, which the local correlation search is tuned for). */
function acceleratingBeatEnvelope(rate, durSec, bpmLo, bpmHi) {
  const n = rate * durSec;
  const O = new Float32Array(n);
  const trueBeatFrames = [];
  for (let f = 0; f < n;) {
    const bpm = bpmLo + (f / n) * (bpmHi - bpmLo);
    trueBeatFrames.push(f);
    O[Math.round(f)] = 1;
    f += (rate * 60) / bpm;
  }
  return { O, trueBeatFrames };
}

test('buildDriftAwareBarGrid tracks a real tempo drift far more closely than one fixed period would', () => {
  const rate = 86, durSec = 240, beatsPerBar = 4;
  const { O, trueBeatFrames } = acceleratingBeatEnvelope(rate, durSec, 120, 126); // 5% drift
  const trueBarMs = trueBeatFrames.filter((_, i) => i % beatsPerBar === 0).map((fr) => (fr / rate) * 1000);

  // The realistic failure mode: a single global correlation search locks onto
  // one tempo (here, the song's start) rather than tracking the drift.
  const globalTau = Math.round((rate * 60) / 120);
  const curve = estimateTempoCurve(O, rate, globalTau);
  const driftGrid = buildDriftAwareBarGrid(0, durSec * 1000, beatsPerBar, rate, curve, globalTau).map((b) => b.ms);

  const fixedGrid = [];
  for (let t = 0; t < durSec * 1000; t += ((globalTau / rate) * 1000) * beatsPerBar) fixedGrid.push(t);

  // By the second half of the song the drift has accumulated enough that a
  // fixed-period grid is off by more than a beat, while the drift-aware one
  // -- re-locking its local tempo read every window -- stays close.
  const k = Math.floor(trueBarMs.length * 0.75);
  const beatMs = (globalTau / rate) * 1000;
  assert.ok(Math.abs(fixedGrid[k] - trueBarMs[k]) > beatMs,
    'fixture should actually exercise real drift (fixed grid must be off by more than a beat)');
  assert.ok(Math.abs(driftGrid[k] - trueBarMs[k]) < Math.abs(fixedGrid[k] - trueBarMs[k]) / 4,
    `drift-aware bar ${k} at ${driftGrid[k]}ms should track true ${trueBarMs[k]}ms far more closely than the fixed grid's ${fixedGrid[k]}ms`);

  // And the fixed grid's accumulated error is bad enough it doesn't even
  // reach the true number of bars in the song -- the drift-aware one does.
  assert.ok(driftGrid.length >= trueBarMs.length - 1);
  assert.ok(fixedGrid.length < trueBarMs.length,
    'fixture should also demonstrate the fixed grid running short, which is the more visible half of this bug');
});

test('buildDriftAwareBarGrid falls back to the global tau where a window is not confident', () => {
  const rate = 86, globalTau = 43;
  // One high-confidence window, one all-silent (unreadable) window.
  const curve = [
    { startFrame: 0, tau: 40, confidence: 0.9 },
    { startFrame: 2000, tau: 999, confidence: 0.01 }, // an obviously-wrong lock a silent window could produce
  ];
  const grid = buildDriftAwareBarGrid(0, 60000, 4, rate, curve, globalTau);
  // No bar should ever be spaced by the untrustworthy window's absurd tau.
  for (let i = 1; i < grid.length; i++) {
    const gap = grid[i].ms - grid[i - 1].ms;
    assert.ok(gap < 5000, `bar gap ${gap}ms should never reflect the untrusted tau=999 segment`);
  }
});

// ── Sliding-median threshold, at the window edges ──────────────────
//
// medianAdaptiveThreshold used to re-copy and re-sort the whole ~87-element
// window from scratch on every one of a song's ~20000 analysis frames, three
// times over (rhythm onsets plus both pseudo-lanes) -- about 1.1s of pure
// allocation+sort on a 4-minute song. It's now a single sorted array updated
// incrementally (remove the frame leaving the window, insert the one
// entering it), which makes the two ends of the signal -- where the window
// is asymmetric (still growing on the left, or already clipped on the
// right) -- the part most likely to go wrong in a rewrite.

test('detectRhythmOnsets still finds an onset sitting at frame 1 (the window has barely started growing)', () => {
  // Frame 0 can never itself be an onset (positiveFlux leaves flux[0] = 0 by
  // construction, regardless of the median), so frame 1 is the earliest real
  // edge case for the sliding median's incremental seeding.
  const rate = 86;
  const n = rate * 4;
  const bands = silentBands(n);
  bands[0][1] = 0.9; bands[1][1] = 0.6; // a kick at the earliest reachable frame
  for (let f = 100; f < n; f += 90) { bands[0][f] = 0.9; bands[1][f] = 0.6; } // keep the median non-trivial
  const { onsets } = detectRhythmOnsets(bands, bands, rate, 1);
  assert.ok(onsets.some((o) => o.frame === 1), 'an onset at frame 1 must still be detected');
});

test('detectRhythmOnsets still finds an onset sitting at the last frame (the window has stopped growing)', () => {
  const rate = 86;
  const n = rate * 4;
  const bands = silentBands(n);
  for (let f = 0; f < n - 90; f += 90) { bands[0][f] = 0.9; bands[1][f] = 0.6; }
  bands[0][n - 1] = 0.9; bands[1][n - 1] = 0.6; // a kick at the very last frame
  const { onsets } = detectRhythmOnsets(bands, bands, rate, 1);
  assert.ok(onsets.some((o) => o.frame === n - 1), 'an onset at the final frame must still be detected');
});

test('song profile event rate follows onset timestamps, not ridge landmarks', () => {
  const durationMs = 8000;
  const onsets = [];
  for (let t = 0; t < durationMs; t += 200) onsets.push({ tMs: t, kick: t % 400 === 0 });
  const rhythm = summarizeRhythmOnsets(onsets, durationMs, { beatPeriodMs: 400, confidence: 0.9 });
  const profile = buildSongProfile({ durationMs, bpm: 150, analysis: { rhythm }, confidence: 0.9 });
  assert.ok(Math.abs(profile.watch.onset - rhythm.eventDensity) < 1e-9);
  assert.equal(profile.events.onsetSource, 'onsets');
  assert.ok(Number.isFinite(profile.watch.form));
  assert.equal(profile.events.landmarks, profile.watch.landmarks);
});
