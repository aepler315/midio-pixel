// Scenic shot tours: does a view's baked terrain package cover its camera
// paths? (docs/scenic-tours.md, stages "bake" and "validate".)
//
// The baker (terrain-bake.mjs) ships only tiles some camera sees, each at
// the coarsest stride whose measured error stays within the pixel budget at
// that camera's closest approach. A tour leaves the rail, so every pose of
// its library footprint is checked against the package it will actually
// draw: the full DEM grid is rasterized from the pose -- the ground truth of
// what is in frame -- and every visible surface must lie on a shipped tile
// (otherwise the picture has a hole) whose drawn stride projects within the
// budget at that pixel's depth.
//
// Local scene axes: X east, Y up, Z south, metres (SceneTravel).
import fs from 'node:fs/promises';
import path from 'node:path';
import { occlusionBuffer, gridTileBoxes, poseErrors, LOD_BUDGETS, VISIBILITY } from './terrain-bake.mjs';
import { focalPx } from '../../src/world/terrain/SceneTravel.js';
import { pathPoseAt } from '../../src/world/terrain/ShotPath.js';
import { MIRROR_SCALE, MIRROR_CLIP_M } from '../../src/world/alpine/WaterMirror.js';

/** Everything under this directory ships; tools/build-teton-tour.mjs holds
 *  it to RANGE_ASSET_LIMIT bytes. */
export const RANGE_ASSET_DIR = 'src/assets/range/v2';
export const RANGE_ASSET_LIMIT = 60e6;

/** Tiles a package ships (decodeTerrain data, or a manifest): `keys`, the
 *  set of 'ix,iz', and `tiles`, per key { id, stride, lod, errorsM,
 *  visible }; the runtime draws only visible tiles (TerrainMesh planBands). */
export function packageTileSet(terrainData) {
  const keys = new Set(), tiles = new Map();
  for (const t of (terrainData.byIndex ?? terrainData.tiles).values()) {
    const key = `${t.ix},${t.iz}`;
    keys.add(key);
    tiles.set(key, { id: t.id, stride: t.stride, lod: t.lod ?? null, errorsM: t.errorsM ?? {}, visible: Boolean(t.visible) });
  }
  return { keys, tiles };
}

const round = (v, k) => Math.round(v * 10 ** k) / 10 ** k;

/**
 * Check camera poses against a baked package. ctx = { grid, terrain:
 * { manifest, data } }: the DEM grid as baked (despiked, smoothed) and the
 * decoded package (decodeTerrain). Each pose is rasterized at the wide
 * aspect (aspect[1]) and its own lens; pixels within the core aspect
 * (aspect[0]) are held to `errorPx`, the side bands -- and every pixel of a
 * pose framed 'extended' -- to `extendedErrorPx`. A visible surface on a
 * tile the package lacks is a hole; on a present tile its drawn stride for
 * `budget` (the runtime's lod, else the baked stride) must project
 * errorsM[stride] * focal / depth within its pixel's limit, the depth held
 * to at least the baker's minDistanceM. Mirror poses (mirroredPose) clip
 * the ground at their water level and are judged at the mirror's
 * resolution. Holes are reported per pose with the fraction of the frame
 * they cover (above `maxHoleFrac`) and the missing tiles; LOD violations
 * per pose and tile at their worst pixel. `raster(grid, pose, framing,
 * { occlusion, tiles, minHeightM })` may replace the rasterizer: it returns
 * { buf (1/depth per pixel, 0 = sky), W, H, tile (iz * tilesX + ix per
 * pixel, -1 = sky) }.
 */
export function validatePoses(ctx, poses, {
  aspect = [16 / 9, 2.1], budget = 'desktop', errorPx = null, extendedErrorPx = null, raster = null,
  occlusion = { width: 480, stride: 4 }, fovScale = 1, nearM = 20, minDepthM = VISIBILITY.minDistanceM, maxHoleFrac = 0,
} = {}) {
  const { grid, terrain } = ctx;
  const m = terrain.manifest;
  const same = m.grid.width === grid.width && m.grid.height === grid.height && m.grid.cellSizeM === grid.cellSizeM
    && m.grid.originM[0] === grid.originM[0] && m.grid.originM[1] === grid.originM[1];
  if (!same) throw new Error('validatePoses: the DEM grid is not the package grid');
  const lens = (m.lod?.budgets ?? LOD_BUDGETS)[budget];
  if (!lens) throw new Error(`validatePoses: unknown budget ${budget}`);
  const coreLimit = errorPx ?? lens.errorPx, wideLimit = extendedErrorPx ?? 3 * coreLimit;
  const layout = gridTileBoxes(grid, m.tileCells);
  // Per tile index: the drawn stride's measured error, or null (not shipped,
  // or shipped hidden: keepHidden diagnostics the runtime does not draw).
  const drawn = new Array(layout.boxes.length).fill(null);
  for (const [key, t] of packageTileSet(terrain.data ?? m).tiles) {
    if (!t.visible) continue;
    const [ix, iz] = key.split(',').map(Number);
    const stride = t.lod?.[budget] ?? t.stride;
    drawn[iz * layout.tilesX + ix] = { key, errorM: t.errorsM[stride] ?? Infinity };
  }
  const [coreAspect, wideAspect] = Array.isArray(aspect) ? aspect : [aspect, aspect];
  const framing = { aspect: wideAspect, fovScale };
  const scratch = {};
  const holes = [], lod = [], worst = { holeFrac: 0, errorPx: 0, extendedErrorPx: 0 };
  poses.forEach((pose, poseIndex) => {
    const errors = poseErrors(pose);
    if (errors.length) throw new Error(`pose ${poseIndex}: ${errors.join('; ')}`);
    const mirror = pose.framing === 'mirror', wideOnly = pose.framing === 'extended';
    const minHeightM = mirror ? pose.levelM + MIRROR_CLIP_M : -Infinity;
    const ob = raster ? raster(grid, pose, framing, { occlusion, tiles: layout, minHeightM })
      : occlusionBuffer(grid, pose, framing, occlusion, { tiles: layout, ids: true, minHeightM, scratch });
    const focal = focalPx(pose.fovYDeg, lens.heightPx) * (mirror ? MIRROR_SCALE : 1);
    const coreHalfPx = wideOnly ? -1 : ((coreAspect / wideAspect) * ob.W) / 2;
    let holePx = 0;
    const missing = new Set(), over = new Map();
    for (let y = 0; y < ob.H; y++) for (let x = 0; x < ob.W; x++) {
      const o = y * ob.W + x, v = ob.buf[o];
      if (!(v > 0) || 1 / v < nearM) continue; // sky, or inside the near plane
      const tile = drawn[ob.tile[o]];
      if (!tile) { holePx++; missing.add(ob.tile[o]); continue; }
      const core = Math.abs(x + 0.5 - ob.W / 2) <= coreHalfPx;
      const depth = Math.max(minDepthM, 1 / v);
      const px = (tile.errorM * focal) / depth, limit = core ? coreLimit : wideLimit;
      if (core) worst.errorPx = Math.max(worst.errorPx, px);
      else worst.extendedErrorPx = Math.max(worst.extendedErrorPx, px);
      // Stored errors are rounded to the millimetre.
      const ratio = (Math.max(0, tile.errorM - 5e-4) * focal) / depth / limit;
      if (ratio > 1 && !(over.get(ob.tile[o])?.ratio >= ratio)) over.set(ob.tile[o], { ratio, px, limit });
    }
    const frac = holePx / (ob.W * ob.H);
    worst.holeFrac = Math.max(worst.holeFrac, frac);
    if (holePx && frac > maxHoleFrac) {
      holes.push({ poseIndex, frac: round(frac, 6), tiles: [...missing].map((k) => `${k % layout.tilesX},${Math.floor(k / layout.tilesX)}`) });
    }
    for (const [k, e] of over) lod.push({ poseIndex, tile: drawn[k].key, errorPx: round(e.px, 3), limitPx: e.limit });
  });
  return {
    ok: !holes.length && !lod.length, holes, lod,
    worst: { holeFrac: round(worst.holeFrac, 6), errorPx: round(worst.errorPx, 3), extendedErrorPx: round(worst.extendedErrorPx, 3) },
  };
}

/**
 * Poses along ShotPath paths (or records holding one as .path, e.g. a
 * decoded library's shots and links) at most `spacingM` of progress apart,
 * both ends of every path included; each pose carries { pathIndex, s } and
 * the record's id as pathId. Over `maxPoses`, the spacing grows until they
 * fit (ends kept); if the ends alone do not fit, poses are taken evenly by
 * index. Deterministic. Bad options throw: an empty sample would validate
 * clean with nothing checked.
 */
export function sampleFootprintPoses(paths, { spacingM = 150, maxPoses = 3000 } = {}) {
  if (!Array.isArray(paths)) throw new Error('sampleFootprintPoses: paths must be an array');
  if (!(Number.isFinite(spacingM) && spacingM > 0)) throw new Error(`sampleFootprintPoses: spacingM must be a positive number, not ${spacingM}`);
  if (!(Number.isInteger(maxPoses) && maxPoses >= 1)) throw new Error(`sampleFootprintPoses: maxPoses must be an integer >= 1, not ${maxPoses}`);
  const list = paths.map((r) => (r.path ? { path: r.path, id: r.id } : { path: r }));
  const spans = list.map(({ path: p }) => [p.s[0], p.s[p.s.length - 1]]);
  const steps = ([a, b], spacing) => (b > a ? Math.max(1, Math.ceil((b - a) / spacing)) : 0);
  const count = (spacing) => spans.reduce((n, span) => n + steps(span, spacing) + 1, 0);
  let spacing = spacingM;
  for (let i = 0; i < 64 && count(spacing) > maxPoses; i++) spacing *= Math.max(1.05, count(spacing) / Math.max(1, maxPoses));
  const poses = [];
  list.forEach(({ path: p, id }, pathIndex) => {
    const [a, b] = spans[pathIndex], n = steps(spans[pathIndex], spacing);
    for (let k = 0; k <= n; k++) {
      const s = n ? a + ((b - a) * k) / n : a;
      poses.push({ ...pathPoseAt(p, s), pathIndex, s, ...(id != null ? { pathId: id } : {}) });
    }
  });
  if (poses.length <= maxPoses) return poses;
  return Array.from({ length: maxPoses }, (_, k) => poses[Math.round((k * (poses.length - 1)) / Math.max(1, maxPoses - 1))]);
}

/** Total bytes of every file under `root`/src/assets/range/v2. */
export async function rangeAssetBytes(root) {
  const walk = async (dir) => {
    let total = 0;
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) total += await walk(file);
      else if (e.isFile()) total += (await fs.stat(file)).size;
    }
    return total;
  };
  return walk(path.join(root, RANGE_ASSET_DIR));
}

/** Errors when the Range assets exceed their byte budget (empty = within). */
export async function assetBudgetErrors(root, { limit = RANGE_ASSET_LIMIT } = {}) {
  const bytes = await rangeAssetBytes(root);
  return bytes > limit ? [`${RANGE_ASSET_DIR} holds ${bytes} bytes, over its ${limit} byte budget`] : [];
}
