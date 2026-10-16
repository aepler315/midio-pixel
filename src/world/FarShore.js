// The far shore: an impossibly distant mountain range on the far side of
// the ocean. So far away that only its tallest masses clear the horizon at
// all -- everything below the curvature line is simply gone, the same way
// a ship's hull vanishes before its masts do. What's left reads as vague,
// massive, and a little wrong to look at: a shape too big to have a shape,
// sitting right at the edge of visibility.
//
// Pure math only -- BiomeManager clips and fills it; tests exercise the
// silhouette directly.
import { mulberry32, clamp01 } from '../utils/math.js';

// Barely moves. At a real distance like this, the world would have to
// scroll for hours before the shore's own parallax became visible at all --
// this is a full order of magnitude slower than the spectrum massif's
// already-glacial 0.03 ratio.
export const FAR_SHORE_PARALLAX = 0.012;

// The silhouette tiles over this many px of (slow) scrolled space.
export const FAR_SHORE_TILE_PX = 2600;

/**
 * Seeded silhouette recipe: a handful of broad, irregular masses. Never
 * fine jagged teeth -- at this distance detail has already dissolved into
 * haze, and only the gross shape of the land survives.
 */
export function farShoreRecipe(seed) {
  const rand = mulberry32(seed >>> 0 || 1);
  const lobeCount = 4 + Math.floor(rand() * 3); // 4-6 broad masses
  const lobes = [];
  for (let i = 0; i < lobeCount; i++) {
    lobes.push({
      center: rand(),
      width: 0.10 + rand() * 0.20,
      height: 0.5 + rand() * 1.0,
    });
  }
  return { lobes, grainPhase: rand() * Math.PI * 2 };
}

/**
 * Silhouette height at fractional position u (0..1, wraps): >=0, roughly
 * 0..1.6. Each lobe is a smooth bump (a mass, not a spike); a little fine
 * grain on top keeps it from reading as a cartoon dome.
 */
export function farShoreHeight01(recipe, u) {
  const uu = ((u % 1) + 1) % 1;
  let h = 0;
  for (const lobe of recipe.lobes) {
    let d = Math.abs(uu - lobe.center);
    d = Math.min(d, 1 - d); // wrap around the tile
    const t = clamp01(1 - d / Math.max(0.02, lobe.width));
    const smooth = t * t * (3 - 2 * t);
    h += lobe.height * smooth;
  }
  h += 0.05 * Math.sin(uu * 41 + recipe.grainPhase) + 0.03 * Math.sin(uu * 97 - recipe.grainPhase);
  // Overlapping lobes can stack; capped so the range stays "massive," not
  // "fills the entire sky whenever two masses happen to line up."
  return Math.min(1.6, Math.max(0, h));
}

/**
 * Slow breathing presence (0..1) -- a very long, quiet pulse so the shore
 * feels alive/watching rather than static wallpaper, without ever reading
 * as an animation. periodSec is on the order of a minute by design.
 */
export function farShorePulse01(tSec, periodSec = 48) {
  return 0.5 + 0.5 * Math.sin((tSec / periodSec) * Math.PI * 2);
}
