// Choreography math for the parallax ranges: the traveling ridge wave and
// kick bounce that make the mountains dance, and the geometry of the
// spectrum massif — the one super-distant mountain whose skyline IS a live
// bar graph of the current 7-band frequency content. Pure functions, no
// canvas: BiomeManager consumes these, tests exercise them directly.
import { clamp01 } from '../utils/math.js';

/** Per-layer dance personalities.
 *
 *  The drama belongs to the FAR ranges. This used to run the other way --
 *  the nearest hills heaved hardest and bounced first, with the wave
 *  rolling away into the distance -- and it read badly: the biggest, most
 *  violent motion was the thing sitting closest to the camera, right behind
 *  the characters, so the foreground flapped while the horizon sat still.
 *  Reversed, the same choreography reads as intended: a huge slow skyline
 *  heaving away in the distance, the ground underfoot comparatively steady,
 *  and the kick wave rolling FORWARD out of the back of the scene.
 *
 *  waveLen/waveHz/phase stay as they were and are deliberately co-prime-ish
 *  across layers, so the ranges never move in lockstep. */
// Amplitude now falls off WITH DISTANCE, not toward it. The old table gave
// the furthest range (L2) the biggest swing of the four -- 11.5px of wave
// plus a 10.8px drop on every kick, up to ~3.4x that under fever -- on a
// layer that scrolls at 0.10 ratio. Something that far away moving that
// hard doesn't read as a mountain range breathing; it reads as the back
// ridge vibrating, because parallax has already told the eye it should be
// nearly still. Near ranges may move; distant ones may only barely.
//
// Kick bounce falls off harder than the wave: a per-beat drop is the most
// legible motion of the two, so it's the one that has to nearly vanish at
// depth. waveLen/waveHz/phase are unchanged and still co-prime-ish across
// layers, so the ranges never move in lockstep.
// sharpen/swell (mountain overhaul Stage 2): per-column VERTICAL SCALE gain,
// on top of the waveAmp/bounceAmp offset dance above -- a summit sharpens on
// the kick, a flank swells on sustained energy, foot-anchored so bases stay
// glued to the ground. Same far-is-calmer bias as the offset dance for the
// same reason (parallax already tells the eye a distant range should barely
// move), but a full order of magnitude smaller: this is a shape change on
// top of an existing motion, not a second competing dance.
export const DANCE_LAYERS = {
  L2: { waveAmp: 2.0, bounceAmp: 0.5, waveLen: 430, waveHz: 0.10, phase: 0.0, delaySec: 0.0, sharpen: 0.02, swell: 0.02 },
  L3: { waveAmp: 3.2, bounceAmp: 1.2, waveLen: 350, waveHz: 0.12, phase: 1.3, delaySec: 0.05, sharpen: 0.04, swell: 0.03 },
  L4: { waveAmp: 4.8, bounceAmp: 2.4, waveLen: 290, waveHz: 0.15, phase: 2.6, delaySec: 0.11, sharpen: 0.06, swell: 0.04 },
  L5: { waveAmp: 6.0, bounceAmp: 3.6, waveLen: 250, waveHz: 0.18, phase: 4.0, delaySec: 0.17, sharpen: 0.08, swell: 0.05 },
};

// Strip-space slice width for the ridge wave. Halved from 128: each slice
// is blitted at its own vertical offset, which also shifts the depth
// gradient baked into the strip, so at every slice boundary the same screen
// row samples a different part of that gradient -- a hard vertical shade
// step marching across the range as it dances. The step scales with the
// offset difference between neighbours, so narrower slices shrink it
// proportionally (the crest stroke and GeoCrest's danceOffsetSmooth both
// derive from this constant, so they follow automatically).
export const DANCE_COL_W = 64;
const IDLE_DRIVE = 0.15;        // the ranges never stand perfectly still

/**
 * Vertical offset (px, negative = lifted) for one strip column.
 * @param {number} stripX   column position in scroll-stable strip space
 * @param {number} tSec     song time
 * @param {number} groove   smoothed 0..1 global energy (calm-attenuated)
 * @param {number} kick     0..1 kick envelope, already layer-delayed
 * @param {object} cfg      a DANCE_LAYERS entry
 * @param {number} fever    0..1 player fever — steady accurate taps at high
 *                          song energy crank the whole dance up to ~2.8×
 */
export function danceOffset(stripX, tSec, groove, kick, cfg, fever = 0) {
  const mul = 1 + FEVER_DANCE_GAIN * clamp01(fever);
  const drive = IDLE_DRIVE + (1 - IDLE_DRIVE) * clamp01(groove);
  const wave = Math.sin(stripX / cfg.waveLen + tSec * cfg.waveHz * 2 * Math.PI + cfg.phase);
  return (cfg.waveAmp * drive * wave - cfg.bounceAmp * clamp01(kick)) * mul;
}

export const FEVER_DANCE_GAIN = 1.4; // fever cranks the dance up to ~2.4x

/** Per-DANCE_COL_W-wide column, how tall that column's own peak reads
 *  relative to the rest of THIS ridge, 0..1 (0 = this range's own flattest
 *  column, 1 = its tallest). Stage 2's per-column deformation reads this so
 *  a squat foothill barely deforms while this range's own summit sharpens
 *  hardest, regardless of how tall the range is overall (already handled
 *  separately by growthMul/scale). Circularly blurred across column seams
 *  -- the strip tiles, so column 0's neighbor on one side is the last
 *  column -- and memoized directly on the ridge object: it's derived
 *  purely from the baked noise, so it can never change after the strip is
 *  baked, and every caller (blit loop, smooth crest) shares one array. */
export function columnHeights01(ridge) {
  if (!ridge) return null;
  if (ridge._colH01) return ridge._colH01;
  const { heights, step } = ridge;
  const width = heights.length * step;
  const nCols = Math.max(1, Math.round(width / DANCE_COL_W));
  const raw = new Float32Array(nCols);
  for (let c = 0; c < nCols; c++) {
    const x0 = c * DANCE_COL_W;
    const x1 = x0 + DANCE_COL_W;
    let peak = -Infinity;
    for (let x = x0; x < x1; x += Math.max(1, step)) {
      const i = Math.min(heights.length - 1, Math.floor(x / step));
      if (heights[i] > peak) peak = heights[i];
    }
    raw[c] = peak === -Infinity ? 0 : peak;
  }
  // Procedural strips tile, so the blur wraps. A scanned range does not:
  // its first column must not be mixed with its last.
  const terrain = ridge.source === 'terrain';
  const blurred = new Float32Array(nCols);
  for (let c = 0; c < nCols; c++) {
    const prev = terrain ? Math.max(0, c - 1) : (c - 1 + nCols) % nCols;
    const next = terrain ? Math.min(nCols - 1, c + 1) : (c + 1) % nCols;
    blurred[c] = (raw[prev] + raw[c] + raw[next]) / 3;
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of blurred) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo;
  const out = new Float32Array(nCols);
  for (let c = 0; c < nCols; c++) out[c] = span > 1e-6 ? (blurred[c] - lo) / span : 0.5;
  ridge._colH01 = out;
  return out;
}

/**
 * The ridge's own baked summit, in ridgeYSmooth's units -- the y its highest
 * point sits at before any dance, deformation or scroll.
 *
 * A STABLE reference for anything that needs "the top of this relief". The
 * live crest (`_crestPoints`'s min over the drawn points) is not one: it is a
 * global extremum over a ridge that is both dancing and scrolling, so it
 * reports a different column frame to frame. Measured on a five-summit ridge,
 * that min wanders 6px from the dance alone and 16-21px once the world is
 * scrolling -- and anything anchored to it inherits the whole wander. The
 * cast shadow already hit this and fixed it by tracing the local crest
 * instead; the snow line needs a stable ALTITUDE rather than a local trace,
 * which is what this is.
 *
 * Derived purely from the baked heights, so it can never change after the
 * strip is baked -- memoized on the ridge like columnHeights01 above.
 */
export function ridgeBakedCrestY(ridge) {
  if (!ridge) return 0;
  if (ridge._bakedCrestY !== undefined) return ridge._bakedCrestY;
  const { heights, baseline, amplitude, height } = ridge;
  let maxH = -Infinity;
  for (const v of heights) if (v > maxH) maxH = v;
  if (!Number.isFinite(maxH)) maxH = 0;
  // Mirrors ridgeYSmooth's own algebra: taller height value -> smaller y.
  ridge._bakedCrestY = height * baseline - maxH * height * amplitude;
  return ridge._bakedCrestY;
}

/** columnHeights01, sampled at strip-space x (wraps at the ridge's own
 *  width -- any real x, including negative or scrolled-past-the-tile,
 *  reads the correct column). */
export function columnHeight01At(ridge, x) {
  const cols = columnHeights01(ridge);
  if (!cols) return 0;
  const n = cols.length;
  if (ridge.source === 'terrain') {
    const c = Math.max(0, Math.min(n - 1, Math.floor(x / DANCE_COL_W)));
    return cols[c];
  }
  const c = ((Math.floor(x / DANCE_COL_W) % n) + n) % n;
  return cols[c];
}

/**
 * Per-column vertical SCALE multiplier (Stage 2 of the mountain overhaul):
 * >=1 always, so a column can only grow, never invert or shrink below its
 * baked height -- foot-anchored growth reads as the range breathing, a
 * shrink would read as it sinking into the ground. Both terms are strictly
 * non-negative and non-oscillating (h01, transient, sustain all live in
 * 0..1, and h01^2.2 / h01*(1-h01) never go negative), which is what keeps
 * this safely independent of ridgeSwell01's phase-only gate -- nothing
 * about this function's OWN timing decides when a column is at the top of
 * its swing, only how far THIS column specifically grows once it's there.
 * @param {number} h01 this column's own relative peak height (columnHeight01At)
 * @param {number} transient 0..1, the kick envelope (sharpens summits)
 * @param {number} sustain 0..1, slow-settled energy (swells flanks)
 * @param {object} cfg a DANCE_LAYERS entry (reads .sharpen/.swell)
 */
export function danceScale(h01, transient, sustain, cfg) {
  const hh = clamp01(h01);
  const t = clamp01(transient);
  const s = clamp01(sustain);
  const sharpen = cfg?.sharpen ?? 0;
  const swell = cfg?.swell ?? 0;
  return 1 + sharpen * t * Math.pow(hh, 2.2) + swell * s * 4 * hh * (1 - hh);
}

/** The range Midio takes his cue from: the furthest, biggest-moving skyline
 *  (see DANCE_LAYERS -- L2 is the furthest, and leads the others on the
 *  kick). Note this reads the swing in PHASE, not pixels, so damping L2's
 *  amplitude for depth doesn't move the gameplay gate at all. */
export const FAR_DANCE_LAYER = 'L2';

/** How much of a kick the swell reading gives away. Small on purpose: the
 *  beat gets a vote on exactly when the gate opens, the slow swell decides
 *  whether it opens at all. */
export const SWELL_KICK_GAIN = 0.18;

/**
 * How high one column of a range is heaved right now, as a scale-free 0..1
 * ("0 = this column is at the bottom of its own swing, 1 = at the top").
 *
 * This is danceOffset's own lift, normalized: the wave term is the same
 * sine, read with the sign flipped so up reads high, and the kick term is
 * the same envelope (a kick lifts the range, hence a positive contribution).
 * What is deliberately dropped is every amplitude factor -- waveAmp,
 * bounceAmp, groove, fever, terrainEnergy, orogeny. A gate built on absolute
 * pixels would swing wide open under fever and clamp shut in a flat, low-
 * energy biome (terrainEnergy near 0 flattens the dance to nothing); read in
 * phase instead, "the skyline near the top of its current swing" means the
 * same thing in every section of every song.
 */
export function ridgeSwell01(stripX, tSec, cfg, kick = 0) {
  const wave = Math.sin(stripX / cfg.waveLen + tSec * cfg.waveHz * 2 * Math.PI + cfg.phase);
  return clamp01(0.5 - 0.5 * wave + SWELL_KICK_GAIN * clamp01(kick));
}

/**
 * Kick envelope at `tauMs` after the (layer-delayed) hit: a 40 ms snap up,
 * then a ~180 ms exponential settle. 0 before the hit reaches this layer.
 */
export function kickEnv(tauMs) {
  if (!(tauMs >= 0)) return 0;
  if (tauMs < 40) return tauMs / 40;
  return Math.exp(-(tauMs - 40) / 180);
}

/** How long after the heard kick a plane at this depth should crest.
 *  Mountain layers use their own DANCE_LAYERS delay: the far ridge leads,
 *  the near hills follow. Planes that are not a ridge borrow the layer
 *  they are drawn with. Far vignettes sit on L2. The ocean is the ground
 *  under the near hills, and the foreground (near field, scatter) is in
 *  front of those hills, so both crest with L5 — not on a private offset
 *  of 60ms or 250ms, which landed them between beats. */
export function planeKickDelayMs(plane) {
  if (plane === 'vignette') return DANCE_LAYERS.L2.delaySec * 1000;
  if (plane === 'ocean' || plane === 'near') return DANCE_LAYERS.L5.delaySec * 1000;
  const cfg = DANCE_LAYERS[plane];
  return cfg ? cfg.delaySec * 1000 : 0;
}

/** Kick envelope for one depth plane, on the heard clock. */
export function planeKick(nowMs, kickMs, plane, amp = 1) {
  return kickEnv(nowMs - kickMs - planeKickDelayMs(plane)) * (amp || 0);
}

/** Added halo scale at a kick. 0 at rest, a fraction of `amount` at a full
 *  hit, gone within a beat. The body stays put; only the glow around it
 *  grows, which is what reads as the sun landing on the note. */
export function kickBloom(kick, amount = 0.45) {
  return amount * clamp01(kick);
}

/** Softer kick envelope for ridge dance — slower attack, longer settle. */
export function ridgeKickEnv(tauMs) {
  if (!(tauMs >= 0)) return 0;
  if (tauMs < 80) return tauMs / 80;
  return Math.exp(-(tauMs - 80) / 340);
}

// Band order across the massif: bass in the middle (band 0 is the lowest,
// most energetic band), treble falling away to the flanks — so the loudest
// content builds the summit and the silhouette stays mountain-shaped.
const MASSIF_ORDER = [5, 3, 1, 0, 2, 4, 6];
// Bell profile: even at total silence the pedestal keeps a mountain outline.
const MASSIF_BELL = [0.30, 0.55, 0.80, 1.00, 0.80, 0.55, 0.30];
const PEDESTAL_FRAC = 0.34; // share of each bar's height that never moves

/**
 * The spectrum massif's bars: for each of the 7 columns (left to right),
 * which band it reads and its 0..1 height — pedestal bell plus the live
 * band level. h01 is always in (0, 1].
 * @param {ArrayLike<number>} eq  7 smoothed band levels, 0..1
 */
export function spectrumBars(eq) {
  return MASSIF_ORDER.map((band, i) => ({
    band,
    h01: MASSIF_BELL[i] * (PEDESTAL_FRAC + (1 - PEDESTAL_FRAC) * clamp01(eq?.[band] ?? 0)),
  }));
}

// Orogeny: how much each range's height grows as the mountains build across
// the song (see OrogenyDirector). Far layers grow the most -- a skyline
// visibly rearing up behind everything -- near layers barely at all, so the
// player's own scale reference never shifts underfoot.
// Gains are modest: the hard frame-fit in mountainStripDrawHeight is the
// real ceiling. Huge multipliers only ever made invisible off-screen mesas.
const OROGENY_GROWTH_MUL = { L2: 0.42, L3: 0.32, L4: 0.22, L5: 0.12 };

/** Height multiplier for a layer at orogeny growth g (0..1). g=0 -> 1.0
 *  (baseline height, "not yet built"); g=1 -> the layer's full grown height. */
export function orogenyHeightMul(layerKey, g) {
  const gain = OROGENY_GROWTH_MUL[layerKey] ?? 0;
  return 1 + gain * clamp01(g);
}

// Off-frame pull-back (CameraDirector.zoom easing toward ZOOM_MIN): the
// nearer ranges grow the most as the camera backs away, the opposite bias
// from orogeny above. This is what closes the dead flat gap between the
// player and the first ridge on a wide shot -- L5/L4 rise up to meet it
// instead of the world just shrinking in place. Far layers get a much
// smaller nudge, enough to keep the whole skyline reading as one gesture
// without the horizon itself visibly lurching.
const PULLBACK_GROWTH_MUL = { L2: 0.06, L3: 0.14, L4: 0.26, L5: 0.36 };

/** Height multiplier for a layer at camera pull-back p (0..1, 0 = normal
 *  framing, 1 = hardest pull-back / ZOOM_MIN). Same shape as
 *  orogenyHeightMul -- multiply the two together, they stack independently. */
export function pullbackHeightMul(layerKey, p) {
  const gain = PULLBACK_GROWTH_MUL[layerKey] ?? 0;
  return 1 + gain * clamp01(p);
}

/**
 * Top of screen reserved for sky / celestial / upper ocean. Peaks that would
 * sit above this are clipped by the frame — they may as well not exist.
 * ~0.16 leaves the ocean horizon (≈0.26) and some open sky readable.
 */
export const MOUNTAIN_SKY_HEADROOM_FRAC = 0.16;

/** Bounce/wave lift budget so a kick doesn't shove a fitted peak off the top. */
const MOUNTAIN_DANCE_PAD_PX = 22;

/**
 * Screen-space strip draw height (px), anchored at groundY+40.
 * Caps orogeny so the range top never leaves the frame.
 *
 * @param {number} stripHeight  baked strip bitmap height
 * @param {number} growthMul    from orogenyHeightMul
 * @param {number} canvasHeight stage height
 * @param {number} groundY      playable ground line
 */
export function mountainStripDrawHeight(stripHeight, growthMul, canvasHeight, groundY) {
  const desired = Math.max(1, stripHeight) * Math.max(0.05, growthMul);
  const bottom = groundY + 40;
  const topMin = canvasHeight * MOUNTAIN_SKY_HEADROOM_FRAC;
  const maxDh = Math.max(96, bottom - topMin - MOUNTAIN_DANCE_PAD_PX);
  return Math.min(desired, maxDh);
}

// How far the dancing ridge's crest stays above the average crest of the
// three ranges in front of it, as a fraction of the stage height. The front
// ranges grow on their own; without this the far ridge stays put and they
// cover it.
export const DANCE_RIDGE_CLEARANCE_FRAC = 0.08;

/** Share of a strip's draw height that is the baked crest above the foot. */
export function crestAboveFootFrac(strip) {
  const h = Number(strip?.height) || Number(strip?.ridge?.height) || 0;
  if (!(h > 0)) return 0.5;
  const crestY = ridgeBakedCrestY(strip.ridge);
  return Math.max(0.08, Math.min(1, (h - crestY) / h));
}

/**
 * Draw height for the dancing ridge. Never shorter than its own fit, and
 * tall enough that its crest sits DANCE_RIDGE_CLEARANCE_FRAC above the
 * average crest of the front ranges. `fronts` is [{ strip, dh }].
 */
export function anchoredFarDrawHeight({ natural, farStrip, fronts, canvasHeight, groundY }) {
  const usable = (fronts || []).filter((f) => f?.strip && f.dh > 0);
  if (!usable.length || !farStrip) return natural;
  let sum = 0;
  for (const f of usable) sum += f.dh * crestAboveFootFrac(f.strip);
  const avg = sum / usable.length;
  const wantAbove = avg + canvasHeight * DANCE_RIDGE_CLEARANCE_FRAC;
  const wantDh = wantAbove / crestAboveFootFrac(farStrip);
  const capped = mountainStripDrawHeight(wantDh, 1, canvasHeight, groundY);
  return Math.max(natural || 0, capped);
}

// --- The spectrum massif's scale (megalophobia pass) -----------------------
//
// Every other range obeys MOUNTAIN_SKY_HEADROOM_FRAC so the sky/ocean stay
// readable above it. The massif is deliberately let off that leash: it is
// the single farthest, slowest-scrolling solid thing in the world (see
// BiomeManager._drawSpectrumMassif's 0.03 parallax ratio -- an order of
// magnitude slower than the nearest range), so a size that would look
// absurd on L2 reads instead as "this is simply how big something that far
// away, and that old, gets to be." A tiny headroom (not zero -- the very
// top edge should still occasionally graze the frame rather than always
// sit flush against it, which is the actual "too big to see the top of"
// sensation) is reserved instead of the normal generous band.
export const MASSIF_SKY_HEADROOM_FRAC = 0.03;
const MASSIF_DANCE_PAD_PX = 10;

/** Same shape as mountainStripDrawHeight, but for the massif's own much
 *  taller ceiling -- @see MASSIF_SKY_HEADROOM_FRAC. */
export function massifDrawHeight(stripHeight, growthMul, canvasHeight, groundY) {
  const desired = Math.max(1, stripHeight) * Math.max(0.05, growthMul);
  const bottom = groundY + 40;
  const topMin = canvasHeight * MASSIF_SKY_HEADROOM_FRAC;
  const maxDh = Math.max(96, bottom - topMin - MASSIF_DANCE_PAD_PX);
  return Math.min(desired, maxDh);
}

// The massif reads as ONE continuous mountain RANGE, not seven separate
// columns with gaps between them -- at genuinely towering heights, narrow
// gapped rectangles stop reading as terrain entirely and start reading as
// a picket fence of skyscrapers. So its silhouette is a single ridge line
// spanning the whole width, smoothly interpolated between the seven bars'
// peaks (still bass-builds-the-summit, still the live EQ) with a
// deterministic, closed-form jag layered on top for a wind-scoured, ancient
// edge instead of a clean sine.
const JAG_AMP_PX = 14;
const JAG_FREQ = [2, 5, 11, 23]; // co-prime-ish harmonics -- irregular and non-repeating across the whole ridge

// Fine surface grain: a second, much higher-frequency and lower-amplitude
// octave layered on top of the coarse jag -- the up-close weathered texture
// a genuinely ancient ridge would show even while its overall silhouette
// barely seems to move at all. Deliberately small relative to the coarse
// jag so it reads as grain, not a second competing skyline.
const FINE_JAG_AMP_PX = 3;
const FINE_JAG_FREQ = [53, 101, 181];

// The massif's own EQ response. spectrumBars everywhere else (horizon EQ,
// etc.) reads _eqSmoothed, which reacts on a musical timescale --
// EQ_ATTACK_SEC/EQ_RELEASE_SEC in BiomeManager are fractions of a second,
// fine for something that's meant to pulse with the beat. The massif is
// the opposite pitch: everything else about it (0.03 parallax -- an order
// of magnitude slower than the nearest range, a permanent haze veil, tiny
// ordinary-speed scale markers) exists to sell "impossibly, geologically
// vast." A silhouette that size visibly hopping on every kick breaks that
// story outright -- something that big cannot perceptibly move on a
// musical timescale. These constants are seconds, not fractions of a
// second: the ridge crawls, it never dances.
export const MASSIF_EQ_ATTACK_SEC = 4.5;
export const MASSIF_EQ_RELEASE_SEC = 9.0;

/** One-pole smoothing step toward `raw` -- same exponential-approach shape
 *  as the general EQ smoother, just with the massif's own glacially slower
 *  multi-second time constants. */
export function massifEqStep(prev, raw, dtSec) {
  const tau = raw > prev ? MASSIF_EQ_ATTACK_SEC : MASSIF_EQ_RELEASE_SEC;
  return prev + (1 - Math.exp(-dtSec / tau)) * (raw - prev);
}

/**
 * The live band level (0..1) under fractional position u across the massif:
 * the same bass-in-the-middle band order as spectrumBars, smoothstepped
 * between neighbouring columns, without the pedestal bell -- for a massif
 * standing on a real crest (HorizonRidge.massifRidgeLift01), where the
 * crest is the bell.
 * @param {ArrayLike<number>} eq 7 smoothed band levels, 0..1
 */
export function massifBandLevel(eq, u) {
  const n = MASSIF_ORDER.length;
  const pos = Math.min(n - 1 - 1e-9, Math.max(0, u * (n - 1)));
  const i0 = Math.floor(pos);
  const frac = pos - i0;
  const s = frac * frac * (3 - 2 * frac);
  const a = clamp01(eq?.[MASSIF_ORDER[i0]] ?? 0), b = clamp01(eq?.[MASSIF_ORDER[i0 + 1]] ?? 0);
  return a * (1 - s) + b * s;
}

/**
 * The ridge's smooth 0..1 height profile at fractional position u (0..1)
 * across the WHOLE massif width -- smoothstep-interpolated between
 * neighboring bar peaks (spectrumBars), so seven discrete columns read as
 * one continuous skyline with gentle saddles between peaks, not sharp V's.
 * @param {Array<{h01:number}>} bars from spectrumBars, left to right
 * @param {number} u 0..1 across the whole ridge
 */
export function massifRidgeHeight01(bars, u) {
  const n = bars.length;
  if (n === 0) return 0;
  if (n === 1) return bars[0].h01;
  const pos = Math.min(n - 1 - 1e-9, Math.max(0, u * (n - 1)));
  const i0 = Math.floor(pos);
  const i1 = Math.min(n - 1, i0 + 1);
  const frac = pos - i0;
  const s = frac * frac * (3 - 2 * frac); // smoothstep -- gentle saddles, not linear V's
  return bars[i0].h01 * (1 - s) + bars[i1].h01 * s;
}

/**
 * Vertical jag offset (px, positive = notched down from the smooth ridge)
 * at fractional position u (0..1) across the WHOLE massif width -- a
 * single continuous roughness field, not a per-bar one, so it never resets
 * or seams at a bar boundary.
 */
export function massifRidgeJagPx(u) {
  let coarse = 0;
  for (const f of JAG_FREQ) coarse += Math.sin(u * f * Math.PI * 2 + f * 1.913);
  coarse = Math.max(0, coarse / JAG_FREQ.length) * JAG_AMP_PX;

  let fine = 0;
  for (const f of FINE_JAG_FREQ) fine += Math.sin(u * f * Math.PI * 2 + f * 0.617);
  fine = Math.max(0, fine / FINE_JAG_FREQ.length) * FINE_JAG_AMP_PX;

  return coarse + fine;
}

// Clearing: the massif sits under a permanent haze veil near its own crest
// (drawn in BiomeManager -- "can't quite see all of it" is doing real work
// for the megalophobia read on its own), but a rare, brief window lets that
// veil thin all the way out and hands the player its full, uninterrupted
// silhouette. Sized to land once or twice in a typical song rather than
// never (too rare to ever land) or constantly (a permanent clearing is just
// the new baseline, not an event).
export const MASSIF_CLEARING_PERIOD_SEC = 80;

/** 0..1, mostly 0 (hazy) with a brief, rare rise to 1 (fully clear) once per
 *  MASSIF_CLEARING_PERIOD_SEC. The high power keeps the clear window narrow
 *  -- a spike, not half the cycle spent clearing. */
export function massifClearing01(tSec) {
  const phase = (((tSec % MASSIF_CLEARING_PERIOD_SEC) + MASSIF_CLEARING_PERIOD_SEC) % MASSIF_CLEARING_PERIOD_SEC) / MASSIF_CLEARING_PERIOD_SEC;
  return Math.max(0, Math.sin(phase * Math.PI)) ** 10;
}

// Scale markers: the actual "occasionally perceived in a way that makes its
// raw size known" mechanic. A tiny, fast-drifting silhouette (a bird, a
// ship -- something the player's eye already knows the true size of)
// crossing the massif's face at ordinary parallax speed, against a backdrop
// crawling at 1/30th that rate, IS the scale reveal: the comparison does the
// work no amount of raw height ever could on its own.
export const MASSIF_MARKER_SPEED_PX_S = 240;
export const MASSIF_MARKER_LIFE_SEC = 7;
export const MASSIF_MARKER_MIN_GAP_SEC = 16;
export const MASSIF_MARKER_MAX_GAP_SEC = 40;

/** Seconds until the next marker should spawn, drawn from the seeded RNG
 *  the caller owns (so it's deterministic per song/seed like everything
 *  else here, not Math.random). */
export function nextMassifMarkerDelaySec(rand) {
  return MASSIF_MARKER_MIN_GAP_SEC + rand() * (MASSIF_MARKER_MAX_GAP_SEC - MASSIF_MARKER_MIN_GAP_SEC);
}
