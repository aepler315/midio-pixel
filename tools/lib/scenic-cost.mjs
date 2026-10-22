// Scenic shot tours: what a camera path would cost in terrain, before any
// bake (docs/scenic-tours.md, "Selection and budgets").
//
// A path's footprint is, per DEM tile its frames hit, the sharpest
// focal / view depth any of its poses has on it (pixels per metre of
// geometric error, at the desktop 1080-row budget). The baker gives a tile
// the coarsest stride whose measured error stays within the pixel budget at
// that sharpness, so the stride -- and with it the tile's compressed bytes
// -- follows from the DEM alone. A tile already shipped costs only the
// detail it must gain; a tile already paid for by chosen shots costs only
// the difference to a finer stride.
import { tileStrideError, TILE_CELLS, LOD_BUDGETS } from './terrain-bake.mjs';
import { STRIDES } from '../../src/world/alpine/TerrainPackage.js';
import { pathPoseAt } from '../../src/world/terrain/ShotPath.js';

/** Compressed bytes per tile by stride, measured on posed Monument Valley
 *  bakes (residuals + flow, gzip ratio applied). */
export const TILE_BYTES = Object.freeze({ 1: 7300, 2: 1900, 4: 500, 8: 140, 16: 45, 32: 16, 64: 7 });

/** Footprint of one path: Map tile index -> sharpest focal/depth. */
export function pathFootprint(ctx, path, raster, { everyM = 150, width = 96, height = 54, heightPx = LOD_BUDGETS.desktop.heightPx } = {}) {
  const out = new Map(), L = path.s[path.s.length - 1];
  for (let x = 0; ; x += everyM) {
    const pose = pathPoseAt(path, Math.min(x, L)), r = raster(pose, { width, height });
    const focal = heightPx / (2 * Math.tan((pose.fovYDeg * Math.PI) / 360));
    for (let i = 0; i < r.tile.length; i++) {
      if (r.tile[i] < 0 || !(r.depth[i] > 0)) continue;
      const fod = focal / Math.max(40, r.depth[i]);
      if (!(out.get(r.tile[i]) >= fod)) out.set(r.tile[i], fod);
    }
    if (x >= L) break;
  }
  return out;
}

/** Terrain cost model for one view's grid and shipped package. */
export function terrainCostModel(ctx, { errorPx = LOD_BUDGETS.desktop.errorPx, scale = 4 } = {}) {
  const g = ctx.grid, cells = ctx.terrain?.manifest?.tileCells ?? TILE_CELLS;
  const tilesX = Math.ceil((g.width - 1) / cells);
  const errors = new Map();
  const errorsOf = (t) => {
    let e = errors.get(t);
    if (!e) {
      const ix = t % tilesX, iz = Math.floor(t / tilesX);
      e = STRIDES.filter((s) => s <= cells).map((s) => [s, tileStrideError(g.heightsM, g.valid, g.width, g.height, ix * cells, iz * cells, cells, s)]);
      errors.set(t, e);
    }
    return e;
  };
  const shipped = (t) => {
    const tile = ctx.terrain?.data?.byIndex?.get(`${t % tilesX},${Math.floor(t / tilesX)}`);
    return tile && tile.visible !== false ? tile.stride : null;
  };
  /** The stride a tile needs at sharpness `fod`. */
  const strideFor = (t, fod) => {
    let best = 1;
    for (const [s, e] of errorsOf(t)) if (e * fod <= errorPx * scale) best = s;
    return best;
  };
  /** Bytes a footprint adds beyond the shipped package and `owned`
   *  (Map tile -> stride already paid for). */
  const marginal = (footprint, owned = new Map()) => {
    let bytes = 0;
    for (const [t, fod] of footprint) {
      const need = strideFor(t, fod), have = Math.min(shipped(t) ?? Infinity, owned.get(t) ?? Infinity);
      if (need < have) bytes += TILE_BYTES[need] - (Number.isFinite(have) ? TILE_BYTES[have] : 0);
    }
    return bytes;
  };
  /** Record a footprint's strides in `owned`. */
  const own = (footprint, owned) => {
    for (const [t, fod] of footprint) {
      const need = strideFor(t, fod);
      if (!(owned.get(t) <= need)) owned.set(t, need);
    }
    return owned;
  };
  return { strideFor, marginal, own, shipped, tilesX };
}
