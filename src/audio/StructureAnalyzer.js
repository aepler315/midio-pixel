// Song structure from a beat-synchronous self-similarity matrix.
//
// What this replaces: the schedule builder in BiomeManager._buildSchedule
// measured novelty as the Euclidean distance between a 4-point trailing mean
// of seven band energies and the same mean four points earlier, and labelled
// the resulting sections by greedily clustering that same 7-band shape
// (SongForm.analyzeSongForm). Band energy is a timbre proxy and nothing else,
// so a verse and a chorus sharing an arrangement were indistinguishable, and
// nothing in the pipeline ever looked at harmony at all.
//
// What this does instead is the textbook pair:
//   * boundaries  -- Foote novelty: correlate a checkerboard kernel down the
//     diagonal of a self-similarity matrix. It answers "does the music before
//     this instant resemble itself, does the music after resemble itself, and
//     do the two halves resemble each other?", which is what a section
//     boundary actually IS. A trailing-mean difference can only see a jump in
//     level.
//   * labels -- a time-lag matrix: a chorus is not "material with a similar
//     average spectrum", it is "material that literally recurs". Scoring
//     diagonals of the SSM finds the repeats directly.
//
// The features are chroma (pitch class, transposition-aware harmony) fused
// with the seven band energies (timbre). Chroma is weighted higher because
// harmony is what separates sections that share a texture.
//
// Costs nothing extra to run: PitchTracker.computePitchFeatures already runs
// the FFT over the whole song for melody/bass tracking, and its per-frame
// semitone energies fold straight into chroma. Pure and DOM-free -- it takes
// plain arrays, so it is directly testable.
import { SEMITONE_LO } from './PitchTracker.js';
import { throwIfAborted } from './loadLimits.js';
import { createYielder } from '../utils/yieldToMain.js';
import { clamp, clamp01 } from '../utils/math.js';

// Checkerboard kernel half-width, in analysis steps (bars, or ~2s slices when
// there is no bar grid). 4 bars either side = an 8-bar view, which is the
// scale real pop/rock sections change on.
const KERNEL_RADIUS = 4;
// A second, finer scale for the boundary hunt: half the radius, so a passage
// too short to register at the coarse scale (a breakdown, a short bridge)
// still produces a candidate. It never promotes a cut into the main
// (min-gap-constrained) schedule -- see `fineBoundariesMs` -- it only stops
// such a passage from being silently erased.
const FINE_KERNEL_RADIUS = Math.max(2, Math.round(KERNEL_RADIUS / 2));
// Gaussian taper on the kernel: an abrupt-edged checkerboard rings and
// produces satellite peaks beside every real boundary.
// Feature fusion. Harmony carries more of the "is this the same section"
// signal than texture does, but texture is what catches a drop or a
// breakdown that stays on the same chords. Dynamics (overall level, not
// shape) is its own signal again: two moments can share identical harmony
// and timbral shape while differing enormously in loudness (a verse dropping
// to just vocal+bass, then the band re-entering), and L2-normalizing chroma
// and timbre on their own throws that away entirely.
//
// These are applied as sqrt(weight) on each block AFTER each block is
// independently unit-normalized, not as weight directly. Cosine similarity
// of the concatenation squares whatever scalar sits in front of a
// unit-normalized block, so naive `w * block` weights of 0.65/0.35 actually
// contribute similarity in a 0.65^2 : 0.35^2 (~77.5% : 22.5%) ratio, not the
// intended one. Because sqrt(w)^2 = w, and because orthogonal unit blocks
// scaled by sqrt(w) each land at unit-norm-times-sqrt(w), the resulting
// fused-vector cosine equals CHROMA_WEIGHT*cosChroma + TIMBRE_WEIGHT*cosTimbre
// + DYNAMICS_WEIGHT*cosDynamics exactly, with no cross term -- a genuine
// linear mixture of the three similarities, weighted as configured.
const CHROMA_WEIGHT = 0.55, TIMBRE_WEIGHT = 0.30, DYNAMICS_WEIGHT = 0.15;
// Repetition labelling: two segments are the same material when their mean
// cross-similarity clears a threshold. Deliberately strict -- a false merge
// makes a verse wear the chorus's biome, which reads far worse than a missed
// repeat.
//
// This is the FALLBACK value. It used to be the only value, and a flat
// cosine cutoff is the wrong shape for the question, because how similar two
// DIFFERENT sections look depends on how much timbral and harmonic contrast
// the arrangement has at all. Measured on a fixed A-B-A-C form with the
// contrast between its classes swept: above ~0.8 contrast the read is correct,
// and below it every pairwise similarity is squeezed above 0.82 and the whole
// song collapses to a SINGLE label -- one biome, start to finish, with the
// form invisible. That is not an exotic input; a track built on one synth
// patch, an acoustic singer-songwriter take, or a lo-fi loop lives there.
//
// So the cutoff is placed against the song's OWN distribution of segment
// similarities instead (see `repeatThresholdFor`), and this constant now
// serves only the cases where that distribution can't be estimated.
export const REPEAT_THRESHOLD = 0.82;
// The fallback quantile when the distribution has no obvious repeat/nonrepeat
// split. A high tail is the conservative choice: a form label should be
// earned by resemblance, not merely by being less unlike than a noisy outlier.
const REPEAT_LEVEL = 0.75;
// Fewer pairs than this and there is no distribution to speak of -- two
// segments give exactly one similarity, whose min and max are the same
// number, which would merge them unconditionally. Fall back to the absolute
// cutoff there.
const REPEAT_MIN_PAIRS = 3;
// A similarity range narrower than this means the song genuinely has one
// texture: every pair is alike, and the peaks in that range are noise rather
// than form. Stretching THAT to full scale manufactures repeats out of
// nothing, so fall back to the absolute cutoff -- the same guard, and the
// same reasoning, as EnergyCurves.FLAT_SPREAD_MIN.
const REPEAT_SPREAD_MIN = 0.02;
// Hard floor on what may ever be called "the same material". A
// through-composed piece has no repeats at all, and its own range tops out
// low; without this its least-dissimilar pair would still be promoted to a
// repeat purely for being the best of a bad lot.
const REPEAT_ABS_MIN = 0.5;
// A gap must be meaningful in both absolute and distribution-relative terms
// before it is trusted as the divide between unrelated material and repeats.
const REPEAT_GAP_MIN = 0.025;
// Ceiling on the confidence of a read that produced a single section, i.e.
// found no boundaries at all. Must sit below BiomeManager's
// SSM_CONFIDENCE_FLOOR so such a read can never win over the energy path.
export const NO_STRUCTURE_CONFIDENCE = 0.2;
// Below this many analysis points the SSM is too small for a checkerboard
// kernel to mean anything; the caller should fall back.
const MIN_POINTS = 3 * KERNEL_RADIUS;

/** L2-normalize in place; a zero vector is left alone (silence stays silent
 *  rather than becoming an arbitrary unit direction). */
function l2normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n > 1e-9) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 1e-9 ? clamp(dot / d, -1, 1) : 0;
}

/**
 * Average PitchTracker frames over [fromMs, toMs) and fold to 12 pitch
 * classes. Folding by pitch class (rather than keeping absolute semitones)
 * is what makes a chorus match its earlier self even when it was voiced an
 * octave apart the second time.
 */
export function chromaBetween(features, fromMs, toMs) {
  const out = new Float64Array(12);
  if (!features || !features.frames || features.frames.length === 0) return out;
  const { rate, frames } = features;
  const i0 = clamp(Math.floor((fromMs / 1000) * rate), 0, frames.length - 1);
  const i1 = clamp(Math.ceil((toMs / 1000) * rate), i0 + 1, frames.length);
  for (let i = i0; i < i1; i++) {
    const semis = frames[i];
    for (let s = 0; s < semis.length; s++) {
      if (semis[s] > 0) out[(((SEMITONE_LO + s) % 12) + 12) % 12] += semis[s];
    }
  }
  return l2normalize(out);
}

// Samples averaged per interval for the timbre block. A single midpoint
// sample can miss a drum entry, fill, or brief texture shift depending
// entirely on where it happens to land inside the interval; averaging a few
// points across the whole span catches it regardless of position.
const TIMBRE_SAMPLES_PER_POINT = 4;

/** Average the seven band energies across [from, to) rather than sampling
 *  once at the midpoint. Returns the RAW (unnormalized) mean -- callers
 *  decide separately whether to keep or discard its magnitude. */
function averageBands(energyCurves, from, to, samples = TIMBRE_SAMPLES_PER_POINT) {
  const acc = new Float64Array(7);
  const n = Math.max(1, samples);
  const span = Math.max(1, to - from);
  for (let s = 0; s < n; s++) {
    const t = from + ((s + 0.5) / n) * span;
    const physical = energyCurves.rmsBands && typeof energyCurves.sampleRms === 'function';
    const v = physical ? null : energyCurves.sampleAll(t);
    // Measured filter-bank power is comparable across bands. Activity is
    // retained only for MIDI/generated curves with no physical envelope.
    for (let k = 0; k < 7; k++) acc[k] += physical ? energyCurves.sampleRms(k,t) ** 2 : v[k];
  }
  for (let k = 0; k < 7; k++) acc[k] /= n;
  return acc;
}

const CHROMA_SCALE = Math.sqrt(CHROMA_WEIGHT);
const TIMBRE_SCALE = Math.sqrt(TIMBRE_WEIGHT);
const DYNAMICS_SCALE = Math.sqrt(DYNAMICS_WEIGHT);

/**
 * Build the fused per-point feature vectors: 12 chroma ⊕ 7 timbre (shape)
 * ⊕ 2 dynamics (level). Chroma and timbre are each independently
 * unit-normalized so one can't drown the other by happening to have a
 * larger scale, exactly as before; dynamics is the piece that block-level
 * normalization removes, recovered as its own small channel instead of
 * being thrown away.
 *
 * Dynamics is encoded as a point on a quarter-circle arc (level -> angle in
 * [0, pi/2]) rather than as a raw scalar, so that plain cosine similarity
 * -- the same operation used for chroma and timbre -- reads it correctly:
 * two equal levels land on the same point (similarity 1), and similarity
 * falls off monotonically as the levels diverge, with no wraparound to
 * worry about across so narrow a range.
 */
function* featureSteps(pointsMs, features, energyCurves, durationMs = null) {
  const rawLevels = new Float64Array(pointsMs.length);
  const timbreDirs = [];
  let maxLevel = 0;
  for (let i = 0; i < pointsMs.length; i++) {
    const from = pointsMs[i];
    const to = i + 1 < pointsMs.length ? pointsMs[i + 1] : Math.max(from + 1, durationMs ?? from + 2000);
    const raw = energyCurves ? averageBands(energyCurves, from, to) : new Float64Array(7);
    let level = 0;
    for (let k = 0; k < 7; k++) level += raw[k];
    rawLevels[i] = level;
    if (level > maxLevel) maxLevel = level;
    timbreDirs.push(l2normalize(raw));
    yield;
  }

  const out = [];
  for (let i = 0; i < pointsMs.length; i++) {
    const from = pointsMs[i];
    const to = i + 1 < pointsMs.length ? pointsMs[i + 1] : Math.max(from + 1, durationMs ?? from + 2000);
    const chroma = chromaBetween(features, from, to);
    const timbre = timbreDirs[i];
    // No energy data at all -> no dynamics signal, matching the old
    // behavior of contributing nothing rather than manufacturing a level.
    const level01 = energyCurves && maxLevel > 1e-9 ? rawLevels[i] / maxLevel : 0;
    const angle = energyCurves ? level01 * (Math.PI / 2) : 0;
    const dynScale = energyCurves ? DYNAMICS_SCALE : 0;

    const v = new Float64Array(21);
    for (let k = 0; k < 12; k++) v[k] = chroma[k] * CHROMA_SCALE;
    for (let k = 0; k < 7; k++) v[12 + k] = timbre[k] * TIMBRE_SCALE;
    v[19] = Math.cos(angle) * dynScale;
    v[20] = Math.sin(angle) * dynScale;
    // Zero harmonic/timbre content is unknown, including a silent frame
    // whose dynamics encoding otherwise contributes cos(0).
    if (!chroma.some(x => x > 0) && !timbre.some(x => x > 0)) v.fill(0);
    out.push(v);
    yield;
  }
  return out;
}

function finishSteps(iterator) {
  let step;
  do { step = iterator.next(); } while (!step.done);
  return step.value;
}

function buildFeatures(...args) { return finishSteps(featureSteps(...args)); }

/** Cosine similarity with the chroma block circularly rotated before it is
 * compared. The other feature blocks (timbre and dynamics) stay fixed. */
function transpositionInvariantCosine(a, b, chromaLength) {
  let na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom <= 1e-9) return 0;

  let best = -Infinity;
  for (let shift = 0; shift < chromaLength; shift++) {
    let dot = 0;
    for (let i = 0; i < chromaLength; i++) dot += a[i] * b[(i + shift) % chromaLength];
    for (let i = chromaLength; i < a.length; i++) dot += a[i] * b[i];
    best = Math.max(best, dot / denom);
  }
  return clamp(best, -1, 1);
}

/**
 * Self-similarity matrix over fused features. Boundary novelty uses the
 * default absolute-pitch matrix (a modulation can be a real section turn),
 * while repeat labelling may ask for an octave/transposition-invariant chroma
 * comparison so a returned chorus shifted up a key still keeps its identity.
 */
function* similaritySteps(feats, { chromaLength = 0, transpositionInvariant = false } = {}) {
  const n = feats.length;
  const S = Array.from({ length: n }, () => new Float64Array(n));
  const rotateChroma = transpositionInvariant && chromaLength > 1;
  for (let i = 0; i < n; i++) {
    S[i][i] = feats[i].some(x => x !== 0) ? 1 : 0;
    for (let j = i + 1; j < n; j++) {
      const s = rotateChroma
        ? transpositionInvariantCosine(feats[i], feats[j], chromaLength)
        : cosine(feats[i], feats[j]);
      S[i][j] = s;
      S[j][i] = s;
    }
    yield;
  }
  return S;
}

export function selfSimilarity(...args) { return finishSteps(similaritySteps(...args)); }

/**
 * Foote novelty: slide a Gaussian-tapered checkerboard kernel down the SSM's
 * diagonal. The kernel's positive quadrants sit on "past vs past" and "future
 * vs future"; its negative quadrants on "past vs future". A high response
 * means both sides are internally coherent AND unlike each other -- a
 * boundary. Edges are zeroed rather than padded: half a kernel of real data
 * produces a meaningless (and usually huge) response.
 */
export function footeNovelty(S, radius = KERNEL_RADIUS) {
  const n = S.length;
  const nov = new Float64Array(n);
  if (n < 2 * radius + 1) return nov;

  const size = 2 * radius;
  const sigma = Math.max(1e-6, radius / 1.5);
  const kernel = Array.from({ length: size }, () => new Float64Array(size));
  for (let a = 0; a < size; a++) {
    for (let b = 0; b < size; b++) {
      const da = a - radius + 0.5, db = b - radius + 0.5;
      const taper = Math.exp(-(da * da + db * db) / (2 * sigma * sigma));
      const sign = (da < 0) === (db < 0) ? 1 : -1; // same quadrant sign -> coherence
      kernel[a][b] = sign * taper;
    }
  }

  for (let c = radius; c < n - radius; c++) {
    let sum = 0;
    for (let a = 0; a < size; a++) {
      const i = c - radius + a;
      for (let b = 0; b < size; b++) sum += kernel[a][b] * S[i][c - radius + b];
    }
    nov[c] = Math.max(0, sum);
  }
  return nov;
}

/**
 * Order-sensitive similarity between two segments (index ranges into S):
 * walk the diagonal path through the p x q block, comparing correspondingly-
 * positioned frames (proportionally, for segments of different lengths)
 * rather than averaging the whole block indiscriminately. `meanSim`, which
 * this replaces, averages the full cross block and is therefore invariant to
 * permuting either segment: `ABAB` and its own reversal `BABA` score
 * identically to it, and a genuinely repeated passage whose average is no
 * higher than an unrelated one's is missed entirely. The walk has a very
 * narrow, monotonic diagonal band: a returning phrase may arrive a bar
 * early/late from local tempo drift, but it cannot skip arbitrary material or
 * reorder a periodic pattern to fake a repeat. Endpoints stay pinned, which
 * distinguishes a genuine aligned recurrence from a shifted cyclic loop.
 *
 * Because the shorter segment sets the number of steps and every step must
 * fall somewhere along the longer one, a short shared hook inside a much
 * longer segment still gets diluted by the rest of that segment's
 * non-matching material -- this does not need a separate coverage check.
 */
function diagonalSim(S, [p0, p1], [q0, q1]) {
  const lenP = p1 - p0, lenQ = q1 - q0;
  const steps = Math.max(1, Math.min(lenP, lenQ));
  if (steps === 1) return S[p0][q0];

  // At most ~12% of the shorter phrase may slide off the proportional
  // diagonal (always at least one point for ordinary bar grids). The band is
  // intentionally much smaller than a half-phrase, so ABAB cannot become
  // BABA by realigning an entire alternating motif.
  const slack = Math.max(1, Math.floor(steps * 0.12));
  const offsets = Array.from({ length: slack * 2 + 1 }, (_, i) => i - slack);
  let prev = new Float64Array(offsets.length).fill(-Infinity);
  let prevJs = new Int32Array(offsets.length);
  let prevBase = 0;

  for (let k = 0; k < steps; k++) {
    const i = p0 + Math.min(lenP - 1, Math.floor((k * (lenP - 1)) / (steps - 1)));
    const baseJ = q0 + Math.min(lenQ - 1, Math.floor((k * (lenQ - 1)) / (steps - 1)));
    const next = new Float64Array(offsets.length).fill(-Infinity);
    const nextJs = new Int32Array(offsets.length);
    for (let oi = 0; oi < offsets.length; oi++) {
      const offset = offsets[oi];
      // Pinned ends are non-negotiable: they prevent a cyclic reorder from
      // entering late and leaving early just to find a pretty diagonal.
      if ((k === 0 || k === steps - 1) && offset !== 0) continue;
      const j = baseJ + offset;
      if (j < q0 || j >= q1) continue;
      if (k === 0) {
        next[oi] = S[i][j];
        nextJs[oi] = j;
        continue;
      }
      const expectedDelta = baseJ - prevBase;
      let best = -Infinity;
      for (let pi = 0; pi < offsets.length; pi++) {
        if (!Number.isFinite(prev[pi])) continue;
        const delta = j - prevJs[pi];
        // Monotonic, with only one point of local tempo correction per step.
        if (delta < 0 || Math.abs(delta - expectedDelta) > 1) continue;
        if (prev[pi] > best) best = prev[pi];
      }
      if (Number.isFinite(best)) {
        next[oi] = best + S[i][j];
        nextJs[oi] = j;
      }
    }
    prev = next;
    prevJs = nextJs;
    prevBase = baseJ;
  }
  const center = slack;
  return Number.isFinite(prev[center]) ? prev[center] / steps : 0;
}

/**
 * Assign a structural label per segment by direct repetition: two segments
 * are the same material when their order-sensitive similarity (see
 * `diagonalSim`) clears a threshold set from the song's own distribution.
 * Labels are integers in first-appearance order, matching what
 * SongForm.analyzeSongForm returns so downstream casting is unchanged.
 */
export function labelByRepetition(S, cuts) {
  const segs = [];
  for (let i = 0; i < cuts.length - 1; i++) segs.push([cuts[i], cuts[i + 1]]);

  // Every pairwise segment similarity, computed once. The labelling pass below
  // needs each of these anyway; taking them up front is what makes the song's
  // own similarity distribution available to set the cutoff from.
  const sim = Array.from({ length: segs.length }, () => new Float64Array(segs.length));
  const pairs = [];
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = diagonalSim(S, segs[i], segs[j]);
      sim[i][j] = s;
      sim[j][i] = s;
      pairs.push(s);
    }
  }
  const threshold = repeatThresholdFor(pairs);

  const labels = new Array(segs.length).fill(-1);
  let next = 0;
  for (let i = 0; i < segs.length; i++) {
    if (labels[i] >= 0) continue;
    labels[i] = next;
    // Compare against this segment only -- not a running centroid. A centroid
    // drifts as members join and can chain two genuinely different sections
    // together through a middling third.
    for (let j = i + 1; j < segs.length; j++) {
      if (labels[j] < 0 && sim[i][j] >= threshold) labels[j] = next;
    }
    next++;
  }
  return labels;
}

/**
 * The "same material" cutoff for one song, from its own spread of pairwise
 * segment similarities.
 *
 * A flat cutoff asks "are these two segments similar in absolute terms?",
 * which conflates two different things: whether the material recurs, and how
 * much contrast the arrangement has to begin with. A song on one synth patch
 * has every pair sitting high and reads as all-one-section; a densely
 * arranged one has every pair sitting low and reads as all-distinct. Placing
 * the cutoff inside the song's own range separates those.
 *
 * Falls back to the absolute REPEAT_THRESHOLD in the two cases where the
 * range says nothing: too few pairs to have a distribution, and a range so
 * narrow the song genuinely is one texture.
 *
 * @param {number[]} pairs every distinct pairwise segment similarity
 * @returns {number} the cutoff a pair must reach to count as a repeat
 */
export function repeatThresholdFor(pairs) {
  if (!pairs || pairs.length < REPEAT_MIN_PAIRS) return REPEAT_THRESHOLD;
  const values = pairs.filter(Number.isFinite).sort((a, b) => a - b);
  if (values.length < REPEAT_MIN_PAIRS) return REPEAT_THRESHOLD;
  const lo = values[0], hi = values[values.length - 1];
  const spread = hi - lo;
  if (spread < REPEAT_SPREAD_MIN) return REPEAT_THRESHOLD;

  // Similarity distributions usually have a dense non-repeat body and a
  // smaller high-similarity repeat cluster. Min/max midpoint lets one
  // pathological unlike pair drag the cutoff down through that body. Find a
  // conspicuous gap in the upper half instead; only then split at its middle.
  const median = values[(values.length - 1) >> 1];
  let bestGap = 0, gapAt = -1;
  for (let i = 0; i < values.length - 1; i++) {
    const gap = values[i + 1] - values[i];
    if (values[i + 1] < median || gap <= bestGap) continue;
    bestGap = gap;
    gapAt = i;
  }
  if (gapAt >= 0 && bestGap >= Math.max(REPEAT_GAP_MIN, spread * 0.25)) {
    return Math.max(REPEAT_ABS_MIN, (values[gapAt] + values[gapAt + 1]) / 2);
  }

  const idx = Math.min(values.length - 1, Math.floor((values.length - 1) * REPEAT_LEVEL));
  return Math.max(REPEAT_ABS_MIN, values[idx]);
}

/**
 * @param {object}  opts
 * @param {number[]} opts.pointsMs  analysis grid (bar starts, or an even
 *   split), ascending. Sections can only begin on one of these.
 * @param {object}  opts.pitchFeatures  from PitchTracker.computePitchFeatures
 * @param {object}  opts.energyCurves
 * @param {number}  opts.durationMs
 * @param {number}  opts.minGapMs   minimum time between two cuts (free time)
 * @param {number}  opts.minGapPoints minimum analysis points between cuts
 * @param {number}  opts.maxCuts
 * @returns {?{boundariesMs: number[], labels: number[], cutIndices: number[],
 *   novelty: Float64Array, confidence: number, boundaryStrengths: number[],
 *   boundaryEvidence: object[], fineBoundariesMs: number[]}}
 *   null when there isn't enough material to say anything -- callers fall
 *   back to the energy-novelty path. `fineBoundariesMs` holds candidate
 *   boundaries found at a finer scale that the main pass rejected only for
 *   crowding an existing cut, not for weak evidence -- a short contrasting
 *   passage's edges land here even when they're too close together to both
 *   become full sections under `minGapMs`. Callers that don't need that
 *   finer hierarchy can ignore it.
 */
export function analyzeStructure({
  pointsMs, pitchFeatures, energyCurves, durationMs,
  minGapMs = 11000, minGapPoints = null, maxCuts = 12,
  preparedFeatures = null, preparedMatrices = null,
} = {}) {
  if (!Array.isArray(pointsMs) || pointsMs.length < MIN_POINTS) return null;
  if (!pitchFeatures || !pitchFeatures.frames || pitchFeatures.frames.length === 0) return null;

  const feats = preparedFeatures || buildFeatures(pointsMs, pitchFeatures, energyCurves, durationMs);
  // Degenerate input (digital silence, a single sustained tone) produces
  // all-zero feature vectors. Their SSM is an identity matrix, and running a
  // checkerboard kernel over an identity matrix yields a perfectly real-
  // looking novelty curve made entirely of the diagonal -- boundaries out of
  // nothing. Bail instead and let the caller keep its own schedule.
  const informative = feats.filter((v) => v.some((x) => x > 0)).length;
  if (informative < feats.length * 0.5) return null;

  // Keep absolute harmony for boundaries: a real modulation can be a section
  // turn. Repeats use a second, transposition-invariant SSM so the same
  // chorus shifted up a key keeps its label instead of becoming a new biome.
  const boundaryS = preparedMatrices?.boundary || selfSimilarity(feats);
  const repeatS = preparedMatrices?.repeat || selfSimilarity(feats, { chromaLength: 12, transpositionInvariant: true });
  const novelty = footeNovelty(boundaryS);

  const peak = Math.max(...novelty);
  if (!(peak > 1e-6)) return null; // featureless input (silence, a pure tone)

  const avgStepMs = (pointsMs[pointsMs.length - 1] - pointsMs[0]) / (pointsMs.length - 1);
  const minGapIdx = Number.isFinite(minGapPoints)
    ? Math.max(1, Math.round(minGapPoints))
    : Math.max(1, Math.round(minGapMs / Math.max(1, avgStepMs)));

  // Greedy peak picking, strongest first, honoring the spacing floor -- the
  // same discipline the energy-novelty path used, so section pacing is
  // unchanged and only the *choice* of boundary improves.
  const peaks = [];
  const order = Array.from(novelty, (v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const lastIdx = pointsMs.length - 1;
  for (const [v, i] of order) {
    if (peaks.length >= maxCuts) break;
    if (v <= peak * 0.15) break; // noise floor: don't manufacture boundaries
    // Spaced against the song's own edges as well as against each other --
    // index 0 and the final index are always cuts, so a peak crowding either
    // one produces a runt section just as surely as two adjacent peaks do.
    if (i < minGapIdx || lastIdx - i < minGapIdx) continue;
    if (peaks.some((p) => Math.abs(p - i) < minGapIdx)) continue;
    peaks.push(i);
  }
  peaks.sort((a, b) => a - b);

  const cutIndices = [0, ...peaks, pointsMs.length - 1];
  const labels = labelByRepetition(repeatS, cutIndices);

  const boundariesMs = [];
  for (let i = 0; i < cutIndices.length - 1; i++) boundariesMs.push(i === 0 ? 0 : pointsMs[cutIndices[i]]);

  // Confidence: how far the chosen peaks stand above the typical novelty. A
  // through-composed piece with no repeats and no clear boundaries scores
  // low, and BiomeManager keeps its existing schedule instead.
  let mean = 0, counted = 0;
  for (let i = 0; i < novelty.length; i++) if (novelty[i] > 0) { mean += novelty[i]; counted++; }
  mean = counted > 0 ? mean / counted : 0;
  const contrast = mean > 1e-9 ? clamp01((peak / mean - 1) / 2) : 0;
  const repeats = labels.length - new Set(labels).size; // how much material recurs
  const repeatBonus = clamp01(repeats / Math.max(1, labels.length - 1));
  let confidence = clamp01(0.6 * contrast + 0.4 * repeatBonus);

  // Finding NO structure is not a confident answer. When every candidate was
  // rejected we return the degenerate [0, last] -- a single section covering
  // the whole song -- and `repeatBonus` is structurally 0 there (one label
  // cannot recur), so contrast alone could still carry this to 0.6 and clear
  // BiomeManager's acceptance floor. It would then *override* an energy-novelty
  // read that had found real boundaries, and the song would wear one biome
  // start to finish. A detector that found nothing must say so.
  if (labels.length < 2) confidence = Math.min(confidence, NO_STRUCTURE_CONFIDENCE);

  const boundaryStrengths = [0, ...peaks.map((i) => clamp01(novelty[i] / peak))];
  const boundaryEvidence = boundariesMs.map((timeMs, index) => ({
    timeMs,
    strength: boundaryStrengths[index] ?? 0,
    source: index === 0 ? 'start' : 'ssm',
    scale: 'coarse',
    ...localBoundaryEvidence(feats, pointsMs, cutIndices[index], durationMs, {
      startIndex: cutIndices[Math.max(0,index-1)], endIndex: cutIndices[index+1],
    }),
  }));
  const fineBoundaryEvidence = findFineBoundaries(boundaryS, pointsMs, cutIndices, minGapIdx, lastIdx);
  const fineBoundariesMs = fineBoundaryEvidence.map((b) => b.timeMs);

  return {
    boundariesMs, labels, cutIndices, novelty, confidence,
    boundaryStrengths, boundaryEvidence,
    fineBoundariesMs, fineBoundaryEvidence,
  };
}

// A short contrasting passage's two edges can be closer together than
// `minGapMs` allows for a full section (a fill, a breakdown, an eight-second
// bridge). The main pass is right to refuse to build two runt sections out
// of them, but refusing to *record* them at all erases a real musical event.
// This second pass runs a finer checkerboard scale (more sensitive to short
// material) and a looser spacing floor, purely to surface what the main pass
// had to drop -- it never feeds back into `cutIndices`, `labels`, or
// `confidence`, so the primary read and its pacing contract are unchanged.
const FINE_GAP_DIVISOR = 2;

function findFineBoundaries(S, pointsMs, cutIndices, minGapIdx, lastIdx) {
  const fineNovelty = footeNovelty(S, FINE_KERNEL_RADIUS);
  const finePeak = Math.max(...fineNovelty, 0);
  if (!(finePeak > 1e-6)) return [];

  const fineGapIdx = Math.max(1, Math.round(minGapIdx / FINE_GAP_DIVISOR));
  const existing = new Set(cutIndices);
  const order = Array.from(fineNovelty, (v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const found = [];
  for (const [v, i] of order) {
    if (v <= finePeak * 0.15) break;
    if (i < 1 || i >= lastIdx) continue; // the song's own edges aren't "fine" events
    if ([...existing].some((c) => Math.abs(c - i) < fineGapIdx)) continue;
    if (found.some((f) => Math.abs(f - i) < fineGapIdx)) continue;
    found.push(i);
  }
  found.sort((a, b) => a - b);
  return found.map((i) => ({
    timeMs: pointsMs[i],
    strength: clamp01(fineNovelty[i] / finePeak),
    source: 'ssm',
    scale: 'fine',
  }));
}

/** Separate musical groups around a boundary; silence is missing evidence.
 * Compare four intervals on each side, and require the changed regime to
 * persist. Dynamics supports mood but cannot duplicate timbral evidence. */
function localBoundaryEvidence(feats, pointsMs, index, durationMs, { startIndex = 0, endIndex = feats.length } = {}) {
  const empty = { confidence: 0, groups: { harmony: 0, timbre: 0, dynamics: 0 }, persistenceMs: 0, beforePersistenceMs: 0 };
  if (index < 0 || index >= feats.length) return empty;
  const mean = (lo,hi) => {
    const v = new Float64Array(21); let n = 0;
    for (let i=lo;i<hi;i++) {
      if (!feats[i].some(x => x > 0)) continue;
      for (let k=0;k<v.length;k++) v[k] += feats[i][k];
      n++;
    }
    return n ? Array.from(v,x => x/n) : null;
  };
  const before = mean(Math.max(startIndex,index-4),index), after = mean(index,Math.min(endIndex,index+4));
  if (index === 0 && after) return { ...empty, afterDescriptors: { harmony: after.slice(0,12), timbre: after.slice(12,19), dynamics: after.slice(19,21) } };
  if (!before || !after) return empty;
  const difference = (a,b,lo,hi) => {
    const av=a.slice(lo,hi), bv=b.slice(lo,hi);
    if (!av.some(x=>x>0) || !bv.some(x=>x>0)) return 0;
    return clamp01(1-cosine(av,bv));
  };
  const groups = { harmony: difference(before,after,0,12), timbre: difference(before,after,12,19), dynamics: difference(before,after,19,21) };
  const strong = Object.entries(groups).filter(([,v])=>v>=.3);
  if (!strong.length) return { ...empty, groups };
  const slots = { harmony:[0,12], timbre:[12,19], dynamics:[19,21] };
  let end=index;
  for (;end<feats.length;end++) {
    const v=feats[end];
    if (!v.some(x=>x>0)) break;
    if (strong.some(([key]) => difference(before,v,...slots[key]) < .3 || difference(after,v,...slots[key]) > .25)) break;
  }
  const persistenceMs = Math.max(0,(pointsMs[end] ?? durationMs)-pointsMs[index]);
  // Local validity and separation own this confidence; recurrence is not
  // required of a new musical regime, and peak height alone is not trust.
  let start=index-1;
  for (;start>=0;start--) {
    const v=feats[start];
    if (!v.some(x=>x>0)) break;
    if (strong.some(([key]) => difference(after,v,...slots[key]) < .3 || difference(before,v,...slots[key]) > .25)) break;
  }
  const beforePersistenceMs = Math.max(0,pointsMs[index]-pointsMs[start+1]);
  const descriptors = {
    before: { harmony: before.slice(0,12), timbre: before.slice(12,19), dynamics: before.slice(19,21) },
    after: { harmony: after.slice(0,12), timbre: after.slice(12,19), dynamics: after.slice(19,21) },
  };
  const confidence = strong.length >= 2 ? clamp01(.65 + .35 * Math.min(...strong.map(([,v])=>v))) : .4;
  return { confidence, groups, persistenceMs, beforePersistenceMs, beforeDescriptors: descriptors.before, afterDescriptors: descriptors.after };
}

// Cap quadratic work/memory in both worker and fallback. Features retain
// song coverage; minGapPoints is rescaled with the grid, preserving pacing.
export const MAX_STRUCTURE_POINTS = 192;
export function boundedStructureInput(input) {
  const original = input.pointsMs || [];
  if (original.length <= MAX_STRUCTURE_POINTS) return input;
  const pointsMs = Array.from({length:MAX_STRUCTURE_POINTS}, (_,i) => original[Math.round(i*(original.length-1)/(MAX_STRUCTURE_POINTS-1))]);
  return { ...input, pointsMs, minGapPoints: Number.isFinite(input.minGapPoints) ? Math.max(1,Math.round(input.minGapPoints * pointsMs.length / original.length)) : null };
}

async function finishAsync(iterator, signal, maybeYield) {
  let step;
  do {
    throwIfAborted(signal);
    step=iterator.next();
    await maybeYield();
  } while (!step.done);
  return step.value;
}

/** Worker-free fallback: yield between feature/matrix rows. The remaining
 * novelty/repetition work is bounded by MAX_STRUCTURE_POINTS and maxCuts. */
export async function analyzeStructureAsync(input, { signal = null, maybeYield = createYielder(4) } = {}) {
  throwIfAborted(signal);
  const bounded=boundedStructureInput(input);
  if (!bounded.pointsMs?.length || !bounded.pitchFeatures?.frames?.length || bounded.pointsMs.length < MIN_POINTS) return null;
  const feats=await finishAsync(featureSteps(bounded.pointsMs,bounded.pitchFeatures,bounded.energyCurves,bounded.durationMs),signal,maybeYield);
  const boundary=await finishAsync(similaritySteps(feats),signal,maybeYield);
  const repeat=await finishAsync(similaritySteps(feats,{chromaLength:12,transpositionInvariant:true}),signal,maybeYield);
  throwIfAborted(signal);
  return analyzeStructure({...bounded,preparedFeatures:feats,preparedMatrices:{boundary,repeat}});
}
