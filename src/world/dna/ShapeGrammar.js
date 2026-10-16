// Shape grammar — instrumentation drives continuous production-rule
// weights instead of a fixed "if distorted guitar -> spiky" lookup.
// They pick the closest-matching particle/fx/celestial enum values, a
// terrainEnergy scalar, and (via deriveTerrainParams below) continuous
// nudges to the alpine ridgeline's own shape parameters -- so a song's
// instrumentation is legible in both the palette and the skyline it
// generates, not just a fixed massif/range/crags cutout per depth.
import { clamp, clamp01, spread01 } from '../../utils/math.js';

const PARTICLE_KINDS = [
  'fireflies', 'embers', 'snow', 'pollen', 'antigrav',
  'petals', 'rain', 'flaresparks', 'digitalrain', 'sand', 'bubbles', 'spores',
];

const FX_BY_TEMP = [
  [0.10, 'aurora'], [0.18, 'nebulaBloom'], [0.27, 'starTwinkle'],
  [0.36, 'bioluminescence'], [0.45, 'canopyDapple'], [0.55, 'godRays'],
  [0.64, 'mirage'], [0.72, 'petalPile'], [0.80, 'sunMotes'],
  [0.87, 'crystalGlint'], [0.94, 'prominence'], [1.01, 'lightning'],
];

// Each category below is built from a different combination of terms (2-3
// weighted 0..1 features, one drawn from the organic/geometric/distorted
// simplex), so their raw pre-normalization ranges are NOT comparable --
// measured over 40k uniform-random DNA samples, spikeCluster averages
// 0.601 while trunkBranch/geometricRegularity average only ~0.35. Since the
// final normalize-to-sum-1 step below divides every category by the SAME
// total, that raw-scale gap survives straight into the output: spikeCluster
// was the dominant family (the largest of the 6, which pickCharacterScheme
// and deriveTerrainParams both key off) for 52.8% of sampled songs, against
// 0.5% for verticalStack -- six categories that were supposed to give a
// song's terrain six genuinely different looks instead collapsed onto
// "usually spiky, rarely anything else." Dividing each category by its own
// measured mean (CATEGORY_MEAN) before combining brings every category back
// to the same ~1.0 average scale first, so the sum-normalization no longer
// systematically favors whichever category happened to have the widest raw
// range. Measured effect: the dominant-family spread narrows from a 105x
// ratio (52.8%/0.5%) to roughly 3.5x, with every one of the 6 categories
// now reachable as the dominant read for a real fraction of songs.
const CATEGORY_MEAN = {
  trunkBranch: 0.349, verticalStack: 0.451, spikeCluster: 0.601,
  arch: 0.467, mound: 0.450, geometricRegularity: 0.350,
};

/** Continuous production-rule weights, normalized to sum to 1. */
export function buildShapeGrammar(dna) {
  const fam = dna.familyShare || { organic: 0.34, geometric: 0.33, distorted: 0.33 };
  const w = {
    trunkBranch: 0.6 * fam.organic + 0.3 * (1 - dna.percussionDensity),
    verticalStack: 0.5 * fam.distorted + 0.4 * fam.geometric + 0.3 * dna.percussionDensity,
    spikeCluster: 0.6 * fam.distorted + 0.5 * dna.percussionDensity + 0.3 * dna.noteDensity,
    arch: 0.5 * fam.organic + 0.4 * dna.phrase + 0.2 * dna.harmonicComplexity,
    mound: 0.6 * (1 - dna.noteDensity) + 0.3 * (1 - dna.percussionDensity),
    geometricRegularity: 0.6 * fam.geometric + 0.3 * (1 - dna.registerSpread),
  };
  let sum = 0;
  for (const k in w) { w[k] = Math.max(0.01, w[k] / CATEGORY_MEAN[k]); sum += w[k]; }
  for (const k in w) w[k] /= sum;
  return w;
}

function dominantFamily(grammar) {
  let best = 'trunkBranch', bestV = -1;
  for (const k in grammar) if (grammar[k] > bestV) { bestV = grammar[k]; best = k; }
  return best;
}

/** temperature 0..1: how hot/driving the song reads, independent of hue.
 *  spread01 (see its own comment) counters the central-limit collapse a
 *  5-term weighted sum has toward 0.5 -- measured, this pushed FX_BY_TEMP's
 *  extreme bands (aurora below 0.10, lightning at/above 0.94) to under
 *  0.05% reachability even though every one of the 12 bands was authored
 *  assuming real coverage across the full range. */
export function computeTemperature(dna) {
  return spread01(clamp01(
    0.28 * dna.percussionDensity
    + 0.24 * dna.energyMean
    + 0.24 * dna.tempoHeat
    + 0.14 * dna.noteDensity
    + 0.10 * dna.dyn,
  ));
}

export function pickFx(temperature) {
  for (const [hi, fx] of FX_BY_TEMP) if (temperature < hi) return fx;
  return 'lightning';
}

/** Particle kind: dominant shape-grammar family narrows the field, then
 *  temperature within that family picks the specific species — so two
 *  songs with the same instrumentation but different intensity still
 *  read as different, rather than collapsing onto one particle kind. */
export function pickParticleKind(grammar, temperature) {
  const dom = dominantFamily(grammar);
  const pools = {
    trunkBranch: ['pollen', 'fireflies', 'petals', 'spores'],
    mound: ['fireflies', 'pollen', 'snow', 'bubbles'],
    arch: ['petals', 'fireflies', 'spores', 'bubbles'],
    spikeCluster: ['embers', 'flaresparks', 'sand', 'digitalrain'],
    verticalStack: ['digitalrain', 'rain', 'flaresparks', 'antigrav'],
    geometricRegularity: ['digitalrain', 'antigrav', 'sand', 'rain'],
  };
  const pool = pools[dom] || PARTICLE_KINDS;
  const idx = Math.min(pool.length - 1, Math.floor(temperature * pool.length));
  return pool[idx];
}

/**
 * Particle motion from the song's register trajectory (SongDNA.registerTrend:
 * -1 falling..1 rising, from MIDI pitch-over-time or the audio-only energy-
 * wave proxy) plus how percussive/dense the song is. Returns a named
 * `direction` (informational/testable) and a `driftBias` velocity in px/s
 * that ParticleField adds on top of each particle kind's own physics —
 * so a song that climbs in register visibly lifts its particle field, one
 * that falls settles it, and a driving, non-trending song reads as bursty
 * rather than merely ambient.
 */
export function deriveParticleMotion(dna) {
  const trend = dna.registerTrend || 0;
  const burstiness = clamp01(0.6 * (dna.percussionDensity || 0) + 0.4 * (dna.noteDensity || 0));

  let direction;
  if (burstiness > 0.62 && Math.abs(trend) < 0.35) direction = 'burst';
  else if (trend > 0.18) direction = 'rise';
  else if (trend < -0.18) direction = 'fall';
  else direction = 'drift';

  let vx = 0, vy = 0;
  if (direction === 'rise') {
    vy = -(8 + 26 * Math.abs(trend));
  } else if (direction === 'fall') {
    vy = 8 + 26 * Math.abs(trend);
  } else if (direction === 'burst') {
    const m = 14 + 34 * burstiness;
    vx = m * 0.5; vy = -m * 0.5;
  } else {
    // Neutral trajectory: gentle lateral drift, direction set by a
    // deterministic (not random) feature so the same song always drifts
    // the same way -- brighter songs drift right, darker ones left.
    const sign = (dna.centroid ?? 0.5) >= 0.5 ? 1 : -1;
    vx = sign * (6 + 14 * Math.abs((dna.centroid ?? 0.5) - 0.5) * 2);
  }

  return { direction, driftBias: { vx, vy } };
}

export function pickCelestialKind(dna) {
  return (dna.meanPitch01 < 0.42 || dna.isMajor === false) && dna.energyMean < 0.55 ? 'moon' : 'sun';
}

/**
 * Continuous nudges to ALPINE_CHARACTERS' shape params (SilhouetteGenerator
 * applyTerrainMods), derived from the shape-grammar weights. Every category
 * averages 1/6 across a normalized grammar, so each bias is centered on
 * that baseline rather than on zero -- a song that's exactly "average" in a
 * category leaves that character untouched.
 *
 *  - spike/vertical-stack heavy songs pinch flanks toward a spire (higher
 *    shoulder/spire exponents, more spireMix, more notch/teeth grain) and
 *    pull peaks apart (less apron fill, so they read as separate spikes
 *    rather than a joined range).
 *  - trunk-branch/mound heavy songs do the opposite: fuller domed flanks,
 *    smoother edges, more connective apron so neighbours merge into one
 *    body of high ground.
 *  - arch heavy songs widen the apron spread further still (broad saddles
 *    between summits) without pinching the flanks.
 *  - geometricRegularity narrows how far off-centre summits sit, so a
 *    regular song's range reads more evenly spaced.
 */
/** Keys each silhouette profile actually reads. Adaptation sends only the
 *  groups the world kind consumes — alpine flanks never go to a city. */
export const RIDGE_TERRAIN_KEYS = [
  'shoulderMul', 'spireMul', 'spireMixAdd', 'notchAdd', 'teethAdd',
  'apronGainAdd', 'apronSpreadAdd', 'apronCapAdd', 'asymMul',
];
export const CITY_TERRAIN_KEYS = [
  'cityWidthMul', 'citySetbackFrac', 'cityTaperMul', 'cityDensityMul',
];
export const ROLLING_TERRAIN_KEYS = [
  'rollingAmpMul', 'rollingOctaveBias',
];

export function deriveTerrainParams(grammar) {
  const g = grammar || {};
  const spiky = (g.spikeCluster || 0) + (g.verticalStack || 0); // baseline ~1/3
  const organic = (g.trunkBranch || 0) + (g.mound || 0); // baseline ~1/3
  const archy = g.arch || 0; // baseline ~1/6
  const regular = g.geometricRegularity || 0; // baseline ~1/6

  const spikeBias = clamp(spiky - 1 / 3, -1 / 3, 1 / 3) * 3; // -1..1
  const organicBias = clamp(organic - 1 / 3, -1 / 3, 1 / 3) * 3; // -1..1
  const archBias = clamp(archy - 1 / 6, -1 / 6, 1 / 6) * 6; // -1..1
  const regularBias = clamp(regular - 1 / 6, -1 / 6, 1 / 6) * 6; // -1..1

  return {
    shoulderMul: 1 + 0.35 * spikeBias - 0.30 * organicBias,
    spireMul: 1 + 0.35 * spikeBias - 0.20 * organicBias,
    spireMixAdd: 0.08 * spikeBias - 0.06 * organicBias,
    notchAdd: 0.05 * spikeBias - 0.04 * organicBias + 0.03 * archBias,
    teethAdd: 0.05 * spikeBias - 0.03 * organicBias,
    apronGainAdd: -0.08 * spikeBias + 0.10 * organicBias + 0.04 * archBias,
    apronSpreadAdd: -0.3 * spikeBias + 0.4 * organicBias + 0.5 * archBias,
    apronCapAdd: -0.04 * spikeBias + 0.06 * organicBias,
    asymMul: 1 + 0.3 * spikeBias - 0.35 * regularBias,

    // City-kind worlds (CitySilhouette.cityHeightField) read these the same
    // way the alpine fields above are read: spiky/vertical-stack songs get
    // narrower, more isolated towers with a more pronounced setback step;
    // organic/mound songs get broader, denser, gentler-tapered fabric.
    cityWidthMul: 1 - 0.25 * spikeBias + 0.20 * organicBias,
    citySetbackFrac: clamp01(0.62 + 0.10 * regularBias - 0.08 * organicBias),
    cityTaperMul: 1 + 0.25 * spikeBias - 0.20 * organicBias,
    cityDensityMul: 1 + 0.35 * organicBias - 0.25 * spikeBias,

    // 'rolling' profile (strip worlds' L2-L4, and every world's nearest L5
    // layer): spiky/vertical-stack songs get more pronounced, grainier
    // hills; organic/regular songs stay smoother.
    rollingAmpMul: 1 + 0.3 * spikeBias - 0.25 * organicBias,
    rollingOctaveBias: spikeBias > 0.3 ? 1 : regularBias > 0.3 ? -1 : 0,
  };
}

/**
 * Which ALPINE_CHARACTERS (SilhouetteGenerator.js) get assigned to the
 * L2/L3/L4 depth layers, in far-to-near order. Every world used to get the
 * exact same triple (massif, range, crags) regardless of the song --
 * deriveTerrainParams above reshapes each layer's flanks/apron/grain, but
 * the underlying LANDFORM never changed, so at a glance every world's L2
 * still read as "a few broad peaks" and every L4 as "many small crags."
 *
 * Three schemes, each still far-to-near ordered broadest-and-fewest to
 * narrowest-and-most (the real depth cue every character progression
 * relies on -- see ALPINE_CHARACTERS' own comment) so layers stay
 * genuinely distinct from EACH OTHER within a song; which scheme a song
 * lands on is what varies ACROSS songs:
 *  - 'classic' (the original triple): massif -> range -> crags.
 *  - 'jagged', for spike/vertical-stack-heavy songs: range -> crags ->
 *    spires -- the whole stack skews sharper, capped by true needle peaks
 *    up close.
 *  - 'monumental', for organic/mound-heavy songs: plateau -> massif ->
 *    range -- the whole stack skews broader, anchored by a joined
 *    tableland at the horizon.
 */
export const CHARACTER_SCHEMES = {
  classic: ['massif', 'range', 'crags'],
  jagged: ['range', 'crags', 'spires'],
  monumental: ['plateau', 'massif', 'range'],
};

export function pickCharacterScheme(grammar) {
  const g = grammar || {};
  const spiky = (g.spikeCluster || 0) + (g.verticalStack || 0);
  const organic = (g.trunkBranch || 0) + (g.mound || 0);
  const spikeBias = clamp(spiky - 1 / 3, -1 / 3, 1 / 3) * 3;
  const organicBias = clamp(organic - 1 / 3, -1 / 3, 1 / 3) * 3;
  if (spikeBias > 0.18 && spikeBias > organicBias) return 'jagged';
  if (organicBias > 0.18 && organicBias > spikeBias) return 'monumental';
  return 'classic';
}
