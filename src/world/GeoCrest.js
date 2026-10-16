// Pure math for the L4 crest: a smooth (seam-free) continuation of
// SilhouetteGenerator's noise ridge, plus a seeded set of geological
// features (cliffs, aretes, knobs, outcrops, terraces) whose height is
// driven by the 7-band spectrum -- the "geological equalizer". No canvas
// here; BiomeManager consumes these, tests exercise them directly.
import { clamp01, mulberry32 } from '../utils/math.js';
import {
  danceOffset, danceScale, columnHeight01At, DANCE_COL_W,
} from './MountainChoreo.js';

/** Smooth (cosine-interpolated) counterpart of SilhouetteGenerator's
 *  ridgeYAt -- that one rounds to the nearest sample (a visible step at
 *  8x zoom); this one blends between neighbors so the crest we stroke
 *  live never steps even though the baked ridge polygon still does.
 *  Wraps at the sample array's end (the noise tail is already blended
 *  back to the head -- SilhouetteGenerator.js -- so the wrap is seamless). */
export function ridgeYSmooth(ridge, x) {
  if (!ridge) return 0;
  const { heights, step, baseline, amplitude, height } = ridge;
  const n = heights.length;
  const terrain = ridge.source === 'terrain';
  const fi = terrain ? Math.max(0, Math.min(n - 1, x / step)) : x / step;
  const i0 = terrain ? Math.floor(fi) : ((Math.floor(fi) % n) + n) % n;
  const i1 = terrain ? Math.min(n - 1, i0 + 1) : (i0 + 1) % n;
  const f = fi - Math.floor(fi);
  const c = (1 - Math.cos(f * Math.PI)) / 2;
  const hVal = heights[i0] * (1 - c) + heights[i1] * c;
  return height * baseline - hVal * height * amplitude;
}

/**
 * The offset curve the blit actually paints.
 *
 * _drawDancingStrip draws each column with a vertical SHEAR: the column's
 * left edge sits at danceOffset(left boundary), its right edge at
 * danceOffset(right boundary), and everything between is the straight line
 * joining them. So the silhouette's offset is a piecewise-linear
 * interpolation of danceOffset sampled on the column-boundary grid, and this
 * function is that same interpolation -- not an approximation of it.
 *
 * It replaces a cosine blend between column CENTERS, which was wrong twice
 * over. The blit sampled each column's LEFT EDGE and held it constant across
 * the column, so the stroke was a ramp phase-shifted half a column from a
 * staircase: the two only touched by accident, and everywhere else the neon
 * crest line floated off the fill it was supposed to be tracing. That is the
 * "ridges not lining up with themselves" artifact.
 *
 * `colW` must be the width the blit is slicing at this frame
 * (PerfGovernor.danceColumnWidth), and must divide the strip width evenly --
 * see DANCE_COL_W's note on why.
 */
export function danceOffsetSmooth(stripX, tSec, groove, kick, cfg, fever = 0, colW = DANCE_COL_W) {
  const b0 = Math.floor(stripX / colW) * colW;
  const f = (stripX - b0) / colW;
  const o0 = danceOffset(b0, tSec, groove, kick, cfg, fever);
  const o1 = danceOffset(b0 + colW, tSec, groove, kick, cfg, fever);
  return o0 + (o1 - o0) * clamp01(f);
}

/** Smooth counterpart of MountainChoreo's danceScale (Stage 2 of the
 *  mountain overhaul): a cosine blend across column CENTERS, so each column's
 *  own raw danceScale value is reached exactly at its center.
 *
 *  Note this is NOT the same pattern as danceOffsetSmooth above, whatever an
 *  earlier version of this comment claimed -- that one blends linearly across
 *  column BOUNDARIES, which is precisely the shape a sheared blit can draw.
 *  This one cannot be drawn by the blit at all: a column is one drawImage with
 *  one straight top edge, and a curve whose extremum sits mid-column has no
 *  straight edge through it. Use `danceScaleRamp` for anything that has to
 *  line up with the painted fill; this function survives as the definition of
 *  the value AT a boundary, which is what that ramp interpolates between. */
export function danceScaleSmooth(ridge, stripX, transient, sustain, cfg, colW = DANCE_COL_W) {
  const c0 = Math.floor((stripX - colW / 2) / colW) * colW + colW / 2;
  const c1 = c0 + colW;
  const f = (stripX - c0) / colW;
  const w = (1 - Math.cos(clamp01(f) * Math.PI)) / 2;
  const s0 = danceScale(columnHeight01At(ridge, c0), transient, sustain, cfg);
  const s1 = danceScale(columnHeight01At(ridge, c1), transient, sustain, cfg);
  return s0 * (1 - w) + s1 * w;
}

/**
 * The per-column scale AS THE BLIT ACTUALLY PAINTS IT: linear between the
 * values at the column's two boundaries, exactly mirroring danceOffsetSmooth.
 *
 * This is the curve every overlay must trace. A dance column is a single
 * drawImage, so its top edge is a straight line; the sheared blit ramps that
 * edge between the boundary values, and nothing else is reachable. Overlays
 * that traced danceScaleSmooth's mid-column extremum instead were drawing a
 * silhouette that was never painted -- and because a scale multiplies HEIGHT
 * ABOVE THE FOOT, the gap was zero at the foot and widest at the summits, and
 * it grew with the kick: 0.4px at rest, 4.3px on a kick, quantized to the
 * column grid. That is the blocky flicker at the peaks.
 *
 * Sampling danceScaleSmooth at the boundaries means each boundary carries the
 * average of the two columns meeting there, so a column's center ends up at
 * (s[k-1] + 2*s[k] + s[k+1]) / 4 -- a centered smoothing of the column values,
 * with no half-column phase shift of where summits sharpen.
 */
export function danceScaleRamp(ridge, stripX, transient, sustain, cfg, colW = DANCE_COL_W) {
  const b0 = Math.floor(stripX / colW) * colW;
  const f = (stripX - b0) / colW;
  const s0 = danceScaleSmooth(ridge, b0, transient, sustain, cfg, colW);
  const s1 = danceScaleSmooth(ridge, b0 + colW, transient, sustain, cfg, colW);
  return s0 + (s1 - s0) * clamp01(f);
}

export const GEO_FEATURE_TYPES = ['cliff', 'arete', 'knob', 'outcrop', 'terrace'];
export const GEO_MAX_LIFT_PX = 46;

/** Seeded one-time assignment of the 7 bands to geological archetypes,
 *  each pinned to a jittered strip-space slot. Deterministic per seed --
 *  the same song always grows the same mountain. */
export function assignBandFeatures(seed) {
  const rand = mulberry32(seed);
  const order = [0, 1, 2, 3, 4, 5, 6];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.map((band, slot) => ({
    band,
    type: GEO_FEATURE_TYPES[Math.floor(rand() * GEO_FEATURE_TYPES.length)],
    u0: (((slot + 0.5) / 7 + (rand() - 0.5) * 0.08) % 1 + 1) % 1,
    halfWidth: 0.03 + rand() * 0.04,
  }));
}

/** Unit-height (0..1) profile of a geological archetype over local
 *  coordinate s in [-1, 1] (0 = feature center), with a slow, small
 *  breathing term so features are alive without wobbling like the
 *  music-synced ranges around them. */
export function featureShape(type, s, tSec = 0) {
  const breathe = 1 + 0.05 * Math.sin(tSec * 0.35 + s * 3);
  const as = Math.max(-1, Math.min(1, s));
  let v;
  switch (type) {
    case 'cliff': {
      // Flat bench, then a sharp near-vertical drop.
      if (as < 0.15) v = 1;
      else if (as > 0.35) v = 0;
      else v = 1 - (as - 0.15) / 0.20;
      break;
    }
    case 'arete': {
      v = Math.pow(Math.max(0, 1 - Math.abs(as)), 0.7);
      break;
    }
    case 'knob': {
      v = 0.5 + 0.5 * Math.cos(Math.PI * as);
      break;
    }
    case 'outcrop': {
      const dome = 0.5 + 0.5 * Math.cos(Math.PI * as);
      const notch = Math.exp(-Math.pow((as - 0.3) / 0.10, 2)) * 0.45;
      v = Math.max(0, dome - notch);
      break;
    }
    case 'terrace': {
      const dome = Math.max(0, 1 - Math.abs(as));
      v = Math.round(dome * 4) / 4;
      break;
    }
    default:
      v = 0;
  }
  return clamp01(v * breathe);
}

/** Wrapped signed distance from u to u0 in a periodic [0,1) space -- the
 *  shortest way around, so a feature straddling the u=0/1 seam still
 *  contributes correctly from both sides. */
function wrapDelta(u, u0) {
  let d = u - u0;
  d -= Math.round(d);
  return d;
}

/** Extra lift (px, >= 0) at strip position u01 in [0,1): the sum of every
 *  feature whose window covers u01, each scaled by its own band's live
 *  level. Zero between features -- the plain noise ridge shows through.
 *  Linear/angular interpolation only (no cosine ease): this is the
 *  opposite silhouette vocabulary from the horizon EQ's smooth aurora,
 *  by design (three equalizers, three different bodies of language). */
export function geoCrestOffset(u01, bands, features, tSec = 0) {
  let lift = 0;
  for (const f of features) {
    const d = wrapDelta(u01, f.u0);
    if (Math.abs(d) > f.halfWidth) continue;
    const s = d / f.halfWidth;
    const level = clamp01(bands ? bands[f.band] ?? 0 : 0);
    lift += GEO_MAX_LIFT_PX * level * featureShape(f.type, s, tSec);
  }
  return Math.min(GEO_MAX_LIFT_PX * 1.001, lift);
}
