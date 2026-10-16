// Ridge portrait: the parallax ranges' OUTLINE, derived from a song.
//
// What was wrong: alpineHeightField placed 3–13 peaks at even intervals
// with random heights, then chewed the skyline with ridged-noise notches
// and teeth. Every song, every biome, got a generic jagged picket fence —
// random AND bland, and musically mute. The live equalizers (spectrum
// massif, GeoCrest) already paint the *now*; orogeny already scales the
// *arc*. The baked silhouette — the thing you actually look at for the
// whole song — was leftover geology from a seed.
//
// What this does instead is an orogenic inversion of two stable parts of
// the sonic profile, neither of which is a waveform or a live EQ:
//
//   1. SPECTRAL MASS (timbre as geology). The 7-band shape is a VERTICAL
//      mass distribution, foot to crest — not a left-to-right spectrogram
//      (that's the massif). Bass is basement rock: broad flanks, high
//      saddles, an altiplano. Mids are the working triangle. Presence/air
//      are the horn at the top. Two songs can share a centroid and still
//      be different rock: a scooped mix (bass+air, empty mids) is a
//      plateau with horns; a mid-forward mix is a classic alpine triangle.
//      Dynamic range sets how far heights spread. Weathering (couloirs,
//      arete teeth) is the high-frequency leftover, and even then, quietly.
//
//   2. ENERGY LANDMARKS (form as composition). The song is sampled at
//      phrase scale (~64 points), prominence-filtered down to a handful
//      of named summits (a drop, a chorus, a bridge — not every kick).
//      Those become the peaks. Placement keeps relative spacing so a
//      song with two choruses flanking a drop reads as two similar
//      summits around a king, but it is a composed skyline, not a
//      scrolling spectrogram: we only keep 3–12 landmarks, we leave
//      margins so the tile wrap is foothills, and we never let the
//      outline move with the beat (that's the dance, already).
//
// Layers read different facets of the same genome so the stack rhymes
// without cloning (L2 = macro form, L3 = timbre, L4 = grain, L5 =
// phrase-scale bass undulation under rolling fbm). Intensity is capped
// on purpose: music decides WHERE the mountains are, HOW they lean, and
// what ROCK they are (the flank's hypsometry). The landform type
// (massif/range/crags) still decides the register.
//
// Pure, DOM-free, deterministic. BiomeManager builds one portrait per
// song and hands it to generateSilhouette; tests exercise every step
// without a canvas.
import { clamp, clamp01, lerp, mulberry32 } from '../utils/math.js';
import { FLAT_WEIGHTS } from '../audio/bands.js';

export const PORTRAIT_SAMPLES = 64;
export const MAX_LANDMARKS = 12;
const MARGIN = 0.12;            // keep peaks off the tile wrap (matches generateSilhouette's blend)
const PROMINENCE_FLOOR = 0.08;  // ripples are not mountains (same idea as SHOULDER_MIN_PROMINENCE)
const MIN_SPACING_SAMPLES = 4;  // ~6% of the song — phrase-scale, not note-scale
const PHRASE_CORR_FLOOR = 0.25;
const SPINE_SMOOTH_PASSES = 3;

/** Per-layer reading of the same portrait. take/min/max control how many
 *  landmarks become summits; phase slides the composition so stacked
 *  ranges don't clone; width/height/spine/weather set the geological
 *  register (far = huge and few, near = grainy and many). */
export const LAYER_ROLES = {
  L2: { take: 0.42, minPeaks: 3, maxPeaks: 5, phase: 0.00, widthMul: 1.18, heightMul: 1.00, spineAmp: 0.10, notchMul: 0.55, teethMul: 0.40, profileMix: 0.55 },
  L3: { take: 0.72, minPeaks: 4, maxPeaks: 7, phase: 0.07, widthMul: 1.00, heightMul: 0.96, spineAmp: 0.08, notchMul: 0.80, teethMul: 0.70, profileMix: 0.72 },
  L4: { take: 1.00, minPeaks: 6, maxPeaks: 11, phase: -0.05, widthMul: 0.82, heightMul: 0.90, spineAmp: 0.06, notchMul: 1.05, teethMul: 1.10, profileMix: 0.38 },
  L5: { take: 0, minPeaks: 0, maxPeaks: 0, phase: 0.11, widthMul: 1, heightMul: 1, spineAmp: 0.22, notchMul: 0, teethMul: 0, profileMix: 0.20 },
};

// Three-term flank, foot → crest. Exponents chosen so the FOOT term is
// fuller than a triangle (mass carried out onto the plain — a shield or
// a plateau), the BODY term is a working alpine shoulder, and the TIP
// is a horn. Weights come from the spectrum; the shape of the mountain
// IS the shape of the mix.
const MASS_FOOT_K = 0.34;
const MASS_BODY_K = 1.05;
const MASS_TIP_K = 2.85;

/** Per-layer tilt of the three-term mass. Distant ranges show basement
 *  (you read the bulk from far away, not the seracs). The mid range is
 *  the timbre layer — spectral geology speaks loudest there. Near crags
 *  tilt toward the crest, where you're close enough to see the horns. */
const LAYER_LITH_TILT = {
  L2: [1.28, 1.04, 0.62],
  L3: [1.00, 1.08, 1.00],
  L4: [0.78, 0.92, 1.35],
  L5: [1.22, 0.90, 0.48],
};

/**
 * Spectral mass as lithology. The 7 bands are a VERTICAL mass distribution
 * from foot (sub/bass) to crest (presence/air). This is the opposite of
 * the spectrum massif, which spreads bands left-to-right; here the mix
 * decides how a single mountain is built, not where the EQ bars sit.
 *
 *   0 SUB       basement / plateau — connecting saddles
 *   1 BASS      body width / bulk  — lower-mid flanks
 *   2 LOW-MID   shoulders          — mass carried high
 *   3 MID       primary structure  — the working triangle
 *   4 HIGH-MID  couloirs           — mid-flank carving
 *   5 PRESENCE  aretes / sub-spires
 *   6 AIR       seracs at the crest
 *
 * `foot`/`mid`/`tip` are the three-term flank weights (sum to 1). A
 * scooped mix (bass+air, empty mids) loads foot AND tip — a plateau with
 * horns. A mid-forward mix loads `mid` — a classic alpine triangle.
 * Floors keep a pure-bass track from losing its summit and a pure-air
 * track from losing its foot.
 */
export function lithologyFromShares(shares) {
  const raw = shares && shares.length >= 7 ? shares : [1, 1, 1, 1, 1, 1, 1];
  let tot = 0;
  for (let i = 0; i < 7; i++) tot += Math.max(0, raw[i] || 0);
  const n = tot > 1e-9 ? tot : 7;
  const b = new Float32Array(7);
  for (let i = 0; i < 7; i++) b[i] = Math.max(0, raw[i] || 0) / n;

  const basement = b[0] + b[1];
  const body = b[2] + b[3];
  const edge = b[4] + b[5];
  const crest = b[5] + b[6];
  const air = b[6];
  // Positive = hollow mids (electronic scoop). Negative = mid-forward.
  const scoop = clamp((basement + crest) - (b[2] + b[3] + b[4]), -1, 1);
  let hypso = 0;
  for (let i = 0; i < 7; i++) hypso += b[i] * (i / 6);

  let foot = Math.max(0.12, basement * 1.18);
  let mid = Math.max(0.16, body * 1.12 + edge * 0.16);
  let tip = Math.max(0.08, crest * 1.22 + air * 0.35);
  const wsum = foot + mid + tip;
  foot /= wsum; mid /= wsum; tip /= wsum;

  return { basement, body, edge, crest, air, scoop, hypso, foot, mid, tip, bands: b };
}

// Per-section landform (mountain overhaul Stage 1): the same 5-rung ladder
// CHARACTER_SCHEMES' three named triples already window into (monumental =
// rungs 0-2, classic = 1-3, jagged = 2-4) -- a section's own spectral
// position + relative energy picks which 3-rung window it gets, so a
// bright, energetic chorus can land on true spires while a dark, quiet
// verse settles on plateau/massif, without inventing a second landform
// vocabulary the rest of the game doesn't already know.
export const LANDFORM_LADDER = ['plateau', 'massif', 'range', 'crags', 'spires'];

/** Which 3-rung window of LANDFORM_LADDER a section lands on, from its
 *  spectral position (bass-heavy 0 .. bright 1) and its energy relative to
 *  the rest of the song (quiet 0 .. loud 1). Both bias the window the same
 *  direction (brighter/louder -> higher rungs -> spires) so the two signals
 *  reinforce rather than fight. */
export function landformWindow(spectralPos01 = 0.5, relEnergy01 = 0.5) {
  const offset = Math.round(clamp01(0.5 * clamp01(spectralPos01) + 0.5 * clamp01(relEnergy01)) * 2);
  return LANDFORM_LADDER.slice(offset, offset + 3);
}

/** Each value's rank against the group's own min..max, 0..1 -- scale
 *  invariant: doubling every input changes none of the outputs, so a quiet
 *  song's chorus still reads as its biggest section and a loud song's
 *  bridge still reads as a lull. A group with no spread (every value
 *  equal) reads as 0.5 everywhere rather than an arbitrary 0 or 1. */
export function relEnergyLadder(energies) {
  if (!energies || energies.length === 0) return [];
  const lo = Math.min(...energies), hi = Math.max(...energies);
  const span = hi - lo;
  return energies.map((e) => (span > 1e-6 ? clamp01((e - lo) / span) : 0.5));
}

// Snowline (mountain overhaul Stage 4): how much of a range's own crest
// reads as capped, 0..1 in COLUMN-HEIGHT-RANK space (see
// MountainChoreo.columnHeight01At) -- 1 means only the single tallest
// column in the range could ever cap, 0 means every column would. A
// bright, airy mix (crest+air-heavy lithology) and a section that's loud
// relative to the rest of its own song both push this down (more of the
// range reads as snowbound), matching how an icy, energetic passage
// should visually read glacial rather than merely tall.
const SNOWLINE_CREST_WEIGHT = 0.55;
const SNOWLINE_ENERGY_WEIGHT = 0.45;
// A hard floor: even the airiest, loudest section leaves most columns
// uncapped -- snow reads as an accent on the true summits, never a blanket
// over the whole range (that would just repaint every layer white).
export const SNOWLINE_MIN = 0.55;

/** Column-height-rank threshold above which a column's own peak is capped.
 *  @param {number} crestAirShare litho.crest (or .air) -- the section's
 *    own bright/high-frequency spectral mass, 0..1
 *  @param {number} relEnergy01 the section's energy relative to the rest
 *    of its own song, 0..1 (relEnergyLadder)
 */
export function snowLine01For(crestAirShare, relEnergy01) {
  const bias = SNOWLINE_CREST_WEIGHT * clamp01(crestAirShare) + SNOWLINE_ENERGY_WEIGHT * clamp01(relEnergy01);
  return Math.max(SNOWLINE_MIN, 1 - bias);
}

/** Tilt the three-term mass toward the layer's geological register. */
export function layerLithology(litho, layerKey = 'L2') {
  const src = litho || lithologyFromShares(null);
  const tilt = LAYER_LITH_TILT[layerKey] || LAYER_LITH_TILT.L2;
  let foot = src.foot * tilt[0];
  let mid = src.mid * tilt[1];
  let tip = src.tip * tilt[2];
  const s = foot + mid + tip;
  if (s > 1e-9) { foot /= s; mid /= s; tip /= s; }
  return { ...src, foot, mid, tip };
}

/**
 * Unit-height flank at normalized distance `d` (0 at the summit, 1 at the
 * foot). Three power laws, weighted by the song's lithology — the spectrum
 * IS the mountain's cross-section. Always 1 at d=0 and 0 at d>=1.
 */
export function massProfile(d, litho) {
  const t = Math.max(0, 1 - Math.max(0, d));
  if (t <= 0 || !litho) return 0;
  return litho.foot * Math.pow(t, MASS_FOOT_K)
    + litho.mid * Math.pow(t, MASS_BODY_K)
    + litho.tip * Math.pow(t, MASS_TIP_K);
}

function boxBlur(src, radius = 1) {
  const n = src.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      s += src[j];
      c++;
    }
    out[i] = c ? s / c : src[i];
  }
  return out;
}

function herfindahlSpread01(shares) {
  // 0 when a single band owns everything, 1 when the spectrum is flat.
  let hhi = 0;
  for (let i = 0; i < shares.length; i++) hhi += shares[i] * shares[i];
  const min = 1 / shares.length;
  return clamp01((1 - hhi) / (1 - min));
}

function centroid01(shares) {
  let wsum = 0, sum = 0;
  for (let b = 0; b < shares.length; b++) {
    wsum += shares[b] * b;
    sum += shares[b];
  }
  return sum > 1e-9 ? wsum / ((shares.length - 1) * sum) : 0.5;
}

function brightnessOf(bands) {
  let num = 0, den = 0;
  for (let b = 0; b < 7; b++) {
    const v = Math.max(0, bands[b] || 0);
    num += v * b;
    den += v;
  }
  return den > 1e-9 ? num / (6 * den) : 0.5;
}

/**
 * Phrase-scale energy wave, 0..1, length PORTRAIT_SAMPLES. Uses the song's
 * own normalized energy so a quiet master and a brickwalled one draw the
 * same landmarks.
 *
 * `window` ({startMs, endMs}), when given, samples only that span of the
 * song (a single section's own timeline) instead of the whole track --
 * everything else about the read (normalization, blur) is identical, so a
 * windowed read and a whole-song read differ only in WHERE they look.
 * Omitted (the default), this is byte-identical to the original whole-song
 * call -- existing callers/tests are unaffected.
 */
export function sampleEnergyWave(energyCurves, durationMs, samples = PORTRAIT_SAMPLES, window = null) {
  const n = Math.max(8, samples | 0);
  const wave = new Float32Array(n);
  const winStart = window ? Math.max(0, window.startMs) : 0;
  const winEnd = window ? Math.min(durationMs, window.endMs) : durationMs;
  const dur = Math.max(1, winEnd - winStart);
  const hasNorm = typeof energyCurves.globalEnergyNorm === 'function';
  for (let i = 0; i < n; i++) {
    const tMs = winStart + (i / Math.max(1, n - 1)) * dur;
    const e = hasNorm
      ? energyCurves.globalEnergyNorm(tMs, FLAT_WEIGHTS)
      : energyCurves.globalEnergy(tMs, FLAT_WEIGHTS);
    wave[i] = clamp01(e);
  }
  return boxBlur(wave, 1);
}

/**
 * Topographic prominence on a 1-D wave. A local max only counts as a
 * landmark if it stands `prominenceFloor` above the higher of the two
 * valleys that bound it, and no two kept landmarks sit closer than
 * `minSpacing` samples. Tallest-first, so the cap keeps the mountains
 * that matter — same selection idea as BiomeManager._ridgePeaks.
 */
export function findLandmarks(wave, {
  minSpacing = MIN_SPACING_SAMPLES,
  maxCount = MAX_LANDMARKS,
  prominenceFloor = PROMINENCE_FLOOR,
} = {}) {
  const n = wave.length;
  const maxima = [];
  for (let i = 1; i < n - 1; i++) {
    if (wave[i] >= wave[i - 1] && wave[i] > wave[i + 1]) maxima.push(i);
  }
  const scored = maxima.map((i) => {
    let left = wave[i], right = wave[i];
    for (let j = i - 1; j >= 0; j--) {
      if (wave[j] > wave[i]) break;
      if (wave[j] < left) left = wave[j];
    }
    for (let j = i + 1; j < n; j++) {
      if (wave[j] > wave[i]) break;
      if (wave[j] < right) right = wave[j];
    }
    return { i, energy: wave[i], prominence: wave[i] - Math.max(left, right) };
  });
  scored.sort((a, b) => b.prominence - a.prominence || b.energy - a.energy);

  const kept = [];
  for (const s of scored) {
    if (s.prominence < prominenceFloor) continue;
    if (kept.some((k) => Math.abs(k.i - s.i) < minSpacing)) continue;
    kept.push(s);
    if (kept.length >= maxCount) break;
  }

  // A song that just gets loud and stays loud has no local max. Treat the
  // high plateau's centre as a single broad summit so we never fall back
  // to a random picket fence on a real track.
  if (kept.length === 0 && n > 2) {
    let maxE = -Infinity, maxI = Math.floor(n / 2);
    for (let i = 0; i < n; i++) if (wave[i] > maxE) { maxE = wave[i]; maxI = i; }
    if (maxE > 0.05) kept.push({ i: maxI, energy: maxE, prominence: maxE });
  }
  return kept;
}

function landmarkWidth01(wave, i) {
  const half = wave[i] * 0.55;
  let lo = i, hi = i;
  while (lo > 0 && wave[lo] >= half) lo--;
  while (hi < wave.length - 1 && wave[hi] >= half) hi++;
  return clamp01((hi - lo) / Math.max(1, wave.length));
}

// The fraction of the read's own dynamic range an event has to move
// through, either side of its peak, before its attack is taken as a real
// gesture rather than a wobble.
const ATTACK_REF_SPAN = 0.35;

function landmarkAttack(wave, i, waveSpan = 0) {
  const span = Math.max(2, Math.round(wave.length * 0.06));
  const pre = wave[Math.max(0, i - span)];
  const post = wave[Math.min(wave.length - 1, i + span)];
  const rise = Math.max(0, wave[i] - pre);
  const fall = Math.max(0, wave[i] - post);
  const raw = (rise - fall) / (rise + fall + 1e-6); // [-1, 1]: drop → + (steeper left)
  // A landmark sitting against the edge of the read has no room on one side,
  // so the clamped sample reports no rise (or no fall) and the ratio pins to
  // ±1 -- a maximally lopsided mountain built out of a measurement that was
  // never taken. That is harmless while attack only sets an unread width,
  // but it now steers which face a summit shows, and a section-windowed
  // portrait puts a landmark against an edge routinely. Damp by how much of
  // the span actually existed, so an unmeasurable edge reports no opinion.
  const have = clamp01(Math.min(i, wave.length - 1 - i) / span);
  // And damp again by how much the energy actually MOVED. The ratio
  // saturates at ±1 the instant one side is flat, which a bump riding a
  // long shoulder manages routinely -- and a range where most summits
  // report a maximal lean in the same direction is the stamped look this
  // whole file exists to avoid. A gesture has to be worth something in the
  // song's own dynamic range before it gets to carve a headwall.
  const conf = waveSpan > 1e-6
    ? clamp01((rise + fall) / (ATTACK_REF_SPAN * waveSpan))
    : 1;
  return raw * have * conf;
}

/**
 * Autocorrelation of the energy wave over phrase-to-section lags. A clear
 * period (verse loop, four-on-the-floor hypermeter) becomes the nearest
 * hills' undulation so the foothills breathe at the song's own scale
 * without tracing the full envelope.
 */
export function phrasePeriod(wave) {
  const n = wave.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += wave[i];
  mean /= n;
  const c = new Float32Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    c[i] = wave[i] - mean;
    energy += c[i] * c[i];
  }
  const empty = { period01: 0, strength: 0, phrase: new Float32Array(16) };
  if (energy < 1e-9) return empty;

  let bestLag = 0, best = 0;
  const lo = 4, hi = Math.min(20, Math.floor(n / 2));
  const ac = new Float64Array(hi + 2);
  for (let lag = lo - 1; lag <= hi + 1; lag++) {
    if (lag < 1 || lag >= n) continue;
    let dot = 0;
    for (let i = 0; i < n - lag; i++) dot += c[i] * c[i + lag];
    ac[lag] = dot / energy;
  }
  // A slow trend (a drone, a single swell) has a monotonically falling
  // autocorrelation — high at lag 4, higher at lag 3, never a peak in the
  // phrase window. A repeating verse has a bump at its period. We only
  // accept a local maximum, so the drone doesn't invent a "phrase".
  for (let lag = lo; lag <= hi; lag++) {
    if (ac[lag] >= ac[lag - 1] && ac[lag] > ac[lag + 1] && ac[lag] > best) {
      best = ac[lag];
      bestLag = lag;
    }
  }
  if (best < PHRASE_CORR_FLOOR || bestLag < lo) return empty;

  const phrase = new Float32Array(bestLag);
  const cycles = Math.max(1, Math.floor(n / bestLag));
  for (let k = 0; k < bestLag; k++) {
    let s = 0, cnt = 0;
    for (let cyc = 0; cyc < cycles; cyc++) {
      const j = cyc * bestLag + k;
      if (j < n) { s += wave[j]; cnt++; }
    }
    phrase[k] = cnt ? s / cnt : 0;
  }
  let pMin = Infinity, pMax = -Infinity;
  for (let k = 0; k < phrase.length; k++) {
    if (phrase[k] < pMin) pMin = phrase[k];
    if (phrase[k] > pMax) pMax = phrase[k];
  }
  const span = pMax - pMin;
  if (span > 1e-6) {
    for (let k = 0; k < phrase.length; k++) phrase[k] = (phrase[k] - pMin) / span;
  }
  return { period01: bestLag / n, strength: clamp01(best), phrase };
}

function meanShares(energyCurves) {
  const shares = new Float32Array(7);
  const n = energyCurves.n || 0;
  if (!energyCurves.bands || n < 1) {
    shares.fill(1 / 7);
    return shares;
  }
  const sums = new Float64Array(7);
  const physical = energyCurves.rmsBands;
  for (let i = 0; i < n; i++) {
    for (let b = 0; b < 7; b++) sums[b] += physical ? Math.max(0, physical[b][i] || 0) ** 2 : Math.max(0, energyCurves.bands[b][i] || 0);
  }
  let tot = 0;
  for (let b = 0; b < 7; b++) tot += sums[b];
  if (tot < 1e-9) {
    shares.fill(1 / 7);
    return shares;
  }
  for (let b = 0; b < 7; b++) shares[b] = sums[b] / tot;
  return shares;
}

function smoothSpine(wave) {
  let s = wave;
  for (let p = 0; p < SPINE_SMOOTH_PASSES; p++) s = boxBlur(s, 3);
  return s;
}

/**
 * Compact, stable reading of a song. Returns null when there isn't enough
 * signal to hang a range on — callers fall back to seeded geology.
 *
 * @param {import('../audio/EnergyCurves.js').EnergyCurves|null} energyCurves
 * @param {number} durationMs
 * @param {{startMs:number,endMs:number}|null} window restrict the read to
 *   one span of the song (a section's own timeline) instead of the whole
 *   track. Omitted (the default) is byte-identical to a whole-song read.
 */
export function extractRidgePortrait(energyCurves, durationMs, window = null) {
  if (!energyCurves || !(durationMs > 1000)) return null;
  if (!energyCurves.bands || !(energyCurves.n >= 8)) return null;

  const winStart = window ? Math.max(0, window.startMs) : 0;
  const winEnd = window ? Math.min(durationMs, window.endMs) : durationMs;
  const winDur = Math.max(1, winEnd - winStart);

  const shares = meanShares(energyCurves);
  const wave = sampleEnergyWave(energyCurves, durationMs, PORTRAIT_SAMPLES, window);
  const rawLandmarks = findLandmarks(wave);
  const hasSampleAll = typeof energyCurves.sampleAll === 'function';

  let waveLo = Infinity, waveHi = -Infinity;
  for (let i = 0; i < wave.length; i++) {
    if (wave[i] < waveLo) waveLo = wave[i];
    if (wave[i] > waveHi) waveHi = wave[i];
  }
  const waveSpan = waveHi - waveLo;

  const landmarks = rawLandmarks.map((lm) => {
    const t01 = lm.i / Math.max(1, wave.length - 1);
    const tMs = winStart + t01 * winDur;
    const bands = hasSampleAll ? energyCurves.sampleAll(tMs) : null;
    return {
      t01,
      energy: lm.energy,
      prominence: lm.prominence,
      brightness: bands ? brightnessOf(bands) : 0.5,
      attack: landmarkAttack(wave, lm.i, waveSpan),
      width01: landmarkWidth01(wave, lm.i),
    };
  });

  let dyn = 0.4;
  if (typeof energyCurves.calibration === 'function') {
    const cal = energyCurves.calibration(FLAT_WEIGHTS);
    dyn = clamp01((cal?.spread ?? 0.2) / 0.5);
  }

  const phrase = phrasePeriod(wave);
  const lithology = lithologyFromShares(shares);
  // How much music this portrait was read from, in seconds. Landmarks are
  // stored as t01 (a fraction of the read), which on its own says nothing
  // about PACE -- two landmarks 0.1 apart are four seconds apart in a 40s
  // verse and forty in the whole song. Carrying the span is what lets
  // composeAlpinePeaks lay the range out at the rate the listener actually
  // travels it (see `timeline` there).
  const windowSec = winDur / 1000;
  const bassShare = lithology.basement;
  const bodyShare = lithology.body;
  const edgeShare = lithology.edge;
  const airShare = lithology.air;

  return {
    shares,
    centroid01: centroid01(shares),
    spread01: herfindahlSpread01(shares),
    bassShare,
    bodyShare,
    edgeShare,
    airShare,
    lithology,
    dynamicRange: dyn,
    windowSec,
    landmarks,
    phrasePeriod01: phrase.period01,
    phraseStrength: phrase.strength,
    phraseWave: phrase.phrase,
    energyWave: wave,
    spine: smoothSpine(wave),
  };
}

function sampleLoop(arr, u) {
  if (!arr || arr.length === 0) return 0;
  const n = arr.length;
  const x = ((u % 1) + 1) % 1 * n;
  const i0 = Math.floor(x) % n;
  const i1 = (i0 + 1) % n;
  const f = x - Math.floor(x);
  return arr[i0] * (1 - f) + arr[i1] * f;
}

/** 0..1 spine height at strip-normalized x. Tiny on purpose — a family
 *  resemblance under the named summits, not a second skyline. */
export function spineAt(portrait, u01, amp = 0.08) {
  if (!portrait?.spine) return 0;
  return amp * sampleLoop(portrait.spine, u01);
}

/** Phrase-shaped undulation for the nearest rolling hills. */
export function phraseAt(portrait, u01) {
  if (!portrait?.phraseWave || portrait.phraseWave.length < 4) return 0;
  return sampleLoop(portrait.phraseWave, u01);
}

function resolveCollisions(placed, minSep) {
  // A few relaxation passes: the less prominent peak yields. Drop a peak
  // that still collides after being pushed to the margin — better fewer
  // readable summits than a hairball.
  const out = placed.map((p) => ({ ...p }));
  out.sort((a, b) => a.u - b.u);
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < out.length; i++) {
      const gap = out[i].u - out[i - 1].u;
      if (gap >= minSep) continue;
      const push = (minSep - gap) / 2 + 0.002;
      if (out[i].prominence <= out[i - 1].prominence) {
        out[i].u = Math.min(1 - MARGIN, out[i].u + push);
      } else {
        out[i - 1].u = Math.max(MARGIN, out[i - 1].u - push);
      }
    }
    out.sort((a, b) => a.u - b.u);
  }
  const kept = [];
  for (const p of out) {
    if (kept.length && p.u - kept[kept.length - 1].u < minSep * 0.72) {
      if (p.prominence > kept[kept.length - 1].prominence) kept[kept.length - 1] = p;
      continue;
    }
    kept.push(p);
  }
  return kept;
}

/**
 * Coverage pass for a TILING strip: insert subordinate summits until no
 * circular gap exceeds `maxGap`. Distinct from fillGaps above, which fills
 * to a peak COUNT and so happily leaves a range bunched in one half of the
 * tile. Gaps are measured around the wrap (the last summit's gap to the
 * first crosses the seam), because a scrolling tile has no first or last.
 */
function fillWideGaps(placed, maxGap, rand) {
  const out = placed.slice();
  let guard = 0;
  while (guard++ < 24) {
    out.sort((a, b) => a.u - b.u);
    if (out.length === 0) break;
    // Circular gaps: the pair (last, first) wraps across the tile seam.
    let bestGap = -1, bestAt = 0.5, parent = out[0];
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      const b = out[(i + 1) % out.length];
      const gap = i === out.length - 1 ? (b.u + 1) - a.u : b.u - a.u;
      if (gap > bestGap) {
        bestGap = gap;
        bestAt = ((a.u + gap / 2) % 1 + 1) % 1;
        parent = a.prominence >= b.prominence ? a : b;
      }
    }
    if (bestGap <= maxGap) break;
    // Split the gap OFF-CENTRE, hard. Repeatedly halving the widest gap is
    // an even subdivision, and evenly-spaced summits of similar size read
    // as a picket fence just as badly as random ones read as noise -- it
    // was the first thing wrong with this pass once coverage was fixed.
    // A wide asymmetric split lets clusters and passes emerge instead: the
    // rhythm real ranges have.
    const frac = 0.26 + rand() * 0.48;
    const at = ((parent === undefined ? bestAt : bestAt - bestGap / 2 + bestGap * frac) % 1 + 1) % 1;
    out.push({
      ...parent,
      u: at,
      // Wide spread of subordinate heights, so neighbouring fills never
      // read as a repeated tooth.
      prominence: parent.prominence * (0.22 + rand() * 0.42),
      width01: clamp01((parent.width01 ?? 0.2) * (0.55 + rand() * 0.9)),
      fill: true,
    });
  }
  return out;
}

function fillGaps(placed, need, rand, minSep) {
  const out = placed.slice();
  let guard = 0;
  while (out.length < need && guard++ < 24) {
    out.sort((a, b) => a.u - b.u);
    let bestGap = 0, bestAt = 0.5, left = null, right = null;
    const edges = [{ u: MARGIN, prominence: 0, energy: 0.3, brightness: 0.5, attack: 0, width01: 0.12 }, ...out, { u: 1 - MARGIN, prominence: 0, energy: 0.3, brightness: 0.5, attack: 0, width01: 0.12 }];
    for (let i = 1; i < edges.length; i++) {
      const gap = edges[i].u - edges[i - 1].u;
      if (gap > bestGap) {
        bestGap = gap;
        bestAt = (edges[i].u + edges[i - 1].u) / 2;
        left = edges[i - 1];
        right = edges[i];
      }
    }
    if (bestGap < minSep * 1.6) break;
    const jitter = (rand() - 0.5) * Math.min(0.04, bestGap * 0.2);
    const parent = (left && right)
      ? (left.prominence >= right.prominence ? left : right)
      : (left || right);
    out.push({
      u: clamp(bestAt + jitter, MARGIN, 1 - MARGIN),
      energy: (parent?.energy ?? 0.4) * (0.42 + rand() * 0.18),
      prominence: (parent?.prominence ?? 0.2) * (0.32 + rand() * 0.18),
      brightness: parent?.brightness ?? 0.5,
      attack: (rand() - 0.5) * 0.6,
      width01: (parent?.width01 ?? 0.12) * (0.7 + rand() * 0.25),
      fill: true,
    });
  }
  return out;
}

// A tile may stand for at most this many traversals of the read window.
// Past it the summits of a long section fold over each other faster than
// collision resolution can keep them legible, and the range stops reading
// as a place and starts reading as a texture.
const MAX_LAPS = 6;
// How far a summit's width may be pulled toward the duration of the event
// it stands for, relative to the rest of the range, and how far that pull
// may ever move it from the landform's own register.
const TIME_WIDTH_MIX = 0.55;
const TIME_WIDTH_MIN_MUL = 0.55;
const TIME_WIDTH_MAX_MUL = 1.85;

/**
 * How many times a layer's tile scrolls past during the span of music the
 * portrait was read from.
 *
 * The strips tile and scroll forever, so a layer has a natural musical
 * duration nothing in the old code ever used: the time it takes one tile
 * to travel one tile-width at that layer's own parallax rate (`spanSec`).
 * At 220 px/s and the parallax ratios in BiomeManager that is ~93 s for
 * the far massif, ~52 s for the mid range, ~31 s for the near range and
 * ~14 s for the foothills -- which is, near enough, one song, one section,
 * one passage and one phrase. Dividing the read window by that gives the
 * whole number of traversals the tile should stand for, and therefore the
 * scale at which the range is drawn.
 *
 * Rounding to a whole number (rather than taking the ratio literally) is
 * what keeps the wrap musical: the tile always holds an exact 1/laps of
 * the window, so the seam falls on the same point of the music every lap
 * instead of drifting through it.
 */
export function layerLaps(windowSec, spanSec, maxLaps = MAX_LAPS) {
  if (!(windowSec > 0) || !(spanSec > 0)) return 1;
  return clamp(Math.round(windowSec / spanSec), 1, maxLaps);
}

/** The tile's own time base for a layer: how many traversals of the
 *  portrait's window it stands for, and how many strip pixels one second
 *  of that music occupies. `pxPerSec` is the layer's scroll rate, so
 *  `pxPerMusicSec` lands within a rounding of it -- which is the whole
 *  point: the range plays back at roughly the speed you travel it. */
export function layerTimeBase(portrait, timeline, width) {
  const pxPerSec = timeline?.pxPerSec;
  const windowSec = portrait?.windowSec;
  if (!(pxPerSec > 0) || !(windowSec > 0) || !(width > 0)) return null;
  const laps = layerLaps(windowSec, width / pxPerSec);
  return { laps, windowSec, pxPerMusicSec: (width * laps) / windowSec };
}

/**
 * Compose a mountain-range peak list from a portrait. Same `{x,h,w}` shape
 * alpineHeightField already consumes. `cfg` is an ALPINE_CHARACTERS entry
 * (passed in to avoid a circular import).
 *
 * With a `timeline` ({pxPerSec}), placement is a TIMELINE: a landmark sits
 * at the fraction of the tile its moment occupies in the music, at the rate
 * the layer scrolls, so the gaps between summits are the gaps between
 * events. Two hits four seconds apart are four seconds of walking apart.
 * The strip scrolls right-to-left, so larger x is later music -- the
 * skyline ahead of you is the music ahead of you.
 *
 * Without one (tests, callers with no scroll rate) it falls back to the
 * older behaviour: relative order and spacing preserved, but stretched to
 * fill the tile and centred on the song's energy-weighted mass.
 */
export function composeAlpinePeaks({
  portrait, cfg, layerKey = 'L2', seed, width, timeline = null,
}) {
  const role = LAYER_ROLES[layerKey] || LAYER_ROLES.L2;
  const rand = mulberry32((seed ^ 0xc0de) >>> 0 || 1);
  const lms = portrait?.landmarks?.slice() || [];
  lms.sort((a, b) => b.prominence - a.prominence);

  const want = clamp(
    Math.round(Math.max(role.minPeaks, Math.min(role.maxPeaks, lms.length * role.take + (portrait?.centroid01 ?? 0.5) * 1.2))),
    role.minPeaks,
    role.maxPeaks,
  );
  const taken = lms.slice(0, Math.max(1, Math.min(lms.length, Math.max(want, role.minPeaks))));

  // Mass centre of the song's energy landmarks: back-loaded songs sit
  // their king slightly right of centre, front-loaded slightly left.
  // Never dead-centre — that was the bland part of the old generator.
  let mass = 0, massW = 0;
  for (const lm of taken) {
    const w = Math.max(0.05, lm.energy);
    mass += lm.t01 * w;
    massW += w;
  }
  const massCenter = massW > 0 ? mass / massW : 0.5;
  const kingU = lerp(0.36, 0.64, clamp01(massCenter));
  // Per-biome / per-layer slide: the genome stays the same (relative
  // spacing, king identity) but the composition isn't stamped identically
  // onto every range. Small on purpose — enough that TWILIGHT and EMBER
  // don't share a stencil, not enough to scramble the song's architecture.
  const slide = (rand() - 0.5) * 0.06;

  if (taken.length === 0) return [];

  const timeBase = layerTimeBase(portrait, timeline, width);

  const times = taken.map((lm) => lm.t01);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const span = Math.max(0.18, tMax - tMin);
  const usable = 1 - 2 * MARGIN;
  const king = taken.reduce((a, b) => (b.prominence > a.prominence ? b : a), taken[0]);
  // Two readings of a landmark's moment. The timed one is a real map: one
  // lap of the tile IS one 1/laps slice of the window, so the interval
  // between two summits is the interval between two events, unstretched.
  // The untimed one is the older normalize-to-fill fallback -- it keeps
  // ORDER but throws the pacing away, because it rescales whatever span the
  // landmarks happen to occupy out to the full tile.
  const uRaw = timeBase
    ? (t) => t * timeBase.laps
    : (t) => MARGIN + ((t - tMin) / span) * usable;
  // The scroll phase of a tile is not synced to the song (nothing anchors
  // worldX to a bar), so absolute position carries no musical information --
  // only the intervals do. That makes the king-centring and the per-biome
  // slide free to keep doing their job on the timed path too: separating
  // the four stacked ranges, which would otherwise sit summit-over-summit
  // at scroll 0 wherever two layers landed on the same lap count.
  const shift = timeBase
    ? role.phase + slide
    : kingU - uRaw(king.t01) + role.phase + slide;

  // WRAP, don't clamp. The strip tiles and scrolls forever, so there is no
  // privileged "frame" to compose inside -- every x is equally likely to be
  // the one on screen. Clamping was actively harmful: `shift` slides the
  // whole composition to put the king at kingU, and clamping then piled
  // every summit that fell outside [MARGIN, 1-MARGIN] onto one edge and
  // left the opposite side of the tile empty. That empty side is the long
  // dead-flat stretch the rendered field showed across ~40% of every tile.
  // Wrapping preserves the song's relative spacing AND keeps the whole
  // tile occupied.
  const wrap01 = (v) => ((v % 1) + 1) % 1;
  const placed = taken.map((lm) => ({
    ...lm,
    u: wrap01(uRaw(lm.t01) + shift + (rand() - 0.5) * 0.02),
  }));

  const minSep = layerKey === 'L2' ? 0.075 : layerKey === 'L3' ? 0.055 : 0.038;
  let resolved = resolveCollisions(placed, minSep);
  if (resolved.length < want) resolved = fillGaps(resolved, want, rand, minSep);
  // Coverage, not just count: fillGaps above stops the moment it has `want`
  // summits, which let a range call itself finished with every one of them
  // crowded into one half of the tile. A range has to actually span the
  // strip, so any remaining gap wider than maxGap gets a subordinate
  // summit -- these are geological extras (`fill`), already scored down to
  // 0.62 height below, so coverage never costs the song's own landmarks
  // their prominence.
  const maxGap = layerKey === 'L2' ? 0.30 : layerKey === 'L3' ? 0.24 : 0.18;
  resolved = fillWideGaps(resolved, maxGap, rand);
  resolved = resolveCollisions(resolved, minSep);

  const maxProm = Math.max(...resolved.map((p) => p.prominence), 1e-6);
  const dyn = portrait?.dynamicRange ?? 0.4;
  // Flat songs bunch heights (0.68–0.92); dynamic ones get a real 0.50–1.0.
  const hLo = lerp(0.68, 0.50, dyn);
  const hHi = lerp(0.90, 1.00, dyn);
  const bass = portrait?.bassShare ?? 0.3;
  const centroid = portrait?.centroid01 ?? 0.5;
  const widthBias = lerp(1.22, 0.82, centroid) * role.widthMul;
  // The range's own middling event length, so durations are read as
  // proportions of each other rather than as absolute seconds.
  const eventWs = resolved.map((p) => clamp01(p.width01 ?? 0)).sort((a, b) => a - b);
  const medianEventW = eventWs.length ? eventWs[eventWs.length >> 1] : 0;

  const peaks = resolved.map((p, idx) => {
    const isKing = p.prominence >= maxProm * 0.97 && idx === resolved.findIndex((q) => q.prominence >= maxProm * 0.97);
    const rel = clamp01(p.prominence / maxProm);
    // Fill peaks (geological extras) stay subordinate so they don't compete
    // with the song's actual landmarks.
    const fillMul = p.fill ? 0.62 : 1;
    let h = lerp(hLo, hHi, Math.pow(rel, 0.72)) * role.heightMul * fillMul;
    if (isKing) h = Math.max(h, lerp(0.92, 0.98, dyn));
    h = clamp(h, 0.42, 1);

    const eventW = clamp01(p.width01);
    // Bright landmarks (presence/air) are thinner spires; dark/bass ones
    // are bulky. A long chorus is a broad mountain, a sharp drop is a horn.
    const brightMul = lerp(1.18, 0.78, clamp01(p.brightness));
    let w = (cfg.wBase + eventW * cfg.wSpan) * widthBias * brightMul;
    // How long the event LASTS, against the other events in this range.
    // width01 is the landmark's own half-power duration, so the ratio to
    // the range's median duration says "this one is twice the event that
    // one was" -- and that is the part worth drawing. The ABSOLUTE duration
    // is not: a landmark of a whole-song read can be twenty seconds long,
    // which at any honest scale is a summit wider than the tile. Keeping
    // the character's register and spending the timing on proportion gives
    // the thing no static width can -- a long chorus takes visibly longer
    // to walk past than a one-bar stab -- without a crags layer having to
    // stop being crag-scale to say it.
    if (medianEventW > 1e-4) {
      const rel = clamp(eventW / medianEventW, 0.25, 4);
      w *= clamp(lerp(1, rel, TIME_WIDTH_MIX), TIME_WIDTH_MIN_MUL, TIME_WIDTH_MAX_MUL);
    }
    if (isKing) w = Math.max(w, cfg.wBase * (1.22 + bass * 0.35));
    w = Math.max(28, w);

    const lean = 1 + cfg.asym * clamp(p.attack, -1, 1) * 0.9;
    return {
      x: p.u * width,
      h,
      w,
      wL: w * lean,
      wR: w / Math.max(0.35, lean),
      // The landmark's attack -- how much steeper its rise was than its
      // fall. Carried onto the peak because it is the one thing that says
      // which FACE the mountain shows you: a drop rises out of nothing and
      // decays, so its headwall faces the way you are travelling. Until now
      // this only ever set wL/wR, which nothing downstream read.
      attack: clamp(p.attack ?? 0, -1, 1),
      king: isKing,
    };
  });

  // The tile's time map, carried on the peak list so anything else drawn
  // into the same tile can agree with it. The spine (the song's own
  // smoothed energy, laid under the summits as a family resemblance) is
  // read at portrait u, and would drift out of step with its own summits
  // the moment the summits were placed on a lap-scaled clock -- the low
  // ground would swell where the music was quiet and the summits stood
  // somewhere else entirely.
  peaks.timeMap = timeBase ? { laps: timeBase.laps, shift } : null;

  // Guarantee a king even if prominence ties.
  if (peaks.length && !peaks.some((p) => p.king)) {
    let best = 0;
    for (let i = 1; i < peaks.length; i++) if (peaks[i].h > peaks[best].h) best = i;
    peaks[best].king = true;
    peaks[best].h = Math.max(peaks[best].h, 0.94);
  }
  return peaks;
}

/**
 * Weathering + lithology for a layer. Bass lifts the connecting bed and
 * the apron cap (high saddles — an altiplano). Air/edge add couloirs and
 * arete teeth — scaled down from the old constants so the named summits
 * actually read. `litho` and `profileMix` are what alpineHeightField
 * uses to blend the song's three-term flank onto the landform type.
 */
export function layerWeathering(portrait, cfg, layerKey = 'L2') {
  const role = LAYER_ROLES[layerKey] || LAYER_ROLES.L2;
  const litho = layerLithology(portrait?.lithology || lithologyFromShares(portrait?.shares), layerKey);
  const basement = litho.basement;
  const edge = litho.edge;
  const air = litho.air;
  const crest = litho.crest;
  const spread = portrait?.spread01 ?? 0.5;
  return {
    notch: cfg.notch * role.notchMul * (0.38 + 0.85 * edge),
    teeth: cfg.teeth * role.teethMul * (0.28 + 0.90 * air + 0.12 * spread),
    bed: cfg.bed * (0.70 + 0.95 * basement),
    apronGain: cfg.apronGain * (0.85 + 0.42 * basement),
    apronCap: clamp(cfg.apronCap + basement * 0.20 - crest * 0.14, 0.36, 0.64),
    apronSpread: clamp(cfg.apronSpread + basement * 0.50 - edge * 0.28, 1.8, 3.4),
    spineAmp: role.spineAmp,
    profileMix: role.profileMix ?? 0.55,
    litho,
  };
}

/**
 * Seeded fallback when there's no portrait (tests, missing curves). Dart-
 * throwing instead of even spacing so the no-music path isn't a picket
 * fence either; the king is the tallest peak, not the centre one.
 */
export function seedPeaks(cfg, seed, width) {
  const rand = mulberry32((seed ^ 0xa1b1) >>> 0 || 1);
  const nPeaks = cfg.peakMin + Math.floor(rand() * cfg.peakSpan);
  const minSep = 0.52 / Math.max(1, nPeaks);
  const us = [];
  let attempts = 0;
  while (us.length < nPeaks && attempts < 100) {
    attempts++;
    const u = MARGIN + rand() * (1 - 2 * MARGIN);
    if (us.every((v) => Math.abs(v - u) >= minSep)) us.push(u);
  }
  if (us.length < nPeaks) {
    for (let i = us.length; i < nPeaks; i++) us.push(MARGIN + ((i + 0.5) / nPeaks) * (1 - 2 * MARGIN));
  }
  us.sort((a, b) => a - b);

  const peaks = us.map((u) => {
    const w = cfg.wBase + rand() * cfg.wSpan;
    const lean = 1 + (rand() * 2 - 1) * cfg.asym;
    return {
      x: clamp01(u) * width,
      h: 0.52 + rand() * 0.38,
      w,
      wL: w * lean,
      wR: w / lean,
      // No song, no attack: these summits take the range's regional dip,
      // which is the only grain a seeded fallback has to offer.
      attack: 0,
      king: false,
    };
  });
  let best = 0;
  for (let i = 1; i < peaks.length; i++) if (peaks[i].h > peaks[best].h) best = i;
  const main = peaks[best];
  main.h = Math.max(main.h, 0.94 + rand() * 0.06);
  const kingW = Math.max(main.w, cfg.wBase * (1.25 + rand() * 0.4));
  const kingLean = 1 + (rand() * 2 - 1) * cfg.asym;
  main.w = kingW;
  main.wL = kingW * kingLean;
  main.wR = kingW / kingLean;
  main.king = true;
  return peaks;
}
