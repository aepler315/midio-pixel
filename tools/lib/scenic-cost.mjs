// Scenic shot tours: what a camera path would cost in terrain, before the
// library bake (docs/scenic-tours.md, "Selection and budgets").
//
// A record's footprint is the stride the baker itself gives each tile the
// record's frames see: the same bake the library will get (rail stations,
// the record's poses and their reflections, the tour pixel budget, core
// framing), run on that record alone. A tile's stride is set by the
// sharpest viewer that sees it, so a library's strides are the finest of
// its records' and costs add up tile by tile. A tile the shipped package
// already holds at that stride or finer costs nothing; a new tile costs its
// compressed samples and its manifest entry; a shipped or already paid-for
// tile costs only the difference to the finer stride.
import { bakeTerrain, mirroredPose } from './terrain-bake.mjs';
import { sampleFootprintPoses } from './scenic-coverage.mjs';
import { mirrorLevelFor } from '../../src/world/alpine/WaterMirror.js';

/** Compressed payload bytes per tile by stride, measured on posed Monument
 *  Valley bakes (residual heights + flow, gzip applied). */
export const TILE_BYTES = Object.freeze({ 1: 7300, 2: 1900, 4: 500, 8: 140, 16: 45, 32: 16, 64: 7 });
/** Manifest JSON bytes per tile entry (uncompressed, as shipped). */
export const MANIFEST_TILE_BYTES = 470;

/** Median height of the package's water samples (null without water). */
export function waterLevelOf(data) {
  const hs = [];
  for (const t of data.tiles.values()) {
    if (!t.flowBytes) continue;
    for (let i = 0; i < t.flowBytes.length; i += 7) if (t.flowBytes[i] === 255 && Number.isFinite(t.heightsM[i])) hs.push(t.heightsM[i]);
  }
  if (!hs.length) return null;
  hs.sort((a, b) => a - b);
  return hs[hs.length >> 1];
}

/** The poses records' frames (and, where a lake mirrors, their
 *  reflections) need covered. */
export function tourPoses(ctx, records, { spacingM = 120, maxPoses = 2600 } = {}) {
  let poses = sampleFootprintPoses(records, { spacingM, maxPoses });
  const mapped = ctx.view.riverPolicy?.terrainWater === 'mapped-only';
  const level = mapped ? null : mirrorLevelFor(ctx.terrain.data, waterLevelOf(ctx.terrain.data));
  if (level != null) poses = poses.concat(poses.filter((_, i) => i % 2 === 0).map((p) => ({ ...mirroredPose(p, level), ...(p.pathId != null ? { pathId: p.pathId } : {}) })));
  return { poses, mirrorLevelM: level };
}

/** The bake options build-range-scene.mjs uses for the view (rail only). */
export function bakeOptions(ctx) {
  const camera = ctx.build.view.camera;
  return { landmarks: ctx.build.landmarks, dataUrl: `${ctx.viewId}.terrain.bin.gz`, ...(ctx.view.water === false ? { water: false } : {}),
    ...(camera.eyeArcM || camera.targetArcM ? { visibility: { stations: 61 } } : {}) };
}

/** Bake options for tour poses at `scale` times the rail's pixel budget. */
export function tourBakeOptions(ctx, poses, scale) {
  return { ...bakeOptions(ctx), poses, poseErrorScale: scale, poseFramings: ['core'] };
}

/** One path's footprint: [tile index, stride] for every tile the bake of
 *  the rail plus this path's poses ships. */
export async function pathFootprint(ctx, path, { scale = 4, spacingM = 120 } = {}) {
  const { poses } = tourPoses(ctx, [{ path }], { spacingM });
  const baked = await bakeTerrain(ctx.grid, ctx.build.view, tourBakeOptions(ctx, poses, scale));
  const tilesX = tilesAcross(ctx);
  return baked.manifest.tiles.filter((t) => t.visible !== false).map((t) => [t.iz * tilesX + t.ix, t.stride]);
}

function tilesAcross(ctx) {
  const cells = ctx.terrain?.manifest?.tileCells ?? 64;
  return Math.ceil((ctx.grid.width - 1) / cells);
}

/** Cost model over footprints (Map tile index -> stride) for one view. */
export function strideCost(ctx) {
  const tilesX = tilesAcross(ctx);
  const shipped = (t) => {
    const tile = ctx.terrain?.data?.byIndex?.get(`${t % tilesX},${Math.floor(t / tilesX)}`);
    return tile && tile.visible !== false ? tile.stride : null;
  };
  const price = (stride, have) => (have == null ? TILE_BYTES[stride] + MANIFEST_TILE_BYTES : TILE_BYTES[stride] - TILE_BYTES[have]);
  /** Bytes a footprint adds beyond the shipped package and `owned`
   *  (Map tile -> stride already paid for). */
  const marginal = (footprint, owned = new Map()) => {
    let bytes = 0;
    for (const [t, need] of footprint) {
      const ship = shipped(t), paid = owned.get(t), have = Math.min(ship ?? Infinity, paid ?? Infinity);
      if (need < have) bytes += price(need, Number.isFinite(have) ? have : null);
    }
    return bytes;
  };
  /** Record a footprint's strides in `owned`. */
  const own = (footprint, owned) => {
    for (const [t, need] of footprint) if (!(owned.get(t) <= need)) owned.set(t, need);
    return owned;
  };
  /** Bytes a set of footprints adds beyond the shipped package. */
  const total = (footprints) => marginal(footprints.reduce((m, fp) => own(fp, m), new Map()));
  return { shipped, marginal, own, total, tilesX };
}
