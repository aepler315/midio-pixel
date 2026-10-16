// The fata morgana: a pale, jagged, snow-capped mountain range hovering
// right at the ocean's own horizon -- not a second landmass, but a MIRAGE
// of the far shore itself (FarShore.js). A real superior Fata Morgana is
// warm-over-cold atmospheric refraction lifting and stretching a remote
// coastline that lies below the horizon's true reach: the same shape,
// drawn unnaturally crisp, doubled, and inverted above/beneath itself.
// BiomeManager therefore feeds this module the SAME farShoreRecipe the
// dark, curvature-cropped shoreline below is built from -- the mirage is
// literally a ghost of what is really out there, not an invented range.
// Only the crest-detail is procedural (a mirage resolves detail the naked
// eye could never see at that distance, which is precisely why it reads
// as impossible).
//
// Pure math only -- BiomeManager clips, warps and fills it; tests exercise
// the silhouette and shimmer directly.
import { mulberry32, clamp01 } from '../utils/math.js';
import { farShoreHeight01, FAR_SHORE_TILE_PX } from './FarShore.js';

// A mirage does not creep past like scenery, it simply hangs there -- but
// it IS the far shore, so it rides the shore's own (nearly static) parallax
// rather than a separate, disconnected crawl. BiomeManager now passes the
// same FAR_SHORE_PARALLAX scroll it uses for the shoreline itself.
export const MIRAGE_PARALLAX = 0.012;

// The silhouette tiles over the same span as the far shore it mirrors.
export const MIRAGE_TILE_PX = FAR_SHORE_TILE_PX;

/**
 * Seeded crest recipe: only the fine, jagged detail a real mirage invents
 * on top of the landmass it refracts. The underlying mass comes from
 * FarShore.farShoreHeight01 so the mirage is a ghost of the actual shore.
 */
export function mirageRecipe(seed) {
  const rand = mulberry32(seed >>> 0 || 1);
  return {
    grainPhase: rand() * Math.PI * 2,
    shimmerPhase: rand() * Math.PI * 2,
    // How much the crest is chewed into impossibly crisp teeth (0..1,
    // varied per range so it never looks like one flat rule).
    jag: 0.5 + rand() * 0.5,
    snowFrac: 0.30 + rand() * 0.18,
  };
}

/**
 * Silhouette height at fractional position u (0..1, wraps), built from the
 * REAL far-shore mass plus the mirage's own fine crest. `shoreRecipe` is
 * the FarShore recipe; when absent we fall back to a modest smooth rise so
 * the function stays defined standalone (tests exercise it both ways).
 *
 * The result is roughly 0..1.8: the refracted image is stretched taller
 * than the shore it mirrors (a superior mirage vertically magnifies), but
 * capped so it never fills the sky.
 */
export function mirageHeight01(shoreRecipe, recipe, u) {
  const uu = ((u % 1) + 1) % 1;
  // The underlying landmass, stretched up (superior mirages magnify vertically).
  // Standalone (no shore recipe) it falls back to a modest smooth rise so the
  // function stays defined -- BiomeManager always passes the real one.
  const base = shoreRecipe ? farShoreHeight01(shoreRecipe, uu) : (0.5 + 0.5 * Math.sin(uu * Math.PI * 2 * 3));
  let h = base * 1.18;
  // The mirage's signature: a fine, jagged crest shaved along the top of
  // the real mass. Refraction resolves detail the eye has no business seeing
  // this far off -- the crispness is the illusion's tell.
  const jag = recipe ? (0.4 + 0.6 * (recipe.jag ?? 0.7)) : 0.6;
  const crest = Math.pow(clamp01(h / 1.2), 0.6); // strongest where the mass is tallest
  h += crest * jag * 0.10
    * (0.55 * Math.sin(uu * 61 + (recipe?.grainPhase ?? 0))
       + 0.30 * Math.sin(uu * 141 - (recipe?.grainPhase ?? 0) * 1.7)
       + 0.15 * Math.sin(uu * 233 + (recipe?.grainPhase ?? 0) * 0.6));
  return Math.min(1.8, Math.max(0, h));
}

/**
 * Heat-shimmer vertical displacement (px, signed) for one column, as a
 * function of its position and time. Slow and lazy -- a real mirage
 * wavers over seconds, not the fast flicker a "glitch" would read as -- and
 * built from two mismatched periods so it never repeats in an obviously
 * mechanical way.
 */
export function mirageShimmerPx(recipe, u, tSec, ampPx) {
  const uu = ((u % 1) + 1) % 1;
  const a = Math.sin(uu * 23 + tSec * 0.17 + recipe.shimmerPhase);
  const b = Math.sin(uu * 11 - tSec * 0.09 + recipe.shimmerPhase * 1.7);
  return (a * 0.6 + b * 0.4) * ampPx;
}

/**
 * Slow breathing presence (0..1) -- how strongly the mirage is "resolved"
 * right now, on a long, quiet cycle so it fades in and out of legibility
 * rather than snapping on and off like a rendered layer.
 */
export function miragePresence01(tSec, periodSec = 37) {
  return 0.5 + 0.5 * Math.sin((tSec / periodSec) * Math.PI * 2);
}

/**
 * Megalophobic motion, lifted from SpaceRidge: the thing reads as "too large
 * to be nearby" not from pixel height but from how SLOWLY it moves. A real
 * mirage stretches, hangs, and sags on the order of a minute as the air
 * column drifts -- never the fast flicker of a rendered layer. Two
 * incommensurate periods so it never repeats on an obvious cycle (the same
 * reason SpaceRidge's tidal drift uses 19s/47s, and its dolly 31s).
 */

// Whole-band vertical bob (px), fraction of canvas height. Two slow periods
// summed; amplitude deliberately tiny -- vastness reads through patience.
export function mirageDriftPx(tSec, canvasHeight) {
  const amp = Math.max(2, canvasHeight * 0.006);
  const w1 = (2 * Math.PI) / 23;
  const w2 = (2 * Math.PI) / 41;
  return amp * (0.6 * Math.sin(tSec * w1) + 0.4 * Math.sin(tSec * w2 + 1.7));
}

// Slow vertical stretch/squeeze (the classic mirage "towering"): a scale on
// the silhouette's height that breathes in and out over ~31s. Pure; draw
// applies it. 1±~0.05 -- enough to read as the image growing without ever
// becoming a jump.
export function mirageStretch01(tSec) {
  return 1 + 0.05 * Math.sin((tSec * 2 * Math.PI) / 31 + 0.6);
}
