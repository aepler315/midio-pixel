// Terrain-to-terrain sun visibility (natural-rendering Task 4). The terrain
// shader had no directional shadow term: a valley floor below a ridge was
// lit exactly like an open slope. This bakes, once per view, the elevation
// angle of the horizon in a fixed set of azimuths over a coarse grid of the
// package's real heights. The shader interpolates the horizon toward the
// current light direction and compares it with the light's elevation, so
// broad relief shades its lee side and the shadow edge moves with the sun
// without any per-frame shadow rendering.
//
// What it is not: it ignores the musical deformation (static geography; the
// deformation's amplitude is small against the relief that casts these
// shadows) and anything finer than its grid (trees, near rocks: their own
// shading and contact handle that). Points outside the package see an open
// horizon. Missing data (NaN) never occludes.
import { terrainHeightAt } from './TerrainMesh.js';

export const HORIZON_AZIMUTHS = 8;
/** Elevation angle (radians) a byte of 255 encodes. Horizons steeper than
 *  this saturate: the sun is then below them for most of the day anyway. */
export const HORIZON_MAX_RAD = Math.PI / 4;
export const HORIZON_DEFAULTS = Object.freeze({ maxSize: 256, minCellM: 30, maxDistM: 9000, steps: 28, eyeM: 4 });

/** Grid the bake runs on for a package grid (texel centres span the same
 *  extent as the surface texture, so vUv addresses both). */
export function horizonGrid(grid, { maxSize = HORIZON_DEFAULTS.maxSize, minCellM = HORIZON_DEFAULTS.minCellM } = {}) {
  const extentX = (grid.width - 1) * grid.cellSizeM, extentZ = (grid.height - 1) * grid.cellSizeM;
  const longest = Math.max(extentX, extentZ);
  const n = Math.max(2, Math.min(maxSize, Math.floor(longest / minCellM) + 1));
  const cell = longest / (n - 1);
  return { width: Math.max(2, Math.round(extentX / cell) + 1), height: Math.max(2, Math.round(extentZ / cell) + 1),
    originM: [grid.originM[0], grid.originM[1]], extentM: [extentX, extentZ] };
}

export function horizonBytes(grid, options) {
  const g = horizonGrid(grid, options);
  return g.width * g.height * HORIZON_AZIMUTHS;
}

/** Byte for an elevation angle in radians (negative horizons store 0). */
export const encodeHorizon = (rad) => Math.max(0, Math.min(255, Math.round(rad / HORIZON_MAX_RAD * 255)));
export const decodeHorizon = (byte) => byte / 255 * HORIZON_MAX_RAD;

/**
 * Bake as a generator (one grid row per step) so preparation can yield.
 * Returns { width, height, originM, extentM, azimuths, data: Uint8Array }
 * where data holds HORIZON_AZIMUTHS bytes per texel, azimuth k at angle
 * 2*pi*k/HORIZON_AZIMUTHS measured from +X toward +Z.
 */
export function* bakeHorizonSteps(data, options = {}) {
  const o = { ...HORIZON_DEFAULTS, ...options };
  const g = horizonGrid(data.grid, o);
  const sample = o.sample || ((x, z) => terrainHeightAt(data, x, z));
  const out = new Uint8Array(g.width * g.height * HORIZON_AZIMUTHS);
  const dirs = Array.from({ length: HORIZON_AZIMUTHS }, (_, k) => {
    const a = (k / HORIZON_AZIMUTHS) * Math.PI * 2;
    return [Math.cos(a), Math.sin(a)];
  });
  // Geometric ray steps: fine near the point (close ridges), coarse far out.
  const cellM = g.extentM[0] / Math.max(1, g.width - 1);
  const first = Math.max(cellM * 0.75, 20), ratio = Math.pow(o.maxDistM / first, 1 / Math.max(1, o.steps - 1));
  const distances = Array.from({ length: o.steps }, (_, i) => first * Math.pow(ratio, i));
  for (let j = 0; j < g.height; j++) {
    const z = g.originM[1] + (g.height > 1 ? (j / (g.height - 1)) * g.extentM[1] : 0);
    for (let i = 0; i < g.width; i++) {
      const x = g.originM[0] + (g.width > 1 ? (i / (g.width - 1)) * g.extentM[0] : 0);
      const h0 = sample(x, z);
      const o8 = (j * g.width + i) * HORIZON_AZIMUTHS;
      if (!Number.isFinite(h0)) continue; // open horizon
      const eye = h0 + o.eyeM;
      for (let k = 0; k < HORIZON_AZIMUTHS; k++) {
        let best = 0;
        const [dx, dz] = dirs[k];
        for (const d of distances) {
          const h = sample(x + dx * d, z + dz * d);
          if (!Number.isFinite(h)) continue;
          const t = (h - eye) / d;
          if (t > best) best = t;
        }
        out[o8 + k] = encodeHorizon(Math.atan(best));
      }
    }
    yield j;
  }
  return { ...g, azimuths: HORIZON_AZIMUTHS, data: out };
}

export function bakeHorizon(data, options) {
  const it = bakeHorizonSteps(data, options);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

export async function bakeHorizonAsync(data, { sliceMs = 8, yieldTo = () => new Promise(r => setTimeout(r, 0)), signal = null, ...options } = {}) {
  const it = bakeHorizonSteps(data, options);
  let t0 = performance.now(), r = it.next();
  while (!r.done) {
    if (performance.now() - t0 > sliceMs) {
      await yieldTo();
      if (signal?.aborted) throw new Error('aborted');
      t0 = performance.now();
    }
    r = it.next();
  }
  return r.value;
}

/** Horizon elevation toward azimuth `phi` at texel (i, j): the JS twin of
 *  the shader lookup (linear between the two nearest baked azimuths). */
export function horizonAt(bake, i, j, phi) {
  const f = ((phi / (Math.PI * 2)) % 1 + 1) % 1 * HORIZON_AZIMUTHS;
  const k0 = Math.floor(f) % HORIZON_AZIMUTHS, k1 = (k0 + 1) % HORIZON_AZIMUTHS, t = f - Math.floor(f);
  const o = (j * bake.width + i) * HORIZON_AZIMUTHS;
  return decodeHorizon(bake.data[o + k0]) * (1 - t) + decodeHorizon(bake.data[o + k1]) * t;
}

/** Soft sun visibility for a light elevation against a horizon (radians). */
export const PENUMBRA_LO = 0.04, PENUMBRA_HI = 0.09;
export function sunVisibility(horizonRad, lightElevationRad, { penumbraLo = PENUMBRA_LO, penumbraHi = PENUMBRA_HI } = {}) {
  const lo = horizonRad - penumbraLo, hi = horizonRad + penumbraHi;
  const t = Math.max(0, Math.min(1, (lightElevationRad - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/** One RGBA8 texture, two halves side by side: azimuths 0-3 in the left
 *  half, 4-7 in the right (one sampler: the terrain shader is near the
 *  mobile uniform budget). */
export function createHorizonTexture(THREE, bake) {
  const W = bake.width, H = bake.height;
  const bytes = new Uint8Array(W * 2 * H * 4);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const src = (j * W + i) * HORIZON_AZIMUTHS;
    for (let c = 0; c < 4; c++) {
      bytes[(j * W * 2 + i) * 4 + c] = bake.data[src + c];
      bytes[(j * W * 2 + W + i) * 4 + c] = bake.data[src + 4 + c];
    }
  }
  const t = new THREE.DataTexture(bytes, W * 2, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return { texture: t, bytes: bytes.byteLength };
}

export const HORIZON_GLSL = /* glsl */`
  uniform sampler2D uHorizon;
  // Bake size in texels; x < 2 means no bake (direct light unshadowed).
  uniform vec2 uHorizonSize;
  float horizonChannel(int k, vec4 a, vec4 b) {
    vec4 v = k < 4 ? a : b;
    int c = k - (k < 4 ? 0 : 4);
    return c == 0 ? v.x : c == 1 ? v.y : c == 2 ? v.z : v.w;
  }
  // Direct-light visibility at grid uv for light direction L (world).
  float sunHorizonVisibility(vec2 gridUv, vec3 L) {
    if (uHorizonSize.x < 2.0) return 1.0;
    if (any(lessThan(gridUv, vec2(0.0))) || any(greaterThan(gridUv, vec2(1.0)))) return 1.0;
    // Texel centres of one half; the halves never filter into each other.
    vec2 uv = gridUv * (uHorizonSize - 1.0) / uHorizonSize + .5 / uHorizonSize;
    uv.x *= .5;
    vec4 a = texture(uHorizon, uv), b = texture(uHorizon, uv + vec2(.5, 0.0));
    float phi = atan(L.z, L.x);
    float f = fract(phi / 6.2831853) * ${HORIZON_AZIMUTHS}.0;
    int k0 = int(floor(f)) % ${HORIZON_AZIMUTHS};
    int k1 = (k0 + 1) % ${HORIZON_AZIMUTHS};
    float h = mix(horizonChannel(k0, a, b), horizonChannel(k1, a, b), fract(f)) * ${HORIZON_MAX_RAD.toFixed(6)};
    float e = asin(clamp(L.y, -1.0, 1.0));
    // A wide penumbra: the bake is coarse (~100-200 m), so a hard edge
    // would draw its texels as blotches instead of a cast shadow.
    return smoothstep(h - ${PENUMBRA_LO.toFixed(3)}, h + ${PENUMBRA_HI.toFixed(3)}, e);
  }
`;
