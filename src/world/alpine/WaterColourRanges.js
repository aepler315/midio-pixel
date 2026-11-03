// The optional water pass repeats the terrain's colour draw with every dry
// fragment discarded. Nearly all of the land's vertices are shaded for
// nothing, so a static view submits only the index ranges that can reach
// water. Ranges address the existing index buffers: no GPU resource is added,
// the depth pre-pass stays whole and triangles keep their order.
//
// A fragment is water only when a bilinear corner of its surface cell holds
// the WATER_FLOW marker (TerrainMaterial waterCoverageAt), and its cell comes
// from undeformed xz alone. A triangle whose texel rectangle, plus a guard
// texel for interpolation rounding, holds no marker can never draw.
import { finishPreparation, prepareInSlices } from './PreparationSteps.js';
import { WATER_FLOW } from './TerrainPackage.js';

/** Colour draws per geometry. */
export const WATER_COLOUR_MAX_RANGES = 4;
/** Dry indices that earn another draw: about one tile's worth of shading. */
export const WATER_COLOUR_MIN_GAP = 6 * 64 * 64;
/** Share of a geometry's indices worth leaving the original draw for. */
export const WATER_COLOUR_MIN_SAVING = .05;
const TRIANGLES_PER_SLICE = 1 << 16;

/**
 * Submit each entry's groups in place of its mesh's whole index range until
 * the returned function runs. A window swap replaces a mesh's geometry, and
 * ranges of another index buffer mean nothing: that mesh draws whole.
 */
export function restrictWaterColour(entries) {
  const applied = (entries || []).filter(e => e.mesh.geometry === e.geometry)
    .map(e => ({ ...e, material: e.mesh.material, whole: e.geometry.groups }));
  for (const e of applied) { e.mesh.material = [e.material]; e.geometry.groups = e.groups; }
  return () => { for (const e of applied) { e.mesh.material = e.material; e.geometry.groups = e.whole; } };
}

/** Summed-area table of the surface's water texels (rows + 1 by columns + 1).
 *  Transient: rectangle queries cost the same on the largest coarse tile. */
export function waterTexelTable(surface) {
  return finishPreparation(waterTexelSteps(surface));
}

export function waterTexelTableAsync(surface, options = {}) {
  return prepareInSlices(waterTexelSteps(surface), options);
}

function* waterTexelSteps({ width, height, data }) {
  const stride = width + 1, sums = new Uint32Array(stride * (height + 1));
  for (let z = 0; z < height; z++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      if (data[(z * width + x) * 4 + 3] === WATER_FLOW) row++;
      sums[(z + 1) * stride + x + 1] = sums[z * stride + x + 1] + row;
    }
    yield;
  }
  return { width, height, sums, stride };
}

/**
 * The { start, count, materialIndex } groups of `indices` that can reach
 * water, in index order. Empty when nothing can (`table` null: terrain water
 * is ruled out by policy). Null when the saving does not justify replacing
 * the original draw.
 */
export function waterColourRanges(positions, indices, table, grid, options) {
  return finishPreparation(waterRangeSteps(positions, indices, table, grid, options));
}

export function waterColourRangesAsync(positions, indices, table, grid, options = {}) {
  return prepareInSlices(waterRangeSteps(positions, indices, table, grid, options), options);
}

function* waterRangeSteps(positions, indices, table, grid, { maxRanges = WATER_COLOUR_MAX_RANGES,
  minGap = WATER_COLOUR_MIN_GAP, minSaving = WATER_COLOUR_MIN_SAVING } = {}) {
  if (!indices.length) return null;
  if (!table) return [];
  // Runs of triangles that can reach water, as flat [start, end) pairs.
  const runs = [];
  const { width: W, height: H, sums, stride } = table;
  const [ox, oz] = grid.originM;
  const sx = (W - 1) / ((grid.width - 1) * grid.cellSizeM), sz = (H - 1) / ((grid.height - 1) * grid.cellSizeM);
  for (let i = 0, open = false; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ax = (positions[a] - ox) * sx, bx = (positions[b] - ox) * sx, cx = (positions[c] - ox) * sx;
    const az = (positions[a + 2] - oz) * sz, bz = (positions[b + 2] - oz) * sz, cz = (positions[c + 2] - oz) * sz;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)) - 1), x1 = Math.min(W, Math.floor(Math.max(ax, bx, cx)) + 3);
    const z0 = Math.max(0, Math.floor(Math.min(az, bz, cz)) - 1), z1 = Math.min(H, Math.floor(Math.max(az, bz, cz)) + 3);
    const wet = sums[z1 * stride + x1] - sums[z0 * stride + x1] - sums[z1 * stride + x0] + sums[z0 * stride + x0] > 0;
    if (wet && !open) runs.push(i, indices.length);
    else if (!wet && open) runs[runs.length - 1] = i;
    open = wet;
    if ((i / 3 + 1) % TRIANGLES_PER_SLICE === 0) yield;
  }
  if (!runs.length) return [];
  // Keep the widest dry gaps the cap allows; narrower ones are drawn through,
  // which only ever adds discarded fragments.
  const gaps = [];
  for (let r = 2; r < runs.length; r += 2) if (runs[r] - runs[r - 1] >= minGap) gaps.push(r);
  gaps.sort((p, q) => (runs[q] - runs[q - 1]) - (runs[p] - runs[p - 1]) || p - q);
  const splits = gaps.slice(0, maxRanges - 1).sort((p, q) => p - q);
  const groups = [];
  let start = runs[0], submitted = 0;
  for (const r of [...splits, runs.length]) {
    const count = runs[r - 1] - start;
    groups.push({ start, count, materialIndex: 0 });
    submitted += count;
    start = runs[r];
  }
  return 1 - submitted / indices.length < minSaving ? null : groups;
}
