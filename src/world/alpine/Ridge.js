// The Range's musical envelope.
//
// The mountains already dance, grow with the song, and change scale with
// each section. What they didn't have is the shared language the other
// painterly worlds use: a kick is not a new massif, bass is weight, and a
// decorative cut is not a new range.
//
// Ambient travel of the ridge is an inverted-U on the 1.2s energy average
// -- quiet songs keep a slow atmosphere, a groove breathes, dense material
// settles so the skyline does not strobe. Large terrain movement is saved
// for phrase boundaries that earned a lift (the same gate After Hours uses
// for blooms). Bass, the same 1.2s low-band average, swells the flanks.
// Isolated accents sharpen a summit on a quiet song; dense material raises
// the floor so only stronger hits mark the skyline.
//
// Pure and causal. Groove held in a one-pole would survive a backward seek.
import { clamp01, lerp } from '../../utils/math.js';
import { boundaryLift01 } from '../WorldMusic.js';

const ATMOSPHERE = 0.16;
const BREATHE = 0.82;
const SETTLE = 0.28;
const PEAK_AT = 0.40;

const WEIGHT_FLOOR = 0.10;
const WEIGHT_CEIL = 0.78;

const PHRASE_GAIN = 0.22;
const PHRASE_GAIN_REDUCED = 0.08;

const KICK_SPARSE = 1;
const KICK_DENSE = 0.18;

export { boundaryLift01 };

/**
 * Visual travel of the ridge, 0..1. Inverted-U so the densest material
 * settles instead of heaving harder. Reduced flash halves it.
 */
export function ambientDance(energy = 0, reducedFlash = false) {
  const e = clamp01(energy);
  let rate;
  if (e <= PEAK_AT) rate = lerp(ATMOSPHERE, BREATHE, e / PEAK_AT);
  else rate = lerp(BREATHE, SETTLE, (e - PEAK_AT) / (1 - PEAK_AT));
  if (reducedFlash) rate *= 0.5;
  return rate;
}

/** Flank swell from sustained bass, never a single-frame sample. */
export function ridgeWeight(bass = 0) {
  return lerp(WEIGHT_FLOOR, WEIGHT_CEIL, clamp01(bass));
}

/**
 * Extra height at an earned phrase opening. Decorative cuts arrive with
 * reveal 0 and do nothing; standing section scale is applied elsewhere.
 */
export function phraseScale({ reveal = 0, lift = 0, reducedFlash = false } = {}) {
  const gain = reducedFlash ? PHRASE_GAIN_REDUCED : PHRASE_GAIN;
  return 1 + gain * clamp01(reveal) * clamp01(lift);
}

/** How much of a kick the ridge is allowed to bounce, 0..1. */
export function kickGate(energy = 0) {
  return lerp(KICK_SPARSE, KICK_DENSE, clamp01(energy));
}

/**
 * How much of a summit-sharpen this accent has earned, 0..1.
 * Dense songs filter to a subset; sparse songs let a lone hit show.
 */
export function summitGesture(accent = 0, energy = 0) {
  const a = clamp01(accent);
  const floor = lerp(0.08, 0.55, clamp01(energy));
  if (a <= floor) return 0;
  return clamp01((a - floor) / Math.max(1e-6, 1 - floor));
}

/** All Range dance inputs derived from one WorldMusic sample. */
export function ridgeEnvelope({
  energy = 0, bass = 0, accent = 0, reveal = 0, lift = 0, reducedFlash = false, reducedMotion = false,
} = {}) {
  return {
    groove: reducedMotion ? 0 : ambientDance(energy, reducedFlash),
    sustain: ridgeWeight(bass),
    scaleMul: reducedMotion ? 1 : phraseScale({ reveal, lift, reducedFlash }),
    kickMul: reducedMotion ? 0 : kickGate(energy),
    gesture: reducedMotion ? 0 : summitGesture(accent, energy),
  };
}
