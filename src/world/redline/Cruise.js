// Redline's musical envelope.
//
// The highway has to read as speed without inventing a beat from BPM -- the
// conductor already told us when a hit landed, and inventing a pulse for
// unmetered material is the same lie WorldMusic refuses. So travel rate
// comes from the 1.2s energy average, not from a tempo guess:
//
//   quiet  → a controlled crawl (the road still exists)
//   groove → a full cruise
//   dense  → half-time, so 170 BPM of drums does not strobe the grid
//
// Phrase boundaries that earned a lift (same gate After Hours uses for
// blooms) spend that lift on a tunnel-then-horizon passage: the mouth
// closes first, then the horizon opens. Decorative pacing cuts get
// nothing. Signage is occupancy, not traffic: one gantry catches the
// latest accent, the rest stay dim, density never spawns more signs.
//
// Everything is pure and causal. A rate held in a field would make a
// backward seek keep the previous song-position's speed.
import { clamp01, lerp } from '../../utils/math.js';
import { boundaryLift01 } from '../WorldMusic.js';
import { energyTravel } from '../EnergyTravel.js';

const CRAWL = 0.22;
const CRUISE = 1;
const HALF_TIME = 0.48;
const PEAK_AT = 0.42;
const TRAVEL_PX = 140;

export { boundaryLift01 };

/**
 * Visual gear for the road, 0..1. Inverted-U so the densest material
 * drops to half-time instead of accelerating. Reduced flash halves it.
 */
export function cruiseRate(energy = 0, reducedFlash = false) {
  const e = clamp01(energy);
  let rate;
  if (e <= PEAK_AT) rate = lerp(CRAWL, CRUISE, e / PEAK_AT);
  else rate = lerp(CRUISE, HALF_TIME, (e - PEAK_AT) / (1 - PEAK_AT));
  if (reducedFlash) rate *= 0.5;
  return rate;
}

const cruisePixelsPerSecond = (energy) => TRAVEL_PX * cruiseRate(energy);

/** Integrated lane travel; independent of render order and frame rate. */
export function cruiseTravel(tSec, energyCurves = null, reducedFlash = false, response = null, reducedMotion = false) {
  return energyTravel(reducedMotion ? 0 : tSec, energyCurves, cruisePixelsPerSecond, response) * (reducedFlash ? 0.5 : 1);
}

/**
 * Tunnel mouth (front-loaded) and horizon wash (back-loaded) for the
 * current section window. `reveal` is the shape and the trust;
 * `lift` is whether this boundary earned one.
 */
export function phrasePassage({ nowMs = 0, section = null, lift = 0 } = {}) {
  const start = section?.startMs ?? 0;
  const end = section?.endMs ?? 0;
  const elapsed = nowMs - start;
  const span = Math.min(4000, end - start);
  const trust = section?.provenance === 'detected' ? 1
    : section?.provenance === 'inferred' ? 0.5 : 0;
  if (!(start > 0 && elapsed > 0 && elapsed < span && trust > 0)) {
    return { tunnel: 0, horizon: 0 };
  }
  const t = elapsed / span;
  const envelope = Math.sin(Math.PI * t) ** 2 * trust * clamp01(lift);
  return {
    tunnel: clamp01(envelope * (1 - t)),
    horizon: clamp01(envelope * t),
  };
}

/** Baseline neon plus one gantry catching the current accent. */
export function signageAlpha(energy = 0, accent = 0, hit = false) {
  const base = 0.10 + 0.28 * clamp01(energy);
  return clamp01(base + (hit ? 0.55 * clamp01(accent) : 0.04 * clamp01(accent)));
}
