// What a real mountain range feels like, read off its skyline.
//
// Every range in the basket is scored on the same few axes a song is, so a
// song can be matched to the range that fits it (RangeMatcher.js). The
// scores are ABSOLUTE -- each feature is normalised against a fixed physical
// reference, never against the other ranges -- so the basket can grow from
// three ranges to three hundred without any range's scores moving. Adding a
// range adds a choice; it never re-ranks the ones already there.
//
// Input is a baked profile (TerrainProfile's JSON: layers keyed L2/L3/L4,
// each with skylineElevM sampled every spacingM along the range). The far
// layer, L2, is the silhouette a viewer reads as "the range".

// Fixed references: the value at which each raw feature reads as 1. Set to
// Earth's extremes, not to the current basket, so the most savage real
// skylines (Karakoram, the high Andes) approach 1 and there is headroom
// above everything built so far. The first calibration used the Tetons'
// own numbers and pinned seven of the first twelve ranges at the ceiling.
export const REFERENCE = Object.freeze({
  reliefM: 4500,        // skyline max - min; the Cordillera Blanca reads 3,859
  slopeMPerKm: 700,     // mean |rise| along the skyline per km
  peaksPer10Km: 6,      // local summits with >= PEAK_PROMINENCE_M of drop on both sides
  roughnessM: 320,      // RMS of the skyline about its own ~2km running mean
});
const PEAK_PROMINENCE_M = 60;
const SMOOTH_KM = 2;
const DOMINANCE_MIN_RELIEF_M = 300;

// Emotional archetypes as prototypes in the four-axis space (energy,
// rawness, grandeur, dominance), each placed where real exemplars land
// rather than guessed in the abstract. A range's archetype is its nearest
// prototype; `weights` is its affinity to every archetype, for anything
// that wants a blend rather than one label.
export const ARCHETYPES = Object.freeze({
  wild:     { energy: 0.80, rawness: 0.85, grandeur: 0.75, dominance: 0.40, mood: 'ferocity' },   // Cordillera Blanca
  majestic: { energy: 0.48, rawness: 0.48, grandeur: 0.40, dominance: 0.48, mood: 'heroism' },    // Tetons, Canadian Rockies
  sublime:  { energy: 0.35, rawness: 0.25, grandeur: 0.65, dominance: 0.80, mood: 'awe' },        // Fuji, Rainier
  defiant:  { energy: 0.22, rawness: 0.25, grandeur: 0.10, dominance: 0.72, mood: 'defiance' },   // Monument Valley
  brooding: { energy: 0.30, rawness: 0.28, grandeur: 0.28, dominance: 0.58, mood: 'melancholy' }, // Wasatch
  restless: { energy: 0.38, rawness: 0.40, grandeur: 0.16, dominance: 0.48, mood: 'unease' },     // Sawtooth
  serene:   { energy: 0.22, rawness: 0.22, grandeur: 0.12, dominance: 0.30, mood: 'calm' },       // Blue Ridge
});
export const AXES = Object.freeze(['energy', 'rawness', 'grandeur', 'dominance']);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function finite(values) {
  return (values || []).filter((v) => Number.isFinite(v));
}

function runningMean(values, halfWindow) {
  return values.map((_, i) => {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - halfWindow); k <= Math.min(values.length - 1, i + halfWindow); k++) {
      sum += values[k]; n++;
    }
    return sum / n;
  });
}

/** Local summits standing at least `prominenceM` above the lowest point
 *  between them and the next summit on each side. */
export function countPeaks(values, prominenceM = PEAK_PROMINENCE_M) {
  let peaks = 0;
  for (let i = 1; i < values.length - 1; i++) {
    if (!(values[i] > values[i - 1] && values[i] >= values[i + 1])) continue;
    let left = values[i], right = values[i];
    for (let k = i - 1; k >= 0 && values[k] <= values[i]; k--) left = Math.min(left, values[k]);
    for (let k = i + 1; k < values.length && values[k] <= values[i]; k++) right = Math.min(right, values[k]);
    if (values[i] - Math.max(left, right) >= prominenceM) peaks++;
  }
  return peaks;
}

/** Raw measurements of a skyline, in physical units. */
export function skylineFeatures(skylineElevM, spacingM) {
  const v = finite(skylineElevM);
  if (v.length < 4 || !(spacingM > 0)) return null;
  const lengthKm = ((v.length - 1) * spacingM) / 1000;
  const hi = Math.max(...v), lo = Math.min(...v);
  const sorted = [...v].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let rise = 0;
  for (let i = 1; i < v.length; i++) rise += Math.abs(v[i] - v[i - 1]);
  const smooth = runningMean(v, Math.max(1, Math.round((SMOOTH_KM * 1000) / spacingM / 2)));
  let sq = 0;
  for (let i = 0; i < v.length; i++) sq += (v[i] - smooth[i]) ** 2;
  return {
    reliefM: hi - lo,
    slopeMPerKm: rise / Math.max(lengthKm, 1e-6),
    peaksPer10Km: (countPeaks(v) / Math.max(lengthKm, 1e-6)) * 10,
    roughnessM: Math.sqrt(sq / v.length),
    // One commanding summit (high) versus an even wall (low): how far the top
    // stands above the typical crest, as a share of the whole relief.
    dominance: hi > lo ? (hi - median) / (hi - lo) : 0,
    summitM: hi,
    lengthKm,
  };
}

/** The four matching axes, each 0..1 against the fixed REFERENCE. */
export function characterFromFeatures(f) {
  const grandeur = clamp01(f.reliefM / REFERENCE.reliefM);
  const slope = clamp01(f.slopeMPerKm / REFERENCE.slopeMPerKm);
  const peaks = clamp01(f.peaksPer10Km / REFERENCE.peaksPer10Km);
  const rough = clamp01(f.roughnessM / REFERENCE.roughnessM);
  return {
    energy: clamp01(0.45 * slope + 0.35 * peaks + 0.20 * grandeur),
    rawness: clamp01(0.6 * rough + 0.4 * peaks),
    grandeur,
    // Dominance is a share of the relief, so on its own a 40m wiggle on a
    // flat wall reads as a commanding summit. A summit has to be physically
    // substantial to dominate: this fades in over the first
    // DOMINANCE_MIN_RELIEF_M. Every range in the first basket clears it
    // (Monument Valley's buttes, the lowest, stand ~320m).
    dominance: clamp01(f.dominance * clamp01(f.reliefM / DOMINANCE_MIN_RELIEF_M)),
  };
}

export function axisDistance(a, b) {
  let sum = 0;
  for (const axis of AXES) sum += ((a[axis] ?? 0.5) - (b[axis] ?? 0.5)) ** 2;
  return Math.sqrt(sum);
}

/** Nearest archetype, plus a normalised affinity to every archetype. */
export function archetypeOf(scores) {
  const dist = Object.fromEntries(Object.entries(ARCHETYPES).map(([k, p]) => [k, axisDistance(scores, p)]));
  const archetype = Object.keys(dist).reduce((a, b) => (dist[b] < dist[a] ? b : a));
  const raw = Object.fromEntries(Object.entries(dist).map(([k, d]) => [k, Math.exp(-d * 4)]));
  const total = Object.values(raw).reduce((s, x) => s + x, 0) || 1;
  const weights = Object.fromEntries(Object.entries(raw).map(([k, x]) => [k, x / total]));
  return { archetype, mood: ARCHETYPES[archetype].mood, weights };
}

/**
 * Whether a built skyline actually shows a range. A build can succeed and
 * still be garbage, and nobody will eyeball three hundred plots, so the
 * builder rejects on two measured faults instead:
 *
 * floorShare -- the share of stations within 8% of the lowest angle. A
 *   skyline that sits on the floor of its own view (camera underground, or a
 *   crest receding out of view). Usable ranges read 0.27 or less; the broken
 *   first Cordillera Blanca build read 0.83.
 *
 * artifact -- the biggest jump in viewing angle that the ground does not
 *   back up: a station whose angle stands out from its neighbours (or steps
 *   from the last one) by more, as a share of the skyline's range, than its
 *   elevation does. A real summit rises in both; a ridge standing close in
 *   front of the crest, or the edge of the elevation grid, rises in angle
 *   alone and draws as a needle or a sheer wall. The curated ranges read
 *   0.25 or less (Monument Valley's buttes, which really are sheer, 0.05);
 *   the builds that looked broken on a contact sheet read 0.43 to 0.56.
 */
export const MAX_FLOOR_SHARE = 0.5;
export const MAX_ARTIFACT = 0.42;
const ARTIFACT_WINDOW = 4;

function neighbourMedian(values, i) {
  const nb = [];
  for (let k = i - ARTIFACT_WINDOW; k <= i + ARTIFACT_WINDOW; k++) {
    if (k !== i && k >= 0 && k < values.length && Number.isFinite(values[k])) nb.push(values[k]);
  }
  if (!nb.length) return NaN;
  nb.sort((a, b) => a - b);
  return nb[nb.length >> 1];
}

/** The artifact score described above; 0 when elevations are missing. */
export function skylineArtifact(angles, elevs) {
  const fa = finite(angles), fe = finite(elevs);
  if (fa.length < 4 || fe.length < 4 || angles.length !== elevs.length) return 0;
  const aSpan = Math.max(...fa) - Math.min(...fa);
  const eSpan = Math.max(...fe) - Math.min(...fe);
  if (!(aSpan > 0)) return 0;
  const eShare = (d) => (eSpan > 0 && Number.isFinite(d) ? d / eSpan : 0);
  let worst = 0;
  for (let i = 0; i < angles.length; i++) {
    if (!Number.isFinite(angles[i])) continue;
    const standsOut = (angles[i] - neighbourMedian(angles, i)) / aSpan;
    if (Number.isFinite(standsOut)) worst = Math.max(worst, standsOut - Math.max(0, eShare(elevs[i] - neighbourMedian(elevs, i))));
    if (i > 0 && Number.isFinite(angles[i - 1])) {
      worst = Math.max(worst, Math.abs(angles[i] - angles[i - 1]) / aSpan - Math.abs(eShare(elevs[i] - elevs[i - 1])));
    }
  }
  return worst;
}

// Scores and the quality gate were calibrated on skylines sampled every
// 400m. A denser build (every ~30m, so the drawn ridge has real detail) is
// pooled back to this spacing before it is scored or gated, so a range's
// scores, mood and relief band mean what they meant before.
export const SCORE_SPACING_M = 400;

/** The far layer at scoring spacing: each 400m run pooled to the sample
 *  with the highest skyline angle (its elevation with it), so a summit is
 *  never averaged away. A layer already that coarse is returned as is. */
export function scoringLayer(layer) {
  if (!layer || !(layer.spacingM > 0)) return layer;
  const k = Math.round(SCORE_SPACING_M / layer.spacingM);
  if (k <= 1) return layer;
  const angles = [];
  const elevs = [];
  const hasElev = layer.skylineElevM && layer.skylineElevM.length === layer.angles.length;
  for (let i = 0; i < layer.angles.length; i += k) {
    let best = -1;
    for (let j = i; j < Math.min(i + k, layer.angles.length); j++) {
      if (Number.isFinite(layer.angles[j]) && (best < 0 || layer.angles[j] > layer.angles[best])) best = j;
    }
    angles.push(best < 0 ? NaN : layer.angles[best]);
    elevs.push(best < 0 || !hasElev ? NaN : layer.skylineElevM[best]);
  }
  return { ...layer, spacingM: layer.spacingM * k, angles, skylineElevM: hasElev ? elevs : layer.skylineElevM };
}

const farLayer = (profileJson) => scoringLayer(profileJson?.layers?.L2 || Object.values(profileJson?.layers || {})[0]);

export function skylineQuality(profileJson) {
  const layer = farLayer(profileJson);
  const angles = finite(layer?.angles);
  if (angles.length < 4) return { floorShare: 1, artifact: 0, usable: false };
  const lo = Math.min(...angles), hi = Math.max(...angles);
  const span = hi - lo;
  if (!(span > 0)) return { floorShare: 1, artifact: 0, usable: false };
  const floorShare = angles.filter((a) => a - lo < 0.08 * span).length / angles.length;
  const artifact = skylineArtifact(layer.angles, layer.skylineElevM || []);
  return { floorShare, artifact, usable: floorShare <= MAX_FLOOR_SHARE && artifact <= MAX_ARTIFACT };
}

/** Score a baked profile JSON. Null when it has no usable far skyline. */
export function rangeCharacter(profileJson) {
  const layer = farLayer(profileJson);
  const features = layer ? skylineFeatures(layer.skylineElevM, layer.spacingM) : null;
  if (!features) return null;
  const scores = characterFromFeatures(features);
  return { features, scores, ...archetypeOf(scores) };
}
