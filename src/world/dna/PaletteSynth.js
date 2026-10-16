// Palette synthesis — the song DNA becomes an actual palette, not a pick
// from a fixed list. Generated in OKLCH (see OklchColor.js for why), scored
// against hard constraints (must clear) and soft objectives (should be
// good), best-of-N wins. This is constrained optimization, not a single
// deterministic formula: candidates that would strobe against Midio, wash
// out the parallax, or clip the sRGB gamut into mud are rejected outright.
import { clamp01, lerp, lerpHue, mulberry32 } from '../../utils/math.js';
import { oklchToHex, hexToOklab, oklabDelta } from './OklchColor.js';
import { constrainPalette } from '../WorldIdentity.js';
import { FIFTHS_ORDER } from './SongDNA.js';
import {
  buildShapeGrammar, computeTemperature, pickFx, pickParticleKind, pickCelestialKind, deriveParticleMotion,
} from './ShapeGrammar.js';

const N_CANDIDATES = 400;

// Midio renders at HSL lightness ~65-78% (src/sim/Midasus.js:469,480,507)
// across a hue that cycles with every note's pitch class — full hue
// coverage, so hue-only separation can't work. What holds for every hue is
// keeping the silhouette she's staged against well below that band.
const SILHOUETTE_MAX_L = 0.44;
const SILHOUETTE_MIN_L = 0.12;
const SKY_STOP_MIN_DELTA = 0.035;
const SILHOUETTE_SKY_MIN_DELTA = 0.11;

function hueFromTonic(tonicPc) {
  const idx = FIFTHS_ORDER.indexOf(((tonicPc % 12) + 12) % 12);
  return (idx >= 0 ? idx : 0) * 30;
}

function roleLch(role, anchor) {
  const { baseHue, rotationDeg, chromaScale, lightnessScale, temp, hueJitter } = anchor;
  const jitter = (role.jitterMul || 0) * hueJitter;
  const H = (baseHue + role.hueFrac * rotationDeg + jitter + 360) % 360;
  const C = Math.max(0.01, role.chromaBase * chromaScale * (1 + 0.25 * temp));
  const L = clamp01(role.lightBase + role.lightGain * lightnessScale);
  return { L, C, H };
}

const ROLES = {
  // silhouette is a colored mass, not a hole in the sky. Decoupled from
  // lightnessScale (small lightGain) so it still sits under Midio at every
  // tempo, but the floor is high enough that the landform reads as paint.
  silhouette: { hueFrac: -0.22, chromaBase: 0.08, lightBase: 0.16, lightGain: 0.10, jitterMul: 0.15 },
  skyDark: { hueFrac: 0, chromaBase: 0.11, lightBase: 0.24, lightGain: 0.26, jitterMul: 0.2 },
  // Intermediate sky-gradient stops (halfway between the ROLES either side of
  // them, same recipe just interpolated) -- only used when a harmonically
  // rich song earns a 5-stop skyStops gradient (see skyStopCountFor below).
  // Kept out of hardConstraintViolation (which only checks dark/mid/hot)
  // since a mid-gradient stop reading close to its neighbours isn't a
  // legibility problem the way silhouette/sky-vs-sky contrast is.
  skyDarkMid: { hueFrac: 0.08, chromaBase: 0.13, lightBase: 0.15, lightGain: 0.40, jitterMul: 0.3 },
  skyMid: { hueFrac: 0.16, chromaBase: 0.15, lightBase: 0.16, lightGain: 0.55, jitterMul: 0.4 },
  skyMidHot: { hueFrac: 0.26, chromaBase: 0.17, lightBase: 0.23, lightGain: 0.80, jitterMul: 0.5 },
  skyHot: { hueFrac: 0.36, chromaBase: 0.19, lightBase: 0.30, lightGain: 1.05, jitterMul: 0.6 },
  halo: { hueFrac: 0.5, chromaBase: 0.15, lightBase: 0.80, lightGain: 0.14, jitterMul: 0.5 },
  celestial: { hueFrac: 0.55, chromaBase: 0.17, lightBase: 0.85, lightGain: 0.10, jitterMul: 0.5 },
  particle: { hueFrac: 0.85, chromaBase: 0.19, lightBase: 0.76, lightGain: 0.14, jitterMul: 0.8 },
};

function synthesizeCandidate(dna, grammar, temp, rand) {
  const baseHue = hueFromTonic(dna.tonicPc);
  const majorSignal = dna.isMajor ? dna.keyConfidence : -dna.keyConfidence;
  const anchor = {
    baseHue,
    rotationDeg: lerp(14, 145, dna.harmonicComplexity) * (0.82 + 0.36 * rand()),
    chromaScale: clamp01(0.55 + 0.22 * majorSignal + 0.28 * dna.energyMean) * (0.82 + 0.36 * rand()),
    lightnessScale: lerp(0.55, 1.15, clamp01(dna.tempoHeat)) * (0.85 + 0.3 * rand()),
    temp,
    hueJitter: (rand() - 0.5) * 26,
  };

  const lch = {};
  const hex = {};
  for (const key in ROLES) {
    lch[key] = roleLch(ROLES[key], anchor);
    hex[key] = oklchToHex(lch[key].L, lch[key].C, lch[key].H);
  }

  return { anchor, lch, hex };
}

function hardConstraintViolation(hex, lch) {
  let violation = 0;
  if (lch.silhouette.L > SILHOUETTE_MAX_L) violation += (lch.silhouette.L - SILHOUETTE_MAX_L) * 4;
  if (lch.silhouette.L < SILHOUETTE_MIN_L) violation += (SILHOUETTE_MIN_L - lch.silhouette.L) * 4;

  const skyDarkLab = hexToOklab(hex.skyDark);
  const skyMidLab = hexToOklab(hex.skyMid);
  const skyHotLab = hexToOklab(hex.skyHot);
  const silLab = hexToOklab(hex.silhouette);

  const dDarkMid = oklabDelta(skyDarkLab, skyMidLab);
  const dMidHot = oklabDelta(skyMidLab, skyHotLab);
  if (dDarkMid < SKY_STOP_MIN_DELTA) violation += (SKY_STOP_MIN_DELTA - dDarkMid) * 6;
  if (dMidHot < SKY_STOP_MIN_DELTA) violation += (SKY_STOP_MIN_DELTA - dMidHot) * 6;

  const dSilSky = oklabDelta(silLab, skyDarkLab);
  if (dSilSky < SILHOUETTE_SKY_MIN_DELTA) violation += (SILHOUETTE_SKY_MIN_DELTA - dSilSky) * 5;

  return violation;
}

// Every synthesized palette gets a display name like "NAVE_A_0" (see
// synthesizeSectionPalettes) so replays can point at "the second chorus" --
// but Landmarks.js and NearField.js key their ground-clutter painters and
// silhouette-darkening color off a biome NAME string, expecting one of the
// stock archetypes (JADE, ARCTIC, CYBER...). Those names never matched a
// synthesized palette's own name, so decorateStrip/nearFieldForSector
// silently found no painters for every generated world (LANDMARKS[name] is
// undefined) and NearField._colorFor's biomeByName fallback silently reused
// TWILIGHT's silhouette color for every one of them too -- ground clutter,
// props, and near-field occluders only ever appeared for the stock/fallback
// path, never for a real generated world.
//
// pickFx(temperature) already lands on one of exactly 12 values that are
// each also a stock BIOME's own `fx` -- the same temperature axis, just
// read twice. Piggybacking a landmarkKey off that fx value (rather than
// adding a whole second classifier) gets every generated palette a real,
// pre-existing archetype to borrow trees/crystals/spires and a real
// silhouette color from, matched on the same visual register (frosty aurora
// reads as ARCTIC's landmarks, humid canopy dapple as JADE's, etc.).
const FX_TO_LANDMARK_KEY = {
  aurora: 'ARCTIC', nebulaBloom: 'NEBULA', starTwinkle: 'TWILIGHT',
  bioluminescence: 'ABYSS', canopyDapple: 'JADE', godRays: 'CORAL',
  mirage: 'DUNE', petalPile: 'SAKURA', sunMotes: 'AURUM',
  crystalGlint: 'GEODE', prominence: 'SOLAR', lightning: 'STORM',
};

/** 3 stops by default; 5 for a harmonically rich song (more distinct chords
 *  in play per bar -- see SongDNA.harmonicComplexity) so its sky reads as a
 *  subtler, more banded gradient instead of the flat default. */
function skyStopCountFor(dna) {
  return (dna.harmonicComplexity || 0) > 0.55 ? 5 : 3;
}

/**
 * Small decorative companion bodies near the primary celestial -- more of
 * them for a harmonically richer song (more distinct chords in play, same
 * signal skyStopCountFor reads). Deliberately NOT wired into the day/night
 * light rig, mandala anchoring, or occlusion the primary celestial owns:
 * BiomeManager draws them as plain faint discs paired with the primary's
 * own crossfade alpha, so they can't perturb any of that machinery.
 * `dxFrac`/`dyFrac` are canvas-fraction offsets from the primary's center;
 * `radiusFrac` scales the primary's own radius.
 */
function buildCompanions(dna, anchor, rand) {
  const richness = clamp01(dna.harmonicComplexity || 0);
  const count = richness > 0.35 ? Math.min(3, Math.round(richness * 4)) : 0;
  const companions = [];
  for (let i = 0; i < count; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = 0.06 + rand() * 0.10;
    const H = (anchor.baseHue + (rand() - 0.5) * 40 + 360) % 360;
    const C = Math.max(0.01, 0.14 * (0.7 + 0.6 * rand()));
    const L = 0.72 + rand() * 0.18;
    companions.push({
      dxFrac: Math.cos(angle) * dist,
      dyFrac: Math.sin(angle) * dist * 0.6,
      radiusFrac: 0.16 + rand() * 0.22,
      color: oklchToHex(L, C, H),
      haloColor: oklchToHex(Math.min(0.95, L + 0.12), C * 0.7, H),
    });
  }
  return companions;
}

function warmthOf(hue) {
  // 1 at hue=30 (amber), 0 at hue=210 (cyan) — a continuous warm/cool axis.
  return clamp01(0.5 + 0.5 * Math.cos(((hue - 30) * Math.PI) / 180));
}

function softScore(dna, anchor, lch) {
  // Vibe alignment: mode + energy vs how warm/bright the hot sky stop reads.
  const majorSignal = dna.isMajor ? dna.keyConfidence : -dna.keyConfidence;
  const valence = clamp01(0.5 + 0.32 * majorSignal + 0.22 * (dna.energyMean - 0.5));
  const warmth = warmthOf(lch.skyHot.H);
  const vibeAlignment = 1 - Math.abs(valence - (0.5 * warmth + 0.5 * lch.skyHot.L));

  // Internal harmony: role hues should sit close to the scheme anchors
  // (baseHue + role.hueFrac*rotation) — penalize how far jitter pushed them.
  let hueDeviation = 0, count = 0;
  for (const key in ROLES) {
    const target = (anchor.baseHue + ROLES[key].hueFrac * anchor.rotationDeg + 360) % 360;
    const actual = lch[key].H;
    const d = Math.abs(lerpHue(target, actual, 1) - target);
    const wrapped = Math.min(d, 360 - d);
    hueDeviation += wrapped;
    count++;
  }
  const internalHarmony = clamp01(1 - (hueDeviation / count) / 30);

  return 0.55 * vibeAlignment + 0.45 * internalHarmony;
}

/** Read the recent-palette-hue history once (not per candidate -- see the
 *  call site in synthesizePalette, which used to hit localStorage.getItem +
 *  JSON.parse 400 times per palette, once per candidate, for a value that
 *  never changes within a single synthesizePalette call). Best-effort: any
 *  storage/parse failure just means no novelty signal this run. */
function readDnaHistory() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem('midio.worldDnaHistory');
    const history = raw ? JSON.parse(raw) : [];
    return Array.isArray(history) ? history : [];
  } catch {
    return [];
  }
}

/** How close `hue` sits to the nearest recently-used hue in `history`, 0
 *  (far from anything recent) to 0.15 (sitting right on top of one) --
 *  "penalty" names what a HIGH return means (this candidate repeats recent
 *  history), so callers must SUBTRACT it from a score, not add it.
 *
 *  `hue` must vary per candidate for this to do anything: it used to be
 *  keyed on anchor.baseHue, which is derived from dna.tonicPc alone and is
 *  therefore IDENTICAL across all N_CANDIDATES candidates for one song --
 *  a constant added the same amount to every candidate's score can never
 *  change which one wins. Each role's post-jitter hue (e.g. skyMid.H) does
 *  vary candidate-to-candidate (rotationDeg and hueJitter are both
 *  re-rolled per candidate) while still tracking the song's own tonic
 *  closely enough to compare meaningfully against past songs' stored
 *  baseHue -- both are "roughly what hue is this world," just measured at
 *  the anchor vs. at one jittered role. */
function noveltyPenalty(history, hue) {
  if (!history.length) return 0;
  let minDist = Infinity;
  for (const h of history) {
    const d = Math.abs((h.baseHue ?? 0) - hue);
    const wrapped = Math.min(d, 360 - d);
    minDist = Math.min(minDist, wrapped);
  }
  return clamp01(1 - minDist / 40) * 0.15; // small nudge, never overrides song identity
}

function rememberDna(seedKey) {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem('midio.worldDnaHistory');
    const history = raw ? JSON.parse(raw) : [];
    const next = [seedKey, ...(Array.isArray(history) ? history : [])].slice(0, 24);
    localStorage.setItem('midio.worldDnaHistory', JSON.stringify(next));
  } catch {
    // best-effort only
  }
}

/** Generate N candidates, reject/penalize hard-constraint violations, score
 *  the rest, return the best — plus a proof object showing why it won. */
export function synthesizePalette(dna, temperatureOverride = null) {
  const grammar = buildShapeGrammar(dna);
  const temp = temperatureOverride ?? computeTemperature(dna);
  const rand = mulberry32((dna.seed ^ 0x9e3779b9) >>> 0);
  const dnaHistory = readDnaHistory(); // once per palette, not once per candidate

  let best = null, bestScore = -Infinity, bestValid = false;
  for (let i = 0; i < N_CANDIDATES; i++) {
    const c = synthesizeCandidate(dna, grammar, temp, rand);
    const violation = hardConstraintViolation(c.hex, c.lch);
    const valid = violation === 0;
    const soft = softScore(dna, c.anchor, c.lch);
    // c.lch.skyMid.H, not c.anchor.baseHue: baseHue is fixed by dna.tonicPc
    // alone and is identical for every candidate this song generates, so a
    // penalty keyed on it can never affect which candidate wins. skyMid.H
    // varies per candidate (rotationDeg/hueJitter are re-rolled each time)
    // while still tracking the song's own tonic closely enough to compare
    // against history meaningfully.
    const novelty = valid ? noveltyPenalty(dnaHistory, c.lch.skyMid.H) : 0;
    const score = soft - novelty - 1000 * violation;
    const better = best === null || (valid && !bestValid) || (valid === bestValid && score > bestScore);
    if (better) { best = c; bestScore = score; bestValid = valid; }
  }

  rememberDna({ baseHue: best.anchor.baseHue });

  const fx = pickFx(temp);
  const particleKind = pickParticleKind(grammar, temp);
  const { direction: particleDirection, driftBias } = deriveParticleMotion(dna);
  const celestialKind = pickCelestialKind(dna);
  const isMoon = celestialKind === 'moon';

  const skyStopCount = skyStopCountFor(dna);
  const skyStops = skyStopCount === 5
    ? [best.hex.skyDark, best.hex.skyDarkMid, best.hex.skyMid, best.hex.skyMidHot, best.hex.skyHot]
    : [best.hex.skyDark, best.hex.skyMid, best.hex.skyHot];
  const companions = buildCompanions(dna, best.anchor, rand);

  const profile = {
    sky: [best.hex.skyDark, best.hex.skyMid, best.hex.skyHot],
    // Only consumed by BiomeManager._drawSky's own gradient loop (and only
    // when both sides of a transition carry the same length) -- every other
    // reader of `sky` keeps using the fixed 3-entry array above by index, so
    // this is purely additive.
    skyStops,
    // See FX_TO_LANDMARK_KEY above: this palette's own display `name` (set
    // by synthesizeSectionPalettes) never matches a LANDMARKS/BIOMES key, so
    // ground clutter and near-field occluders need a real archetype to
    // borrow from.
    landmarkKey: FX_TO_LANDMARK_KEY[fx] || 'TWILIGHT',
    silhouette: best.hex.silhouette,
    celestial: {
      kind: celestialKind,
      color: best.hex.celestial,
      radius: Math.round(30 + temp * 36 + (isMoon ? 8 : 0)),
      haloColor: best.hex.halo,
      veiled: temp > 0.72 && grammar.spikeCluster > 0.3,
      ring: isMoon && grammar.arch > 0.3,
      shafts: !isMoon && (temp > 0.55 || dna.air > 0.6),
      // Purely decorative -- see buildCompanions above. Empty for a
      // harmonically simple song (single sun/moon, today's look unchanged).
      companions,
    },
    particles: {
      kind: particleKind,
      color: best.hex.particle,
      count: Math.round(16 + temp * 46 + dna.noteDensity * 22),
      speed: Math.round(10 + temp * 110 + dna.percussionDensity * 40),
      direction: particleDirection,
      driftBias,
    },
    fx,
    // BiomeManager scales the ridge-dance amplitude by this directly
    // (BiomeManager.js:3828 etc.) — stock worlds span roughly 0.6-1.35, not
    // 0-1, so clamping to 0-1 here would make every generated world dance
    // visibly less than a stock one at the same energy.
    terrainEnergy: lerp(0.6, 1.35, clamp01(0.3 * grammar.spikeCluster + 0.3 * grammar.verticalStack + 0.2 * temp + 0.2 * dna.dyn)),
  };

  return {
    profile,
    temperature: temp,
    valid: bestValid,
    proof: {
      candidatesTried: N_CANDIDATES,
      hardConstraintsSatisfied: bestValid,
      softScore: bestScore,
      baseHue: best.anchor.baseHue,
      rotationDeg: best.anchor.rotationDeg,
      grammar,
    },
  };
}

/** One palette entry per distinct section label, sharing the base hue
 *  family but shifted in lightness/chroma/temperature — deterministic per
 *  (song seed, label) so the same section always reads the same way on
 *  replay. Falls back to a single entry when there's no section data. */
export function synthesizeSectionPalettes(dna, name) {
  // `name` is the world kind (alpine, city, …). It is only a palette-id
  // prefix and physical admission key; WorldAdaptation then tints toward its
  // stock materials so After Hours does not inherit a mountain sky.
  // castBiomes forbids picking the same name twice in a row, so a single
  // entry would strand every section after the first with no candidate.
  // Detected structure wins when we have it; otherwise fall back to three
  // deterministic movements so casting always has real choices.
  const detected = Array.isArray(dna.sectionLabels) ? [...new Set(dna.sectionLabels)] : [];
  const labels = detected.length >= 2 ? detected : ['A', 'B', 'C'];

  const baseTemp = computeTemperature(dna);
  const palettes = [];
  const temperature = {};

  labels.forEach((label, i) => {
    const rand = mulberry32(dna.seed ^ (0x1000193 * (i + 1)) ^ hashOfLabel(label));
    const sectionTemp = clamp01(baseTemp + (rand() - 0.5) * 0.30);
    const sectionDna = { ...dna, tempoHeat: clamp01(dna.tempoHeat + (rand() - 0.5) * 0.2) };
    const { profile } = synthesizePalette(sectionDna, sectionTemp);
    const paletteName = `${name}_${label}_${i}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    palettes.push(constrainPalette(name, { ...profile, name: paletteName }));
    temperature[paletteName] = sectionTemp;
  });

  return { palettes, temperature };
}

function hashOfLabel(label) {
  const s = String(label || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}
