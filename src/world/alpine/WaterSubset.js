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
 *  coarse block summary for fast rejection. `rgba` is width*height*4. Fill
 *  it in row slices with fillWetRows to keep each slice short. */
export function createWetMask(width, height) {
  const bw = Math.ceil(width / BLOCK), bh = Math.ceil(height / BLOCK);
  return { wet: new Uint8Array(width * height), blocks: new Uint8Array(bw * bh), width, height, bw, bh, count: 0 };
}

export function fillWetRows(mask, rgba, y0, y1) {
  const { wet, blocks, width, bw } = mask;
  for (let y = y0; y < Math.min(y1, mask.height); y++) {
    const row = y * width, brow = (y / BLOCK | 0) * bw;
    for (let x = 0; x < width; x++) {
      if (rgba[(row + x) * 4 + 3] === 255) { wet[row + x] = 1; blocks[brow + (x / BLOCK | 0)] = 1; mask.count++; }
    }
  }
  return mask;
}

export function wetTexelMask(rgba, width, height) {
  return fillWetRows(createWetMask(width, height), rgba, 0, height);
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
export function waterIndexSubset(positions, index, grid, mask, { maxShare = WATER_SUBSET_MAX_SHARE, chunks = null } = {}) {
  const n = index.length - index.length % 3;
  const keep = keptTriangles(positions, index, grid, mask, 0, n, Math.floor(n * maxShare), chunkCursor(chunks));
  return keep && keep.slice();
}

// Counts the kept indices of each chunk of `table` (TerrainChunks.js): its
// index ranges tile the index in order, so a triangle's chunk only moves
// forward as the scan does.
function chunkCursor(table) {
  if (!table) return null;
  table.kept?.fill(0);
  return { start: table.start, count: table.count, kept: table.kept, c: 0 };
}

/**
 * The same, in slices of `sliceTriangles`, awaiting `pause()` between them
 * so a large band never blocks the main thread for long. `chunks`, a chunk
 * table of `index` with a `kept` Uint32Array, gets each chunk's kept index
 * count (the subset's own chunk table, TerrainChunks.subsetChunkTable).
 */
export async function waterIndexSubsetAsync(positions, index, grid, mask, { maxShare = WATER_SUBSET_MAX_SHARE, sliceTriangles = 65536, pause = async () => {}, chunks = null } = {}) {
  const n = index.length - index.length % 3, limit = Math.floor(n * maxShare);
  const parts = [], cursor = chunkCursor(chunks);
  let total = 0;
  for (let start = 0; start < n; start += sliceTriangles * 3) {
    const part = keptTriangles(positions, index, grid, mask, start, Math.min(n, start + sliceTriangles * 3), limit - total, cursor);
    if (!part) return null;
    parts.push(part.slice()); total += part.length;
    if (start + sliceTriangles * 3 < n) await pause();
  }
  const out = new index.constructor(total);
  let o = 0;
  for (const part of parts) { out.set(part, o); o += part.length; }
  return out;
}

// Triangles [start, end) of `index` that can draw water, as a view on a
// scratch array, or null past `limit` indices.
function keptTriangles(positions, index, grid, mask, start, end, limit, cursor = null) {
  const ox = grid.originM[0], oz = grid.originM[1], inv = 1 / grid.cellSizeM;
  if (!mask.count) return new index.constructor(0);
  const keep = new index.constructor(end - start);
  let k = 0;
  for (let i = start; i < end; i += 3) {
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
    if (cursor) {
      while (cursor.c < cursor.start.length && i >= cursor.start[cursor.c] + cursor.count[cursor.c]) cursor.c++;
      if (cursor.c < cursor.start.length && i >= cursor.start[cursor.c]) cursor.kept[cursor.c] += 3;
    }
  }
  return keep.subarray(0, k);
}
