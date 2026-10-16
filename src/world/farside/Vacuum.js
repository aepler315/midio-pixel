// Far Side's musical envelope.
//
// Vacuum has no air to carry a beat. A steady starfield and a terminator
// that only walks song-time already said that; what was missing is that
// slow tonal change and isolated hits still have somewhere to go without
// turning the surface into a music visualizer.
//
// Illumination is the 1.2s energy average plus an earned phrase lift --
// the same gate After Hours uses for blooms. Isolated accents leave a
// surface trace; dense material raises the floor so only the stronger
// hits mark the regolith. Sparse songs keep the composition and the
// stillness. Nothing here invents a pulse from BPM.
//
// Pure and causal. A trace held in a field would survive a backward seek.
import { clamp01, lerp } from '../../utils/math.js';
import { boundaryLift01 } from '../WorldMusic.js';

export { boundaryLift01 };

/** How hard the lit/dark split reads. Quiet vacuum is harsher. */
export function terminatorContrast(energy = 0) {
  return lerp(0.22, 0.10, clamp01(energy));
}

/**
 * Slow lighting of the primary and the lit face. Reveal is the shape
 * of a phrase; lift is whether the boundary earned one.
 */
export function illumination({ energy = 0, reveal = 0, lift = 0 } = {}) {
  return clamp01(0.20 + 0.48 * clamp01(energy) + 0.28 * clamp01(reveal) * clamp01(lift));
}

/**
 * How much of a crater-flash this accent has earned, 0..1.
 * Dense songs filter to a subset; sparse songs let a lone hit show.
 */
export function surfaceTrace(accent = 0, energy = 0) {
  const a = clamp01(accent);
  const floor = lerp(0.10, 0.58, clamp01(energy));
  if (a <= floor) return 0;
  return clamp01((a - floor) / Math.max(1e-6, 1 - floor));
}
