// Scalar/vector field math for the phenomena layer: smooth 3D value noise
// and its 2D curl. Taking the curl of a scalar potential gives a velocity
// field that is divergence-free by construction -- particles advected
// through it swirl like smoke or wind gusts and can never pile up or
// drain away, which is why this is the standard fluid-look trick.

function hash3(ix, iy, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 1440662683)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10); // smootherstep: C2-continuous

/** Smooth value noise in (x, y, t) space, range [0, 1]. */
export function valueNoise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
  const lerp = (a, b, t) => a + (b - a) * t;

  const c000 = hash3(ix, iy, iz), c100 = hash3(ix + 1, iy, iz);
  const c010 = hash3(ix, iy + 1, iz), c110 = hash3(ix + 1, iy + 1, iz);
  const c001 = hash3(ix, iy, iz + 1), c101 = hash3(ix + 1, iy, iz + 1);
  const c011 = hash3(ix, iy + 1, iz + 1), c111 = hash3(ix + 1, iy + 1, iz + 1);

  return lerp(
    lerp(lerp(c000, c100, fx), lerp(c010, c110, fx), fy),
    lerp(lerp(c001, c101, fx), lerp(c011, c111, fx), fy),
    fz,
  );
}

const CURL_EPS = 0.01;

/** 2D curl of the noise potential at (x, y, t): v = (d(psi)/dy, -d(psi)/dx). */
export function curl2(x, y, t) {
  const dpdy = (valueNoise3(x, y + CURL_EPS, t) - valueNoise3(x, y - CURL_EPS, t)) / (2 * CURL_EPS);
  const dpdx = (valueNoise3(x + CURL_EPS, y, t) - valueNoise3(x - CURL_EPS, y, t)) / (2 * CURL_EPS);
  return { x: dpdy, y: -dpdx };
}
