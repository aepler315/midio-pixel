// Procedural micro-relief below the resolution of the elevation data.
// Real DEMs stop at ~3-30 m; close up, mountains need rock steps, ribs and
// boulder-scale roughness. This adds band-limited gradient noise in the
// wavelengths the data cannot contain (<= 32 m), scaled by how rugged the
// ground is. It is a pure function of position, so neighbouring tiles and
// different detail levels agree. Coordinates are "mercator metres":
// normalized mercator x/y times the equatorial circumference.

export const DETAIL_MAX_WAVELENGTH = 32;
export const DETAIL_MIN_WAVELENGTH = 1;

function hash2(ix, iy) {
  // 32-bit integer hash -> [0, 1)
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Gradient noise in [-1, 1]-ish at lattice spacing 1. */
export function gradNoise(x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const g = (ix, iy, dx, dy) => {
    const a = hash2(ix, iy) * 6.283185307179586;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const n00 = g(x0, y0, fx, fy), n10 = g(x0 + 1, y0, fx - 1, fy);
  const n01 = g(x0, y0 + 1, fx, fy - 1), n11 = g(x0 + 1, y0 + 1, fx - 1, fy - 1);
  const a = n00 + (n10 - n00) * u, b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 1.4;
}

/**
 * Detail height (m) at mercator-metre position (mx, my).
 *   rough      0 (smooth meadow / water) .. 1 (broken rock)
 *   texelM     sample spacing of the caller; octaves shorter than ~2.5
 *              samples are left out (they would alias), with a soft fade
 */
export function detailHeight(mx, my, rough, texelM) {
  if (rough <= 0) return 0;
  let h = 0;
  for (let lam = DETAIL_MAX_WAVELENGTH; lam >= DETAIL_MIN_WAVELENGTH; lam /= 2) {
    const w = (lam / texelM - 2.5) / 1.5; // fade in between 2.5 and 4 samples per wavelength
    if (w <= 0) break;
    const n = gradNoise(mx / lam + lam * 17.13, my / lam - lam * 7.71);
    // Ridged on rough ground reads as rock ribs; the crest is rounded (smooth
    // |n|), since a razor crease lights up as a thin line, like wood grain.
    const ridged = 0.5 - Math.sqrt(n * n + 0.03);
    const amp = lam * (0.05 + 0.11 * rough) * Math.min(1, w);
    h += amp * (n * (1 - rough * 0.5) + ridged * rough * 0.6);
  }
  return h * rough;
}

/** Ruggedness from slope (rise/run): flats smooth, cliffs broken. */
export const roughnessFromSlope = (slope) => Math.min(1, Math.max(0.08, (slope - 0.15) * 1.4));
