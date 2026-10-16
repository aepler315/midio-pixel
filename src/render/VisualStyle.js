// Single house look: CGI mountains + atmosphere, selective sky energy,
// solid ocean with soft wave contours. No classic/neon dual mode.
// Pure helpers + storage; Renderer / BiomeManager / MeshDrawer consume dials.
import { hexToRgb, rgbToHsl, hslToRgb, rgbToHex } from '../utils/color.js';

export const STYLE_CLASSIC = 'classic'; // kept for URL/storage compat → maps to house
export const STYLE_RENDERED = 'rendered';

/** Everything resolves to the one house look. */
export function resolveVisualStyle(_raw) {
  return STYLE_RENDERED;
}

export function getVisualStyle() {
  return STYLE_RENDERED;
}

export function isRendered(_style) {
  return true;
}

export function styleLabel(_style) {
  return 'Look: Midio';
}

/** Toggle is a no-op — one look only. */
export function nextVisualStyle(_style) {
  return STYLE_RENDERED;
}

/**
 * House presentation dials. One set for the whole show.
 */
export function styleDials(_style) {
  return {
    id: STYLE_RENDERED,
    // Post
    bloomBaseMul: 0.9,
    filmGradeMul: 1.45,
    vignetteDepthMul: 1.08,
    // Atmosphere
    hazeMul: 1.2,
    fogMul: 1.4,
    spaceWash: true,
    starAmbient: 1.6,
    oceanPresence: 1.55,
    // Characters — wireframe + glow. The world is a dense painterly stack
    // (haze, ocean, mountains, particles); strokes that look fine in
    // isolation vanish into it. These sit just above the previous 1.8/2.7
    // so the trio reads as figures on the ground, not scratches on it.
    glowHaloMul: 0.95,
    rimAmount: 0.95,
    widthBase: 2.2,
    widthGlow: 2.6,
    outlineWidthAdd: 3.4,
    // Ocean — water mass + soft contours. It's meant to anchor the ambience
    // between the cosmos and the ground, so it needs real contour
    // definition, not just a wash -- raised from a near-invisible 0.18/0.28.
    oceanLineAlpha: 0.42,
    oceanDrawContours: true,
    oceanBodyAlpha: 1.25,
    oceanReflect: 0.85,
    rowCountMul: 0.6,
    heatShimmerSlices: false,
    groundCrestCaps: true,
    massifCrestCaps: true,
    // Sky music
    horizonEqAlpha: 0.85,
    crestGlowAlpha: 0.55,
    crestStroke: true,
    spaceRidgeAlpha: 0.55,
    skyWireAlpha: 0.38,
  };
}

/** Darken/lighten a hex by shifting HSL lightness (delta in -1..1 space). */
export function shiftLightness(hex, delta) {
  const { r, g, b } = hexToRgb(hex);
  const hsl = rgbToHsl(r, g, b);
  const l = Math.max(0, Math.min(1, hsl.l + delta));
  const s = Math.max(0, Math.min(1, hsl.s + (delta < 0 ? 0.08 : -0.04)));
  const rgb = hslToRgb(hsl.h, s, l);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

/** Raises `hex` to at least `minL` HSL lightness, leaving anything already
 *  bright enough untouched.
 *
 *  A *relative* lift (shiftLightness) is not enough on its own for anything
 *  that must stay readable on every palette: +0.14 from a near-black
 *  silhouette is still near-black, so the darkest biomes' ground sank into
 *  the void -- especially under a bright ocean, where the eye's reference
 *  point is the water and everything below it reads as nothing at all.
 *  A floor is the only thing that holds regardless of what it started from. */
export function ensureMinLightness(hex, minL) {
  const { r, g, b } = hexToRgb(hex);
  const hsl = rgbToHsl(r, g, b);
  if (hsl.l >= minL) return hex;
  const rgb = hslToRgb(hsl.h, hsl.s, minL);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

/** Guarantees a silhouette (mountains, ground) never washes out against
 *  whatever it's sitting on -- a fixed authored color and a night-pulled sky
 *  can converge toward the same near-black at full night, on any biome whose
 *  palette happens to run dark. If the two are already within `minDelta` of
 *  each other's lightness, nudge `hex` further along its existing side of
 *  `againstHex` (lighter stays lighter, darker stays darker; a dead tie
 *  breaks lighter, since a silhouette going *toward* pitch black is exactly
 *  the failure this guards against) until the gap reopens. Already-readable
 *  pairs pass through untouched. */
export function ensureContrast(hex, againstHex, minDelta = 0.12) {
  const hsl = rgbToHsl(...Object.values(hexToRgb(hex)));
  const bgHsl = rgbToHsl(...Object.values(hexToRgb(againstHex)));
  const gap = hsl.l - bgHsl.l;
  if (Math.abs(gap) >= minDelta) return hex;
  const dir = gap >= 0 ? 1 : -1;
  return shiftLightness(hex, dir * (minDelta - Math.abs(gap)));
}
