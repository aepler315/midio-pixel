// Contact shadows (The Light Show, pass 4): a soft ground-anchored ellipse
// per character that fades and shrinks with height above the local
// terrain, so jumps/hops/flight read as leaving the ground instead of
// floating. Pure and stateless -- mirrors MountainChoreo's danceOffset
// (numbers in, a plain object out; the caller owns ctx).
import { clamp, smoothstep } from '../utils/math.js';
import { lightDirTo } from '../render/LightField.js';

// Absolute px above ground at which the shadow has fully vanished. Chosen
// so a soft hop (Midio's weakest kick, apex ~83px) keeps a dimming-but-
// present shadow through the whole arc, while a hard jump (apex ~193px)
// is fully shadow-less at the hang -- no shadow dragged into the sky.
export const SHADOW_FADE_HEIGHT_PX = 130;
// Footprint radius as a fraction of the character's on-screen width --
// narrower than the full silhouette span, since none of the three meshes
// are footprint-shaped (spiky crowns/haunches splay well past the feet).
export const SHADOW_WIDTH_FRAC = 0.46;
export const SHADOW_ASPECT = 0.32;   // ry = rx * SHADOW_ASPECT -- a flattened ~1:3 oval
export const SHADOW_RX_MIN = 10;     // px floor (guards Midasus's tiny hexagram)
export const SHADOW_RX_MAX = 48;     // px ceiling (headroom against future width inputs)
export const SHADOW_ALPHA_MAX = 0.36; // peak opacity directly underfoot
export const SHADOW_HEIGHT_SHRINK = 0.35; // fraction the ellipse shrinks from grounded to fully faded
// How far the ellipse slides along the light's travel direction, per px of
// height above the ground. Grounded characters keep the shadow at their
// feet; a mid-jump throws it further away from the celestial.
export const SHADOW_CAST_PER_PX = 0.38;
// Sunset elongation: at the horizon the ellipse is this fraction longer
// than at zenith. The celestial's own y-frac range is small (DayNight
// parks zenith at 0.12 and the sea horizon at 0.26), so the stretch is
// keyed off that full span rather than raw screen y.
export const SHADOW_HORIZON_STRETCH = 0.55;
export const SHADOW_ZENITH_YFRAC = 0.12;
export const SHADOW_HORIZON_YFRAC = 0.26;

/**
 * @param {number} screenX          character's screen-space x (shadow center)
 * @param {number} groundY          local ground y at screenX (shadow center)
 * @param {number} heightAbove      px above ground the character currently is
 * @param {number} characterWidthPx character's current on-screen width
 * @param {{x:number,y:number,celestialYFrac?:number}|null} [light]
 *        optional celestial (or any screen-space light). Omitted / null
 *        reproduces the original underfoot ellipse exactly.
 * @returns {{cx:number, cy:number, rx:number, ry:number, alpha:number}}
 */
export function contactShadow(screenX, groundY, heightAbove, characterWidthPx, light = null) {
  const h = Number.isFinite(heightAbove) ? Math.max(0, heightAbove) : 0;
  const visibility = 1 - smoothstep(0, SHADOW_FADE_HEIGHT_PX, h);
  if (visibility <= 0) {
    return { cx: screenX, cy: groundY, rx: 0, ry: 0, alpha: 0 };
  }

  const w = Number.isFinite(characterWidthPx) ? Math.max(0, characterWidthPx) : 0;
  const rxBase = clamp(w * SHADOW_WIDTH_FRAC, SHADOW_RX_MIN, SHADOW_RX_MAX);
  const shrink = 1 - SHADOW_HEIGHT_SHRINK * (1 - visibility);
  let rx = rxBase * shrink;
  let cx = screenX;

  if (light && Number.isFinite(light.x) && Number.isFinite(light.y)) {
    // lightDirTo points FROM the light TOWARD the feet -- the direction
    // the shadow is thrown. cy stays on the ground plane: a contact
    // shadow that climbed into the air would read as a floating stain.
    const dir = lightDirTo(light, screenX, groundY);
    cx = screenX + dir.x * SHADOW_CAST_PER_PX * h;
    const yFrac = light.celestialYFrac;
    if (Number.isFinite(yFrac)) {
      const span = SHADOW_HORIZON_YFRAC - SHADOW_ZENITH_YFRAC;
      const low = span > 0 ? clamp((yFrac - SHADOW_ZENITH_YFRAC) / span, 0, 1) : 0;
      rx *= 1 + SHADOW_HORIZON_STRETCH * low;
    }
  }

  const ry = rx * SHADOW_ASPECT;
  return { cx, cy: groundY, rx, ry, alpha: SHADOW_ALPHA_MAX * visibility };
}
