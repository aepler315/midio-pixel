import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { argumentsOf, readJson, writeJson, hash, gitState, newDirectory } from './io.mjs';
import { summarize, compareBenchmarks } from './contracts.mjs';
import { geometryChecksum } from './geometry.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = argumentsOf(process.argv.slice(2), ['--out', '--source', '--baseline', '--samples', '--relative', '--absolute-ms']);
assert.ok(args.out, 'Usage: npm run bench:engineering -- --out NEW_DIR [--baseline report.json] [--samples 7..30]');
const source = path.resolve(args.source || root);
const load = relative => import(pathToFileURL(path.join(source, relative)));
const [{ loadTerrainPackage }, { buildTerrainGeometry, terrainHeightAt }, { compileLandscapeScore }, { landRiseCamera }, { rangeQuality }, { pixelGrid }, { default: catalog }] = await Promise.all([
  load('src/world/alpine/RangeAssets.js'), load('src/world/alpine/TerrainMesh.js'), load('src/world/alpine/LandscapeScore.js'),
  load('src/world/alpine/LandRiseCamera.js'), load('src/world/alpine/RangeQuality.js'), load('src/render/PixelRenderPolicy.js'), load('src/world/terrain/sceneCatalogData.js'),
]);
const samples = Number(args.samples || 7); assert.ok(Number.isInteger(samples) && samples >= 7 && samples <= 30, 'samples must be 7..30');
const out = path.resolve(args.out); await newDirectory(out);
const fixture = { version: 1, seed: 315, durationMs: 120000, samples, queries: 240, view: 'teton-jackson-lake' };
const report = { version: 1, status: 'failed', scope: 'Node CPU surrogate. No GL context, GPU timing, displayed FPS or JOYING results. Memory is Node process RSS/heap/arrayBuffers, not graphics residency.',
  environment: { node: process.versions.node, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length },
  source: gitState(source), fixture, results: [] };
const memoryStart = process.memoryUsage();
try {
  const view = catalog.views.find(v => v.id === fixture.view);
  const baseUrl = pathToFileURL(path.join(source, 'src/assets/range/v2/'));
  const file = new URL(view.terrainManifestUrl, baseUrl);
  const fetchImpl = async url => new Response(await fs.readFile(fileURLToPath(url)));
  const start = performance.now();
  const pack = await loadTerrainPackage(file.href, { fetchImpl, expectManifestSha256: view.terrainManifestSha256 });
  report.initializationMs = performance.now() - start;
  report.asset = pack.identity;
  report.workloadHash = hash({ fixture, asset: pack.identity });
  const pose = { eyeM: [0, 1800, 900], targetM: [0, 1400, 0], fovYDeg: 35 };
  const song = { durationMs: fixture.durationMs, seed: fixture.seed,
    energyCurves: { globalEnergyNorm: t => .1 + .8 * Math.sin(t / 7000) ** 2 },
    sections: [0, 30000, 60000, 90000].map(startMs => ({ startMs, endMs: startMs + 30000, provenance: 'detected' })) };
  function measure(id, operation, select = value => value) {
    for (let i = 0; i < 2; i++) operation();
    const times = [], checksums = []; let memoryPeak = process.memoryUsage();
    for (let i = 0; i < samples; i++) {
      const start = performance.now(), value = operation(); times.push(performance.now() - start);
      // Output serialization/hashing is outside the timed region.
      checksums.push(hash(select(value)));
      const memory = process.memoryUsage(); for (const key of Object.keys(memory)) memoryPeak[key] = Math.max(memoryPeak[key], memory[key]);
    }
    assert.equal(new Set(checksums).size, 1, `nondeterministic output ${id}`);
    report.results.push({ id, ...summarize(times), checksum: checksums[0], memoryPeak });
  }
  for (const budget of ['mobile', 'desktop']) for (const bias of [1, 2]) {
    measure(`terrain-${budget}-bias${bias}`, () => buildTerrainGeometry(pack.data, { budget, bias }), geometry => geometryChecksum(geometry));
  }
  measure('score-compile-and-sample', () => { const score = compileLandscapeScore(song); return Array.from({ length: fixture.queries }, (_, i) => score.at(i * 500)); });
  measure('camera-growth-updates', () => Array.from({ length: fixture.queries }, (_, i) => landRiseCamera(pose, { rise01: i / 239, baseM: 1000, groundM: 1000, focusM: [0, 2500, 0], timeMs: i * 500 })));
  measure('quality-grid-transitions', () => Array.from({ length: fixture.queries }, (_, i) => ({ quality: rangeQuality(i % 7), grid: pixelGrid(i % 2 ? 'classic' : 'detailed') })));
  measure('geographic-height-sampling', () => {
    const bounds = pack.manifest.boundsM;
    return Array.from({ length: fixture.queries }, (_, i) => {
      const h = terrainHeightAt(pack.data, bounds.min[0] + (bounds.max[0] - bounds.min[0]) * i / 239, bounds.min[2] + (bounds.max[2] - bounds.min[2]) * .5);
      return Number.isFinite(h) ? h : 'outside-valid-footprint';
    });
  });
  if (args.baseline) {
    report.comparison = compareBenchmarks(await readJson(path.resolve(args.baseline)), report,
      { relative: Number(args.relative ?? .5), absoluteMs: Number(args['absolute-ms'] ?? 1) });
    assert.ok(report.comparison.pass, 'benchmark regression; see comparison deltas');
  }
  report.status = 'passed';
} catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); }
finally {
  report.memory = { start: memoryStart, end: process.memoryUsage() };
  await writeJson(path.join(out, 'report.json'), report);
  const text = `CPU verification: **${report.status}**\n\n${report.scope}\n\n| Scenario | Median ms | p95 ms | Max ms |\n|---|---:|---:|---:|\n` + report.results.map(r => `| ${r.id} | ${r.medianMs.toFixed(3)} | ${r.p95Ms.toFixed(3)} | ${r.maxMs.toFixed(3)} |`).join('\n') + '\n' + (report.error || '');
  await fs.writeFile(path.join(out, 'summary.md'), text); console.log(text);
}
