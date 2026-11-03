// Precomputed water-only terrain indices.
//
// The lake layer (RangeScene.renderWater) redraws every terrain band with
// uWaterOnly set, and the terrain shader discards each fragment that is not
// water. Most of a view is dry, so almost all of that work -- every vertex,
// and every fragment up to the discard, at up to output resolution -- is
// thrown away. A fragment can only be water where waterCoverageAt() reaches
// a fully wet surface texel (alpha 255), and a triangle's fragments only
// sample texels inside the bounding box of its vertices' grid coordinates.
// So a triangle with no wet texel in that box (plus a texel of margin) can
// never produce a water fragment, and the water pass can skip it outright.
// Kept triangles stay in their original order, so depth ties resolve
// exactly as before: the drawn picture is unchanged.

/** Texels of margin around each triangle's sample box (float safety). */
export const WATER_SUBSET_MARGIN = 1;
/** Past this share of a band's triangles a subset saves too little to be
 *  worth its index memory; the band keeps its full index for water. */
export const WATER_SUBSET_MAX_SHARE = 0.5;
const BLOCK = 16;

/** Wet-texel mask of the surface texture's alpha (flow) channel, with a
 *  coarse block summary for fast rejection. `rgba` is width*height*4. */
export function wetTexelMask(rgba, width, height) {
  const wet = new Uint8Array(width * height);
  const bw = Math.ceil(width / BLOCK), bh = Math.ceil(height / BLOCK);
  const blocks = new Uint8Array(bw * bh);
  let count = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width, brow = (y / BLOCK | 0) * bw;
    for (let x = 0; x < width; x++) {
      if (rgba[(row + x) * 4 + 3] === 255) { wet[row + x] = 1; blocks[brow + (x / BLOCK | 0)] = 1; count++; }
    }
  }
  return { wet, blocks, width, height, bw, bh, count };
}

function anyWet(mask, x0, y0, x1, y1) {
  const { wet, blocks, width, height, bw } = mask;
  if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
  if (x1 > width - 1) x1 = width - 1; if (y1 > height - 1) y1 = height - 1;
  if (x0 > x1 || y0 > y1) return false;
  const bx0 = x0 / BLOCK | 0, bx1 = x1 / BLOCK | 0, by0 = y0 / BLOCK | 0, by1 = y1 / BLOCK | 0;
  for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
    if (!blocks[by * bw + bx]) continue;
    const ty0 = Math.max(y0, by * BLOCK), ty1 = Math.min(y1, by * BLOCK + BLOCK - 1);
    const tx0 = Math.max(x0, bx * BLOCK), tx1 = Math.min(x1, bx * BLOCK + BLOCK - 1);
    for (let y = ty0; y <= ty1; y++) {
      const row = y * width;
      for (let x = tx0; x <= tx1; x++) if (wet[row + x]) return true;
    }
  }
  return false;
}

/**
 * The triangles of `index` (over xyz `positions`) that can draw water, in
 * their original order, as the same typed-array kind; or null when they are
 * more than `maxShare` of the triangles. `grid` maps world x/z to texel
 * coordinates: texel = (p - originM) / cellSizeM, which is exactly the
 * shader's `vUv * (1 - uTexel) + .5 * uTexel` scaled by the texture size,
 * minus the half texel (TerrainMaterial waterCoverageAt).
 */
export function waterIndexSubset(positions, index, grid, mask, { maxShare = WATER_SUBSET_MAX_SHARE } = {}) {
  const ox = grid.originM[0], oz = grid.originM[1], inv = 1 / grid.cellSizeM;
  const n = index.length - index.length % 3;
  if (!mask.count) return new index.constructor(0);
  const keep = new index.constructor(n);
  let k = 0;
  const limit = Math.floor(n * maxShare);
  for (let i = 0; i < n; i += 3) {
    const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
    const ax = (positions[a] - ox) * inv, az = (positions[a + 2] - oz) * inv;
    const bx = (positions[b] - ox) * inv, bz = (positions[b + 2] - oz) * inv;
    const cx = (positions[c] - ox) * inv, cz = (positions[c + 2] - oz) * inv;
    // waterCoverageAt reads corner = floor(sample) and corner + 1.
    const x0 = Math.floor(Math.min(ax, bx, cx)) - WATER_SUBSET_MARGIN;
    const x1 = Math.floor(Math.max(ax, bx, cx)) + 1 + WATER_SUBSET_MARGIN;
    const z0 = Math.floor(Math.min(az, bz, cz)) - WATER_SUBSET_MARGIN;
    const z1 = Math.floor(Math.max(az, bz, cz)) + 1 + WATER_SUBSET_MARGIN;
    if (!(Number.isFinite(x0) && Number.isFinite(x1) && Number.isFinite(z0) && Number.isFinite(z1))) return null;
    if (!anyWet(mask, x0, z0, x1, z1)) continue;
    if (k + 3 > limit) return null;
    keep[k++] = index[i]; keep[k++] = index[i + 1]; keep[k++] = index[i + 2];
  }
  return keep.slice(0, k);
}
