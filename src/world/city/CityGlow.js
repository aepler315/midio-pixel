// The After Hours glow envelope.
//
// `windowOccupancy` answers "how much of this city is awake", which is the
// right question for a skyline and the wrong one for a light show. Its inputs
// are a 1.2s energy average and the monotonically growing orogeny arc, so over
// a whole song it drifts inside a narrow band and only ever really climbs --
// measured across a plausible trajectory, raw occupancy 0.36..0.85, which the
// old `0.15 + 0.45 * occ` mapping squeezed into a window alpha of 0.31..0.53.
// The dead-quiet bridge and the loudest chorus were a fifth of the scale
// apart. That is why the intensity never lands: it is always roughly on, so
// there is nothing for it to be brighter THAN.
//
// So spend it differently. The baseline is occupancy compressed into a dimmer
// band and given a slow breath, and every bit of headroom that frees up is
// saved for blooms at boundaries that earned one. Quiet passages go genuinely
// dark; a chorus arriving lights the city the way it used to light it all the
// time.
//
// Everything here is pure and causal -- derived from the clock and the section
// list, never accumulated across frames. Holding a decaying envelope in a
// field would make the glow depend on how the song was played rather than
// where it is, and would show up immediately as a backward seek that stays
// blown out (`npm run test:worlds` seeks backwards on purpose).
import { clamp01, lerp } from '../../utils/math.js';
export { boundaryLift01 } from '../WorldMusic.js';

// The band the city idles in. The ceiling is deliberately below the old
// mapping's peak: the loud-but-unremarkable middle of a song should sit under
// what a boundary can reach, or a boundary has nowhere to go.
const BASE_FLOOR = 0.16;
const BASE_CEIL = 0.46;

// Occupancy never approaches either end of its nominal 0..1. Its constant
// term and the orogeny arc hold it inside roughly 0.32..0.88 for a real song,
// so fed straight into the band above it would idle near the middle of its own
// scale and never reach the floor. Stretch the range it actually uses back
// over the whole band first.
const OCC_LOW = 0.32;
const OCC_HIGH = 0.88;

// The breath itself. One slow cycle, well off any musical period so it reads
// as the city idling rather than as something tracking the beat.
const BREATH_SEC = 13;
const BREATH_DEPTH = 0.10;

// What a bloom is worth at full strength. Baseline ceiling + this reaches 1,
// so the biggest lift in the loudest part of a song blazes, and nothing short
// of that does.
const BLOOM_GAIN = 0.62;

/**
 * Signed breath, -1..1. Suppressed entirely under reduced flash, where a
 * constantly drifting field brightness is the symptom being avoided.
 */
export function breathSigned(tSec, reducedFlash = false) {
  if (reducedFlash || !Number.isFinite(tSec)) return 0;
  return Math.sin((tSec / BREATH_SEC) * Math.PI * 2);
}

/**
 * The composed glow, 0..1: a breathing baseline plus whatever bloom the
 * current boundary earned. `reveal` supplies the bloom's shape and its trust
 * in the boundary; `lift` supplies its size.
 */
export function cityGlow({ occupancy = 0, tSec = 0, reveal = 0, lift = 0, reducedFlash = false } = {}) {
  const awake = clamp01((occupancy - OCC_LOW) / (OCC_HIGH - OCC_LOW));
  const base = lerp(BASE_FLOOR, BASE_CEIL, awake);
  const breathed = base * (1 + BREATH_DEPTH * breathSigned(tSec, reducedFlash));
  return clamp01(breathed + BLOOM_GAIN * clamp01(reveal) * clamp01(lift));
}

/** Blit alpha for the baked window strip. */
export function windowGlowAlpha(glow01) {
  return 0.10 + 0.62 * clamp01(glow01);
}
