// Worker thread for tools/build-scenic-tours.mjs: loads one view's context
// once, then scores shot and link paths sent by the main thread.
//
// Discovery judges scenery on the full DEM: a tile the shipped package
// lacks is not a flaw of the shot (the bake adds it), only a cost, so
// scoring runs without the package and holes mean rays leaving the grid.
// 'missing' jobs report the tiles a path's frames need from the package;
// 'footprint' jobs the stride the baker gives each tile (scenic-cost.mjs).
import { parentPort, workerData } from 'node:worker_threads';
import { loadViewContext, depthRaster } from './scenic-terrain.mjs';
import { scorePath, linkScore } from './scenic-score.mjs';
import { pathPoseAt } from '../../src/world/terrain/ShotPath.js';
import { pathFootprint } from './scenic-cost.mjs';

const ctx = await loadViewContext(workerData.viewId, { root: workerData.root });
// Rays leaving the grid this close below the horizontal are sky, not holes.
ctx.edgeDipDeg = workerData.edgeDipDeg ?? 0;
const dem = { ...ctx, terrain: null };

function missing(path, { everyM = 150, width = 96, height = 54 } = {}) {
  const need = new Set(), L = path.s[path.s.length - 1];
  for (let x = 0; ; x += everyM) {
    const r = depthRaster(ctx, pathPoseAt(path, Math.min(x, L)), { width, height });
    for (let i = 0; i < r.tile.length; i++) if (r.tile[i] >= 0 && !r.present[i]) need.add(r.tile[i]);
    if (x >= L) break;
  }
  return [...need].sort((a, b) => a - b);
}

parentPort.on('message', async ({ id, kind, path, opts }) => {
  try {
    if (kind === 'missing') { parentPort.postMessage({ id, result: missing(path, opts) }); return; }
    if (kind === 'footprint') {
      parentPort.postMessage({ id, result: await pathFootprint(ctx, path, opts) }); return;
    }
    const result = kind === 'link' ? linkScore(dem, path, opts) : scorePath(dem, path, opts);
    parentPort.postMessage({ id, result: { aggregate: result.aggregate, flow: result.flow, signature: result.signature,
      samples: result.samples.map((s) => ({ s: s.s, composition: s.composition, subject: s.subject, depth: s.depth,
        visible: s.metrics?.subject?.visibleFrac ?? null, screenH: s.metrics?.subject?.screenH ?? null,
        foreground: s.metrics?.foregroundFrac ?? null, holes: s.metrics?.holeFrac ?? 0 })) } });
  } catch (error) { parentPort.postMessage({ id, error: String(error?.stack || error) }); }
});
parentPort.postMessage({ ready: true });
