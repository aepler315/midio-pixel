// Tile rules shared by the offline baker (tools/lib/terrain-bake.mjs) and the
// runtime song range assembler (StageAssembly.js): tile size, quality budgets,
// visibility framing, per-stride triangulation error and the payload's height
// encoding. Pure: no DOM, no GPU, no Node APIs. Moving these here changed no
// baked byte; both sides import this one copy.

/** Coarsest stride a tile holding both water and land may use (cells). */
export const SHORE_MAX_STRIDE = 4;
export const TILE_CELLS = 64;
export const LOD_BUDGETS = Object.freeze({
  desktop: { errorPx: 1, heightPx: 1080 },
  mobile: { errorPx: 2, heightPx: 720 },
});
// Frustum widening used for visibility: the widest supported framing
// (2.4:1), the deepest camera pull-back (1 / ZOOM_MIN = 1.52) and the shake
// overscan margin together. Conservative on purpose: a tile culled here is
// never baked finely, so under-estimating would show coarse terrain.
export const VISIBILITY = Object.freeze({
  // Normal framing: 16:9 up to the reference's 2.07:1, with shake overscan.
  core: { aspect: 2.1, fovScale: 1.2, budgetScale: 1 },
  // Everything a frame can ever show: 2.4:1 at the deepest pull-back.
  // Terrain only visible here is baked at 3x the pixel budget.
  extended: { aspect: 2.4, fovScale: 1.85, budgetScale: 3 },
  stations: 21, minDistanceM: 40,
  // Occlusion raster: width in pixels, sample stride in cells, tolerance.
  occlusion: { width: 384, stride: 4, depthSlack: 0.015, slackM: 30 },
});
export const FRAMINGS = Object.freeze(['core', 'extended']);

export function triangulatedHeight(a, b, c, d, fu, fv) {
  return fu >= fv ? a + (b - a) * fu + (d - b) * fv : a + (d - c) * fu + (c - a) * fv;
}

/** Max |full - stride triangulation| over one tile. Cells with an invalid
 *  corner are skipped (they are not drawn); a cell that would bridge an
 *  invalid interior sample makes the stride ineligible (Infinity). */
export function tileStrideError(h, valid, w, hgt, x0, y0, cells, stride) {
  if (stride === 1) return 0;
  let err = 0;
  for (let cy = 0; cy < cells; cy += stride) {
    for (let cx = 0; cx < cells; cx += stride) {
      const X = x0 + cx, Y = y0 + cy;
      if (X + stride >= w || Y + stride >= hgt) continue;
      const ia = Y * w + X, ib = ia + stride, ic = ia + stride * w, id = ic + stride;
      if (!(valid[ia] && valid[ib] && valid[ic] && valid[id])) continue;
      const a = h[ia], b = h[ib], c = h[ic], d = h[id];
      for (let v = 0; v <= stride; v++) {
        for (let u = 0; u <= stride; u++) {
          const j = (Y + v) * w + X + u;
          // A coarse cell with valid corners would draw over no-data inside
          // it: that stride cannot represent this tile.
          if (!valid[j]) return Infinity;
          const e = Math.abs(h[j] - triangulatedHeight(a, b, c, d, u / stride, v / stride));
          if (e > err) err = e;
        }
      }
    }
  }
  return err;
}

/** Byte-plane split of Uint16 values (low bytes, then high bytes): gzip
 *  compresses small residuals far better this way. */
export function splitPlanes(u16) {
  const out = new Uint8Array(u16.length * 2);
  for (let i = 0; i < u16.length; i++) { out[i] = u16[i] & 0xff; out[u16.length + i] = u16[i] >>> 8; }
  return out;
}

/** Planar predictor residuals (left + up - upleft), modulo 2^16. Inverse:
 *  decodeResiduals in TerrainPackage.js. */
export function encodeResiduals(q, n) {
  const r = new Uint16Array(q.length);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const left = x ? q[i - 1] : (y ? q[i - n] : 0);
      const up = y ? q[i - n] : left;
      const ul = x && y ? q[i - n - 1] : (y ? q[i - n] : left);
      const pred = x && y ? Math.min(65535, Math.max(0, left + up - ul)) : (x ? left : up);
      r[i] = (q[i] - pred) & 0xffff;
    }
  }
  return r;
}

/** Global height quantization for a package spanning [lo, hi] metres. */
export function quantizationFor(lo, hi, quantStepM = null) {
  const stepM = quantStepM || Math.max(0.05, Math.ceil(((hi - lo + 2) / 65000) * 100) / 100);
  return { offsetM: Math.floor(lo) - 1, stepM };
}
