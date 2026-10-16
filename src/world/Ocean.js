// Pure math for the far-distance ocean: an abstract field of horizontal
// wave-contour rows receding toward a high horizon, seen through/behind the
// mountain silhouettes -- like an infinite flat plane of water in
// perspective. No canvas here; BiomeManager consumes these, tests exercise
// them directly.
import { clamp01, mulberry32 } from '../utils/math.js';

export const OCEAN_HORIZON_FRAC = 0.3781;
// Near edge sits mid-frame so water stays legible between mountain gaps
// instead of living only as a thin strip under the sky. Rows still pack
// denser toward the horizon; foreground L4/L5 occlude the lowest portion.
// Slightly larger plane so the ocean vibe reads as a world, not a ribbon --
// enough survives behind L4/L5 to hold the middle distance between the
// cosmos and the ground instead of reading as a thin band.
export const OCEAN_NEAR_FRAC = 0.7781;

/** Peak absolute contribution of each harmonic in seaLineY (pre-amp). Kept
 *  as named constants so tests can pin the bound without re-deriving.
 *  Large enough that the three summed sines read as actual undulating
 *  waves at a glance -- the original magnitudes (2.2/1.4/0.85, ~4.5px sum)
 *  were nearly invisible against the perspective row spacing and read as
 *  flat lines with a faint wobble, not waves. */
export const SEA_H1 = 6.5;
export const SEA_H2 = 4.0;
export const SEA_H3 = 2.4;
export const SEA_LINE_MAX = SEA_H1 + SEA_H2 + SEA_H3;

/** Vertical offset (px) of a wave row at horizontal position u01 in [0,1)
 *  -- three summed sines, all integer multiples of 2*pi over u so the curve
 *  is exactly periodic (no seam when a row wraps under parallax scroll).
 *  Amplitude breathes with the bass; a kick presses the whole line down
 *  slightly, like a distant swell settling. */
export function seaLineY(u01, tSec, bass, kick = 0) {
  const b = clamp01(bass);
  const amp = 0.35 + 0.65 * b;
  const wave = SEA_H1 * Math.sin(u01 * Math.PI * 2 * 3 + tSec * 0.5)
    + SEA_H2 * Math.sin(u01 * Math.PI * 2 * 7 - tSec * 0.9)
    + SEA_H3 * Math.sin(u01 * Math.PI * 2 * 11 + tSec * 1.35);
  return wave * amp - 2.5 * clamp01(kick);
}

/** Extra crest lift (px, >=0) for occasional breakers on mid/near rows.
 *  Integer cycles over u keep the field seamless; energy (0..1) opens the
 *  peaks without ever exceeding the hard cap. */
export function breakerLift(u01, tSec, energy = 0.5) {
  const e = clamp01(energy);
  // Sparse sharp peaks: high-frequency envelope, low-frequency gate.
  const gate = Math.max(0, Math.sin(u01 * Math.PI * 2 * 2 + tSec * 0.35));
  const spike = Math.pow(gate, 6);
  return spike * (1.2 + 2.4 * e);
}

/** Foam/whitecap presence (0..1) at a sample -- denser on nearer rows
 *  (low rowFrac) and only at crest-like phases so flecks read as foam, not
 *  salt scatter. Pure and cheap for draw-side sampling. */
export function whitecapMask(u01, tSec, rowFrac = 0.5) {
  const near = clamp01(1 - rowFrac); // 1 nearest, 0 at horizon
  const crest = 0.5 + 0.5 * Math.sin(u01 * Math.PI * 2 * 5 - tSec * 1.7);
  // Soft threshold: only the upper crest third lights up.
  const foam = clamp01((crest - 0.62) / 0.38);
  return foam * foam * (0.25 + 0.75 * near);
}

/** Mild per-row phase drift (radians-ish, added into u) so stacked rows
 *  don't lock into a single traveling pattern forever. Deterministic in
 *  (row index, tSec). */
export function rowPhaseDrift(rowIndex, tSec) {
  return 0.04 * Math.sin(tSec * 0.17 + rowIndex * 1.7)
    + 0.025 * Math.sin(tSec * 0.31 + rowIndex * 2.3);
}

/** Row baselines (screen y, px) for `count` wave rows receding from a near
 *  edge to a distant horizon, projected 1/z-style so the gaps between rows
 *  strictly shrink toward the horizon -- the perspective compression that
 *  reads as an infinite flat plane. Row 0 is nearest (largest y, closest to
 *  `nearY`); the last row approaches `horizonY` but never reaches it. */
export function oceanRowYs(horizonY, nearY, count, g = 1.5) {
  const n = Math.max(1, count | 0);
  const span = nearY - horizonY;
  const out = new Array(n);
  for (let j = 0; j < n; j++) {
    const d = Math.pow(g, j);
    out[j] = horizonY + span / d;
  }
  return out;
}

/** Seeded per-row descriptors for the wave field -- deterministic per song. */
export function waveRows(seed, count = 14) {
  const rand = mulberry32(seed >>> 0);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      uPhase: rand(),
      speedMul: 0.6 + rand() * 1.0,
      ampMul: 0.7 + rand() * 0.6,
      alphaMul: 0.75 + rand() * 0.4,
    });
  }
  return out;
}

/** Opacity envelope (0..1) across the row stack, indexed near-to-far
 *  (i=0 nearest). Fades toward the horizon (distance haze) and tapers for
 *  the very nearest rows (mostly occluded by foreground silhouettes
 *  anyway), peaking in the upper-middle of the stack where the field is
 *  actually visible above the ridgelines. */
export function rowAlpha(i, count) {
  const n = Math.max(1, count);
  const u = n <= 1 ? 0.35 : i / (n - 1); // 0 near, 1 far/horizon
  const PEAK_U = 0.32;
  // Presence floor keeps the plane readable even at the horizon / feet.
  let a;
  if (u <= PEAK_U) {
    const t = u / PEAK_U;
    a = 0.42 + 0.58 * Math.sin(t * Math.PI / 2); // nearest rows taper in, but stay present
  } else {
    const t = (u - PEAK_U) / (1 - PEAK_U);
    a = 0.14 + 0.86 * (1 - t) * (1 - t); // fades toward the horizon, never vanishing
  }
  return clamp01(a);
}
