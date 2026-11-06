#!/usr/bin/env node
// Structural coverage of the transient inferred RiseGround backdrop. This
// checks the shipped packages without downloading or claiming missing DEM
// truth. Visual captures must check the actual render and the final skyline.
//
// node tools/rise-coverage-check.mjs [--poses N] [viewId ...]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import catalog from '../src/world/terrain/sceneCatalogData.js';
import { cameraPoseAt, cameraBasis } from '../src/world/terrain/SceneTravel.js';
import { decodeTerrain, terrainHeightAt } from '../src/world/alpine/TerrainMesh.js';
import { railGroundData, tourGround } from '../src/world/alpine/RailDraw.js';
import { buildRiseGround, riseGroundBytes, RISE_GROUND_SIDE } from '../src/world/alpine/RiseGround.js';
import { landRiseCamera } from '../src/world/alpine/LandRiseCamera.js';
import { risenHeight } from '../src/world/alpine/LandRise.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), posesAt = args.indexOf('--poses');
if (args.includes('--truth')) throw new Error('RiseGround infers missing ground. This check does not verify unshipped elevation truth.');
const count = posesAt >= 0 ? Number(args[posesAt + 1]) : 21;
if (!Number.isInteger(count) || count < 2 || count > 200) throw new Error('--poses must be an integer from 2 to 200');
const ids = args.filter((a, i) => !a.startsWith('--') && (posesAt < 0 || i !== posesAt + 1));
const views = catalog.views.filter(v => v.camera && (!ids.length || ids.includes(v.id)));
if (!views.length) throw new Error('No matching camera views');
let failed = false;
console.log('Inferred support topology and flat-plane coverage only; final visual/DEM accuracy requires separate evidence.');
for (const view of views) {
  const file = path.join(root, 'src/assets/range/v2', view.terrainManifestUrl);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const data = decodeTerrain(manifest, new Uint8Array(zlib.gunzipSync(fs.readFileSync(file.replace('.terrain.json', '.terrain.bin.gz')))));
  const modes = tourGround(data) ? [railGroundData(data), data] : [data];
  let errors = 0, inferred = 0;
  for (const mode of modes) {
    const support = buildRiseGround(mode), n = RISE_GROUND_SIDE;
    const baseM = manifest.boundsM.min[1], rise = { sink: 1, baseM };
    if (support.positions.length !== n * n * 3 || support.indices.length !== (n - 1) ** 2 * 6) errors++;
    if (support.positions.byteLength + support.indices.byteLength >= 1024 ** 2 || riseGroundBytes() >= 1024 ** 2) errors++;
    inferred += n * n - support.knownSamples;
    // Every cell has two upward-facing triangles, with no missing sample
    // or discarded cell capable of exposing the sky through the rectangle.
    for (let i = 0; i < support.positions.length; i += 3) {
      const y = support.positions[i + 1];
      if (!Number.isFinite(y) || Math.abs(risenHeight(y, 0, rise) - baseM) > 1e-9) errors++;
    }
    for (let i = 0; i < support.indices.length; i += 3) {
      const a = support.indices[i] * 3, b = support.indices[i + 1] * 3, c = support.indices[i + 2] * 3, p = support.positions;
      const up = (p[b + 2] - p[a + 2]) * (p[c] - p[a]) - (p[b] - p[a]) * (p[c + 2] - p[a + 2]);
      if (!(up > 0)) errors++;
    }
    // The analytic horizon plane covers every downward ray, even beyond
    // the package and the terrain camera's far clip. In particular each
    // opening bottom-row ray must meet the common base with positive t.
    for (let k = 0; k < count; k++) {
      const original = cameraPoseAt(view, k / (count - 1));
      const groundM = terrainHeightAt(mode, original.eyeM[0], original.eyeM[2]);
      const pose = landRiseCamera(original, { rise01: 0, baseM, groundM });
      const B = cameraBasis(pose), tv = Math.tan(pose.fovYDeg * Math.PI / 360);
      for (let c = 0; c < 48; c++) {
        const x = (c + .5) / 48 * 2 - 1;
        const dy = B.forward[1] + x * tv * 16 / 9 * B.right[1] - tv * B.up[1];
        const t = (baseM - pose.eyeM[1]) / dy;
        if (!(dy < 0 && t > 0 && Number.isFinite(t))) errors++;
      }
    }
  }
  failed ||= errors > 0;
  console.log(`${view.id}: ${errors ? `FAIL ${errors}` : 'ok'} | ${modes.length} source mode(s), ${inferred} inferred samples | ${riseGroundBytes()} admitted bytes/view`);
}
process.exitCode = failed ? 1 : 0;
