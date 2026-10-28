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
/** At most this many rows of one column are re-owned (a spire the filter has
 *  not caught up with yet; larger moves pass the filter straight through). */
export const REOWN_MAX_ROWS = 16;

/** The extent of the drawn line over column i's cell span [i, i+1]. The
 *  stroke and the split clip are one polyline through the column centres
 *  (i + 0.5, line[i]); at a cell edge it is the mean of the two centres, so
 *  over one cell it runs edge → centre → edge, and its lowest and highest
 *  points there are among those three. Returns [top, bottom] (grid rows,
 *  top < bottom numerically) in `out`. */
export function crestSpan(line, i, out = [0, 0]) {
  const L = line[i], a = line[i - 1], b = line[i + 1];
  const l = Number.isFinite(a) ? (a + L) / 2 : L, r = Number.isFinite(b) ? (b + L) / 2 : L;
  out[0] = Math.min(l, L, r); out[1] = Math.max(l, L, r);
  return out;
}

let spanTop = new Float32Array(0), spanBottom = new Float32Array(0);

/**
 * Make the grid follow the smoothed line, before palette quantization.
 *
 * `image` = { data, width, y0, rows }: RGBA rows y0..y0+rows−1 of the grid.
 * `orig` is an untouched copy of `image.data` (the rule reads only it).
 * `line[i]` is the smoothed boundary at column i's centre, `raw[i]` the
 * first row this band actually covers (both in grid rows); `skip[i]` drops
 * a column (a nearer band's line is within reach).
 *
 * Cells are classified against the drawn polyline over their whole width
 * (crestSpan), not just at the column centre: a peak cell whose centre sits
 * on the line still has corners above it where the line falls away to both
 * sides. Every cell of this band's land above the line (from its raw crest,
 * however far the filter has smoothed a spire below it) becomes what lies
 * above; every cell the line crosses keeps its UPPER colour in the grid and
 * its LOWER colour in `split` (same layout as `data`), which the presenter
 * draws at output resolution below the line only. `crossed[i]`/`crossedEnd[i]`
 * receive the first and last crossed row of column i (−1: none).
 *
 * Each half takes the colour of the nearest cell fully on its own side
 * (equidistant same-side cells are averaged). Lower candidates must be
 * opaque land rows of this band, so sky is never sampled into land; an
 * upper candidate that is transparent (a separately drawn sky) makes the
 * upper half transparent: cut away to show the smooth sky. With no such
 * neighbour the upper half takes what lies above the column's raw crest
 * (transparent above the image), and the lower half of a land cell keeps
 * its own colour: no crossed land cell keeps land above the line. Returns
 * the number of cells written.
 */
export function reownCrestCells(image, orig, split, line, raw, skip = null, crossed = null, crossedEnd = null) {
  const { data, width, y0, rows } = image;
  if (spanTop.length < width) { spanTop = new Float32Array(width); spanBottom = new Float32Array(width); }
  const span = [0, 0];
  for (let i = 0; i < width; i++) {
    if (Number.isFinite(line[i])) { crestSpan(line, i, span); spanTop[i] = span[0]; spanBottom[i] = span[1]; }
    else spanTop[i] = spanBottom[i] = NaN;
  }
  const qualifies = (i, r, lower) => {
    if (i < 0 || i >= width || r < y0 || r >= y0 + rows) return false;
    const R = raw[i];
    if (!Number.isFinite(spanTop[i]) || !Number.isFinite(R)) return false;
    const a = orig[((r - y0) * width + i) * 4 + 3];
    return lower ? r >= spanBottom[i] && r >= R && a >= LAND_ALPHA : r + 1 <= spanTop[i] && r < R;
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
  // Upper fallback: what lies directly above the column's own raw crest.
  const above = (i, r) => {
    const y = Math.min(r, raw[i]) - 1;
    if (y < y0) { acc[3] = 0; return acc; }
    const k = ((y - y0) * width + i) * 4;
    if (orig[k + 3] < SKY_ALPHA) { acc[3] = 0; return acc; }
    acc[0] = orig[k]; acc[1] = orig[k + 1]; acc[2] = orig[k + 2]; acc[3] = 255;
    return acc;
  };
  const own = (i, r) => {
    const k = ((r - y0) * width + i) * 4;
    if (r < raw[i] || orig[k + 3] < LAND_ALPHA) return null;
    acc[0] = orig[k]; acc[1] = orig[k + 1]; acc[2] = orig[k + 2]; acc[3] = 255;
    return acc;
  };
  const put = (target, i, r, c) => {
    const k = ((r - y0) * width + i) * 4;
    if (c[3] === 0) { target[k] = target[k + 1] = target[k + 2] = target[k + 3] = 0; return; }
    target[k] = Math.round(c[0]); target[k + 1] = Math.round(c[1]); target[k + 2] = Math.round(c[2]); target[k + 3] = 255;
  };
  let written = 0;
  for (let i = 0; i < width; i++) {
    if (crossed) crossed[i] = -1;
    if (crossedEnd) crossedEnd[i] = -1;
    const top = spanTop[i], bottom = spanBottom[i], R = raw[i];
    if (!Number.isFinite(top) || !Number.isFinite(R) || skip?.[i]) continue;
    const last = Math.floor(bottom) + 1;
    const first = Math.max(Math.min(Math.floor(top), R) - 1, last - REOWN_MAX_ROWS);
    for (let r = first; r <= last; r++) {
      if (r < y0 || r >= y0 + rows) continue;
      const isAbove = r + 1 <= top, isBelow = r >= bottom, land = r >= R;
      if (isAbove && land) { put(data, i, r, sideColor(i, r, false) || above(i, r)); written++; }
      else if (isBelow && !land) { const c = sideColor(i, r, true); if (c) { put(data, i, r, c); written++; } }
      else if (!isAbove && !isBelow) {
        const lo = sideColor(i, r, true) || own(i, r);
        if (!lo) continue; // no land to show below the line here: leave the cell alone
        put(split, i, r, lo);
        if (crossed && crossed[i] < 0) crossed[i] = r;
        if (crossedEnd) crossedEnd[i] = r;
        put(data, i, r, sideColor(i, r, false) || above(i, r));
        written++;
      }
    }
  }
  return written;
}
const SPLIT_RINGS = [[0, 1, -1, 0, 1, 0], [-1, 1, 1, 1], [0, 2]];

// --- Shorelines --------------------------------------------------------------

/** Shoreline shape rules, by nearness (0 far, 1 near; each [far, near]
 *  pair is interpolated). A near waterline meets the beach at a grazing
 *  angle, so small terrain bumps and music waves move its raster edge by
 *  several rows from column to column: near chains link over larger steps,
 *  must be longer and are smoothed over more columns.
 *  - minRunRows: a transition with another one this close in its column
 *    bounds a sliver (a wave crest over a sandbar, a trough), not a shore.
 *  - maxStep: rows per column between linked edges; maxGap: empty columns
 *    a chain may bridge.
 *  - minColumns: shorter chains are dropped (fragments, not a coherent shore).
 *  - sigma: the widest smoothing along the chain (columns), used at
 *    noiseRows of raster noise or more; a cleaner chain is smoothed less
 *    (a clean one not at all), so real slopes, bends and coves survive.
 *  - endRidge: how far a noisy chain's end slope leans (× noise²) on a
 *    fit twice as wide, so jitter near an end does not tilt it; a clean
 *    chain's ends are exact.
 *  - maxCurvature: limit on |y[i−1] − 2y[i] + y[i+1]| for a chain at full
 *    noise; it relaxes as the noise falls.
 *  - maxResidual: RMS rows between the smoothed and the raw chain above
 *    which the chain is too jagged to be one shore and is dropped. */
export const SHORE_SHAPE = Object.freeze({ minRunRows: 3, maxStep: [2, 5], maxGap: 6, minColumns: [5, 16], sigma: [1, 5],
  noiseRows: 0.5, endRidge: 20, maxCurvature: 0.25, maxResidual: 1.75 });

/** SHORE_SHAPE at `nearness`. */
export function shoreShape(nearness) {
  const n = clamp01(nearness);
  return { maxStep: lerp(SHORE_SHAPE.maxStep[0], SHORE_SHAPE.maxStep[1], n),
    minColumns: Math.round(lerp(SHORE_SHAPE.minColumns[0], SHORE_SHAPE.minColumns[1], n)),
    sigma: lerp(SHORE_SHAPE.sigma[0], SHORE_SHAPE.sigma[1], n) };
}

/** Keep the shore transitions of one column that bound a real land/water
 *  region on both sides: `edges` is the column's transitions in row order
 *  ({ row, shore }), all of them (shore or not), so a sliver between a
 *  shore edge and a non-shore one is seen too; `height` the target height.
 *  Returns the indices kept. */
export function solidShoreEdges(edges, height, minRun = SHORE_SHAPE.minRunRows) {
  const kept = [];
  for (let s = 0; s < edges.length; s++) {
    const e = edges[s];
    if (!e.shore || e.row <= 0 || e.row >= height - 1) continue;
    if (s > 0 && e.row - edges[s - 1].row < minRun) continue;
    if (s + 1 < edges.length && edges[s + 1].row - e.row < minRun) continue;
    kept.push(s);
  }
  return kept;
}

/** Gaussian-weighted local linear regression of `a` (sigma in samples)
 *  into `out`: inside the chain it equals a Gaussian, and at the ends the
 *  local line keeps any slope instead of pulling the end toward the
 *  interior (a truncated, renormalized kernel would). `out` may be `a`.
 *  Options: `weights` (per sample) down-weight outliers; `ridge` (per unit
 *  weight) pulls the local slope toward `prior` (per sample, default 0)
 *  where few samples set it (a noisy chain's ends); `slopes` receives the
 *  local slopes. */
export function gaussianSmooth(a, sigma, out = new Float32Array(a.length), { weights = null, ridge = 0, prior = null, slopes = null } = {}) {
  const n = a.length;
  if (!(sigma > 0)) { if (out !== a) out.set(a); slopes?.fill(0); return out; }
  const src = out === a ? Float32Array.from(a) : a, radius = Math.max(1, Math.ceil(2.5 * sigma));
  const kernel = Float32Array.from({ length: radius + 1 }, (_, d) => Math.exp(-(d * d) / (2 * sigma * sigma)));
  for (let p = 0; p < n; p++) {
    let sw = 0, sx = 0, sy = 0;
    const lo = Math.max(0, p - radius), hi = Math.min(n - 1, p + radius);
    for (let q = lo; q <= hi; q++) {
      const w = kernel[Math.abs(q - p)] * (weights ? weights[q] : 1);
      sw += w; sx += w * (q - p); sy += w * src[q];
    }
    if (!(sw > 0)) { out[p] = src[p]; if (slopes) slopes[p] = 0; continue; }
    const mx = sx / sw, my = sy / sw;
    let sxx = 0, sxy = 0;
    for (let q = lo; q <= hi; q++) {
      const w = kernel[Math.abs(q - p)] * (weights ? weights[q] : 1), dx = q - p - mx;
      sxx += w * dx * dx; sxy += w * dx * (src[q] - my);
    }
    const lam = ridge * sw, m0 = prior ? prior[p] : 0;
    const slope = sxx + lam > 1e-9 ? (sxy + lam * m0) / (sxx + lam) : 0;
    out[p] = my - slope * mx;
    if (slopes) slopes[p] = slope;
  }
  return out;
}

/** Limit |y[i−1] − 2y[i] + y[i+1]| to `k` in place (local relaxation). */
export function limitCurvature(ys, k) {
  if (!(k < Infinity)) return ys;
  for (let pass = 0; pass < 64; pass++) {
    let worst = 0;
    for (let p = 1; p < ys.length - 1; p++) {
      const c = ys[p - 1] - 2 * ys[p] + ys[p + 1], over = Math.abs(c) - k;
      if (over > 0) { ys[p] += Math.sign(c) * over / 2; if (over > worst) worst = over; }
    }
    if (worst < 1e-3) break;
  }
  return ys;
}

const medianOf = v => {
  const w = Array.from(v).sort((x, y) => x - y), n = w.length;
  return n ? (n % 2 ? w[n >> 1] : (w[n / 2 - 1] + w[n / 2]) / 2) : 0;
};

/** Jitter of a chain (rows): a robust estimate of its per-column scatter
 *  from second differences (median, scaled for white noise), so a clean
 *  slope, bend or cove scores ~0 however steep it is. A rasterized clean
 *  edge steps by floor or ceil of its slope (|second difference| <= 1):
 *  that much is quantization, not jitter, and is not counted. */
export function shoreNoise(ys) {
  const n = ys.length;
  if (n < 3) return 0;
  const d2 = new Float32Array(n - 2);
  for (let p = 1; p < n - 1; p++) d2[p - 1] = Math.max(0, Math.abs(ys[p - 1] - 2 * ys[p] + ys[p + 1]) - 1);
  return 1.4826 * medianOf(d2) / Math.sqrt(6);
}

/** Replace single-column spikes in place: a sample both neighbours'
 *  linear extrapolations agree on missing by more than `thr` rows. A cove
 *  or point (both legs extrapolate to the vertex) and a bend are kept. At
 *  the chain's ends one side's extrapolation decides (a one-column leg is
 *  no shape to keep). */
function removeSpikes(a, thr = 1.5) {
  const n = a.length, src = Float32Array.from(a), at = p => src[p];
  const off = (p, v) => Math.abs(src[p] - v) > thr;
  for (let p = 1; p < n - 1; p++) {
    const l = p >= 2 ? 2 * at(p - 1) - at(p - 2) : NaN, r = p < n - 2 ? 2 * at(p + 1) - at(p + 2) : NaN, mid = (at(p - 1) + at(p + 1)) / 2;
    if ((Number.isNaN(l) || off(p, l)) && (Number.isNaN(r) || off(p, r)) && off(p, mid)) a[p] = mid;
  }
  // An end sample off a straight run of its next three (within raster
  // quantization) by more than `thr`, from the line and from its neighbour.
  const straight = (b, c, d) => Math.abs(b - 2 * c + d) <= 1;
  if (n >= 4) {
    const r0 = 2 * a[1] - a[2], rn = 2 * a[n - 2] - a[n - 3];
    if (straight(a[1], a[2], a[3]) && Math.abs(a[0] - r0) > thr && Math.abs(a[0] - a[1]) > thr) a[0] = r0;
    if (straight(a[n - 2], a[n - 3], a[n - 4]) && Math.abs(a[n - 1] - rn) > thr && Math.abs(a[n - 1] - a[n - 2]) > thr) a[n - 1] = rn;
  }
  return a;
}

/** Shape one shore chain from its integer rows: sub-cell reconstruction,
 *  single-column spike removal, then a robust Gaussian-weighted local
 *  linear fit whose width scales with the chain's raster noise (up to
 *  `sigma` columns at SHORE_SHAPE.noiseRows), so a jittery waterline is
 *  smoothed while a clean slope, bend or cove keeps its shape and its end
 *  points. The curvature limit relaxes the same way (none for a clean
 *  chain). Returns { ys, residual, noise, sigma, maxCurvature }: residual is
 *  the RMS rows from the reconstruction (jaggedness: ~0 for a clean edge). */
export function smoothShoreChain(rows, sigma, maxCurvature = SHORE_SHAPE.maxCurvature) {
  const n = rows.length, recon = reconstructCrest(rows), ys = new Float32Array(n);
  const noise = shoreNoise(recon), amount = clamp01(noise / SHORE_SHAPE.noiseRows);
  const s = sigma * amount, k = amount > 0 ? maxCurvature / amount : Infinity, ridge = SHORE_SHAPE.endRidge * noise * noise;
  const raw = Float32Array.from(recon);
  removeSpikes(recon);
  // A noisy chain's end slopes lean on a fit twice as wide (no lean on a
  // straight line, much less end scatter than a narrow fit alone).
  const prior = new Float32Array(n);
  if (ridge > 0) gaussianSmooth(recon, 2 * s, new Float32Array(n), { slopes: prior });
  gaussianSmooth(recon, s, ys, { ridge, prior });
  if (s > 0) {
    // One robust pass (bisquare on the residuals) so outliers do not pull the fit.
    const e = new Float32Array(n);
    for (let p = 0; p < n; p++) e[p] = Math.abs(recon[p] - ys[p]);
    const scale = 6 * Math.max(0.25, medianOf(e)), w = new Float32Array(n);
    for (let p = 0; p < n; p++) { const u = e[p] / scale; w[p] = u < 1 ? (1 - u * u) ** 2 : 0; }
    gaussianSmooth(recon, s, ys, { weights: w, ridge, prior });
  }
  limitCurvature(ys, k);
  let sq = 0;
  for (let p = 0; p < n; p++) sq += (ys[p] - raw[p]) ** 2;
  return { ys, residual: n ? Math.sqrt(sq / n) : 0, noise, sigma: s, maxCurvature: k };
}

/** The least smoothing (columns) of the drawn shore points: enough to
 *  merge neighbouring per-column deadbands, little enough that a clean
 *  slope-2 cove's vertex moves about a row. */
export const SHORE_HELD_SIGMA = 0.75;

/** Smooth the drawn shore points `held` in place (through a scratch copy,
 *  so the filter stays symmetric) and apply the chain's curvature limit. */
export function smoothHeldShore(held, sigma, maxCurvature = SHORE_SHAPE.maxCurvature) {
  held.set(gaussianSmooth(held, sigma, new Float32Array(held.length)));
  return limitCurvature(held, maxCurvature);
}

/** Link shore transitions of nearby columns into chains. `cols` is an
 *  array (per column) of arrays of { y, kind, maxStep? } (kind 1: water
 *  below the edge, 2: water above; `maxStep` overrides the default rows per
 *  column for that edge). An edge joins the chain whose last edge (same
 *  kind) is nearest in rows within maxStep per column crossed, across at
 *  most `maxGap` empty columns (a column whose only edge was a sliver).
 *  Returns chains as arrays of [column, slotIndex]. */
export function linkShoreChains(cols, maxStep = 2, maxGap = 0) {
  const chains = [];
  let tails = []; // { chain, x, y, kind }
  for (let x = 0; x < cols.length; x++) {
    const here = cols[x] || [];
    tails = tails.filter(t => x - t.x <= maxGap + 1);
    const taken = new Set(), next = [];
    for (let s = 0; s < here.length; s++) {
      const e = here[s];
      let best = null, bestD = Infinity;
      for (const t of tails) {
        if (taken.has(t) || t.kind !== e.kind) continue;
        const d = Math.abs(t.y - e.y);
        if (d <= (e.maxStep ?? maxStep) * (x - t.x) + 1e-6 && d + (x - t.x - 1) < bestD) { bestD = d + (x - t.x - 1); best = t; }
      }
      let chain;
      if (best) { taken.add(best); chain = best.chain; } else { chain = []; chains.push(chain); }
      chain.push([x, s]);
      next.push({ chain, x, y: e.y, kind: e.kind });
    }
    tails = tails.filter(t => !taken.has(t)).concat(next);
  }
  return chains;
}
