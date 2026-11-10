// Song range composition, Phase 1: cut massif pieces from complete source
// DEMs, compose fixed layouts on a stage template, and bake each layout with
// the production baker into an ordinary candidate catalog view.
//
//   node tools/build-song-range-pilot.mjs --list [--out DIR]
//   node tools/build-song-range-pilot.mjs --build [--layout ID] [--out DIR] [--publish]
//
// --list cuts every source in data/terrain/song-range-pilot.json and writes
// the piece table (and per-piece previews) to DIR (default .smoke/song-range-
// pieces). --build composes the pilot's layouts; without --publish the
// packages go to .terrain-cache/song-range/, with --publish to
// src/assets/range/v2/terrain/ plus data/terrain/stage-views.json, and the
// runtime catalog is regenerated. Published stages are candidates and are
// reachable only through ?rangeView=<id>.
//
// Sources are normalized again with the 'tile' window-cache layout (design
// spec D11), so multi-tile 3DEP seams do not depend on cache history.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeDem, readDemGrid } from './lib/terrain-source.mjs';
import { bakeTerrain, viewSkyline, despikeGrid } from './lib/terrain-bake.mjs';
import { findMassifSeeds, watershedLabels, cutMassif, borderRelief, CUT_DEFAULTS } from './lib/massif-cut.mjs';
import { composeStage, stageFloor, stageCamera, templateErrors } from './lib/stage-compose.mjs';
import { skylineFeatures, characterFromFeatures, archetypeOf } from '../src/world/terrain/RangeCharacter.js';
import { cameraPoseAt } from '../src/world/terrain/SceneTravel.js';
import { readAuthoring, writeCatalog, RUNTIME_DIR, STAGE_AUTHORING } from './build-range-scene.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PILOT = path.join(root, 'data', 'terrain', 'song-range-pilot.json');
const TEMPLATES = path.join(root, 'data', 'terrain', 'stage-templates.json');
const CACHE = path.join(root, '.terrain-cache');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const round1 = (v) => Math.round(v * 10) / 10;
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

/** Normalize one source view's DEM with the 'tile' layout; cached by its
 *  parameters. Returns the despiked grid and its provenance. */
export async function loadSourceGrid(view, { log = console.log } = {}) {
  const dem = { ...view.dem, windowCache: 'tile' };
  const points = { eyeStart: view.rail.eyeStart.lonLat, eyeEnd: view.rail.eyeEnd.lonLat };
  for (const l of view.landmarks || []) points[`landmark:${l.name}`] = l.lonLat;
  const key = sha(JSON.stringify({ dem, points })).slice(0, 16);
  const prefix = path.join(CACHE, 'massif-sources', `${view.id}-${key}`);
  let grid;
  try { grid = await readDemGrid(prefix); log(`${view.id}: cached source ${path.relative(root, prefix)}`); }
  catch {
    log(`${view.id}: normalizing ${dem.source} ${dem.extentM.join('x')} m at ${dem.cellM} m (tile layout)`);
    grid = await normalizeDem(dem.source, { out: prefix, centerLonLat: dem.centerLonLat, extentM: dem.extentM, offsetM: dem.offsetM,
      cellM: dem.cellM, zoom: dem.zoom, cache: CACHE, windowCache: 'tile', pin: dem.pin, points, fill: dem.fill, fillZoom: dem.fillZoom });
  }
  const meta = JSON.parse(await fs.readFile(`${prefix}.json`, 'utf8'));
  if (grid.valid.some((v) => !v)) throw new Error(`${view.id}: source grid has no-data; pieces need complete coverage`);
  const despiked = despikeGrid(grid);
  return { grid, despiked, gridSha256: meta.payload.heights.sha256, tools: meta.tools || null, windowCache: 'tile',
    provenance: grid.provenance || null, cache: path.relative(root, prefix) };
}

/** Skyline character of a piece seen from its facing side (+Z), standing on
 *  a level floor, the way a stage slot presents it. */
export function pieceCharacter(piece) {
  const c = piece.cellSizeM, W = piece.width;
  const distM = Math.max(6000, 1.5 * piece.height * c);
  const pad = Math.ceil((distM + 1000) / c);
  const H = piece.height + pad;
  const heightsM = new Float32Array(W * H);
  heightsM.set(piece.relief);
  const grid = { width: W, height: H, cellSizeM: c, originM: [0, 0], heightsM, valid: new Uint8Array(W * H).fill(1) };
  const cx = (W - 1) / 2 * c, cz = (piece.height - 1) / 2 * c;
  const pose = { eyeM: [cx, 30, cz + distM], targetM: [cx, piece.peakReliefM * 0.6, cz], fovYDeg: 38 };
  const sky = viewSkyline(grid, pose);
  const f = skylineFeatures(sky.elevationsM, sky.spacingM);
  return f ? { features: f, scores: characterFromFeatures(f) } : null;
}

/** Cut every acceptable piece of every pilot source. */
export async function cutLibrary(pilot, doc, { log = console.log } = {}) {
  const pieces = [], rejected = [], sources = {};
  const opts = { ...CUT_DEFAULTS, ...(pilot.cut || {}) };
  for (const id of pilot.sources) {
    const view = doc.views.find((v) => v.id === id);
    if (!view) throw new Error(`pilot source ${id} is not in scenic-views.json`);
    const src = await loadSourceGrid(view, { log });
    const { grid } = src;
    sources[id] = { gridSha256: src.gridSha256, windowCache: src.windowCache, tools: src.tools, cache: src.cache,
      despikedSamples: src.despiked, width: grid.width, height: grid.height, cellSizeM: grid.cellSizeM,
      provenance: src.provenance, title: view.title, place: view.place,
      // How a credit names the source: the range the massifs come from.
      label: [pilot.sourceLabels?.[id] || view.title, (view.place || '').split(',').pop().trim()].filter(Boolean).join(', ') };
    const landmarks = (view.landmarks || []).map((l) => ({ name: l.name, localM: grid.points?.[`landmark:${l.name}`]?.localM }));
    const e0 = grid.points.eyeStart.localM, e1 = grid.points.eyeEnd.localM;
    const viewerM = [(e0[0] + e1[0]) / 2, (e0[1] + e1[1]) / 2];
    const seeds = findMassifSeeds(grid, { landmarks, ...opts });
    const labels = watershedLabels(grid, seeds);
    const scratch = {};
    for (const [n, seed] of seeds.entries()) {
      const r = cutMassif(grid, seed, labels, n, { viewerM, ...opts }, scratch);
      const sid = `${id}:${seed.name ? slug(seed.name) : `summit-${Math.round(seed.heightM)}`}`;
      if (!r.ok) { rejected.push({ id: sid, reason: r.reason, heightM: Math.round(seed.heightM) }); continue; }
      const p = r.piece;
      if (p.outline.band[1] > (pilot.outlineSlopeRatioMax ?? 1.15) * p.outline.bandSource[1] + 0.02) {
        rejected.push({ id: sid, reason: 'outline-steepened', heightM: Math.round(seed.heightM), outline: p.outline }); continue;
      }
      if (borderRelief(p.relief, p.width, p.height) !== 0) throw new Error(`${sid}: non-zero border`);
      const ch = pieceCharacter(p);
      pieces.push({ ...p, id: sid, sourceView: id,
        name: p.name || `${pilot.sourceLabels?.[id] || view.title} summit ${Math.round(p.peakM)} m`, place: view.place,
        character: ch?.scores || null, skylineFeatures: ch?.features || null });
    }
    log(`${id}: ${seeds.length} seeds, ${pieces.filter((p) => p.sourceView === id).length} pieces`);
  }
  return { pieces, rejected, sources };
}

const pieceRow = (p) => ({ id: p.id, name: p.name, sourceView: p.sourceView, seedKind: p.seedKind,
  peakM: Math.round(p.peakM), levelM: Math.round(p.levelM), baseAtPeakM: Math.round(p.baseAtPeakM),
  peakReliefM: Math.round(p.peakReliefM), meanReliefM: Math.round(p.meanReliefM), tiles: p.tiles,
  regionAreaKm2: round1(p.regionAreaKm2), quarterTurns: p.quarterTurns, facingResidualDeg: p.facingResidualDeg,
  coverageFanDeg: p.coverageFanDeg, outline: p.outline, base: p.base, character: p.character,
  reliefSha256: sha(Buffer.from(p.relief.buffer, p.relief.byteOffset, p.relief.byteLength)) });

function creditFor(placed, sources) {
  const regions = [...new Set(placed.map((p) => sources[p.sourceView]?.label).filter(Boolean))];
  return `Elevation: USGS 3DEP 1/3 arc-second DEM; composed stage of measured massifs from ${regions.join('; ')}`;
}

/** Compose, bake and describe one layout. */
export async function buildLayout(layout, template, library, { log = console.log } = {}) {
  const byId = new Map(library.pieces.map((p) => [p.id, p]));
  const placements = Object.entries(layout.slots).map(([slotId, s]) => {
    const piece = byId.get(s.piece);
    if (!piece) throw new Error(`${layout.id}: no piece ${s.piece} (run --list to see the library)`);
    return { slotId, piece, mirrored: !!s.mirrored };
  });
  const floor = stageFloor(template);
  const grid = composeStage(template, placements, { floor });
  const camera = stageCamera(template, floor);
  const principal = placements.find((p) => p.slotId === template.principalSlot)?.piece;
  const runtimeView = { id: layout.id, regionId: 'song-range-stage', biome: 'CONIFER', camera };
  const landmarks = grid.placed.map((p) => ({ name: byId.get(placements.find((q) => q.slotId === p.slotId).piece.id).name,
    lonLat: null, publishedElevationM: null, localM: p.peakLocalM.map(round1), demGroundM: round1(p.stagePeakM), demPeakWithin200mM: round1(p.stagePeakM) }));
  const baked = await bakeTerrain(grid, runtimeView, { landmarks, dataUrl: `${layout.id}.terrain.bin.gz` });
  const scores = { energy: 0, rawness: 0, grandeur: 0, dominance: 0 };
  const features = [];
  for (const u of [0, 0.5, 1]) {
    const sky = viewSkyline(grid, cameraPoseAt(runtimeView, u));
    const f = skylineFeatures(sky.elevationsM, sky.spacingM);
    if (!f) throw new Error(`${layout.id}: no measurable skyline at u=${u}`);
    features.push(f);
    const c = characterFromFeatures(f);
    for (const k of Object.keys(scores)) scores[k] += c[k] / 3;
  }
  for (const k of Object.keys(scores)) scores[k] = Math.round(scores[k] * 1000) / 1000;
  const placed = grid.placed.map((p) => {
    const pc = placements.find((q) => q.slotId === p.slotId).piece;
    return { ...p, pieceId: pc.id, name: pc.name, sourceView: pc.sourceView, levelM: Math.round(pc.levelM),
      peakReliefM: Math.round(p.peakReliefM), stagePeakM: Math.round(p.stagePeakM), floorAtPeakM: Math.round(p.floorAtPeakM) };
  });
  const usedSources = [...new Set(placed.map((p) => p.sourceView))];
  const manifestText = JSON.stringify(baked.manifest) + '\n';
  const build = {
    credit: creditFor(placed, library.sources),
    sourceSha256: [...new Set(usedSources.flatMap((s) => library.sources[s].provenance?.sha256 || []))],
    view: runtimeView, characterScores: scores, archetype: archetypeOf(scores).archetype, skylineFeatures: features,
    manifestSha256: sha(manifestText), payloadSha256: baked.manifest.payload.sha256, payloadBytes: baked.payload.byteLength,
    stats: baked.stats, landmarks, achievedErrorPx: baked.manifest.lod.achievedErrorPx, despikedSamples: 0, gentleGroundSmoothingM: null,
    composition: {
      schema: 'midio.song-range-stage', version: 1, template: template.id, layout: layout.id,
      principal: principal ? { slot: template.principalSlot, pieceId: principal.id, name: principal.name } : null,
      stageGridSha256: grid.meta.payload.heights.sha256, lakeLevelM: template.lake.levelM,
      pieces: placed,
      sources: Object.fromEntries(usedSources.map((s) => [s, { gridSha256: library.sources[s].gridSha256, windowCache: library.sources[s].windowCache,
        tools: library.sources[s].tools, place: library.sources[s].place, label: library.sources[s].label,
        license: library.sources[s].provenance?.license || null, urls: library.sources[s].provenance?.urls || [] }])),
    },
  };
  log(`${layout.id}: ${baked.stats.tiles} tiles, ${(baked.payload.byteLength / 1048576).toFixed(2)} MiB payload, `
    + `desktop ${baked.stats.desktop.triangles} tris, mobile ${baked.stats.mobile.triangles} tris; character ${JSON.stringify(scores)} (${build.archetype})`);
  return { baked, manifestText, build, grid };
}

async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  const pilot = await readJson(PILOT);
  const template = (await readJson(TEMPLATES)).templates.find((t) => t.id === pilot.template);
  if (!template) throw new Error(`no template ${pilot.template}`);
  const errors = templateErrors(template);
  if (errors.length) throw new Error(`${template.id}: ${errors.join('; ')}`);
  const doc = await readAuthoring();
  const library = await cutLibrary(pilot, doc);
  if (args.includes('--list')) {
    const out = path.resolve(opt('--out') || path.join(root, '.smoke', 'song-range-pieces'));
    await fs.mkdir(out, { recursive: true });
    const rows = library.pieces.map(pieceRow);
    await fs.writeFile(path.join(out, 'pieces.json'), JSON.stringify({ sources: library.sources, pieces: rows, rejected: library.rejected }, null, 2) + '\n');
    for (const r of rows.sort((a, b) => b.peakReliefM - a.peakReliefM)) {
      console.log(`${r.id.padEnd(52)} relief ${String(r.peakReliefM).padStart(5)} m  tiles ${r.tiles.join('x').padEnd(5)} turns ${r.quarterTurns}  ${r.name}`);
    }
    console.log(`${rows.length} pieces, ${library.rejected.length} seeds rejected; table in ${path.relative(root, out)}/pieces.json`);
    return;
  }
  if (!args.includes('--build')) throw new Error('give --list or --build');
  const publish = args.includes('--publish');
  const layouts = pilot.layouts.filter((l) => !opt('--layout') || l.id === opt('--layout'));
  if (!layouts.length) throw new Error(`no layout ${opt('--layout')}`);
  const outDir = opt('--out') ? path.resolve(opt('--out')) : publish ? path.join(RUNTIME_DIR, 'terrain') : path.join(CACHE, 'song-range');
  await fs.mkdir(outDir, { recursive: true });
  const stageDoc = await readJson(STAGE_AUTHORING).catch(() => ({ schema: 'midio.stage-views', version: 1, views: [] }));
  for (const layout of layouts) {
    const { baked, manifestText, build } = await buildLayout(layout, template, library);
    await fs.writeFile(path.join(outDir, `${layout.id}.terrain.json`), manifestText);
    await fs.writeFile(path.join(outDir, `${layout.id}.terrain.bin.gz`), baked.payload);
    await fs.writeFile(path.join(outDir, `${layout.id}.build.json`), JSON.stringify(build, null, 1) + '\n');
    const entry = { id: layout.id, regionId: 'song-range-stage', biome: 'CONIFER', status: 'candidate',
      title: layout.title, place: layout.place, notes: layout.notes || '', stage: { template: template.id, layout: layout.id } };
    const at = stageDoc.views.findIndex((v) => v.id === layout.id);
    if (at >= 0) stageDoc.views[at] = { ...stageDoc.views[at], ...entry, status: 'candidate' }; else stageDoc.views.push(entry);
  }
  if (publish) {
    await fs.writeFile(STAGE_AUTHORING, JSON.stringify(stageDoc, null, 2) + '\n');
    await writeCatalog(doc);
  } else console.log(`packages in ${path.relative(root, outDir)} (not published)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
