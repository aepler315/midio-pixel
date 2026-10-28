// Ridge crest line: the pure math behind Landscape's high-resolution crest
// and shoreline strokes (docs/pixel-presentation.md, "Crest line"). No DOM,
// no canvas: every function here works on typed arrays so it can be tested
// directly and so a frame's result can be frozen and redrawn exactly by a
// recording.
//
// Conventions. A crest is stored per column as the y of the land boundary
// in pixel-edge units: y = c means the boundary runs along the top edge of
// row c, which is where a nearest-sampled raster puts it when its first
// covered row is c. NaN means "no crest in this column".
import { MIDIO_IDENTITY_HUE, HAZARD_HUE, REWARD_HUE } from './ColorLaw.js';
import { rgbToHsl, hslToRgb } from '../utils/color.js';

export const CREST_BANDS = Object.freeze(['far', 'mid', 'near']);

/** Width (output px at 1080 lines) and opacity ranges, lowest to highest
 *  rank. Each band's range is entered by `e` (crestE). The skyline (a crest
 *  whose upper side is sky) outranks every band in opacity, at a thinner
 *  width than the near band. Never driven by music. */
export const CREST_TIERS = Object.freeze({
  far: Object.freeze({ width: [1.0, 1.5], alpha: [0.35, 0.50] }),
  mid: Object.freeze({ width: [1.5, 2.25], alpha: [0.50, 0.70] }),
  near: Object.freeze({ width: [2.0, 3.0], alpha: [0.70, 0.90] }),
  // Outranks every near stroke in opacity. Its width is half the 3.0-3.5 px
  // it first had: a thinner line against the sky reads cleaner (owner's call).
  skyline: Object.freeze({ width: [1.5, 1.75], alpha: [0.90, 0.95] }),
});
export const CREST_TIER_ORDER = Object.freeze(['far', 'mid', 'near', 'skyline']);
/** Fraction of the stroke width that sits on the land side of the boundary. */
export const CREST_LAND_SIDE = 0.7;
/** Lightness factor of the line against its local land colour. */
export const CREST_DARKEN = 0.55;
/** Aerial perspective: how far each band's line colour is mixed toward the sky. */
export const CREST_AERIAL = Object.freeze({ far: 0.25, mid: 0.10, near: 0 });
/** Protected hues (ColorLaw.js) keep at least this distance from line colours. */
export const PROTECTED_HUE_GAP = 20;
export const PROTECTED_HUES = Object.freeze([MIDIO_IDENTITY_HUE, HAZARD_HUE, REWARD_HUE]);

/** Temporal filter (per column One-Euro with a backlash deadband). A raw
 *  move above kickPx in a column that held still for steadySec, made by at
 *  least coherentFrac of the band's columns in the same direction (a heave,
 *  not a local row flip), passes within the frame, as does the move right
 *  after it (the kick's return). */
export const CREST_FILTER = Object.freeze({ minCutoffHz: 1.2, beta: 3, derivativeCutoffHz: 15, deadbandPx: 0.35, fastPx: 1.5,
  kickPx: 0.7, steadySec: 0.1, coherentFrac: 0.3 });
/** Shorelines: a very low fixed cutoff (time constant ~1.6 s), a deadband
 *  and no fast path, so music water waves (1-2 px at 0.5-3 Hz) never ripple
 *  them. Camera motion and heave are carried separately (the crest bands'
 *  common shift, applied exactly) and cuts reset the state. */
export const SHORE_FILTER = Object.freeze({ minCutoffHz: 0.1, beta: 0, derivativeCutoffHz: 15, deadbandPx: 0.5, fastPx: Infinity });

const clamp01 = v => (v <= 0 ? 0 : v >= 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** e = 0.6·elevation + 0.4·height above the band's foot, both 0..1. With no
 *  elevation (the grid-scan fallback) the screen term carries it alone. */
export function crestE(elevation01, aboveFoot01) {
  if (!Number.isFinite(elevation01)) return clamp01(aboveFoot01);
  return clamp01(0.6 * clamp01(elevation01) + 0.4 * clamp01(aboveFoot01));
}

/** Stroke width (output px) and opacity for `tier` at rank `e`, scaled with
 *  the output height, never thinner than one output pixel. */
export function crestStroke(tier, e, outputHeight = 1080) {
  const t = CREST_TIERS[tier] || CREST_TIERS.far, u = clamp01(e);
  const width = Math.max(1, lerp(t.width[0], t.width[1], u) * (outputHeight > 0 ? outputHeight : 1080) / 1080);
  return { width, alpha: lerp(t.alpha[0], t.alpha[1], u) };
}

/** Shoreline stroke from nearness (1 near, 0 lost in the haze). */
export function shoreStroke(nearness, outputHeight = 1080) {
  const n = clamp01(nearness);
  return { width: Math.max(1, lerp(0.8, 2.0, n) * (outputHeight > 0 ? outputHeight : 1080) / 1080), alpha: lerp(0.05, 0.6, n * n) };
}

// --- Temporal filter --------------------------------------------------------

const smoothing = (cutoffHz, dt) => { const tau = 1 / (2 * Math.PI * cutoffHz); return 1 / (1 + tau / dt); };

/** Per-column kick-detection state for filterSample/filterCrest. */
export function filterAux(n) {
  return { raw: new Float32Array(n).fill(NaN), still: new Float32Array(n), kick: new Uint8Array(n) };
}

/** One filtered sample. `y` holds the output and `d` the derivative (px/s)
 *  at `index`; returns true when `x` was passed straight through.
 *  - |x − y| > fastPx (a big kick, a camera cut): y = x, no lag.
 *  - a kick (`aux` given, see CREST_FILTER; `kickDir` is the band's common
 *    move direction this frame, 0 when none): y = x.
 *  - within ±deadbandPx: held (sub-pixel crawl and ±1-cell flicker vanish).
 *  - otherwise: a One-Euro step toward x whose cutoff rises with sustained
 *    speed, so leaving the deadband never jumps and musical motion keeps up,
 *    while a reversal (row flicker) restarts the speed estimate at zero. */
export function filterSample(y, d, index, x, dt, opts = CREST_FILTER, aux = null, kickDir = 0) {
  const prev = y[index], diff = x - prev, fresh = !Number.isFinite(prev);
  let pass = fresh || Math.abs(diff) > opts.fastPx, follow = false;
  if (aux) {
    const last = aux.raw[index], moved = x - last;
    if (!pass && kickDir && Math.abs(moved) > opts.kickPx && Math.sign(moved) === kickDir && Math.abs(diff) > opts.deadbandPx) {
      if (aux.still[index] >= opts.steadySec) pass = true;
      else if (aux.kick[index]) pass = follow = true;
    }
    aux.still[index] = Number.isFinite(moved) && Math.abs(moved) < 0.1 ? aux.still[index] + dt : 0;
    aux.raw[index] = x;
    aux.kick[index] = pass && !fresh && !follow ? 1 : 0;
  }
  if (pass) {
    // Passed straight through; a continuing move keeps its speed.
    y[index] = x; d[index] = fresh ? 0 : diff / dt; return true;
  }
  const target = Math.abs(diff) <= opts.deadbandPx ? prev : x;
  const dRaw = (target - prev) / dt;
  // Speed only counts while the motion keeps its direction: a crest that
  // flickers between two rows reverses every frame and stays slow.
  const dHat = dRaw * d[index] <= 0 ? Math.sign(dRaw) * 1e-6
    : d[index] + smoothing(opts.derivativeCutoffHz, dt) * (dRaw - d[index]);
  d[index] = dHat;
  const a = smoothing(opts.minCutoffHz + opts.beta * Math.abs(dHat), dt);
  y[index] = prev + a * (target - prev);
  return false;
}

/** The band's common raw move direction this frame (+1 down, −1 up, 0 none):
 *  at least `coherentFrac` of the present columns moved over kickPx that way. */
export function kickDirection(aux, input, opts = CREST_FILTER) {
  let up = 0, down = 0, present = 0;
  for (let i = 0; i < input.length; i++) {
    const m = input[i] - aux.raw[i];
    if (!Number.isFinite(m)) continue;
    present++;
    if (m > opts.kickPx) down++; else if (m < -opts.kickPx) up++;
  }
  const need = Math.max(1, present * (opts.coherentFrac ?? 0.3));
  return down >= need && down > up ? 1 : up >= need && up > down ? -1 : 0;
}

/** Filter a whole crest in place: `state` = { y, d } Float32Arrays of the
 *  crest's length, plus `aux` (filterAux) for kick detection. Missing
 *  columns (NaN) clear their state so a crest that reappears starts from its
 *  raw value. Returns the count of passes. */
export function filterCrest(state, input, dt, opts = CREST_FILTER) {
  const step = dt > 0 ? Math.min(dt, 1 / 15) : 1 / 60;
  const aux = state.aux || null, dir = aux ? kickDirection(aux, input, opts) : 0;
  let fast = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    if (!Number.isFinite(x)) {
      state.y[i] = NaN; state.d[i] = 0;
      if (aux) { aux.raw[i] = NaN; aux.still[i] = 0; aux.kick[i] = 0; }
      continue;
    }
    if (filterSample(state.y, state.d, i, x, step, opts, aux, dir)) fast++;
  }
  return fast;
}

/** Clear a filter state (and its aux) in place. */
export function resetFilter(state) {
  state.y.fill(NaN); state.d.fill(0);
  if (state.aux) { state.aux.raw.fill(NaN); state.aux.still.fill(0); state.aux.kick.fill(0); }
}

/** The median of the finite values of `a − b` (a common shift), using
 *  `scratch` (same length) as storage. NaN when fewer than `min` pairs. */
export function medianShift(a, b, scratch, min = 8) {
  let n = 0;
  for (let i = 0; i < a.length; i++) { const v = a[i] - b[i]; if (Number.isFinite(v)) scratch[n++] = v; }
  if (n < min) return NaN;
  const s = scratch.subarray(0, n).sort();
  return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// --- Sub-cell reconstruction ----------------------------------------------

/** Rebuild a sub-cell crest from integer first-covered rows (MLAA-like). A
 *  raster's unit step between columns a−1 and a means the true boundary
 *  crossed the cell-centre line between them, so the knot (a, mean of the
 *  two rows) lies on it. A run of equal rows bounded by two steps in the
 *  same direction is a ramp between its knots; peaks, valleys and steep
 *  sides keep the row itself (already within ±0.5 of the boundary). */
export function reconstructCrest(rows, out = new Float32Array(rows.length)) {
  const n = rows.length;
  let a = 0;
  while (a < n) {
    const c = rows[a];
    if (!Number.isFinite(c)) { out[a] = NaN; a++; continue; }
    let b = a;
    while (b + 1 < n && rows[b + 1] === c) b++;
    const cl = a > 0 ? rows[a - 1] : NaN, cr = b + 1 < n ? rows[b + 1] : NaN;
    const kl = Number.isFinite(cl) && Math.abs(cl - c) === 1 ? (cl + c) / 2 : NaN;
    const kr = Number.isFinite(cr) && Math.abs(cr - c) === 1 ? (cr + c) / 2 : NaN;
    if (Number.isFinite(kl) && Number.isFinite(kr) && (kl - c) * (kr - c) < 0) {
      const span = b + 1 - a;
      for (let i = a; i <= b; i++) out[i] = kl + (kr - kl) * ((i + 0.5 - a) / span);
    } else for (let i = a; i <= b; i++) out[i] = c;
    a = b + 1;
  }
  return out;
}

// --- Colour ------------------------------------------------------------------

const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** True when `rgb` is a vivid colour within PROTECTED_HUE_GAP of a
 *  protected hue. Muted earth tones (saturation below 0.4, or very dark or
 *  pale) do not read as the identity, hazard or reward signal colours, and
 *  the palettes' own terrain ramps live there. */
export function nearProtectedHue(rgb) {
  const { h, s, l } = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  if (s < 0.4 || l < 0.15 || l > 0.92) return false;
  return PROTECTED_HUES.some(p => hueGap(h, p) < PROTECTED_HUE_GAP);
}

/** Rotate a chromatic colour's hue out of every protected band. */
export function guardHue(rgb) {
  if (!nearProtectedHue(rgb)) return rgb;
  const hsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  let best = null;
  for (const p of PROTECTED_HUES) for (const side of [-1, 1]) {
    const h = (p + side * (PROTECTED_HUE_GAP + 0.5) + 360) % 360;
    if (PROTECTED_HUES.some(q => hueGap(h, q) < PROTECTED_HUE_GAP)) continue;
    const cost = hueGap(h, hsl.h);
    if (!best || cost < best.cost) best = { h, cost };
  }
  const c = hslToRgb(best.h, hsl.s, hsl.l);
  return [Math.round(c.r), Math.round(c.g), Math.round(c.b)];
}

/** The line colour: the local land colour at CREST_DARKEN lightness with its
 *  hue kept, then mixed toward the sky by the band's aerial amount. */
export function crestLineColor(land, sky, band) {
  const hsl = rgbToHsl(land[0], land[1], land[2]);
  const c = hslToRgb(hsl.h, hsl.s, hsl.l * CREST_DARKEN);
  const k = CREST_AERIAL[band] || 0;
  const s = sky || land;
  return guardHue([Math.round(lerp(c.r, s[0], k)), Math.round(lerp(c.g, s[1], k)), Math.round(lerp(c.b, s[2], k))]);
}

/** A shoreline's pale water-side edge: the water's own (reflected) colour
 *  lifted toward white, less at night when the water itself is dark. */
export function shoreColor(water) {
  const lum = (0.2126 * water[0] + 0.7152 * water[1] + 0.0722 * water[2]) / 255;
  const k = 0.45 * Math.min(1, Math.max(0.2, lum * 3));
  return guardHue([0, 1, 2].map(i => Math.round(lerp(water[i], 255 * Math.min(1, 0.35 + lum * 1.6), k))));
}

const LINEAR = Float32Array.from({ length: 256 }, (_, i) => { const v = i / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
const RGB332 = { r: [0, 36, 73, 109, 146, 182, 219, 255], b: [0, 85, 170, 255] };
const nearestLevel = (levels, v) => levels.reduce((best, l) => (Math.abs(l - v) < Math.abs(best - v) ? l : best), levels[0]);

/** Snap a line colour to the active palette (split-cell halves are terrain
 *  and go through the grid's own quantizer instead, PaletteQuantize.js): `palette` is null (no
 *  palette: hue guard only), 'rgb332', or a compiled palette ({ rgb }).
 *  The nearest entry that keeps PROTECTED_HUE_GAP from protected hues wins
 *  (achromatic entries always qualify). */
export function snapCrestColor(rgb, palette) {
  if (!palette) return guardHue(rgb);
  if (palette === 'rgb332') {
    const c = [nearestLevel(RGB332.r, rgb[0]), nearestLevel(RGB332.r, rgb[1]), nearestLevel(RGB332.b, rgb[2])];
    if (!nearProtectedHue(c)) return c;
    const g = guardHue(rgb);
    const s = [nearestLevel(RGB332.r, g[0]), nearestLevel(RGB332.r, g[1]), nearestLevel(RGB332.b, g[2])];
    return nearProtectedHue(s) ? [nearestLevel(RGB332.r, (c[0] + c[1] + c[2]) / 3), nearestLevel(RGB332.r, (c[0] + c[1] + c[2]) / 3), nearestLevel(RGB332.b, (c[0] + c[1] + c[2]) / 3)] : s;
  }
  let prepared = SNAP_CACHE.get(palette);
  if (!prepared) {
    // Allowed entries and their linear values once per palette; results are
    // memoized (bounded) because split cells repeat a handful of colours.
    const allowed = (palette.rgb || []).filter(c => !nearProtectedHue(c));
    prepared = { allowed, lab: allowed.map(oklab), memo: new Map() };
    SNAP_CACHE.set(palette, prepared);
  }
  const key = ((rgb[0] & 255) << 16) | ((rgb[1] & 255) << 8) | (rgb[2] & 255);
  const hit = prepared.memo.get(key);
  if (hit) return hit;
  // OKLab with hue (a, b) weighted double: a darkened brown must not snap
  // to a dark green that happens to sit nearer in plain RGB.
  const p = oklab(rgb);
  let best = -1, bestD = Infinity;
  for (let i = 0; i < prepared.lab.length; i++) {
    const c = prepared.lab[i];
    const d = (c[0] - p[0]) ** 2 + 4 * ((c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2);
    if (d < bestD) { bestD = d; best = i; }
  }
  const out = best >= 0 ? prepared.allowed[best].slice(0, 3) : guardHue(rgb);
  if (prepared.memo.size >= 4096) prepared.memo.clear();
  prepared.memo.set(key, out);
  return out;
}
const SNAP_CACHE = new WeakMap();
function oklab(c) {
  const r = LINEAR[c[0] | 0], g = LINEAR[c[1] | 0], b = LINEAR[c[2] | 0];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}

// --- Split-cell re-ownership -------------------------------------------------

const LAND_ALPHA = 250, SKY_ALPHA = 128;

/**
 * Make the grid follow the smoothed line, before palette quantization.
 *
 * `image` = { data, width, y0, rows }: RGBA rows y0..y0+rows−1 of the grid.
 * `orig` is an untouched copy of `image.data` (the rule reads only it).
 * `line[i]` is the smoothed boundary at column i's centre, `raw[i]` the
 * first row this band actually covers (both in grid rows); `skip[i]` drops
 * a column (a nearer band's line is within reach). Cells within ±1 of the
 * line change owner; a cell the line crosses keeps its UPPER colour in the
 * grid and its LOWER colour in `split` (same layout as `data`), which the
 * presenter draws at output resolution below the line only.
 *
 * Each half takes the colour of the nearest cell fully on its own side
 * (equidistant same-side cells are averaged). Lower candidates must be
 * opaque land rows of this band, so sky is never sampled into land; an
 * upper candidate that is transparent (a separately drawn sky) makes the
 * upper half transparent: cut away to show the smooth sky. Returns the
 * number of cells written.
 */
export function reownCrestCells(image, orig, split, line, raw, skip = null, crossed = null) {
  const { data, width, y0, rows } = image;
  const qualifies = (i, r, lower) => {
    if (i < 0 || i >= width || r < y0 || r >= y0 + rows) return false;
    const L = line[i], R = raw[i];
    if (!Number.isFinite(L) || !Number.isFinite(R)) return false;
    const a = orig[((r - y0) * width + i) * 4 + 3];
    return lower ? r >= L && r >= R && a >= LAND_ALPHA : r + 1 <= L && r < R;
  };
  const acc = [0, 0, 0, 0];
  // Candidate rings in order of distance: 1 (axial), √2 (diagonal), 2
  // (axial), as [dx, dy·side] pairs.
  const sideColor = (i, r, lower) => {
    const dir = lower ? 1 : -1;
    for (let ring = 0; ring < SPLIT_RINGS.length; ring++) {
      const offsets = SPLIT_RINGS[ring];
      let n = 0, transparent = false;
      acc[0] = acc[1] = acc[2] = 0;
      for (let o = 0; o < offsets.length; o += 2) {
        const x = i + offsets[o], y = r + offsets[o + 1] * dir;
        if (!qualifies(x, y, lower)) continue;
        const k = ((y - y0) * width + x) * 4;
        if (orig[k + 3] < SKY_ALPHA) { transparent = true; continue; }
        acc[0] += orig[k]; acc[1] += orig[k + 1]; acc[2] += orig[k + 2]; n++;
      }
      if (!lower && transparent) { acc[3] = 0; return acc; }
      if (n) { acc[0] /= n; acc[1] /= n; acc[2] /= n; acc[3] = 255; return acc; }
    }
    return null;
  };
  const put = (target, i, r, c) => {
    const k = ((r - y0) * width + i) * 4;
    if (c[3] === 0) { target[k] = target[k + 1] = target[k + 2] = target[k + 3] = 0; return; }
    target[k] = Math.round(c[0]); target[k + 1] = Math.round(c[1]); target[k + 2] = Math.round(c[2]); target[k + 3] = 255;
  };
  let written = 0;
  for (let i = 0; i < width; i++) {
    if (crossed) crossed[i] = -1;
    const L = line[i], R = raw[i];
    if (!Number.isFinite(L) || !Number.isFinite(R) || skip?.[i]) continue;
    const r0 = Math.floor(L);
    for (let r = r0 - 1; r <= r0 + 1; r++) {
      if (r < y0 || r >= y0 + rows) continue;
      const above = r + 1 <= L, below = r >= L, land = r >= R;
      if (above && land) { const c = sideColor(i, r, false); if (c) { put(data, i, r, c); written++; } }
      else if (below && !land) { const c = sideColor(i, r, true); if (c) { put(data, i, r, c); written++; } }
      else if (!above && !below) {
        const lo = sideColor(i, r, true);
        if (!lo) continue; // no land colour to show below the line: leave the cell alone
        put(split, i, r, lo);
        if (crossed) crossed[i] = r;
        const up = sideColor(i, r, false);
        if (up) put(data, i, r, up);
        written++;
      }
    }
  }
  return written;
}
const SPLIT_RINGS = [[0, 1, -1, 0, 1, 0], [-1, 1, 1, 1], [0, 2]];

// --- Shorelines --------------------------------------------------------------

/** Link shore transitions of adjacent columns into chains. `cols` is an
 *  array (per column) of arrays of { y, kind } (kind 1: water below the
 *  edge, 2: water above). Returns chains as arrays of [column, slotIndex]. */
export function linkShoreChains(cols, maxStep = 2) {
  const chains = [];
  let prevChains = [];
  for (let x = 0; x < cols.length; x++) {
    const here = cols[x] || [], prev = x > 0 ? cols[x - 1] || [] : [];
    const nextChains = new Array(here.length);
    let used = 0; // bitmask of consumed previous slots (at most a few per column)
    for (let s = 0; s < here.length; s++) {
      const t = here[s];
      let best = -1, bestD = maxStep + 1e-6;
      for (let p = 0; p < prev.length; p++) {
        if (used & (1 << p) || prev[p].kind !== t.kind) continue;
        const d = Math.abs(prev[p].y - t.y);
        if (d <= bestD) { bestD = d; best = p; }
      }
      let chain;
      if (best >= 0 && prevChains[best]) { used |= 1 << best; chain = prevChains[best]; }
      else { chain = []; chains.push(chain); }
      chain.push([x, s]);
      nextChains[s] = chain;
    }
    prevChains = nextChains;
  }
  return chains;
}
