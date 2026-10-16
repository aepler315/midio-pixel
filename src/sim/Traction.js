// Slippery surfaces: when snow has been falling long enough to settle (or
// the biome is frozen to begin with), the ground stops gripping. Pure math
// here; Simulation owns the state and BiomeManager draws the frost.
//
// The skid is deliberately RENDER-ONLY displacement: Midio's world position,
// collision box, and the chart's clearance guarantee never see it. What the
// player reads as "he landed and slid" is a bounded screen-space offset that
// eases out and returns to zero -- all slide, no gameplay risk.
import { clamp01 } from '../utils/math.js';

export const SKID_MAX_PX = 26;       // the hard rail on screen offset
export const SKID_MIN_COVER = 0.25;  // below this much settled snow, boots still grip
export const SKID_BASE_MS = 300;
export const SKID_COVER_MS = 320;    // deeper cover -> longer slide

/**
 * The skid's screen offset at progress u (0..1): a fast slide out that
 * peaks around u=0.4 with a small settle wobble on the way back -- the
 * shape of catching your footing, not a clean parabola. 0 outside [0,1].
 */
export function skidOffset(u) {
  if (!(u > 0) || u >= 1) return 0;
  const main = Math.sin(Math.PI * Math.min(1, u * 1.25)) * (1 - 0.55 * u);
  const wobble = u > 0.55 ? 0.12 * Math.sin((u - 0.55) * Math.PI * 4) * (1 - u) : 0;
  return main + wobble;
}

/**
 * Landing skid parameters for a landing of intensity I (ImpactFX 0..1) on
 * `snowCover` (0..1 settled snow). Null when the ground still grips --
 * light cover or a soft landing produces no slide at all.
 */
export function skidParams(snowCover, intensity) {
  if (!(snowCover >= SKID_MIN_COVER) || !(intensity > 0.15)) return null;
  const cover = clamp01(snowCover);
  return {
    amp: Math.min(SKID_MAX_PX, (7 + 22 * clamp01(intensity)) * cover),
    durMs: SKID_BASE_MS + SKID_COVER_MS * cover,
  };
}

/** How much grip remains under `snowCover` of settled snow: 1 = dry rock,
 *  floors at 0.3 -- fully iced but never frictionless (nobody moonwalks). */
export function tractionFrom(snowCover) {
  return 1 - 0.7 * clamp01(snowCover);
}
