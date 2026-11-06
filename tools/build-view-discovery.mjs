#!/usr/bin/env node
// Build cheap real-terrain stills and a broad review queue, without Chromium,
// production baking, tour search, audio analysis, or runtime catalog changes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { enumerateDiscoveryCandidates, resolveReferenceCamera, candidateSignature, encodePng, createTileLoader, loadDiscoveryGrid, loadScoutMaterials, resolveScoutMaterial } from './lib/view-discovery.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildDiscovery({ candidates, out, loadGrid, render, styleFor, log = console.log, groupConcurrency = 3, zoom = 9, cellM = 250, tileStats = null } = {}) {
  if (!Array.isArray(candidates) || !out || typeof loadGrid !== 'function' || typeof render !== 'function' || typeof styleFor !== 'function') throw new Error('Discovery requires candidates, output, grid loader, renderer and appearance source');
  if (!Number.isInteger(groupConcurrency) || groupConcurrency < 1 || groupConcurrency > 12) throw new Error('groupConcurrency must be an integer from 1 to 12');
  const start = performance.now(), groups = new Map(), results = new Map();
  for (const candidate of candidates) {
    if (!/^[a-z0-9-]+$/.test(candidate.id) || results.has(candidate.id)) throw new Error('Invalid or duplicate discovery candidate id');
    results.set(candidate.id, null);
    const key = candidate.sourceRangeId || `reference:${candidate.provenance.cameraSourceViewId || candidate.sourceViewId}`;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(candidate);
  }
  let previousUrls = [];
  try {
    const prior = JSON.parse(await fs.readFile(path.join(out, 'catalog.json'), 'utf8'));
    if (prior.schema === 'midio.view-discovery' && Array.isArray(prior.candidates)) previousUrls = prior.candidates.flatMap(c => [c.preview?.url, c.preview?.shape?.url]).filter(url => /^previews\/[a-z0-9-]+\.(?:png|json)$/.test(url));
  } catch { /* First build, or unrelated output: never delete unrecorded files. */ }
  await fs.mkdir(path.join(out, 'previews'), { recursive: true });
  const jobs = [...groups], errors = [], counts = { groups: jobs.length, ready: 0, unavailable: 0, unsupported: 0, failed: 0 }, cpu = { renderMs: 0 };
  const savePreview = async (candidate, preview, grid, appearance) => {
    const png = encodePng(preview.width, preview.height, preview.rgba);
    const imageHash = createHash('sha256').update(png).digest('hex');
    const url = `previews/${candidate.id}-${imageHash.slice(0, 12)}.json`;
    const destination = path.join(out, url), temporary = `${destination}.tmp-${process.pid}`;
    await fs.writeFile(temporary, `${JSON.stringify({ png: png.toString('base64') })}\n`);
    await fs.rename(temporary, destination);
    const warning = [candidate.provenance.warning, grid.warning, preview.warning].filter(Boolean).join(' ');
    return { png, record: { status: 'ready', url, encoding: 'png-base64', sha256: imageHash, appearance,
      width: preview.width, height: preview.height, cellM: grid.cellM, source: grid.source, coverage: preview.coverage,
      ...(warning ? { warning } : {}) } };
  };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(groupConcurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const [key, group] = jobs[next++];
      let grid, problem;
      const unsupported = group.every(c => !c.camera);
      if (unsupported) problem = group[0].provenance.warning || 'No single reference camera';
      else try { grid = await loadGrid(group); } catch (error) { problem = error.message; errors.push({ group: key, error: problem }); }
      for (const original of group) {
        let candidate = original;
        const sourceIdentity = grid ? { zoom: grid.zoom, cellM: grid.cellM, source: grid.source, tileHashes: grid.tileHashes, bounds: [grid.west,grid.south,grid.east,grid.north] } : { unavailable: problem };
        try {
          if (problem) throw new Error(problem);
          candidate = { ...original, camera: resolveReferenceCamera(original.camera, grid) };
          const appearance = styleFor(candidate);
          if (!appearance?.style || !appearance.provenance) throw new Error('Candidate appearance source is missing');
          const before = performance.now();
          const shapeFrame = render(grid, candidate.camera, { width: 320, height: 180, maxDistanceM: 36000 });
          const appearanceFrame = render(grid, candidate.camera, { width: 320, height: 180, maxDistanceM: 36000, style: appearance.style });
          cpu.renderMs += performance.now() - before;
          const shape = await savePreview(candidate, shapeFrame, grid, 'terrain-only');
          const scene = await savePreview(candidate, appearanceFrame, grid, 'landscape-study');
          if (appearance.provenance.warning) scene.record.warning = [scene.record.warning, appearance.provenance.warning].filter(Boolean).join(' ');
          const identity = { ...sourceIdentity, style: appearance.provenance, shapeSha256: shape.record.sha256, appearanceSha256: scene.record.sha256 };
          results.set(candidate.id, { ...candidate, signature: candidateSignature(candidate, Buffer.concat([scene.png, shape.png]), identity),
            preview: { ...scene.record, shape: shape.record },
            provenance: { ...candidate.provenance, terrain: sourceIdentity, style: appearance.provenance },
          });
          counts.ready++;
        } catch (error) {
          results.set(candidate.id, { ...candidate, signature: candidateSignature(candidate, Buffer.alloc(0), sourceIdentity),
            preview: { status: 'unavailable', width: 320, height: 180, cellM: grid?.cellM || cellM,
              source: grid?.source || 'Terrain tiles unavailable', coverage: 0, warning: error.message } });
          counts.unavailable++;
          if (unsupported) counts.unsupported++; else counts.failed++;
          if (!problem) errors.push({ candidate: candidate.id, error: error.message });
        }
      }
      log(`${key}: ${group.length} previews processed (${counts.ready} ready, ${counts.unavailable} unavailable)`);
    }
  }));
  const catalog = { schema: 'midio.view-discovery', version: 1,
    generatedWith: { method: 'existing cameras plus four loose orbit positions; no scenic rejection or hill-climbing',
      terrain: `cached Terrarium z${zoom} (z8 fallback when capped), ${cellM}m sample grid`, imageSize: [320, 180], maxDistanceM: 36000,
      appearance: 'current production palettes and habitat rules, simplified daylight; neutral terrain retained', productionValidation: false, generatedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - start),
      renderMs: Math.round(cpu.renderMs), ...counts, ...(tileStats ? { tiles: { ...tileStats } } : {}), errors },
    candidates: candidates.map(c => results.get(c.id)),
  };
  const catalogPath = path.join(out, 'catalog.json'), temporary = `${catalogPath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(catalog)}\n`);
  await fs.rename(temporary, catalogPath);
  const currentUrls = new Set(catalog.candidates.flatMap(c => [c.preview.url, c.preview.shape?.url]).filter(Boolean));
  for (const url of previousUrls) if (!currentUrls.has(url)) await fs.rm(path.join(out, url), { force: true });
  return catalog;
}

export function parseArguments(args) {
  const options = { out: path.join(root, 'src/assets/view-discovery'), only: null, help: false, zoom: 9, cellM: 250, explicitOut: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') options.help = true;
    else if (['--out','--only','--zoom','--cell'].includes(arg)) {
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--out') { options.out = path.resolve(value); options.explicitOut = true; }
      else if (arg === '--only') options.only = value.split(',').filter(Boolean);
      else if (arg === '--zoom') { options.zoom = Number(value); if (![8,9].includes(options.zoom)) throw new Error('--zoom must be 8 or 9'); }
      else { options.cellM = Number(value); if (!(options.cellM >= 200 && options.cellM <= 1000)) throw new Error('--cell must be between 200 and 1000 metres'); }
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.only && !options.explicitOut && !options.help) throw new Error('--only requires an explicit --out directory to preserve the full queue');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node tools/build-view-discovery.mjs [--only range-id,candidate-id,view-id] [--out DIR] [--zoom 8|9] [--cell 200..1000]\nBuilds a broad review queue and bounded 320×180 real-terrain stills. Existing comparisons and selected candidates are retained; unavailable previews are reported. Does not bake or promote production scenery.');
    return;
  }
  const [authored, viewpoints] = await Promise.all(['data/terrain/scenic-views.json', 'ridgeview/data/viewpoints.json'].map(p => fs.readFile(path.join(root, p), 'utf8').then(JSON.parse)));
  const all = enumerateDiscoveryCandidates(authored, viewpoints);
  let candidates = all;
  if (options.only) {
    for (const id of options.only) if (!all.some(c => [c.id,c.sourceRangeId,c.sourceViewId].includes(id))) throw new Error(`Unknown candidate, range or view: ${id}`);
    const wanted = all.filter(c => options.only.some(id => [c.id,c.sourceRangeId,c.sourceViewId].includes(id)));
    const references = new Set(wanted.map(c => c.referenceId).filter(Boolean));
    candidates = all.filter(c => wanted.includes(c) || references.has(c.id));
  }
  const tileLoader = createTileLoader({ cacheDir: path.join(root, '.terrain-cache'), concurrency: 12 });
  const { renderScoutPreview } = await import('./lib/scout-preview.mjs');
  const { createScoutStyle } = await import('./lib/scout-style.mjs');
  const materials = await loadScoutMaterials({ root });
  const styleFor = candidate => {
    const resolved = resolveScoutMaterial(candidate, { materials, authored });
    return { style: createScoutStyle(resolved.material, { biome: resolved.styleBiome, cameraHeadingDeg: candidate.camera.headingDeg, materialRules: resolved.materialRules }),
      provenance: resolved.provenance };
  };
  const result = await buildDiscovery({ candidates, out: options.out,
    loadGrid: group => loadDiscoveryGrid(group, { tileLoader, zoom: options.zoom, cellM: options.cellM }), render: renderScoutPreview, styleFor, zoom: options.zoom, cellM: options.cellM, tileStats: tileLoader.stats });
  console.log(JSON.stringify(result.generatedWith, null, 2));
  if (result.generatedWith.failed) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
