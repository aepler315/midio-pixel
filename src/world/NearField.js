import { resolveLandscapePresentation } from './LandscapePresentation.js';
// Near-field foreground occluders: the one classic side-scroller depth cue
// this game didn't have -- something large sweeping past IN FRONT of the
// characters. L7 (the old drawForeground) was three blurred white ellipses
// standing in for a whole parallax layer; everything else (L2-L5) got a
// real generated silhouette with biome-specific landmarks (Landmarks.js).
// This gives the frontmost layer the same treatment, reusing those exact
// landmark painters -- just huge, near-black, and drawn directly at a
// faster-than-character scroll ratio instead of baked into a tileable
// strip, since these have to occlude Midio as they cross him.
//
// Placement follows FarVignettes.js's architecture exactly: a seeded sector
// grid of SCROLLED space, so the same file always hides the same shapes in
// the same places (a replay can be pointed at: "the crystal spire is right
// after the second chorus"). Unlike FarVignettes, a sector's SHAPE also
// depends on which biome is showing when the sector first comes into view
// -- captured once and cached forever, so a later biome change never
// retroactively reskins something already placed.
import { mulberry32, hashSeed, clamp01 } from '../utils/math.js';
import { hexLerp } from '../utils/color.js';
import { LANDMARKS } from './Landmarks.js';
import { identityFor } from './WorldIdentity.js';
import { drawWorldProp } from './ForegroundProps.js';
import { biomeByName } from './BiomeProfiles.js';

export const NEARFIELD_RATIO = 1.42; // faster than L7's veil (1.20) and the L6 characters (1.00)
export const SECTOR_PX = 820;
export const PROP_CHANCE = 0.4;
// Near-field silhouettes read as underexposed/backlit against everything
// behind them -- the classic "closer = darker" foreground convention.
// A linear-light lerp toward black (not an HSL lightness subtraction):
// biome silhouette colors are already dark to begin with, and shifting
// lightness by a fixed amount clamps most of them to indistinguishable
// pure black. Lerping preserves each biome's hue even this close to black.
const TINT_TOWARD_BLACK = 0.55;
const MIN_SCALE = 3.2, MAX_SCALE = 5.2; // vs. ~1 for the baked L4/L5 landmarks
// The same near-black outline vocabulary MeshDrawer's `outline` option
// gives the characters (rgba(7,10,20,0.85), drawn UNDER the real color) --
// so the frontmost occluders read with the same razor-sharp-against-glow
// silhouette quality the trio already has, instead of a flat, soft-edged
// cutout. Landmark painters build and fill/stroke their own paths
// internally rather than returning them for a caller to re-stroke, so
// this reuses them as-is: the same deterministic painter (same seed, so
// identical shape) run once bigger in near-black underneath, then once
// at normal scale in the real color on top -- a rim, not a true uniform-
// width stroke, but self-contained to this file rather than touching
// every shared painter in Landmarks.js.
export const OUTLINE_COLOR = 'rgba(7,10,20,0.85)';
const OUTLINE_SCALE_MUL = 1.08;

/**
 * What (if anything) occupies one sector, given whichever biome is showing
 * when the sector is first queried. Pure + deterministic.
 *
 * A hard readability floor: two occupied sectors are never adjacent, so
 * there is always at least one full clear sector (SECTOR_PX of scrolled
 * space) between two props -- Midio can never be boxed in by consecutive
 * occluders, regardless of how the dice land.
 *
 * @returns {?{biomeName:string, hang:boolean, painterIdx:number,
 *   offset01:number, flip:boolean, scale:number, seed:number}}
 */
export function nearFieldForSector(songSeed, sectorIdx, biomeName, prevOccupied = false) {
  if (sectorIdx < 1 || prevOccupied) return null; // never the opening screenful, never back-to-back
  const painters = LANDMARKS[biomeName];
  if (!painters || painters.length === 0) return null;
  const rand = mulberry32(hashSeed(`${songSeed}:nearfield:${sectorIdx}`));
  if (rand() >= PROP_CHANCE) return null;
  return {
    biomeName,
    hang: rand() < 0.35, // most props root from the ground; some hang from the top
    painterIdx: Math.floor(rand() * painters.length),
    offset01: 0.1 + rand() * 0.8,
    flip: rand() < 0.5,
    scale: MIN_SCALE + rand() * (MAX_SCALE - MIN_SCALE),
    seed: Math.floor(rand() * 0xffffffff),
  };
}

export class NearField {
  constructor(songSeed, world = null) {
    this.presentation = resolveLandscapePresentation(world);
    this.identity = world ? identityFor(world) : null;
    this.songSeed = songSeed;
    this._cache = new Map(); // sectorIdx -> descriptor|null
    this._colorCache = new Map(); // biomeName -> darkened silhouette hex
  }

  _sector(idx, biomeName) {
    if (!this.presentation.artificialNearProps && ['city', 'strip', 'foundry', 'nave'].includes(this.identity?.kind)) return null;
    if (!this._cache.has(idx)) {
      // A consecutive run of eligible sectors alternates occupied/empty.
      // Walk only to the first failed roll, without caching unseen geometry.
      let run = 0;
      for (let previous = idx - 1; previous >= 1; previous--) {
        const rand = mulberry32(hashSeed(`${this.songSeed}:nearfield:${previous}`));
        if (rand() >= PROP_CHANCE) break;
        run++;
      }
      const prev = run % 2 === 1;
      const descriptor = nearFieldForSector(this.songSeed, idx, this.identity ? 'JADE' : biomeName, !!prev);
      if (descriptor && this.identity) {
        descriptor.biomeName = biomeName;
        descriptor.kind = this.identity.kind;
        descriptor.hang = descriptor.hang && this.identity.foreground.hanging;
      }
      this._cache.set(idx, descriptor);
    }
    return this._cache.get(idx);
  }

  _colorFor(biomeName) {
    let c = this._colorCache.get(biomeName);
    if (!c) {
      const b = biomeByName(biomeName);
      c = hexLerp(b ? b.silhouette : '#000000', '#000000', TINT_TOWARD_BLACK);
      this._colorCache.set(biomeName, c);
    }
    return c;
  }

  /**
   * @param env {{tSec:number, kick:number, biomeName:string,
   *   reducedMotion?:boolean, ratio?:number}} biomeName is the CURRENTLY
   *   dominant biome -- only consulted the first time a given sector comes
   *   into view. `ratio` overrides NEARFIELD_RATIO (CodaDirector's ending
   *   delamination nudges every layer's ratio apart from the rest).
   */
  draw(ctx, canvas, worldX, env) {
    const scroll = worldX * (env.ratio || NEARFIELD_RATIO);
    const first = Math.floor((scroll - 400) / SECTOR_PX);
    const last = Math.floor((scroll + canvas.width + 400) / SECTOR_PX);
    for (let idx = first; idx <= last; idx++) {
      const d = this._sector(idx, env.biomeName);
      if (!d) continue;
      const x = idx * SECTOR_PX + d.offset01 * SECTOR_PX - scroll;
      this._drawOne(ctx, canvas, d, x, env);
    }
  }

  _drawOne(ctx, canvas, d, x, env) {
    if (d.kind) {
      const height = canvas.height * this.identity.foreground.maxHeight * (d.scale / MAX_SCALE);
      const motion = env.reducedMotion ? 0 : Math.sin(env.tSec * 0.6 + d.seed) * 2;
      ctx.save();
      ctx.translate(x + motion, d.hang ? 0 : canvas.height);
      // Narrow coverage leaves the landmark and cast visible between props.
      ctx.scale(Math.min(height * 0.65, canvas.width * 0.09) / 100 * (d.flip ? -1 : 1), height / 100 * (d.hang ? -1 : 1));
      ctx.fillStyle = env.silhouette ? hexLerp(env.silhouette, '#000000', TINT_TOWARD_BLACK) : this._colorFor(d.biomeName);
      drawWorldProp(ctx, d.kind, d.seed);
      ctx.restore();
      return;
    }
    const painters = LANDMARKS[d.biomeName];
    const painter = painters[d.painterIdx % painters.length];
    const color = this._colorFor(d.biomeName);
    // A little life so a huge static silhouette doesn't read as a cardboard
    // cutout: a slow sway, plus a small kick-synced nudge like everything
    // else in this file reacts to the beat.
    const motionMul = env.reducedMotion ? 0.35 : 1;
    const sway = Math.sin(env.tSec * 0.6 + d.seed) * 3 * motionMul;
    const kickNudge = (env.kick || 0) * 4 * motionMul;

    const paint = () => {
      // Outline first (bigger, near-black), real color on top at normal
      // scale -- see OUTLINE_COLOR's comment above. Both calls get a
      // freshly re-seeded generator so their random structure (branch
      // counts, proportions) matches exactly; only the scale differs.
      painter(ctx, 0, 0, d.scale * OUTLINE_SCALE_MUL, mulberry32(d.seed), OUTLINE_COLOR);
      painter(ctx, 0, 0, d.scale, mulberry32(d.seed), color);
    };

    ctx.save();
    ctx.translate(x + sway, 0);
    if (d.flip) ctx.scale(-1, 1);
    if (d.hang) {
      // Every painter grows AWAY from rootY in its own local -y direction
      // (up). Flipping Y turns that into "down" on screen, so with the root
      // pinned near y=0 the shape hangs from the ceiling and grows toward
      // the floor -- the same painters L4/L5 already use, just inverted.
      ctx.translate(0, kickNudge); // a small downward dip on the beat, like a swing
      ctx.scale(1, -1);
      paint();
    } else {
      // Root pinned near the bottom edge; the painter's own "grow up" is
      // already the right direction here, no flip needed.
      ctx.translate(0, canvas.height - kickNudge); // a small lift on the beat, like a footfall
      paint();
    }
    ctx.restore();
  }
}
