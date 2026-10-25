// How the cast's lights land on the pixel grid (ActorsGL). The scene draws
// them at the native grid, single-sampled, where a light smaller than a
// pixel either hits a pixel centre or vanishes: the fixed lines twinkled,
// the motes popped and the 1-px survey lines stair-stepped. Here every
// light is filtered analytically instead:
//
// - Sprites are sums of Gaussians, each integrated over the pixel's own
//   square (a box filter) and never narrower than SPRITE_MIN_SIGMA. Pixel
//   squares tile the plane, so a light's total brightness is the same
//   wherever it falls on the grid; the minimum keeps it spread over a few
//   pixels so it glides between them instead of hopping. A light finer
//   than the minimum keeps a peak in proportion to its size, not its area:
//   spread at its own energy, a mote or a far fixed-line light peaked at a
//   few percent of a pixel and vanished.
// - Lines are ribbons at least THREAD_HALF_PX either side of their centre,
//   with the same box-filtered Gaussian across them, so their brightness per
//   unit length is constant at any position and angle.
//
// The JS twins are exact copies of the GLSL (CAST_RASTER_GLSL) for tests.

/** Narrowest Gaussian a light is drawn with (native pixels). */
export const SPRITE_MIN_SIGMA = 0.6;
/** A thread's Gaussian radius across it (native pixels): about 1.6 px at
 *  half brightness once filtered, never a hairline. */
export const THREAD_SIGMA = 0.6;
/** Half-width of a thread's ribbon (native pixels): its filtered profile
 *  is negligible beyond. */
export const THREAD_HALF_PX = 0.5 + 3 * THREAD_SIGMA;
/** A sprite's halo as two Gaussians (fractions of its radius, and peak
 *  weights): the old exp(-4.5r)(1-r) glow refitted so it can be filtered. */
export const HALO = Object.freeze({ s1: 0.093, w1: 0.46, s2: 0.25, w2: 0.35 });

/** Abramowitz-Stegun 7.1.26 (|error| < 1.5e-7). */
export function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x < 0 ? -y : y;
}

/** Share of a unit-energy 1D Gaussian of radius `sigma` centred `x` pixels
 *  from a pixel's centre that falls inside that pixel. */
export function boxGauss(x, sigma) {
  const k = Math.SQRT1_2 / sigma;
  return 0.5 * (erf((x + 0.5) * k) - erf((x - 0.5) * k));
}

/** What one pixel at offset (dx, dy) px from a light's centre receives of a
 *  unit-peak Gaussian of radius `sigma` px: its peak where it is wide; finer
 *  than SPRITE_MIN_SIGMA, drawn that wide with a total of 2 pi sigma s (its
 *  peak scales with sigma / s instead of (sigma / s)^2). */
export function spot(dx, dy, sigma) {
  const s = Math.max(sigma, SPRITE_MIN_SIGMA);
  return 2 * Math.PI * sigma * s * boxGauss(dx, s) * boxGauss(dy, s);
}

/** A sprite's halo of radius `R` px at offset (dx, dy). */
export function spriteHalo(dx, dy, R) {
  return HALO.w1 * spot(dx, dy, HALO.s1 * R) + HALO.w2 * spot(dx, dy, HALO.s2 * R);
}

/** Half-size (px) of the quad a sprite of radius `R` px needs: its widest
 *  filtered Gaussian fits inside, however small the sprite. */
export function spriteExtent(R) {
  return Math.max(R, 0.5 + 3 * Math.max(HALO.s2 * R, SPRITE_MIN_SIGMA));
}

/** A thread's brightness `across` px from its centre line. */
export function ribbonCoverage(across) {
  return boxGauss(across, THREAD_SIGMA);
}

/** Gain that brings a ribbon's centre line up to the full brightness of the
 *  1-px line it replaced: spread over its filter at that line's energy it
 *  read at 0.6 of it, and the smooth upscale softened it further. */
export const THREAD_PEAK = 1 / ribbonCoverage(0);

export const CAST_RASTER_GLSL = /* glsl */`
  float castErf(float x) {
    float t = 1.0 / (1.0 + 0.3275911 * abs(x));
    float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
    return x < 0.0 ? -y : y;
  }
  float boxGauss(float x, float sigma) {
    float k = 0.70710678 / sigma;
    return 0.5 * (castErf((x + 0.5) * k) - castErf((x - 0.5) * k));
  }
  float spot(vec2 d, float sigma) {
    float s = max(sigma, ${SPRITE_MIN_SIGMA.toFixed(3)});
    return 6.2831853 * sigma * s * boxGauss(d.x, s) * boxGauss(d.y, s);
  }
  float spriteHalo(vec2 d, float R) {
    return ${HALO.w1.toFixed(3)} * spot(d, ${HALO.s1.toFixed(3)} * R) + ${HALO.w2.toFixed(3)} * spot(d, ${HALO.s2.toFixed(3)} * R);
  }
  float spriteExtent(float R) {
    return max(R, 0.5 + 3.0 * max(${HALO.s2.toFixed(3)} * R, ${SPRITE_MIN_SIGMA.toFixed(3)}));
  }
  float ribbonCoverage(float across) { return boxGauss(across, ${THREAD_SIGMA.toFixed(3)}); }
`;
