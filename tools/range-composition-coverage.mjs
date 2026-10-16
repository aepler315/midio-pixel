// Read-only CPU coverage evidence for the coherent composition candidates,
// or with --all for every catalogue view.
// Usage: node tools/range-composition-coverage.mjs [output.json] [--all]
// (--all writes docs/evidence/range-v2/no-stage-coverage.json by default.)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import catalog from '../src/world/terrain/sceneCatalogData.js';
import { SHAKE_MARGIN_PX, presentationCamera } from '../src/render/Renderer.js';
import { ZOOM_MIN } from '../src/render/CameraDirector.js';
import { scenicProjection, viewportState } from '../src/world/alpine/RangeFrame.js';
import { buildTerrainGeometry } from '../src/world/alpine/TerrainMesh.js';
import { cameraPoseAt } from '../src/world/terrain/SceneTravel.js';
import { glacierSample, glacierStateAt } from '../src/world/alpine/GlacierField.js';
import { loadShippedTerrain, stationMasks } from './lib/range-exposure.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(repo, 'src/assets/range/v2');
const nominalW = 1280, nominalH = 720, rasterWidth = 320;
const samplesW = 320, samplesH = 180, lowerFraction = .12;
const bottomStart = Math.floor(samplesH * (1 - lowerFraction));
const args = process.argv.slice(2), outArg = args.find(a => !a.startsWith('--')), all = args.includes('--all');
const ids = all ? catalog.views.map(v => v.id)
  : ['teton-jackson-lake-coherent', 'monument-valley-163-coherent', 'pend-oreille-valley'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = file => path.relative(repo, file).split(path.sep).join('/');
const fingerprint = async file => ({ path: relative(file), sha256: sha256(await fs.readFile(file)) });
const newCounts = () => ({ scenarios: 0, testedPixels: 0, uncoveredPixels: 0, outsideBufferPixels: 0,
  missingTerrainPixels: 0, uncoveredBottomPixels: 0, worst: null });
const extremes = [];
for (const zoom of [1, ZOOM_MIN]) for (const shakeX of [-32, 32]) for (const shakeY of [-32, 32]) for (const roll of [-.025, .025]) {
  extremes.push({ zoom, shakeX, shakeY, roll });
}
const rows = [];
for (const id of ids) {
  const view = catalog.views.find(v => v.id === id);
  if (!view) throw new Error(`catalog view missing: ${id}`);
  const manifestFile = path.join(runtime, view.terrainManifestUrl);
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const data = await loadShippedTerrain(runtime, view);
  const original = buildTerrainGeometry(data, { budget: 'desktop' }).bands;
  const counts = { nominal: newCounts(), extremes: newCounts() };
  const cameraContext = [{ enabled: true, captionViewFor: () => view },
    { currentBlend: { from: view.biome, to: view.biome, t: 1 } }];
  for (let station = 0; station <= 20; station++) {
    const progress = station / 20;
    const retreat = glacierStateAt({ timeMs: progress * 1000, durationMs: 1000, progress01: progress }).retreat01;
    const meshes = Object.fromEntries(Object.entries(original).map(([band, mesh]) => {
      const positions = mesh.positions.slice();
      if (view.glacier) for (let i = 0; i < positions.length; i += 3) {
        positions[i + 1] = glacierSample(view.glacier, positions[i], positions[i + 2], positions[i + 1], retreat).surfaceM;
      }
      return [band, { ...mesh, positions }];
    }));
    const pose = cameraPoseAt(view, progress), rasters = new Map();
    for (const [group, cameras] of [['nominal', [{ zoom: 1, shakeX: 0, shakeY: 0, roll: 0 }]], ['extremes', extremes]]) {
      for (const rawCamera of cameras) {
        const camera = presentationCamera(rawCamera, ...cameraContext), zoom = camera.zoom;
        const baseW = nominalW / zoom, baseH = nominalH / zoom;
        const logicalW = baseW + 2 * SHAKE_MARGIN_PX, logicalH = baseH + 2 * SHAKE_MARGIN_PX;
        let masks = rasters.get(zoom);
        if (!masks) {
          const projection = scenicProjection(pose.fovYDeg, viewportState({ logicalWidth: logicalW, logicalHeight: logicalH,
            nominalWidth: nominalW, nominalHeight: nominalH, overscanPx: SHAKE_MARGIN_PX }));
          masks = stationMasks(meshes, pose, { framing: { aspect: projection.aspect, fovScale: projection.tanScale, groundFrac: 1 },
            occ: { width: rasterWidth, stride: 1 } });
          rasters.set(zoom, masks);
        }
        const result = counts[group], cx = baseW / 2 + SHAKE_MARGIN_PX, cy = baseH / 2 + SHAKE_MARGIN_PX;
        const c = Math.cos(camera.roll), s = Math.sin(camera.roll);
        let uncoveredPixels = 0;
        result.scenarios++;
        for (let y = bottomStart; y < samplesH; y++) for (let x = 0; x < samplesW; x++) {
          // Inverse of Renderer.draw's scenic Canvas transform: uniform
          // scale, pivot translate, rotate, translate(-pivot+shake-margin).
          const dx = ((x + .5) / samplesW * nominalW) / zoom - cx;
          const dy = ((y + .5) / samplesH * nominalH) / zoom - cy;
          const px = cx - camera.shakeX + SHAKE_MARGIN_PX + c * dx + s * dy;
          const py = cy - camera.shakeY + SHAKE_MARGIN_PX - s * dx + c * dy;
          const ix = Math.floor(px / logicalW * masks.W), iy = Math.floor(py / logicalH * masks.H);
          const inBuffer = ix >= 0 && ix < masks.W && iy >= 0 && iy < masks.H;
          const covered = inBuffer && masks.owner[iy * masks.W + ix] !== 0;
          result.testedPixels++;
          if (!covered) {
            uncoveredPixels++; result.uncoveredPixels++;
            if (inBuffer) result.missingTerrainPixels++; else result.outsideBufferPixels++;
            if (y === samplesH - 1) result.uncoveredBottomPixels++;
          }
        }
        if (uncoveredPixels && (!result.worst || uncoveredPixels > result.worst.uncoveredPixels)) {
          result.worst = { station, progress, rawCamera, effectiveCamera: camera, uncoveredPixels };
        }
      }
    }
  }
  rows.push({ id, status: view.status, composition: view.composition,
    sourceDemSha256: view.evidence?.sourceHashes || [], viewSha256: sha256(JSON.stringify(view)),
    terrainManifest: await fingerprint(manifestFile),
    terrainPayload: await fingerprint(path.join(path.dirname(manifestFile), manifest.payload.url)),
    materialManifest: await fingerprint(path.join(runtime, view.materialManifestUrl)),
    effectiveExtremeExample: presentationCamera(extremes[0], ...cameraContext), stations: 21, ...counts });
}
const sourceFiles = await Promise.all(['tools/range-composition-coverage.mjs', 'tools/lib/range-exposure.mjs',
  'src/render/Renderer.js', 'src/render/CameraDirector.js', 'src/world/alpine/RangeFrame.js',
  'src/world/alpine/TerrainMesh.js', 'src/world/alpine/GlacierField.js', 'src/world/terrain/SceneTravel.js',
  'src/world/terrain/sceneCatalogData.js'].map(file => fingerprint(path.join(repo, file))));
const result = { schema: 'midio.range-composition-coverage', version: 1, visualApproval: false,
  nominalStage: [nominalW, nominalH], overscanPx: SHAKE_MARGIN_PX, sampleGrid: [samplesW, samplesH], rasterWidth,
  region: { lowerFraction, firstSampleRow: bottomStart, includesBottomRow: true },
  nominalCamera: { zoom: 1, shakeX: 0, shakeY: 0, roll: 0 },
  rawExtremes: { zoom: [1, ZOOM_MIN], shakeX: [-32, 32], shakeY: [-32, 32], roll: [-.025, .025] },
  cameraMapping: 'production presentationCamera, fully arrived per-view assignment',
  glacierMapping: 'production glacierStateAt; song time and journey progress equal station fraction',
  limitations: ['sampled CPU desktop triangles and glacier surface', 'lower foreground region only; sky is intentionally absent',
    'no musical deformation, trees or travel compositor', 'no GPU render, material appearance, device performance or visual approval'],
  sourceFiles, rows };
const output = path.resolve(repo, outArg || (all ? 'docs/evidence/range-v2/no-stage-coverage.json'
  : '.smoke/terrain-continuation/coverage.json'));
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
for (const row of rows) console.log(`${row.id}: nominal ${row.nominal.uncoveredPixels}/${row.nominal.testedPixels}, extremes ${row.extremes.uncoveredPixels}/${row.extremes.testedPixels} uncovered`);
console.log(`Wrote ${relative(output)}; visual approval: false`);
if (rows.some(row => row.nominal.uncoveredPixels || row.extremes.uncoveredPixels)) process.exitCode = 1;
