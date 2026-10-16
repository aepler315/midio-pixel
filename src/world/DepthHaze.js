// Aerial perspective for the L2-L5 parallax mountain ranges (The Light
// Show, pass 1): without it every range paints the same flat silhouette
// tint and the world reads as a stack of same-color cutouts instead of
// receding into distance. A cheap sky-colored wash after each layer,
// strongest behind the farthest range and fading to nothing at the
// nearest, sells depth for the cost of a couple of gradient fills.
import { clamp01 } from '../utils/math.js';

// Relative share of the total atmosphere each layer sits behind -- a
// geometric-ish falloff (not linear), matching how real haze thickens
// faster than distance. L5 (nearest) never washes: it's the crisp
// foreground anchor the eye calibrates depth against.
export const HAZE_LAYER_FRAC = { L2: 1.00, L3: 0.55, L4: 0.24, L5: 0 };

export const HAZE_BASE_ALPHA = 0.23;  // strongest wash (right after L2), dial=1, calm=0
export const HAZE_CALM_BOOST = 0.45;  // calm sections thicken haze by up to +45%
export const HAZE_WARM_MIX = 0.5;     // cap on how far haze color pulls toward warm dawn/dusk tone
export const HAZE_WARM_COLOR = '#ffb37a'; // TWILIGHT's celestial.color -- warm peach, native to the palette
export const HAZE_EPS = 0.004;        // below this, skip the fillRect entirely

// Forward scatter: real atmosphere is far brighter looking toward the
// light than away from it. Capped in the neighbourhood of HAZE_BASE_ALPHA
// because this stacks across up to three layers and the frame already
// carries a bloom pass.
export const HAZE_SCATTER_MAX = HAZE_BASE_ALPHA * 0.6;
export const HAZE_SCATTER_RADIUS_FRAC = 0.62;

/** Wash alpha for one layer, before color. hazeMul is the per-biome
 *  PERSONALITY dial (default 1); calmLevel thickens it slightly. */
export function hazeAlpha(layerKey, hazeMul = 1, calmLevel = 0) {
  const frac = HAZE_LAYER_FRAC[layerKey] ?? 0;
  if (frac <= 0) return 0;
  const calmBoost = 1 + HAZE_CALM_BOOST * clamp01(calmLevel);
  return HAZE_BASE_ALPHA * frac * Math.max(0, hazeMul) * calmBoost;
}

/** How far the haze color should pull toward HAZE_WARM_COLOR, given
 *  dayArc()'s 0..1 hazeWarm curve (1 at dawn/dusk, 0 at zenith). */
export function hazeWarmMix(hazeWarm) {
  return clamp01(hazeWarm) * HAZE_WARM_MIX;
}

/** The scatter halo for one haze layer: real atmosphere is far brighter
 *  looking toward the light than away from it (forward scattering), which is
 *  the strongest single cue that a landscape is lit rather than tinted.
 *  Returns null -- a hard skip, no fill -- with no light, no intensity, or a
 *  layer that carries no haze. */
export function hazeScatter(layerKey, light, hazeMul = 1, canvasHeight = 0) {
  if (!light || !(light.intensity > 0) || !Number.isFinite(light.x) || !Number.isFinite(light.y)) {
    return null;
  }
  const frac = HAZE_LAYER_FRAC[layerKey] ?? 0;
  if (frac <= 0) return null;
  const mul = Math.max(0, hazeMul);
  if (!(mul > 0)) return null;
  const alpha = Math.min(
    HAZE_SCATTER_MAX,
    HAZE_SCATTER_MAX * frac * clamp01(light.intensity) * mul,
  );
  if (!(alpha > HAZE_EPS)) return null;
  return {
    cx: light.x,
    cy: light.y,
    radius: Math.max(0, canvasHeight) * HAZE_SCATTER_RADIUS_FRAC,
    alpha,
  };
}
