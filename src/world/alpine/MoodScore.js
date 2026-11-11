// The song's mood as one hue for the whole Landscape frame.
//
// Minor, sparse, dark and quiet passages read blue: sad, haunting, empty.
// Major, full, bright and driven passages read orange-cream. Every point in
// between sits on one continuous spectrum (MOOD_STOPS), so the grade turns
// with the music instead of switching on a label.
//
// Compiled once per immutable analysis, like EffectsMusic's atmosphere, and
// sampled at heard time: seek, pause, export and the water mirror agree. The
// envelope is causal: each step integrates the PREVIOUS analysis step, and
// the key is the tonality row heard at or before that step (the rolling key
// window already ends at its own tMs), so interpolation never reads ahead.
import { FLAT_WEIGHTS } from '../../audio/bands.js';
import { physicalFloor } from './EffectsMusic.js';

const unit = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const smooth = (v) => { const t = unit(v); return t * t * (3 - 2 * t); };

export const MOOD_STEP_MS = 100;
/** Seconds for the hue to cover ~63% of a change: it turns like weather. */
export const MOOD_TAU_MS = 2600;
/** Feature smoothing: a phrase, not a drum. */
const FEATURE_TAU_MS = 1800;
/** Onset rate (per second) that reads as a full arrangement. */
const FULL_ONSET_HZ = 5;
/** Share of the mood a settled key carries. The key chooses the side of the
 *  spectrum (minor cool, major warm); the arrangement moves the hue within
 *  it, so a loud minor climax deepens to slate rather than turning amber. */
const KEY_SHARE = 0.65;
/** Every key row votes for its mode; confidence weights the vote, but a
 *  distorted mix's thin-confidence rows still count when they agree. */
const VOTE_FLOOR = 0.25;
/** Trailing memory of the key votes, against the whole song so far. */
const KEY_TAU_MS = 10000;
const KEY_TRAIL_SHARE = 0.6;
/** A new analysis takes over the hue over this long (LandscapeScore's
 *  camera handoff), never with a jump. */
export const MOOD_HANDOFF_MS = 6000;
/** Where a silent passage settles: empty, so cool, but not the saddest blue. */
const SILENT_VALENCE = -0.45;

/** The mood spectrum, cold to warm. `at` is mood01. */
export const MOOD_STOPS = Object.freeze([
  Object.freeze({ at: 0.00, rgb: Object.freeze([34, 58, 140]) }),   // deep blue: sad, empty
  Object.freeze({ at: 0.22, rgb: Object.freeze([52, 98, 160]) }),   // steel blue: haunting
  Object.freeze({ at: 0.40, rgb: Object.freeze([96, 136, 162]) }),  // cold slate: wistful
  Object.freeze({ at: 0.55, rgb: Object.freeze([168, 158, 140]) }), // neutral stone
  Object.freeze({ at: 0.75, rgb: Object.freeze([232, 172, 104]) }), // amber: warm
  Object.freeze({ at: 1.00, rgb: Object.freeze([250, 210, 158]) }), // orange-cream: bright, full
]);

/** Colour-blend alpha: a floor so the hue is always the music's, and a
 *  ceiling so the scene's own light still reads through. */
export const MOOD_ALPHA = Object.freeze({ min: 0.16, max: 0.55 });

const NEUTRAL = Object.freeze({ mood01: 0.5, fullness01: 0, valence: 0, rgb: Object.freeze([168, 158, 140]),
  alpha: 0 });

/** Mood01 -> [r, g, b] on MOOD_STOPS, written into `out`. */
export function moodColor(mood01, out = [0, 0, 0]) {
  const m = unit(mood01);
  let i = 1;
  while (i < MOOD_STOPS.length - 1 && MOOD_STOPS[i].at < m) i++;
  const a = MOOD_STOPS[i - 1], b = MOOD_STOPS[i];
  const k = smooth((m - a.at) / Math.max(1e-6, b.at - a.at));
  for (let c = 0; c < 3; c++) out[c] = Math.round(a.rgb[c] + (b.rgb[c] - a.rgb[c]) * k);
  return out;
}

/** How strongly the hue is laid on: distance from neutral, deepened by an
 *  empty passage on the cold side and a full one on the warm side. */
export function moodAlpha(mood01, fullness01) {
  const m = unit(mood01), f = unit(fullness01);
  // Concave, so a moderately minor passage already reads clearly blue.
  const reach = Math.sqrt(unit(Math.abs(m - 0.5) * 2.5));
  const conviction = m < 0.5 ? 0.75 + 0.25 * (1 - f) : 0.75 + 0.25 * f;
  return MOOD_ALPHA.min + (MOOD_ALPHA.max - MOOD_ALPHA.min) * reach * conviction;
}

function rows(tonality) {
  if (!Array.isArray(tonality)) return [];
  return tonality.filter((k) => Number.isFinite(k?.tMs)).slice().sort((a, b) => a.tMs - b.tMs);
}

/** Bass notes [tMs, pitchClass, weight], time-ordered: the tonic evidence
 *  that settles a relative major/minor pair (G major vs E minor share every
 *  note; the bass line dwells on G in one and on E in the other). */
function bassNotes(timeline) {
  if (!Array.isArray(timeline)) return [];
  return timeline.filter((e) => e && e.role === 'BASS' && Number.isFinite(e.pitch) && Number.isFinite(e.tMs) && unit(e.vel ?? e.velocity) > 0)
    .map((e) => [e.tMs, ((Math.round(e.pitch) % 12) + 12) % 12, unit(e.vel ?? e.velocity) * Math.max(0.1, Math.min(2, (e.durMs || 250) / 250))])
    .sort((a, b) => a[0] - b[0]);
}

/** Mode of a key row after the bass has had its say: a row whose relative
 *  key's tonic (and fifth) the bass favours clearly is read as that key. */
export function bassResolvedMode(row, bass) {
  const mode = row.mode === 'minor' ? -1 : row.mode === 'major' ? 1 : Math.sign(row.majorness || 0);
  if (!mode || !bass || !Number.isFinite(row.tonic)) return mode;
  const t = ((Math.round(row.tonic) % 12) + 12) % 12, rel = (t + (mode < 0 ? 3 : 9)) % 12;
  const score = (pc) => bass[pc] + 0.5 * bass[(pc + 7) % 12];
  const own = score(t), other = score(rel);
  return other > 1.3 * own + 1e-6 ? -mode : mode;
}

function onsetTimes(timeline) {
  if (!Array.isArray(timeline)) return new Float64Array(0);
  const t = timeline.filter((e) => e && Number.isFinite(e.tMs) && e.tMs >= 0 && unit(e.vel ?? e.velocity) > 0)
    .map((e) => e.tMs).sort((a, b) => a - b);
  return Float64Array.from(t);
}

/** Read one analysis frame: energy, brightness share and audibility. */
function frameAt(curves, timeMs, floor) {
  const rate = Number.isFinite(curves?.rateHz) && curves.rateHz > 0 ? curves.rateHz : 50;
  const index = Math.max(0, Math.floor(timeMs * rate / 1000 + 1e-10));
  const read = (band) => { const v = band?.[Math.min(index, Math.max(0, (band?.length || 0) - 1))]; return Number.isFinite(v) && v > 0 ? v : 0; };
  const bands = curves?.bands;
  if (!Array.isArray(bands)) return { audible: false, energy: 0, bright: 0.5 };
  let sum = 0;
  for (let b = 0; b < 7; b++) sum += read(bands[b]);
  let audible = sum / 7 > 1e-9;
  if (audible && floor != null && Array.isArray(curves.rmsBands)) {
    let sq = 0;
    for (const band of curves.rmsBands) sq += read(band) ** 2;
    audible = Math.sqrt(sq / 7) > floor;
  }
  if (!audible) return { audible: false, energy: 0, bright: 0.5 };
  const dark = read(bands[1]) + read(bands[2]), light = read(bands[5]) + read(bands[6]);
  const at = index * 1000 / rate;
  const energy = unit(curves.globalEnergyNorm?.(at, FLAT_WEIGHTS) ?? sum / 7);
  return { audible: true, energy, bright: dark + light > 1e-9 ? light / (dark + light) : 0.5 };
}

/**
 * Compile the mood track for one analysis. Pure; returns
 * { stepMs, mood: Float32Array, fullness: Float32Array, at(timeMs) }.
 * `at` returns a frozen { mood01, fullness01, valence, rgb, alpha }.
 */
export function compileMood({ energyCurves = null, tonalityTimeline = null, timeline = null, durationMs = 0 } = {}) {
  const rate = Number.isFinite(energyCurves?.rateHz) && energyCurves.rateHz > 0 ? energyCurves.rateHz : 50;
  const frames = Math.max(0, ...((energyCurves?.bands || []).map((b) => b?.length || 0)));
  const spanMs = Math.max(Number(durationMs) || 0, frames > 0 ? (frames - 1) * 1000 / rate : 0);
  if (!(spanMs > 0) || !frames) return Object.freeze({ stepMs: MOOD_STEP_MS, mood: null, fullness: null, at: () => NEUTRAL });
  const n = Math.ceil(spanMs / MOOD_STEP_MS) + 2;
  const mood = new Float32Array(n), fullness = new Float32Array(n), valence = new Float32Array(n);
  const keys = rows(tonalityTimeline), onsets = onsetTimes(timeline), floor = physicalFloor(energyCurves);
  const kf = 1 - Math.exp(-MOOD_STEP_MS / FEATURE_TAU_MS), km = 1 - Math.exp(-MOOD_STEP_MS / MOOD_TAU_MS);
  const kd = 1 - Math.exp(-MOOD_STEP_MS / 3000), kk = 1 - Math.exp(-MOOD_STEP_MS / KEY_TAU_MS);
  let energy = 0, bright = 0.4, density = 0, v = 0, full = 0, key = -1, onset = 0;
  let trailVote = 0, trailWeight = 0, songVote = 0, songWeight = 0, counted = -1;
  // Trailing bass pitch-class weight (KEY_TAU_MS memory), heard notes only.
  const basses = bassNotes(timeline), bass = new Float64Array(12);
  let bassAt = 0;
  mood[0] = 0.5;
  for (let i = 1; i < n; i++) {
    const t = (i - 1) * MOOD_STEP_MS;
    const f = frameAt(energyCurves, t, floor);
    let hits = 0;
    while (onset < onsets.length && onsets[onset] <= t) { if (onsets[onset] > t - MOOD_STEP_MS) hits++; onset++; }
    density += (hits * (1000 / MOOD_STEP_MS) / FULL_ONSET_HZ - density) * kd;
    energy += (f.energy - energy) * kf;
    if (f.audible) bright += (f.bright - bright) * kf;
    while (key + 1 < keys.length && keys[key + 1].tMs <= t) key++;
    for (let pc = 0; pc < 12; pc++) bass[pc] *= 1 - kk;
    while (bassAt < basses.length && basses[bassAt][0] <= t) { bass[basses[bassAt][1]] += basses[bassAt][2]; bassAt++; }
    // Each newly heard key row votes once; the trailing tally decays.
    trailVote *= 1 - kk; trailWeight *= 1 - kk;
    for (; counted < key; counted++) {
      const row = keys[counted + 1];
      const weight = VOTE_FLOOR + (1 - VOTE_FLOOR) * unit(row.confidence);
      const mode = bassResolvedMode(row, bassAt ? bass : null);
      trailVote += mode * weight; trailWeight += weight; songVote += mode * weight; songWeight += weight;
    }
    const trail = trailWeight > 1e-6 ? trailVote / trailWeight : 0, song = songWeight > 1e-6 ? songVote / songWeight : 0;
    // Agreement, not a single row, settles the key; a tally needs a few
    // seconds of rows before it speaks with full weight.
    const settled = smooth(Math.min(trailWeight, songWeight) / 2);
    const side = Math.tanh(2 * (KEY_TRAIL_SHARE * trail + (1 - KEY_TRAIL_SHARE) * song)) / Math.tanh(2) * settled;
    const d = unit(density), e = unit(energy);
    // Brightness share sits around .15 (dark, bass-led) to .55 (airy).
    const b = unit((bright - 0.15) / 0.4);
    const colour = 0.45 * (2 * b - 1) + 0.30 * (2 * e - 1) + 0.25 * (2 * d - 1);
    const w = KEY_SHARE * Math.abs(side);
    const target = f.audible || e > 0.02 ? KEY_SHARE * side + (1 - w) * colour : SILENT_VALENCE;
    v += (target - v) * km;
    full += (0.6 * e + 0.4 * d - full) * km;
    valence[i] = v;
    mood[i] = unit(0.5 + 0.5 * v);
    fullness[i] = unit(full);
  }
  const rgb = [0, 0, 0];
  const at = (timeMs) => {
    const x = Math.min(n - 1, Math.max(0, (Number(timeMs) || 0) / MOOD_STEP_MS));
    const lo = Math.floor(x), hi = Math.min(n - 1, lo + 1), k = x - lo;
    const m = mood[lo] + (mood[hi] - mood[lo]) * k, fl = fullness[lo] + (fullness[hi] - fullness[lo]) * k;
    moodColor(m, rgb);
    return Object.freeze({ mood01: m, fullness01: fl, valence: valence[lo] + (valence[hi] - valence[lo]) * k,
      rgb: Object.freeze([rgb[0], rgb[1], rgb[2]]), alpha: moodAlpha(m, fl) });
  };
  return Object.freeze({ stepMs: MOOD_STEP_MS, mood, fullness, at });
}

/**
 * A score that plays `previous` through `freezeThroughMs`, then eases into
 * `next` over MOOD_HANDOFF_MS. A whole-song analysis replacing the opening
 * one re-normalises energy and gathers more key evidence, so its curve
 * differs; the hue must turn into it, not jump. Pure in heard time.
 */
export function handoffMood(previous, next, freezeThroughMs) {
  if (!previous?.at || !(freezeThroughMs >= 0)) return next;
  const rgb = [0, 0, 0];
  const at = (timeMs) => {
    const t = Number(timeMs) || 0;
    if (t <= freezeThroughMs) return previous.at(t);
    const k = smooth((t - freezeThroughMs) / MOOD_HANDOFF_MS);
    if (k >= 1) return next.at(t);
    const a = previous.at(t), b = next.at(t);
    const mood01 = a.mood01 + (b.mood01 - a.mood01) * k, fullness01 = a.fullness01 + (b.fullness01 - a.fullness01) * k;
    moodColor(mood01, rgb);
    return Object.freeze({ mood01, fullness01, valence: a.valence + (b.valence - a.valence) * k,
      rgb: Object.freeze([rgb[0], rgb[1], rgb[2]]), alpha: moodAlpha(mood01, fullness01) });
  };
  return Object.freeze({ ...next, previous, freezeThroughMs, at });
}

const cache = new WeakMap();
/**
 * The mood track for `owner` (the BiomeManager), compiled once per analysis.
 * Inputs are compared by identity, as LandscapeScore does: a replaced
 * analysis recompiles and hands off from `committedThroughMs` (the heard
 * time when it arrived); a timeline growing in place does not recompile.
 * A rebuilt owner (the whole-song analysis arriving in place) hands off
 * from `owner.landscapeHistory.moodScore` at its committedThroughMs.
 * The current score is published as `owner.moodScore` for that carry.
 */
export function moodScoreFor(owner, { energyCurves = null, tonalityTimeline = null, timeline = null, durationMs = 0,
  committedThroughMs = -1 } = {}) {
  if (!energyCurves || typeof energyCurves !== 'object' || !owner || typeof owner !== 'object') return null;
  const hit = cache.get(owner);
  if (hit && hit.curves === energyCurves && hit.tonality === tonalityTimeline && hit.timeline === timeline
    && hit.durationMs === durationMs) return hit.score;
  const own = compileMood({ energyCurves, tonalityTimeline, timeline, durationMs });
  const carried = owner.landscapeHistory?.moodScore || null;
  const score = hit ? handoffMood(hit.score, own, committedThroughMs)
    : carried ? handoffMood(carried, own, owner.landscapeHistory.committedThroughMs ?? -1) : own;
  cache.set(owner, { curves: energyCurves, tonality: tonalityTimeline, timeline, durationMs, score });
  owner.moodScore = score;
  return score;
}

/** Mood at heard time for `owner`, or neutral (no grade) without an analysis. */
export function sampleMood(owner, inputs, timeMs) {
  const score = moodScoreFor(owner, inputs);
  return score ? score.at(timeMs) : NEUTRAL;
}
