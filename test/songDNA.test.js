import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateKey, buildSongDNA, FIFTHS_ORDER, familyShareFromWatch,
} from '../src/world/dna/SongDNA.js';
import { oklchToHex, hexToOklab, oklabDelta } from '../src/world/dna/OklchColor.js';
import {
  buildShapeGrammar, computeTemperature, pickFx, pickParticleKind, deriveTerrainParams, deriveParticleMotion,
  pickCharacterScheme, CHARACTER_SCHEMES,
} from '../src/world/dna/ShapeGrammar.js';
import { synthesizePalette, synthesizeSectionPalettes } from '../src/world/dna/PaletteSynth.js';
import { LANDMARKS } from '../src/world/Landmarks.js';
import { biomeByName } from '../src/world/BiomeProfiles.js';
import { ValueNoise1D } from '../src/utils/noise.js';
import { alpineHeightField, rollingHeightField, ALPINE_CHARACTERS } from '../src/world/SilhouetteGenerator.js';
import { ParticleField } from '../src/world/ParticleField.js';
import { cityHeightField, buildingProfile } from '../src/world/city/CitySilhouette.js';

// The published Krumhansl-Schmuckler tonal-hierarchy profiles, rooted at C.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const rotate = (arr, n) => arr.map((_, i) => arr[(i - n + 12) % 12]);

test('estimateKey resolves an exact C major profile to C major with high confidence', () => {
  const { tonicPc, isMajor, confidence } = estimateKey(MAJOR_PROFILE);
  assert.equal(tonicPc, 0);
  assert.equal(isMajor, true);
  assert.ok(confidence > 0.8, `confidence ${confidence} too low`);
});

test('estimateKey resolves an exact A minor profile to A minor', () => {
  const hist = rotate(MINOR_PROFILE, 9); // root shifted from C to A
  const { tonicPc, isMajor, confidence } = estimateKey(hist);
  assert.equal(tonicPc, 9);
  assert.equal(isMajor, false);
  assert.ok(confidence > 0.8, `confidence ${confidence} too low`);
});

test('estimateKey rotates cleanly across all 12 tonics', () => {
  for (let pc = 0; pc < 12; pc++) {
    const { tonicPc } = estimateKey(rotate(MAJOR_PROFILE, pc));
    assert.equal(tonicPc, pc, `major profile rooted at ${pc} misread as ${tonicPc}`);
  }
});

test('FIFTHS_ORDER puts fifths-related keys 30 degrees apart, starting at C', () => {
  assert.equal(FIFTHS_ORDER[0], 0); // C
  assert.equal(FIFTHS_ORDER[1], 7); // G, a fifth up
  assert.equal(FIFTHS_ORDER[2], 2); // D
  assert.equal(new Set(FIFTHS_ORDER).size, 12); // every pitch class exactly once
});

function synthTimeline({ pitches, program = 0, channel = 0, n = 200, durationMs = 60000 }) {
  const timeline = [];
  for (let i = 0; i < n; i++) {
    timeline.push({
      tMs: (i / n) * durationMs,
      durMs: 200,
      pitch: pitches[i % pitches.length],
      vel: 0.6,
      role: 'MELODY',
      channel,
      program,
    });
  }
  return { timeline, durationMs, bpm: 120 };
}

test('buildSongDNA detects key from a MIDI timeline built on a C major triad', () => {
  const data = synthTimeline({ pitches: [60, 64, 67, 72, 64, 67] }); // C E G
  const dna = buildSongDNA(data);
  assert.equal(dna.tonicPc, 0);
  assert.equal(dna.isMajor, true);
  assert.equal(dna.hasTimeline, true);
});

test('buildSongDNA is deterministic: same song data -> same seed and same DNA', () => {
  const data = synthTimeline({ pitches: [57, 60, 64, 69] });
  const a = buildSongDNA(data);
  const b = buildSongDNA(data);
  assert.equal(a.seed, b.seed);
  assert.equal(a.tonicPc, b.tonicPc);
  assert.equal(a.isMajor, b.isMajor);
});

test('buildSongDNA falls back to spectral proxies with no timeline (audio-only upload)', () => {
  const dna = buildSongDNA({ durationMs: 60000, bpm: 100 });
  assert.equal(dna.hasTimeline, false);
  assert.ok(Number.isFinite(dna.seed));
  assert.ok(dna.tonicPc >= 0 && dna.tonicPc <= 11);
});

test('familyShareFromWatch reads real spectral texture into organic/geometric/distorted, not a constant', () => {
  const organic = familyShareFromWatch({ litho: { scoop: -0.6 }, contrast: 0.15, spread: 0.75, warmth: 0.8 });
  const geometric = familyShareFromWatch({ litho: { scoop: 0.1 }, contrast: 0.3, spread: 0.15, warmth: 0.25 });
  const distorted = familyShareFromWatch({ litho: { scoop: 0.85 }, contrast: 0.85, spread: 0.5, warmth: 0.3 });
  for (const fs of [organic, geometric, distorted]) {
    const sum = fs.organic + fs.geometric + fs.distorted;
    assert.ok(Math.abs(sum - 1) < 1e-6, `shares should sum to 1, got ${sum}`);
  }
  // Each profile's own category should come out on top.
  assert.ok(organic.organic > organic.geometric && organic.organic > organic.distorted);
  assert.ok(geometric.geometric > geometric.organic && geometric.geometric > geometric.distorted);
  assert.ok(distorted.distorted > distorted.organic && distorted.distorted > distorted.geometric);
  // No litho at all (energyCurves-null default) still returns something
  // finite and normalized rather than NaN/undefined.
  const noLitho = familyShareFromWatch({});
  const sum = noLitho.organic + noLitho.geometric + noLitho.distorted;
  assert.ok(Math.abs(sum - 1) < 1e-6);
});

test('buildSongDNA (audio-only) actually varies familyShare with the song\'s spectral character instead of a fixed default', () => {
  // analysis.brightness/dynamicRange are the one lever extractWatchFeatures
  // exposes without a full fake EnergyCurves object -- they still move
  // centroid/warmth/dyn/contrast, which is enough to prove familyShare is
  // no longer pinned to {organic:0.34, geometric:0.33, distorted:0.33} for
  // every audio upload regardless of how the song actually sounds.
  const dark = buildSongDNA({ durationMs: 60000, bpm: 100, analysis: { brightness: 0.1, dynamicRange: 0.1 } });
  const bright = buildSongDNA({ durationMs: 60000, bpm: 100, analysis: { brightness: 0.95, dynamicRange: 0.9 } });
  assert.notDeepEqual(dark.familyShare, bright.familyShare);
  const grammarDark = buildShapeGrammar(dark);
  const grammarBright = buildShapeGrammar(bright);
  assert.notDeepEqual(grammarDark, grammarBright);
});

// ── The audio upload path ──────────────────────────────────────────
//
// AudioAdapter produces a real NoteEvent timeline (rhythm/melody/bass/PAD),
// so `timeline.length >= 4` is TRUE for an audio upload -- it is not the
// "no timeline" case the tests above cover. Two things followed from that:
//
//  * familyShare's spectral fallback was gated on timeline length rather
//    than on whether GM programs actually existed, and audio events carry
//    program -1. So every audio upload took the MIDI branch, found no
//    family for any event, and kept the hardcoded even split -- the exact
//    constant familyShareFromWatch was written to replace. The test above
//    passed throughout because it calls the no-timeline path.
//  * every rhythm onset is emitted at a fixed placeholder pitch (36/38/42
//    for KICK/SNARE/HAT), and those were folded into the register and
//    harmony statistics as if they were notes.

/** An AudioAdapter-shaped timeline: no programs anywhere, plus the fixed
 *  placeholder-pitch drum lane, which is typically the most numerous role. */
function audioTimeline({ melody, withDrums = true, durationMs = 120000 }) {
  const timeline = [];
  for (let t = 0, i = 0; t < durationMs; t += 600, i++) {
    timeline.push({
      tMs: t, durMs: 550, pitch: melody[i % melody.length], vel: 0.7,
      role: 'MELODY', channel: 3, program: -1,
    });
  }
  if (withDrums) {
    for (let t = 0; t < durationMs; t += 250) {
      timeline.push({
        tMs: t, durMs: 90, pitch: t % 500 === 0 ? 36 : 42, vel: 0.8,
        role: 'RHYTHM', channel: 0, program: -1,
      });
    }
  }
  return { timeline, durationMs, bpm: 120 };
}

test('familyShare falls back to the spectral read for an audio timeline, which has no GM programs', () => {
  const melody = [67, 71, 74, 67, 62, 71, 66, 67];
  const dark = buildSongDNA({ ...audioTimeline({ melody }), analysis: { brightness: 0.1, dynamicRange: 0.1 } });
  const bright = buildSongDNA({ ...audioTimeline({ melody }), analysis: { brightness: 0.95, dynamicRange: 0.9 } });

  const FLAT = { organic: 0.34, geometric: 0.33, distorted: 0.33 };
  assert.notDeepEqual(dark.familyShare, FLAT, 'an audio upload must not wear the hardcoded even split');
  assert.notDeepEqual(dark.familyShare, bright.familyShare, 'and it must track the song, not be constant');
  // It reaches the skyline: five of buildShapeGrammar's six production rules
  // put familyShare in their dominant term, so a pinned share flattens them.
  assert.notDeepEqual(buildShapeGrammar(dark), buildShapeGrammar(bright));
});

test('a MIDI timeline with real GM programs still reads family from the programs, not the spectrum', () => {
  // The fallback must not steal the case it was never meant to cover.
  const distorted = buildSongDNA(synthTimeline({ pitches: [40, 43, 47], program: 30 }));
  const organic = buildSongDNA(synthTimeline({ pitches: [60, 64, 67], program: 0 }));
  assert.ok(distorted.familyShare.distorted > 0.99, 'a wholly distorted-program song is 100% distorted');
  assert.ok(organic.familyShare.organic > 0.99);
});

test('the drum lane does not move register or harmony, but still counts as density and percussion', () => {
  const melody = [67, 71, 74, 67, 62, 71, 66, 67];
  const dry = buildSongDNA(audioTimeline({ melody, withDrums: false }));
  const wet = buildSongDNA(audioTimeline({ melody, withDrums: true }));

  // Pitch classes 0/2/6 and the bottom-two-octaves pitches 36/38/42 are the
  // drum MAP, not the music. Adding drums to the same melody must not move
  // what the song's register or harmony reads as.
  assert.equal(wet.tonicPc, dry.tonicPc, 'key must come from the pitched material alone');
  assert.ok(Math.abs(wet.meanPitch01 - dry.meanPitch01) < 1e-9,
    `register moved ${dry.meanPitch01} -> ${wet.meanPitch01} on drums alone`);
  assert.ok(Math.abs(wet.registerSpread - dry.registerSpread) < 1e-9);
  assert.ok(Math.abs(wet.harmonicComplexity - dry.harmonicComplexity) < 1e-9,
    `harmony moved ${dry.harmonicComplexity} -> ${wet.harmonicComplexity} on drums alone`);

  // But drums are genuinely part of the arrangement: density and percussion
  // share must still see them, or this trades one wrong answer for another.
  assert.ok(wet.noteDensity > dry.noteDensity, 'drums add notes');
  assert.ok(wet.percussionDensity > 0.4, `drums are percussion, got ${wet.percussionDensity}`);
  assert.equal(dry.percussionDensity, 0);
});

test('a drum-only timeline reports no tonal read rather than the drum map as a key', () => {
  const drums = audioTimeline({ melody: [], withDrums: true });
  drums.timeline = drums.timeline.filter((e) => e.role === 'RHYTHM');
  const dna = buildSongDNA({ ...drums, analysis: { brightness: 0.6 } });
  assert.ok(dna.timeline === undefined);
  assert.equal(dna.hasTimeline, true, 'there IS a timeline -- it just has no pitches');
  assert.equal(dna.hasTonalTimeline, false, 'and nothing tonal in it to read');
  // Falls through to the spectral proxies, which are bounded and finite.
  assert.ok(dna.tonicPc >= 0 && dna.tonicPc <= 11);
  assert.ok(Number.isFinite(dna.meanPitch01) && Number.isFinite(dna.harmonicComplexity));
  assert.ok(dna.percussionDensity > 0.99, 'a drum-only song is all percussion');
});

test('audio chroma is a measured key; placeholder drum pitches are not', () => {
  const drums = audioTimeline({ melody: [], withDrums: true });
  drums.timeline = drums.timeline.filter((e) => e.role === 'RHYTHM');
  const dna = buildSongDNA({
    ...drums,
    analysis: { tonic: 4, mode: 'minor', tonalConfidence: 0.72, brightness: 0.4 },
  });
  assert.equal(dna.hasTonalTimeline, false);
  assert.equal(dna.tonicPc, 4);
  assert.equal(dna.isMajor, false);
  assert.ok(dna.keyConfidence > 0.5);
});

test('oklchToHex always returns a valid 6-digit hex, even at extreme out-of-gamut chroma', () => {
  for (const [L, C, H] of [[0.5, 0.4, 0], [0.9, 0.5, 120], [0.1, 0.3, 250], [0.5, 0, 90]]) {
    const hex = oklchToHex(L, C, H);
    assert.match(hex, /^#[0-9a-f]{6}$/);
  }
});

test('oklabDelta is zero for identical colors and positive for different ones', () => {
  const a = hexToOklab('#336699');
  const b = hexToOklab('#336699');
  const c = hexToOklab('#ffcc00');
  assert.ok(oklabDelta(a, b) < 1e-9);
  assert.ok(oklabDelta(a, c) > 0.05);
});

test('buildShapeGrammar weights are non-negative and normalized to sum 1', () => {
  const dna = buildSongDNA(synthTimeline({ pitches: [40, 43, 47], program: 30 })); // distorted guitar range
  const g = buildShapeGrammar(dna);
  const sum = Object.values(g).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}`);
  for (const v of Object.values(g)) assert.ok(v >= 0);
});

// The six production-rule categories are built from different combinations
// of terms, so their raw (pre-normalization) achievable ranges differ --
// measured, spikeCluster averaged 0.601 pre-fix while trunkBranch/
// geometricRegularity averaged only ~0.35. Since every category is divided
// by the SAME sum at the end, that raw-scale gap survived into the output:
// spikeCluster was the single largest ("dominant") category for 52.8% of
// sampled songs pre-fix, against 0.5% for verticalStack -- five of the six
// categories a song's terrain is supposed to draw from were rarely or never
// actually reachable as the dominant read.
test('every shape-grammar category is reachable as the dominant one for a real fraction of songs', () => {
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(2024);
  const domCount = { trunkBranch: 0, verticalStack: 0, spikeCluster: 0, arch: 0, mound: 0, geometricRegularity: 0 };
  const N = 6000;
  for (let i = 0; i < N; i++) {
    const a = rand(), b = rand(), c = rand(), s = a + b + c;
    const dna = {
      familyShare: { organic: a / s, geometric: b / s, distorted: c / s },
      percussionDensity: rand(), noteDensity: rand(), phrase: rand(),
      harmonicComplexity: rand(), registerSpread: rand(),
    };
    const g = buildShapeGrammar(dna);
    let bestK = null, bestV = -1;
    for (const k in g) if (g[k] > bestV) { bestV = g[k]; bestK = k; }
    domCount[bestK]++;
  }
  // Pre-fix, verticalStack's share was ~0.5% and spikeCluster's was ~52.8%
  // (a 105x ratio). Post-fix every category should clear a real double-digit
  // floor, and no single category should run away with more than a third.
  for (const [k, count] of Object.entries(domCount)) {
    const frac = count / N;
    assert.ok(frac > 0.03, `${k} is dominant for only ${(100 * frac).toFixed(1)}% of songs -- still nearly unreachable`);
    assert.ok(frac < 0.35, `${k} is dominant for ${(100 * frac).toFixed(1)}% of songs -- still running away with the vocabulary`);
  }
});

test('computeTemperature, pickFx, pickParticleKind stay in range / return valid enums', () => {
  const VALID_FX = new Set(['starTwinkle', 'emberGlow', 'aurora', 'canopyDapple', 'glitchTear', 'petalPile',
    'prominence', 'lightning', 'lakeReflection', 'neonGrid', 'bioluminescence', 'mirage', 'godRays',
    'sporeGlow', 'sunMotes', 'nebulaBloom', 'crystalGlint']);
  const VALID_PARTICLES = new Set(['fireflies', 'embers', 'snow', 'pollen', 'antigrav', 'petals', 'rain',
    'flaresparks', 'digitalrain', 'sand', 'bubbles', 'spores']);
  for (const pitches of [[36, 38, 42], [72, 76, 79], [21, 24, 28]]) {
    const dna = buildSongDNA(synthTimeline({ pitches }));
    const temp = computeTemperature(dna);
    assert.ok(temp >= 0 && temp <= 1);
    assert.ok(VALID_FX.has(pickFx(temp)), `pickFx(${temp}) returned invalid fx`);
    const grammar = buildShapeGrammar(dna);
    assert.ok(VALID_PARTICLES.has(pickParticleKind(grammar, temp)), 'invalid particle kind');
  }
});

test('computeTemperature spreads toward the edges instead of collapsing to the middle', () => {
  // The 5-term weighted sum inside computeTemperature collapses toward 0.5
  // by the central limit theorem (measured pre-fix: sd 0.134, effectively
  // 0% of songs above 0.90 or below 0.10) -- which made FX_BY_TEMP's most
  // extreme bands (aurora below 0.10, lightning at/above 0.94) read as
  // basically unreachable even though every band was authored assuming
  // real coverage. Sweep a real spread of DNA shapes and confirm the
  // resulting temperatures spread meaningfully past what the raw
  // (un-spread) formula would produce.
  const temps = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const dna = {
      percussionDensity: t, energyMean: t, tempoHeat: t, noteDensity: t, dyn: t,
    };
    temps.push(computeTemperature(dna));
  }
  // A pure linear sweep is a poor stand-in for the real central-limit
  // collapse (every term moves together here), so instead confirm the
  // extremes of the sweep actually reach near 0 and near 1 -- spread01 is a
  // no-op at 0/0.5/1, so this also guards against the transform being lost.
  assert.ok(temps[0] < 0.03, `t=0 should read near-zero, got ${temps[0]}`);
  assert.ok(temps[20] > 0.97, `t=1 should read near-one, got ${temps[20]}`);

  // The real test: independent (not lock-step) random features, matching
  // how a real song's percussionDensity/energyMean/tempoHeat/noteDensity/dyn
  // actually vary independently of each other.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(2024);
  let extreme = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const dna = {
      percussionDensity: rand(), energyMean: rand(), tempoHeat: rand(), noteDensity: rand(), dyn: rand(),
    };
    const temp = computeTemperature(dna);
    if (temp < 0.15 || temp > 0.85) extreme++;
  }
  assert.ok(extreme / N > 0.02, `expected >2% of songs to reach a genuinely hot/cold temperature, got ${(100 * extreme / N).toFixed(2)}%`);
});

test('synthesizePalette satisfies its own hard constraints: silhouette dark, sky stops distinguishable', () => {
  const songs = [
    synthTimeline({ pitches: [60, 64, 67] }),
    synthTimeline({ pitches: [57, 60, 63, 67], program: 30 }),
    synthTimeline({ pitches: [72, 76, 79, 84], program: 73 }),
    { durationMs: 90000, bpm: 70 }, // audio-only, no timeline
  ];
  for (const data of songs) {
    const dna = buildSongDNA(data);
    const { profile, valid } = synthesizePalette(dna);
    assert.equal(valid, true, `song seed ${dna.seed} failed to find a valid palette`);

    const silL = hexToOklab(profile.silhouette)[0];
    assert.ok(silL < 0.40, `silhouette too bright: L=${silL}`);

    const [skyDark, skyMid, skyHot] = profile.sky.map(hexToOklab);
    assert.ok(oklabDelta(skyDark, skyMid) > 0.02, 'sky dark/mid too close');
    assert.ok(oklabDelta(skyMid, skyHot) > 0.02, 'sky mid/hot too close');
    assert.ok(oklabDelta(hexToOklab(profile.silhouette), skyDark) > 0.08, 'silhouette blends into sky');

    assert.ok(['sun', 'moon'].includes(profile.celestial.kind));
    assert.ok(profile.celestial.color && profile.celestial.haloColor);
    assert.ok(profile.particles.color);
    // Matches the range stock worlds actually use (BiomeManager scales the
    // ridge-dance amplitude by this directly) -- not 0..1.
    assert.ok(profile.terrainEnergy >= 0.6 && profile.terrainEnergy <= 1.35);
  }
});

test('synthesizePalette is deterministic for the same DNA', () => {
  const dna = buildSongDNA(synthTimeline({ pitches: [62, 65, 69] }));
  const a = synthesizePalette(dna);
  const b = synthesizePalette(dna);
  assert.deepEqual(a.profile.sky, b.profile.sky);
  assert.equal(a.profile.silhouette, b.profile.silhouette);
});

// The novelty mechanism (recent-hue history nudging candidate selection
// away from what recently played) was provably inert two ways at once:
// (1) it was keyed on anchor.baseHue, which is fixed by dna.tonicPc alone
// and therefore IDENTICAL across every one of the 400 candidates a single
// song generates, so a constant added equally to every candidate's score
// can never change which one wins; (2) even if it had varied, the score
// line ADDED it (`soft + novelty`), and noveltyPenalty returns its LARGEST
// value for the candidate CLOSEST to recent history -- so a working
// version would have rewarded repeating recent palettes, not avoiding
// them. Meanwhile it cost a localStorage.getItem+JSON.parse on every one
// of those 400 iterations for a value that never changed within the call.
function withMockLocalStorage(fn) {
  const store = new Map();
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
  try {
    return fn(store);
  } finally {
    globalThis.localStorage = prev;
  }
}

test('novelty history genuinely penalizes (not rewards) landing near a recently-used hue', () => {
  const dna = { ...buildSongDNA(synthTimeline({ pitches: [64, 67, 71] })), seed: 4242 };
  withMockLocalStorage((store) => {
    const noHistory = synthesizePalette(dna);
    // Seed history at exactly the hue this song would otherwise land on --
    // the case the mechanism exists for.
    store.set('midio.worldDnaHistory', JSON.stringify([{ baseHue: noHistory.proof.baseHue }]));
    const withHistory = synthesizePalette(dna);
    // The old (additive, inverted) formula could only ever RAISE the score
    // for a candidate near history. A real penalty must lower it.
    assert.ok(withHistory.proof.softScore < noHistory.proof.softScore - 1e-6,
      `matching history should lower the winning score (was ${noHistory.proof.softScore}, now ${withHistory.proof.softScore})`);
  });
});

test('novelty history is read once per palette, not once per candidate', () => {
  withMockLocalStorage((store) => {
    let reads = 0;
    const real = store.get.bind(store);
    globalThis.localStorage.getItem = (k) => { reads++; return store.has(k) ? real(k) : null; };
    store.set('midio.worldDnaHistory', JSON.stringify([{ baseHue: 90 }, { baseHue: 200 }]));
    reads = 0;
    const dna = buildSongDNA(synthTimeline({ pitches: [60, 64, 67] }));
    synthesizePalette(dna);
    assert.ok(reads <= 2, `expected at most a couple localStorage reads per palette, got ${reads} (N_CANDIDATES=400 would mean it's back in the loop)`);
  });
});

test('novelty history measurably steers selection away from a recently-used hue across many songs', () => {
  // A real, observable effect on WHICH candidate wins, not just its score --
  // sampled across many seeds since any single song's softScore landscape
  // can happen to have the same top candidate survive a small penalty.
  let flips = 0;
  const N = 40;
  withMockLocalStorage((store) => {
    for (let s = 1; s <= N; s++) {
      const dna = { ...buildSongDNA(synthTimeline({ pitches: [60, 64, 67] })), seed: s * 1000 + 7 };
      store.clear();
      const a = synthesizePalette(dna);
      store.set('midio.worldDnaHistory', JSON.stringify([{ baseHue: a.proof.baseHue }]));
      const b = synthesizePalette(dna);
      if (JSON.stringify(a.profile.sky) !== JSON.stringify(b.profile.sky)) flips++;
    }
  });
  assert.ok(flips > 0, 'matching history should change the winning palette for at least some songs');
});

// A synthesized palette's own display `name` (e.g. "NAVE_A_0", set by
// synthesizeSectionPalettes) never matches a LANDMARKS/BIOMES key -- ground
// clutter (decorateStrip), near-field occluders, and NearField's silhouette-
// darkening color (biomeByName) all keyed off that display name and silently
// found nothing for every generated world. landmarkKey is the fix: it must
// always resolve to a real archetype, for every DNA shape this pipeline can
// produce, not just the handful covered by the deterministic tests above.
test('every synthesized palette carries a landmarkKey that LANDMARKS and biomeByName actually recognize', () => {
  const songs = [
    synthTimeline({ pitches: [60, 64, 67] }),
    synthTimeline({ pitches: [57, 60, 63, 67], program: 30 }),
    synthTimeline({ pitches: [72, 76, 79, 84], program: 73 }),
    synthTimeline({ pitches: [36, 40, 43], program: 112 }), // distorted/percussive-leaning
    { durationMs: 90000, bpm: 70 }, // audio-only, no timeline
    { durationMs: 240000, bpm: 175 }, // audio-only, fast/hot
  ];
  for (const data of songs) {
    const dna = buildSongDNA(data);
    const { profile } = synthesizePalette(dna);
    assert.ok(profile.landmarkKey, `song seed ${dna.seed} produced no landmarkKey`);
    assert.ok(Array.isArray(LANDMARKS[profile.landmarkKey]) && LANDMARKS[profile.landmarkKey].length > 0,
      `landmarkKey "${profile.landmarkKey}" (song seed ${dna.seed}) has no LANDMARKS entry`);
    assert.ok(biomeByName(profile.landmarkKey).name === profile.landmarkKey,
      `landmarkKey "${profile.landmarkKey}" doesn't resolve via biomeByName`);
  }
});

test('synthesizeSectionPalettes: every section palette carries its own valid landmarkKey', () => {
  const dna = buildSongDNA(synthTimeline({ pitches: [60, 62, 64, 65, 67, 69, 71], program: 73 }));
  dna.sectionLabels = ['intro', 'verse', 'chorus', 'verse', 'chorus', 'outro'];
  const { palettes } = synthesizeSectionPalettes(dna, 'nave');
  assert.ok(palettes.length >= 2);
  for (const p of palettes) {
    assert.ok(LANDMARKS[p.landmarkKey], `${p.name} has invalid landmarkKey "${p.landmarkKey}"`);
    // The generated display name must NOT itself be a landmark key -- this
    // is exactly the mismatch that made decorateStrip a silent no-op.
    assert.ok(!LANDMARKS[p.name], `${p.name} unexpectedly collides with a real LANDMARKS key`);
  }
});

test('skyStops: a harmonically simple song gets the plain 3-stop sky, a rich one gets 5 legible stops', () => {
  const simpleDna = buildSongDNA(synthTimeline({ pitches: [60, 64, 67] }));
  simpleDna.harmonicComplexity = 0.2;
  const richDna = buildSongDNA(synthTimeline({ pitches: [60, 62, 64, 65, 67, 69, 71], program: 73 }));
  richDna.harmonicComplexity = 0.85;

  const { profile: simple } = synthesizePalette(simpleDna);
  const { profile: rich } = synthesizePalette(richDna);

  assert.equal(simple.skyStops.length, 3);
  assert.deepEqual(simple.skyStops, simple.sky);
  assert.equal(rich.skyStops.length, 5);
  // The canonical dark/mid/hot stops still appear (at the new positions),
  // so every other reader that still indexes A.sky[0..2] sees the exact
  // same values as before.
  assert.equal(rich.sky[0], rich.skyStops[0]);
  assert.equal(rich.sky[1], rich.skyStops[2]);
  assert.equal(rich.sky[2], rich.skyStops[4]);

  // Every adjacent pair in the richer gradient stays visually distinguishable.
  const labs = rich.skyStops.map(hexToOklab);
  for (let i = 1; i < labs.length; i++) {
    assert.ok(oklabDelta(labs[i - 1], labs[i]) > 0.008, `stops ${i - 1}/${i} too close`);
  }
});

test('celestial companions: none for a simple song, more for a harmonically rich one, always paired with a valid color', () => {
  const simpleDna = buildSongDNA(synthTimeline({ pitches: [60, 64, 67] }));
  simpleDna.harmonicComplexity = 0.15;
  const richDna = buildSongDNA(synthTimeline({ pitches: [60, 62, 64, 65, 67, 69, 71], program: 73 }));
  richDna.harmonicComplexity = 0.9;

  const { profile: simple } = synthesizePalette(simpleDna);
  const { profile: rich } = synthesizePalette(richDna);

  assert.equal(simple.celestial.companions.length, 0);
  assert.ok(rich.celestial.companions.length >= 1 && rich.celestial.companions.length <= 3);
  for (const co of rich.celestial.companions) {
    assert.match(co.color, /^#[0-9a-f]{6}$/);
    assert.match(co.haloColor, /^#[0-9a-f]{6}$/);
    assert.ok(co.radiusFrac > 0 && co.radiusFrac < 1);
    assert.ok(Number.isFinite(co.dxFrac) && Number.isFinite(co.dyFrac));
  }
});

test('synthesizeSectionPalettes always yields >=2 distinctly-named entries so castBiomes never strands a section without a repeat-free choice', () => {
  const dna = buildSongDNA(synthTimeline({ pitches: [60, 64, 67, 71] }));
  const { palettes, temperature } = synthesizeSectionPalettes(dna, 'testworld');
  assert.ok(palettes.length >= 2, `only ${palettes.length} palette(s) generated`);
  const names = palettes.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, 'palette names collide');
  for (const name of names) {
    assert.ok(Number.isFinite(temperature[name]), `${name} missing a temperature entry`);
    assert.ok(temperature[name] >= 0 && temperature[name] <= 1);
  }
});

test('deriveTerrainParams: a spike/vertical-stack heavy grammar pinches flanks and pulls peaks apart, a mound/trunk heavy grammar does the opposite', () => {
  const spiky = { trunkBranch: 0.03, verticalStack: 0.35, spikeCluster: 0.40, arch: 0.05, mound: 0.02, geometricRegularity: 0.15 };
  const mound = { trunkBranch: 0.35, verticalStack: 0.03, spikeCluster: 0.02, arch: 0.05, mound: 0.40, geometricRegularity: 0.15 };
  const spikyMods = deriveTerrainParams(spiky);
  const moundMods = deriveTerrainParams(mound);
  assert.ok(spikyMods.shoulderMul > 1, `expected pinched flanks, got shoulderMul=${spikyMods.shoulderMul}`);
  assert.ok(spikyMods.spireMixAdd > 0, `expected more spire, got ${spikyMods.spireMixAdd}`);
  assert.ok(spikyMods.apronGainAdd < 0, `expected peaks pulled apart, got apronGainAdd=${spikyMods.apronGainAdd}`);
  assert.ok(moundMods.shoulderMul < 1, `expected fuller flanks, got shoulderMul=${moundMods.shoulderMul}`);
  assert.ok(moundMods.apronGainAdd > 0, `expected connective apron, got apronGainAdd=${moundMods.apronGainAdd}`);
  assert.ok(spikyMods.shoulderMul > moundMods.shoulderMul);
});

test('deriveTerrainParams on a real song DNA actually changes the rendered ridgeline geometry', () => {
  const spikyDna = buildSongDNA(synthTimeline({ pitches: [40, 43, 46, 49], program: 30, n: 400 })); // distorted, dense
  const moundDna = buildSongDNA({ durationMs: 60000, bpm: 70 }); // sparse fallback, low percussion/density
  const spikyMods = deriveTerrainParams(buildShapeGrammar(spikyDna));
  const moundMods = deriveTerrainParams(buildShapeGrammar(moundDna));

  const noise = new ValueNoise1D(11, 256);
  const n = 400, step = 5, width = n * step;
  const plain = alpineHeightField(noise, n, step, 11, width, 'massif', null, 'L2', null);
  const withSpiky = alpineHeightField(noise, n, step, 11, width, 'massif', null, 'L2', spikyMods);
  const withMound = alpineHeightField(noise, n, step, 11, width, 'massif', null, 'L2', moundMods);

  let same = true;
  for (let i = 0; i < n; i++) {
    if (Math.abs(plain[i] - withSpiky[i]) > 1e-9 || Math.abs(plain[i] - withMound[i]) > 1e-9) { same = false; break; }
  }
  assert.equal(same, false, 'terrainMods had no measurable effect on the height field');
  for (let i = 0; i < n; i++) {
    assert.ok(withSpiky[i] >= 0 && withSpiky[i] <= 1);
    assert.ok(withMound[i] >= 0 && withMound[i] <= 1);
  }
});

test('deriveTerrainParams city/rolling fields: spiky songs get narrower isolated towers and grainier hills, mound songs the opposite', () => {
  const spiky = { trunkBranch: 0.03, verticalStack: 0.35, spikeCluster: 0.40, arch: 0.05, mound: 0.02, geometricRegularity: 0.15 };
  const mound = { trunkBranch: 0.35, verticalStack: 0.03, spikeCluster: 0.02, arch: 0.05, mound: 0.40, geometricRegularity: 0.15 };
  const spikyMods = deriveTerrainParams(spiky);
  const moundMods = deriveTerrainParams(mound);

  assert.ok(spikyMods.cityWidthMul < 1, `expected narrower towers, got ${spikyMods.cityWidthMul}`);
  assert.ok(moundMods.cityWidthMul > 1, `expected broader blocks, got ${moundMods.cityWidthMul}`);
  assert.ok(spikyMods.cityTaperMul > moundMods.cityTaperMul, 'spiky should taper more sharply than mound');
  assert.ok(spikyMods.cityDensityMul < moundMods.cityDensityMul, 'mound should pack denser fabric than spiky');
  assert.ok(spikyMods.rollingAmpMul > moundMods.rollingAmpMul, 'spiky should read taller/grainier hills than mound');
});

test('buildingProfile: default params reproduce the original fixed setback exactly; DNA params move it', () => {
  assert.equal(buildingProfile(0.4), 1);
  assert.ok(Math.abs(buildingProfile(0.7) - 0.84) < 1e-9);
  assert.ok(Math.abs(buildingProfile(0.9) - 0.58) < 1e-9);
  // A sharper setback (higher taper) drops further at the same width.
  assert.ok(buildingProfile(0.7, 0.62, 1.6) < buildingProfile(0.7, 0.62, 1));
  // A later setbackFrac keeps full height further out.
  assert.equal(buildingProfile(0.7, 0.85, 1), 1);
});

test('pickCharacterScheme: spiky songs get the jagged scheme, organic songs the monumental scheme, balanced songs the classic scheme', () => {
  const spiky = { trunkBranch: 0.03, verticalStack: 0.35, spikeCluster: 0.40, arch: 0.05, mound: 0.02, geometricRegularity: 0.15 };
  const mound = { trunkBranch: 0.35, verticalStack: 0.03, spikeCluster: 0.02, arch: 0.05, mound: 0.40, geometricRegularity: 0.15 };
  const balanced = { trunkBranch: 1 / 6, verticalStack: 1 / 6, spikeCluster: 1 / 6, arch: 1 / 6, mound: 1 / 6, geometricRegularity: 1 / 6 };
  assert.equal(pickCharacterScheme(spiky), 'jagged');
  assert.equal(pickCharacterScheme(mound), 'monumental');
  assert.equal(pickCharacterScheme(balanced), 'classic');
});

test('CHARACTER_SCHEMES: every scheme is a 3-tuple of real ALPINE_CHARACTERS keys, far-to-near ordered broadest-to-narrowest', () => {
  for (const [name, scheme] of Object.entries(CHARACTER_SCHEMES)) {
    assert.equal(scheme.length, 3, `${name} should have exactly 3 layers`);
    const widths = scheme.map((c) => {
      assert.ok(ALPINE_CHARACTERS[c], `${name}'s "${c}" is not a real ALPINE_CHARACTERS entry`);
      return ALPINE_CHARACTERS[c].wBase;
    });
    assert.ok(widths[0] > widths[1] && widths[1] > widths[2],
      `${name} should narrow far-to-near, got wBase ${widths.join(',')}`);
  }
  assert.deepEqual(CHARACTER_SCHEMES.classic, ['massif', 'range', 'crags']);
});

test('a spiky vs. an organic song render measurably different L2 geometry via their character schemes, not just terrainMods', () => {
  const spikyDna = buildSongDNA(synthTimeline({ pitches: [40, 43, 46, 49], program: 30, n: 400 }));
  const moundDna = buildSongDNA({ durationMs: 60000, bpm: 70 });
  const spikyGrammar = buildShapeGrammar(spikyDna);
  const moundGrammar = buildShapeGrammar(moundDna);
  const spikyScheme = CHARACTER_SCHEMES[pickCharacterScheme(spikyGrammar)];
  const moundScheme = CHARACTER_SCHEMES[pickCharacterScheme(moundGrammar)];

  const noise = new ValueNoise1D(11, 256);
  const n = 400, step = 5, width = n * step;
  // Same seed, same terrainMods, ONLY the character (landform) differs --
  // isolates the scheme's own contribution from the shape-nudge one.
  const spikyMods = deriveTerrainParams(spikyGrammar);
  const withSpikyScheme = alpineHeightField(noise, n, step, 11, width, spikyScheme[0], null, 'L2', spikyMods);
  const withMoundScheme = alpineHeightField(noise, n, step, 11, width, moundScheme[0], null, 'L2', spikyMods);

  let same = true;
  for (let i = 0; i < n; i++) {
    if (Math.abs(withSpikyScheme[i] - withMoundScheme[i]) > 1e-9) { same = false; break; }
  }
  assert.equal(same, false, 'different character schemes produced identical L2 geometry');
});

test('cityHeightField: terrainMods measurably changes the rendered skyline and stays in 0..1', () => {
  const spikyDna = buildSongDNA(synthTimeline({ pitches: [40, 43, 46, 49], program: 30, n: 400 }));
  const moundDna = buildSongDNA({ durationMs: 60000, bpm: 70 });
  const spikyMods = deriveTerrainParams(buildShapeGrammar(spikyDna));
  const moundMods = deriveTerrainParams(buildShapeGrammar(moundDna));

  const n = 400, step = 5, width = n * step;
  const plain = cityHeightField(n, step, 11, width, null, 'L2', null);
  const withSpiky = cityHeightField(n, step, 11, width, null, 'L2', spikyMods);
  const withMound = cityHeightField(n, step, 11, width, null, 'L2', moundMods);

  let same = true;
  for (let i = 0; i < n; i++) {
    if (Math.abs(plain[i] - withSpiky[i]) > 1e-9 || Math.abs(plain[i] - withMound[i]) > 1e-9) { same = false; break; }
  }
  assert.equal(same, false, 'terrainMods had no measurable effect on the city height field');
  for (let i = 0; i < n; i++) {
    assert.ok(withSpiky[i] >= 0 && withSpiky[i] <= 1);
    assert.ok(withMound[i] >= 0 && withMound[i] <= 1);
  }
});

test('rollingHeightField: terrainMods measurably changes the rendered hills and stays in 0..1', () => {
  const spikyDna = buildSongDNA(synthTimeline({ pitches: [40, 43, 46, 49], program: 30, n: 400 }));
  const spikyMods = deriveTerrainParams(buildShapeGrammar(spikyDna));

  const noise = new ValueNoise1D(11, 256);
  const n = 400, step = 5, width = n * step;
  const plain = rollingHeightField(noise, n, step, 2, null, width, null);
  const withMods = rollingHeightField(noise, n, step, 2, null, width, spikyMods);

  let same = true;
  for (let i = 0; i < n; i++) {
    if (Math.abs(plain[i] - withMods[i]) > 1e-9) { same = false; break; }
  }
  assert.equal(same, false, 'terrainMods had no measurable effect on the rolling height field');
  for (let i = 0; i < n; i++) assert.ok(withMods[i] >= 0 && withMods[i] <= 1);
});

function synthRisingTimeline({ startPitch, endPitch, n = 200, durationMs = 60000 }) {
  const timeline = [];
  for (let i = 0; i < n; i++) {
    const t01 = i / (n - 1);
    timeline.push({
      tMs: t01 * durationMs,
      durMs: 200,
      pitch: Math.round(startPitch + (endPitch - startPitch) * t01),
      vel: 0.6,
      role: 'MELODY',
      channel: 0,
      program: 0,
    });
  }
  return { timeline, durationMs, bpm: 120 };
}

test('buildSongDNA reads registerTrend from how pitch moves across the song', () => {
  const rising = buildSongDNA(synthRisingTimeline({ startPitch: 48, endPitch: 84 }));
  const falling = buildSongDNA(synthRisingTimeline({ startPitch: 84, endPitch: 48 }));
  const flat = buildSongDNA(synthTimeline({ pitches: [60, 64, 67] }));
  assert.ok(rising.registerTrend > 0.3, `expected a rising trend, got ${rising.registerTrend}`);
  assert.ok(falling.registerTrend < -0.3, `expected a falling trend, got ${falling.registerTrend}`);
  assert.ok(Math.abs(flat.registerTrend) < 0.15, `expected ~flat trend, got ${flat.registerTrend}`);
});

test('deriveParticleMotion: rising/falling register picks rise/fall direction with an opposing vertical driftBias', () => {
  const rising = buildSongDNA(synthRisingTimeline({ startPitch: 48, endPitch: 84 }));
  const falling = buildSongDNA(synthRisingTimeline({ startPitch: 84, endPitch: 48 }));
  const riseMotion = deriveParticleMotion(rising);
  const fallMotion = deriveParticleMotion(falling);
  assert.equal(riseMotion.direction, 'rise');
  assert.equal(fallMotion.direction, 'fall');
  assert.ok(riseMotion.driftBias.vy < 0, `rise should drift upward, got vy=${riseMotion.driftBias.vy}`);
  assert.ok(fallMotion.driftBias.vy > 0, `fall should drift downward, got vy=${fallMotion.driftBias.vy}`);
});

test('deriveParticleMotion: dense percussive song with no register trend reads as burst', () => {
  const dna = buildSongDNA(synthTimeline({ pitches: [36, 38, 42, 45], program: 0, channel: 9, n: 400 }));
  dna.registerTrend = 0;
  dna.percussionDensity = 0.9;
  dna.noteDensity = 0.85;
  const motion = deriveParticleMotion(dna);
  assert.equal(motion.direction, 'burst');
});

test('ParticleField driftBias is a uniform per-frame nudge applied on top of a kind\'s own physics', () => {
  const withoutBias = new ParticleField({ kind: 'fireflies', color: '#fff', count: 5, speed: 20 }, 400, 300, 7);
  const withBias = new ParticleField({
    kind: 'fireflies', color: '#fff', count: 5, speed: 20, driftBias: { vx: 0, vy: -50 },
  }, 400, 300, 7);
  withoutBias.update(1, 0, null, 0);
  withBias.update(1, 0, null, 0);
  for (let i = 0; i < 5; i++) {
    assert.ok(withBias.particles[i].y < withoutBias.particles[i].y - 40,
      `particle ${i} should have drifted up by ~50px more than the unbiased field`);
  }
});

test('section palettes stay in the same hue family (same tonic) across a song', () => {
  const dna = buildSongDNA(synthTimeline({ pitches: [60, 64, 67, 60, 64, 67] }));
  dna.sectionLabels = ['INTRO', 'VERSE', 'CHORUS', 'BRIDGE'];
  const { palettes } = synthesizeSectionPalettes(dna, 'hue-family');
  const hues = palettes.map((p) => {
    const [, a, b] = hexToOklab(p.sky[0]);
    return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  });
  for (let i = 1; i < hues.length; i++) {
    let d = Math.abs(hues[i] - hues[0]);
    d = Math.min(d, 360 - d);
    assert.ok(d < 70, `section ${i} hue ${hues[i]} strayed ${d}deg from section 0's ${hues[0]}`);
  }
});
