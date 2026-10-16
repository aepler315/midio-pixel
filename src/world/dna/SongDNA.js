// Song DNA — a continuous feature vector fingerprinting a song, extracted
// from real signal (MIDI note timeline + the energy-curve features already
// used for world scoring). No enums: every field is a number in [0,1] (or
// a pitch class 0..11), and the whole vector hashes into a seed that makes
// downstream generation deterministic for the same song.
import { clamp01, hashSeed } from '../../utils/math.js';
import { buildSongProfile, PROFILE_VERSION } from '../../audio/SongProfile.js';
import { Role } from '../../core/NoteEvent.js';

export { estimateKey } from '../../audio/TonalEvidence.js';
import { isAuthoredPitch } from '../../audio/TonalEvidence.js';
export const FIFTHS_ORDER = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];

// Coarse GM program-number -> shape-grammar family. Independent of
// MidiParser's role-classification table; this one only needs to answer
// "what does this instrument push the silhouette toward."
const FAMILY_RANGES = [
  [0, 7, 'organic'], [8, 15, 'geometric'], [16, 23, 'organic'],
  [24, 26, 'organic'], [27, 31, 'distorted'], [32, 39, 'organic'],
  [40, 47, 'organic'], [48, 55, 'organic'], [56, 63, 'geometric'],
  [64, 79, 'organic'], [80, 87, 'geometric'], [88, 103, 'geometric'],
  [104, 111, 'organic'], [112, 119, 'distorted'], [120, 127, 'geometric'],
];
function familyOf(program) {
  if (!Number.isFinite(program) || program < 0) return null;
  for (const [lo, hi, fam] of FAMILY_RANGES) if (program >= lo && program <= hi) return fam;
  return null;
}

/**
 * Audio-only fallback for familyShare (the organic/geometric/distorted mix
 * that drives ShapeGrammar's production-rule weights). A MIDI timeline
 * reads this straight from GM program numbers; audio has no programs, but
 * extractWatchFeatures already derives real spectral texture from the
 * energy-curve lithology (RidgePortrait.lithologyFromShares) that this was
 * simply never plugged into -- every audio upload got the same constant
 * {organic:0.34, geometric:0.33, distorted:0.33}, silently flattening a
 * large chunk of the terrain shape-grammar signal for the most common
 * upload path (most users drop an MP3/WAV, not an authored .mid).
 *
 *  - litho.scoop: positive = hollow-mid "electronic scoop" (bass+treble
 *    heavy, mids carved out -- EDM/metal-shaped spectra), negative =
 *    mid-forward (vocals/acoustic). Scoop + high transient contrast reads
 *    as `distorted`.
 *  - Narrow spectral spread (regular, synthetic-leaning timbre) plus low
 *    warmth reads as `geometric`.
 *  - Warm, wide-spread, mid-forward timbre reads as `organic`.
 */
export function familyShareFromWatch(watch) {
  const scoop01 = clamp01(0.5 + 0.5 * (watch.litho?.scoop ?? 0));
  const contrast = clamp01(watch.contrast ?? 0.3);
  const spread = clamp01(watch.spread ?? 0.5);
  const warmth = clamp01(watch.warmth ?? 0.4);

  const distorted = clamp01(0.55 * scoop01 + 0.45 * contrast);
  const geometric = clamp01(0.6 * (1 - spread) + 0.25 * (1 - warmth) + 0.15 * (1 - contrast));
  const organic = clamp01(0.5 * warmth + 0.3 * spread + 0.2 * (1 - scoop01));

  const sum = organic + geometric + distorted;
  if (sum < 1e-6) return { organic: 0.34, geometric: 0.33, distorted: 0.33 };
  return { organic: organic / sum, geometric: geometric / sum, distorted: distorted / sum };
}

/**
 * Whether an event carries real pitch information.
 *
 * The audio path emits every rhythm onset at a fixed placeholder pitch --
 * 36/38/42 for KICK/SNARE/HAT (AudioAdapter, via OnsetDetector's classifier)
 * -- and MIDI drums live on channel 9, where the "pitch" is a GM drum-kit
 * slot, not a note. Either way the number is not a pitch. Folding it into a
 * pitch-class histogram or a register statistic does not add noise, it adds a
 * large spike of CONSTANT, wrong shape: 36/38/42 fold to pitch classes 0, 2
 * and 6, so every audio upload gets a C/D/F# bias pushed into
 * Krumhansl-Schmuckler, and every mean-pitch reading gets dragged toward the
 * bottom two octaves. Rhythm onsets also use a 60ms minimum gap against the
 * pseudo-lanes' 120ms (OnsetDetector), so on most real music they are the
 * single most numerous role -- they outvote the actual notes.
 */
export function isPitched(e) {
  return e.channel !== 9 && e.role !== Role.RHYTHM;
}

function bucketByBar(timeline, barGrid, durationMs) {
  if (Array.isArray(barGrid) && barGrid.length > 1) {
    const bounds = barGrid.map((b) => b.ms).sort((a, b) => a - b);
    bounds.push(durationMs);
    const buckets = new Array(bounds.length - 1).fill(null).map(() => new Set());
    for (const e of timeline) {
      let i = 0;
      while (i < bounds.length - 2 && e.tMs >= bounds[i + 1]) i++;
      buckets[i].add(((e.pitch ?? 60) % 12 + 12) % 12);
    }
    return buckets;
  }
  const step = 2000;
  const nBuckets = Math.max(1, Math.ceil(durationMs / step));
  const buckets = new Array(nBuckets).fill(null).map(() => new Set());
  for (const e of timeline) {
    const i = Math.min(nBuckets - 1, Math.floor(e.tMs / step));
    buckets[i].add(((e.pitch ?? 60) % 12 + 12) % 12);
  }
  return buckets;
}

/**
 * Build the continuous song-DNA vector. `data` is whatever's already
 * threaded through offerWorldsThenStart: energyCurves/durationMs/bpm/
 * analysis/structure, PLUS (new) timeline/barGrid from midiToTimeline
 * when the source was MIDI. Audio-only songs (no timeline) still get a
 * full DNA — tonal fields fall back to neutral/energy-derived proxies.
 */
export function buildSongDNA(data = {}) {
  const { durationMs = 0, bpm = 0, structure = null } = data;
  const timeline = Array.isArray(data.timeline) ? data.timeline : [];
  const barGrid = data.barGrid;
  const dur = Math.max(1, durationMs || 1);

  const profile = data.profile?.version === PROFILE_VERSION
    ? data.profile
    : buildSongProfile(data);
  const watch = profile.watch;

  let tonicPc = 0, isMajor = true, keyConfidence = 0.3;
  let meanPitch01 = 0.5, registerSpread = 0.3, noteDensity = 0.3, velocityRange = 0.3;
  let harmonicComplexity = 0.3, percussionDensity = 0.2, registerTrend = 0;
  let familyShare = { organic: 0.34, geometric: 0.33, distorted: 0.33 };

  // The tonal fields (key, register, harmony) may only be read off events
  // that actually carry a pitch -- see isPitched. A drum-only timeline has a
  // rhythm to report but no key, and saying so is better than reporting the
  // drum map's own pitch classes as the song's harmony.
  const pitched = timeline.filter(isAuthoredPitch);
  const hasTonal = pitched.length >= 4;

  if (timeline.length >= 4) {
    let velMin = 1, velMax = 0, percCount = 0;
    const fam = { organic: 0, geometric: 0, distorted: 0, total: 0 };
    // Density, dynamics, percussion share and instrument family are
    // properties of the WHOLE arrangement -- drums belong in all four.
    for (const e of timeline) {
      const v = e.vel ?? 0.5;
      if (v < velMin) velMin = v;
      if (v > velMax) velMax = v;
      if (e.channel === 9 || e.role === Role.RHYTHM) percCount++;
      const f = familyOf(e.program);
      if (f) { fam[f]++; fam.total++; }
    }
    const n = timeline.length;
    noteDensity = clamp01((n / (dur / 1000)) / 8);
    velocityRange = clamp01(velMax - velMin);
    percussionDensity = clamp01(percCount / n);

    // GM program numbers, when the source actually had any. Audio uploads
    // never do (NoteEvent defaults program to -1, so familyOf returns null
    // for every event and fam.total stays 0) -- they fall through to the
    // spectral read below instead of to a hardcoded even split, which is the
    // whole reason familyShareFromWatch exists. Keying that fallback off
    // `timeline.length` rather than off the programs is what left every audio
    // upload wearing the constant: the audio path DOES build a timeline
    // (rhythm/melody/bass/PAD events), so it never reached the fallback.
    familyShare = fam.total > 0
      ? {
        organic: fam.organic / fam.total,
        geometric: fam.geometric / fam.total,
        distorted: fam.distorted / fam.total,
      }
      : familyShareFromWatch(watch);
  } else {
    familyShare = familyShareFromWatch(watch);
    noteDensity = watch.onset;
    velocityRange = watch.dyn;
    percussionDensity = clamp01(watch.onset * 0.6);
  }

  if (hasTonal) {
    let pitchSum = 0, pitchSqSum = 0;
    // Register trajectory: mean pitch of the song's first third vs its last
    // third, so particle direction can read whether the song climbs or
    // descends in register rather than only its instantaneous register.
    let firstSum = 0, firstN = 0, lastSum = 0, lastN = 0;
    const firstCut = dur / 3, lastCut = (dur * 2) / 3;
    for (const e of pitched) {
      const pitch = e.pitch ?? 60;
      pitchSum += pitch;
      pitchSqSum += pitch ** 2;
      if (e.tMs <= firstCut) { firstSum += pitch; firstN++; }
      else if (e.tMs >= lastCut) { lastSum += pitch; lastN++; }
    }
    tonicPc = profile.tonal.tonic; isMajor = profile.tonal.mode !== 'minor'; keyConfidence = profile.tonal.confidence;

    const meanPitch = pitchSum / pitched.length;
    const variance = Math.max(0, pitchSqSum / pitched.length - meanPitch * meanPitch);
    meanPitch01 = clamp01((meanPitch - 30) / 66);
    registerSpread = clamp01(Math.sqrt(variance) / 24);
    if (firstN > 0 && lastN > 0) {
      registerTrend = Math.max(-1, Math.min(1, (lastSum / lastN - firstSum / firstN) / 14));
    }

    // Harmony too: a drum hit is not a chord tone, and three fixed drum
    // classes per bar would inflate every bar's distinct-pitch-class count
    // toward the "rich harmony" end of a /7 scale on rhythm alone.
    const buckets = bucketByBar(pitched, barGrid, dur);
    const nonEmpty = buckets.filter((b) => b.size > 0);
    if (nonEmpty.length) {
      const avgDistinct = nonEmpty.reduce((s, b) => s + b.size, 0) / nonEmpty.length;
      harmonicComplexity = clamp01(avgDistinct / 7);
    }
  } else if (profile.tonal?.source === 'audio-chroma' && Number.isFinite(profile.tonal.tonic)) {
    // Recorded-audio chroma is a real measurement. Do not re-estimate a key
    // from placeholder event-lane pitches, and do not treat a spectral
    // centroid as a detected tonic.
    tonicPc = profile.tonal.tonic;
    isMajor = profile.tonal.mode !== 'minor';
    keyConfidence = profile.tonal.confidence;
    meanPitch01 = watch.centroid;
    registerSpread = watch.spread;
    harmonicComplexity = clamp01(watch.contrast);
    registerTrend = watch.trend ?? 0;
  } else {
    // Nothing pitched to read (audio-only upload with no melodic content, or
    // a drum-only timeline): derive tonal-ish proxies from spectral features
    // rather than pretending we detected a key.
    tonicPc = Math.round(watch.centroid * 11) % 12;
    isMajor = watch.warmth < 0.5;
    keyConfidence = 0.15;
    meanPitch01 = watch.centroid;
    registerSpread = watch.spread;
    harmonicComplexity = clamp01(watch.contrast);
    registerTrend = watch.trend ?? 0;
  }

  const dna = {
    tonicPc, isMajor, keyConfidence,
    meanPitch01, registerSpread, noteDensity, velocityRange, registerTrend,
    harmonicComplexity, percussionDensity, familyShare,
    tempo: bpm || watch.bpm || 100,
    tempoHeat: watch.tempoHeat,
    dyn: watch.dyn, centroid: watch.centroid, spread: watch.spread,
    phrase: watch.phrase, contrast: watch.contrast, groove: watch.groove,
    warmth: watch.warmth, texture: watch.texture, air: watch.air, bass: watch.bass,
    energyMean: watch.energyMean, arc: watch.arc, onset: watch.onset,
    sectionLabels: structure?.labels || null,
    hasTimeline: timeline.length >= 4,
    // Whether the tonal fields above came from real pitches or from the
    // spectral fallback -- the two are not equally trustworthy, and only this
    // says which one you got.
    hasTonalTimeline: hasTonal,
  };

  const seedKey = [
    tonicPc, isMajor ? 1 : 0, Math.round(keyConfidence * 100),
    Math.round(meanPitch01 * 100), Math.round(registerSpread * 100),
    Math.round(noteDensity * 100), Math.round(velocityRange * 100),
    Math.round(harmonicComplexity * 100), Math.round(percussionDensity * 100),
    Math.round(dna.tempo), Math.round(dna.dyn * 100), Math.round(dna.centroid * 100),
    Math.round(registerTrend * 100), Math.round(dur),
  ].join(':');
  dna.seed = hashSeed(seedKey);

  return dna;
}
