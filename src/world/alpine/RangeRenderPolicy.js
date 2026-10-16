// Range v2 edge policy (natural-rendering Task 1). Decides how many
// multisamples the offscreen scenic target gets, and accounts for the memory
// that costs, before anything is allocated.
//
// Why multisampling and what keeps it honest:
// - The scene renders into an offscreen target (RangeScene.target), so the
//   canvas context's `antialias` flag never reached it; only the target's
//   own sample count does.
// - Partitions share one full-scene depth pre-pass, so each sample has
//   exactly one terrain owner. With samples, a pixel on a near ridge's
//   silhouette is split between two partitions (far 40 %, near 60 %).
//   Composited with source-over that would leave 0.4 * 0.6 = 24 % of
//   whatever was painted underneath (sky) showing through: a pale halo. The
//   pre-pass therefore also records which band owns each sample
//   (ownership), and the copy rescales a partition by the coverage still
//   left to it once nearer bands are painted, so disjoint coverage sums
//   exactly. See RangeScene._copyPartition.
// - Pixel and Palette looks render the scene into a deliberate low-res grid.
//   Smoothing their edges would blur that grid, so they never multisample.
// - Under load the governor's rungs shed the samples before anything else
//   the listener would notice (see rangeQuality / Task 6).

/** Most samples requested on any device. */
export const MAX_RANGE_SAMPLES = 4;

/** Physical pixels above which 4x falls back to 2x (memory and fill). */
export const MSAA_4X_PIXEL_LIMIT = 2560 * 1440;

/** Developer override: ?rangeMsaa=0|2|4 (anything else is ignored). */
export function msaaOverride(search = (typeof location !== 'undefined' ? location.search : '')) {
  try {
    const raw = new URLSearchParams(String(search || '').replace(/^\?/, '')).get('rangeMsaa');
    if (raw == null) return null;
    const n = Number(raw);
    return [0, 2, 4].includes(n) ? n : null;
  } catch { return null; }
}

/**
 * Sample counts this context can render RGBA8 colour and 24-bit depth at,
 * both. Returns the largest supported power of two <= MAX_RANGE_SAMPLES, or
 * 0 (no WebGL2 query, or no common count). Pure apart from the GL queries.
 */
export function supportedSamples(gl) {
  try {
    if (!gl || typeof gl.getInternalformatParameter !== 'function') return 0;
    const max = gl.getParameter(gl.MAX_SAMPLES) | 0;
    if (max < 2) return 0;
    const counts = (format) => Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER, format, gl.SAMPLES) || []);
    const colour = counts(gl.RGBA8), depth = counts(gl.DEPTH_COMPONENT24);
    let best = 0;
    for (const n of [2, 4]) if (n <= max && n <= MAX_RANGE_SAMPLES && colour.includes(n) && depth.includes(n)) best = n;
    return best;
  } catch { return 0; }
}

/**
 * The policy for one scenic target.
 * @param {object} o
 * @param {number} o.widthPx  physical width of the target
 * @param {number} o.heightPx physical height
 * @param {number} [o.quality=0] governor level (0 best .. 6)
 * @param {'desktop'|'mobile'} [o.budget='desktop']
 * @param {boolean} [o.pixelated=false] Pixel / Palette presentation
 * @param {number} [o.capability=0] supportedSamples() of the context
 * @param {number|null} [o.override=null] msaaOverride()
 * @returns {{ samples: number, reason: string }}
 */
export function rangeRenderPolicy({ widthPx, heightPx, quality = 0, budget = 'desktop', pixelated = false,
  capability = 0, override = null } = {}) {
  const cap = Math.max(0, Math.min(MAX_RANGE_SAMPLES, capability | 0));
  if (pixelated) return { samples: 0, reason: 'pixel-look' };
  if (cap < 2) return { samples: 0, reason: 'unsupported' };
  if (override != null) {
    const n = Math.min(cap, override);
    return { samples: n >= 2 ? n : 0, reason: 'override' };
  }
  const level = Math.max(0, Math.min(6, quality | 0));
  // Rung 3 already sheds fog samples and shafts for frame time: edges go
  // at the same point, never before the forest representation does.
  if (level >= 3) return { samples: 0, reason: 'quality' };
  let samples = budget === 'mobile' ? 2 : level <= 1 ? 4 : 2;
  if (widthPx * heightPx > MSAA_4X_PIXEL_LIMIT) samples = Math.min(samples, 2);
  samples = Math.min(samples, cap);
  return { samples: samples >= 2 ? samples : 0, reason: samples >= 2 ? 'natural' : 'unsupported' };
}

/**
 * Residency bytes for a main scenic target (colour RGBA8 + 24/8 depth, the
 * drawing buffer it is copied to, and with samples the multisample colour
 * and depth renderbuffers plus the band-ownership image).
 */
export function sceneTargetBytes(w, h, samples = 0) {
  const px = w * h;
  return px * 12 + (samples > 0 ? px * 8 * samples + px * 4 : 0);
}

/** Residency bytes for the travel side B target (no drawing buffer). */
export function sideTargetBytes(w, h, samples = 0) {
  const px = w * h;
  return px * 8 + (samples > 0 ? px * 8 * samples + px * 4 : 0);
}

/** Which bands are nearer than `pass` (rgb = far, mid, near ownership). */
export function nearerMask(pass) {
  return pass === 'far' ? [0, 1, 1] : pass === 'mid' ? [0, 0, 1] : [0, 0, 0];
}

/**
 * The copy's coverage correction, in JS (the GLSL twin is in RangeScene).
 * `rgba` is the partition's resolved premultiplied colour, `own` the
 * resolved ownership [far, mid, near] coverage, `mask` nearerMask(pass).
 */
export function correctCoverage(rgba, own, mask) {
  const nearer = own[0] * mask[0] + own[1] * mask[1] + own[2] * mask[2];
  const a = rgba[3];
  if (!(a > 0) || !(nearer > 0)) return rgba.slice();
  const gain = Math.min(1 / Math.max(1 - nearer, 1 / 255), 1 / a);
  return rgba.map(v => v * gain);
}
