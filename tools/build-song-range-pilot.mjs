// Song range composition, Phase 1: cut massif pieces from complete source
// DEMs, compose fixed layouts on a stage template, and bake each layout with
// the production baker into an ordinary candidate catalog view.
//
//   node tools/build-song-range-pilot.mjs --list [--out DIR]
//   node tools/build-song-range-pilot.mjs --build [--layout ID] [--out DIR] [--publish]
//   node tools/build-song-range-pilot.mjs --catalog
//
// --list cuts every source in data/terrain/song-range-pilot.json and writes
// the piece table (and per-piece previews) to DIR (default .smoke/song-range-
// pieces). --build composes the pilot's layouts; without --publish the
// packages go to .terrain-cache/song-range/, with --publish to
// src/assets/range/v2/terrain/ plus data/terrain/stage-views.json, and the
// runtime catalog is regenerated. Published stages are candidates and are
// reachable only through ?rangeView=<id>. --catalog writes the massif catalog
// the song range planner reads (src/world/terrain/massifCatalogData.js):
// templates and piece metadata only, no terrain bytes.
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
import { readAuthoring, writeCatalog, RUNTIME_DIR, STAGE_AUTHORING, DEFAULT_PACKS } from './build-range-scene.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PILOT = path.join(root, 'data', 'terrain', 'song-range-pilot.json');
const TEMPLATES = path.join(root, 'data', 'terrain', 'stage-templates.json');
const CACHE = path.join(root, '.terrain-cache');
export const MASSIF_CATALOG_MODULE = path.join(root, 'src', 'world', 'terrain', 'massifCatalogData.js');
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

/** Stages are a 20 m grid: a source on any other grid is normalized again at
 *  20 m for cutting, its extent capped at 60 km (song range composition,
 *  Phase 5). Sources already at 20 m keep their parameters and cache. */
export const PIECE_CELL_M = 20;
/** How a credit names each elevation source. */
export const ELEVATION_LABELS = Object.freeze({
  '3dep13': 'USGS 3DEP 1/3 arc-second DEM',
  terrarium: 'Terrain Tiles on AWS (Mapzen/Tilezen; USGS 3DEP, SRTM, GMTED, ETOPO)',
});
const PIECE_MAX_EXTENT_M = 60000;
export function pieceSourceView(view) {
  if (view.dem.cellM === PIECE_CELL_M) return view;
  return { ...view, dem: { ...view.dem, cellM: PIECE_CELL_M, extentM: view.dem.extentM.map((e) => Math.min(e, PIECE_MAX_EXTENT_M)) } };
}

/** A DEM-only region (no authored camera) as the view record the cutter
 *  reads: pieces face its nominal viewer. */
export function regionView(r) {
  return { id: r.id, title: r.title, place: r.place, biome: r.biome, materialPack: r.family, dem: r.dem,
    rail: { eyeStart: { lonLat: r.viewerLonLat }, eyeEnd: { lonLat: r.viewerLonLat } }, landmarks: r.landmarks || [], demOnly: true };
}

/** Cut every acceptable piece of every pilot source and DEM-only region. */
export async function cutLibrary(pilot, doc, { log = console.log, only = null } = {}) {
  const pieces = [], rejected = [], sources = {};
  const opts = { ...CUT_DEFAULTS, ...(pilot.cut || {}) };
  const entries = [...pilot.sources.map((id) => {
    const view = doc.views.find((v) => v.id === id);
    if (!view) throw new Error(`pilot source ${id} is not in scenic-views.json`);
    return view;
  }), ...(pilot.regions || []).map(regionView)].filter((v) => !only || only.includes(v.id));
  const ids = new Set();
  for (const sourceView of entries) {
    const view = pieceSourceView(sourceView), id = view.id;
    const src = await loadSourceGrid(view, { log });
    const { grid } = src;
    sources[id] = { gridSha256: src.gridSha256, windowCache: src.windowCache, tools: src.tools, cache: src.cache,
      despikedSamples: src.despiked, width: grid.width, height: grid.height, cellSizeM: grid.cellSizeM,
      provenance: src.provenance, title: view.title, place: view.place, demOnly: !!view.demOnly,
      elevation: ELEVATION_LABELS[view.dem.source] || String(view.dem.source),
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
      // Two unnamed summits of one height in a source get distinct ids.
      const base = `${id}:${seed.name ? slug(seed.name) : `summit-${Math.round(seed.heightM)}`}`;
      let sid = base;
      for (let k = 2; ids.has(sid); k++) sid = `${base}-${k}`;
      ids.add(sid);
      if (!r.ok) { rejected.push({ id: sid, reason: r.reason, heightM: Math.round(seed.heightM) }); continue; }
      const p = r.piece;
      if (p.outline.band[1] > (pilot.outlineSlopeRatioMax ?? 1.15) * p.outline.bandSource[1] + 0.02) {
        rejected.push({ id: sid, reason: 'outline-steepened', heightM: Math.round(seed.heightM), outline: p.outline }); continue;
      }
      if (borderRelief(p.relief, p.width, p.height) !== 0) throw new Error(`${sid}: non-zero border`);
      const ch = pieceCharacter(p);
      pieces.push({ ...p, id: sid, sourceView: id, family: view.materialPack || DEFAULT_PACKS[view.biome],
        name: p.name || `${pilot.sourceLabels?.[id] || view.title} summit ${Math.round(p.peakM)} m`, place: view.place,
        character: ch?.scores || null, skylineFeatures: ch?.features || null });
    }
    log(`${id}: ${seeds.length} seeds, ${pieces.filter((p) => p.sourceView === id).length} pieces`);
  }
  return { pieces, rejected, sources };
}

/** Which template rows a piece can stand in: its relief within the row's
 *  range and its block within the slot (as the planner's fit test). */
export function pieceRows(templates, p) {
  return [...new Set([].concat(templates).flatMap((t) => t.slots).filter((s) => {
    const [lo, hi] = s.reliefM || [0, null];
    return p.peakReliefM >= lo && (hi == null || p.peakReliefM <= hi) && p.tiles[0] <= s.tiles[2] && p.tiles[1] <= s.tiles[3];
  }).map((s) => s.row))];
}

/**
 * At most `cap[family]` pieces per family (null: keep all), chosen so every
 * template row stays fillable: first the rows' needs (front, back, horizon,
 * round robin over sources, tallest first), then the tallest of the rest.
 * Pieces that fit no row are dropped. Returns the kept library and a report.
 */
export function capLibrary(library, templates, caps = {}) {
  templates = [].concat(templates);
  // Each row's need is the most any template asks of it.
  const need = {};
  for (const t of templates) {
    const n = {};
    for (const s of t.slots) n[s.row] = (n[s.row] || 0) + 1;
    for (const [r, c] of Object.entries(n)) need[r] = Math.max(need[r] || 0, c);
  }
  const template = templates;
  const byFamily = new Map();
  for (const p of library.pieces) {
    if (!byFamily.has(p.family)) byFamily.set(p.family, []);
    byFamily.get(p.family).push(p);
  }
  const kept = [], report = {};
  for (const [family, all] of byFamily) {
    const cap = caps[family] === undefined ? caps.default ?? null : caps[family];
    const fitting = all.map((p) => ({ p, rows: pieceRows(template, p) })).filter((x) => x.rows.length);
    // No cap: every piece stays, published packages and pilot layouts with them.
    if (cap == null) { kept.push(...all); report[family] = { cut: all.length, fitting: fitting.length, kept: all.length }; continue; }
    const chosen = new Set();
    const roundRobin = (pool, n) => {
      const bySource = new Map();
      for (const x of pool.sort((a, b) => b.p.peakReliefM - a.p.peakReliefM)) {
        if (!bySource.has(x.p.sourceView)) bySource.set(x.p.sourceView, []);
        bySource.get(x.p.sourceView).push(x);
      }
      const queues = [...bySource.values()];
      while (n > 0 && queues.some((q) => q.length)) {
        for (const q of queues) { const x = q.shift(); if (x && !chosen.has(x.p) && chosen.size < cap) { chosen.add(x.p); n--; } if (n <= 0) break; }
      }
    };
    // Twice each row's slots, so a song's draw has a choice in every row.
    for (const row of ['front', 'back', 'horizon']) roundRobin(fitting.filter((x) => x.rows.includes(row) && !chosen.has(x.p)), 2 * (need[row] || 0));
    roundRobin(fitting.filter((x) => !chosen.has(x.p)), cap - chosen.size);
    kept.push(...chosen);
    const rows = Object.fromEntries(['front', 'back', 'horizon'].map((r) => [r, [...chosen].filter((p) => pieceRows(template, p).includes(r)).length]));
    report[family] = { cut: all.length, fitting: fitting.length, kept: chosen.size, rows,
      plannable: Object.entries(need).every(([r, n]) => rows[r] >= n) && chosen.size >= Math.max(...templates.map((t) => t.slots.length)) };
  }
  return { library: { ...library, pieces: kept }, report };
}

/** The planner's fit test (SongRangePlan.js). */
const fitsSlot = (slot, p) => p.tiles[0] <= slot.tiles[2] && p.tiles[1] <= slot.tiles[3]
  && p.peakReliefM >= (slot.reliefM?.[0] ?? 0) && (slot.reliefM?.[1] == null || p.peakReliefM <= slot.reliefM[1]);

/** Can `pieces` fill every slot of `template` with distinct pieces? A
 *  bipartite matching, slots to pieces. */
export function fillsTemplate(template, pieces) {
  const owner = new Map();
  const assign = (slot, seen) => {
    for (const p of pieces) {
      if (seen.has(p) || !fitsSlot(slot, p)) continue;
      seen.add(p);
      if (!owner.has(p) || assign(owner.get(p), seen)) { owner.set(p, slot); return true; }
    }
    return false;
  };
  return template.slots.every((slot) => assign(slot, new Set()));
}

/** Each template's families: those listed whose pieces can fill it. */
export function plannableFamilies(templates, pieces) {
  const byFamily = new Map();
  for (const p of pieces) { if (!byFamily.has(p.family)) byFamily.set(p.family, []); byFamily.get(p.family).push(p); }
  return Object.fromEntries(templates.map((t) => [t.id, t.families.filter((f) => byFamily.has(f) && fillsTemplate(t, byFamily.get(f)))]));
}

const pieceRow = (p) => ({ id: p.id, name: p.name, sourceView: p.sourceView, seedKind: p.seedKind,
  peakM: Math.round(p.peakM), levelM: Math.round(p.levelM), baseAtPeakM: Math.round(p.baseAtPeakM),
  peakReliefM: Math.round(p.peakReliefM), meanReliefM: Math.round(p.meanReliefM), tiles: p.tiles,
  regionAreaKm2: round1(p.regionAreaKm2), quarterTurns: p.quarterTurns, facingResidualDeg: p.facingResidualDeg,
  coverageFanDeg: p.coverageFanDeg, outline: p.outline, base: p.base, character: p.character,
  reliefSha256: sha(Buffer.from(p.relief.buffer, p.relief.byteOffset, p.relief.byteLength)) });

export const MASSIF_DIR = path.join(RUNTIME_DIR, 'massif');
/** File stem of a piece package: ids hold ':' which Windows cannot store. */
export const pieceFile = (id) => id.replace(/:/g, '--');

/** One piece as its own terrain package: every tile at stride 1 with its
 *  per-stride errors, relief above the piece base in metres, the piece's
 *  own hydrology, and kind 'massif-piece' so it is never taken for a view. */
export async function bakePiece(piece, sourceLabel) {
  const W = piece.width, H = piece.height;
  const bytes = Buffer.from(piece.relief.buffer, piece.relief.byteOffset, piece.relief.byteLength);
  const grid = { width: W, height: H, cellSizeM: piece.cellSizeM, originM: [0, 0], heightsM: piece.relief,
    valid: new Uint8Array(W * H).fill(1), centerLonLat: null, upsampled: false,
    horizontalCrs: 'Piece frame: metres from the block corner, +Z toward the source camera',
    verticalReference: 'Relief above the piece base (metres)', sourceResolutionM: piece.cellSizeM, outputSpacingM: piece.cellSizeM,
    meta: { payload: { heights: { sha256: sha(bytes) } } } };
  const stem = pieceFile(piece.id);
  const baked = await bakeTerrain(grid, { id: stem, regionId: piece.sourceView }, { allTiles: true, dataUrl: `${stem}.terrain.bin.gz` });
  const manifest = { ...baked.manifest, kind: 'massif-piece',
    piece: { id: piece.id, name: piece.name, sourceView: piece.sourceView, place: sourceLabel, tiles: [...piece.tiles],
      peakReliefM: Math.round(piece.peakReliefM), levelM: Math.round(piece.levelM) } };
  const manifestText = JSON.stringify(manifest) + '\n';
  return { stem, manifestText, payload: baked.payload, manifestSha256: sha(manifestText) };
}

/** Runtime metadata for the planner and the assembler: templates (with
 *  their floor and camera) and pieces (with their package pins). */
export function massifCatalog(templates, library, pins = new Map(), materials = {}, pilots = [], pilotTemplate = templates[0]) {
  const pieces = library.pieces.map((p) => ({ id: p.id, name: p.name, family: p.family, sourceView: p.sourceView,
    place: library.sources[p.sourceView].label, elevation: library.sources[p.sourceView].elevation,
    seedKind: p.seedKind, tiles: [...p.tiles],
    peakReliefM: Math.round(p.peakReliefM), peakM: Math.round(p.peakM),
    characterScores: Object.fromEntries(Object.entries(p.character).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
    reliefSha256: sha(Buffer.from(p.relief.buffer, p.relief.byteOffset, p.relief.byteLength)),
    ...(pins.has(p.id) ? { manifestUrl: `massif/${pieceFile(p.id)}.terrain.json`, manifestSha256: pins.get(p.id) } : {}) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { schema: 'midio.massif-catalog', version: 1,
    templates: templates.map((template) => ({ id: template.id, title: template.title, families: [...template.families], principalSlot: template.principalSlot,
      lakeLevelM: template.lake.levelM, grid: { ...template.grid, originM: [...template.grid.originM] },
      lake: { levelM: template.lake.levelM, centerM: [...template.lake.centerM], radiiM: [...template.lake.radiiM] },
      floor: { ...template.floor }, camera: stageCamera(template),
      slots: template.slots.map((s) => ({ id: s.id, row: s.row, tiles: [...s.tiles], reliefM: s.reliefM ?? [0, null] })) })),
    materials, pieces,
    // The Phase 1 layouts, so ?songRangeLayout=<id> can run one through the
    // runtime path for comparison with its offline stage (diagnostic only).
    pilots: pilots.map((l) => ({ id: l.id, templateId: pilotTemplate.id,
      slots: pilotTemplate.slots.map((s) => ({ slotId: s.id, pieceId: l.slots[s.id].piece, mirrored: !!l.slots[s.id].mirrored })) })) };
}

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
  const templates = (await readJson(TEMPLATES)).templates;
  for (const t of templates) {
    const errors = templateErrors(t);
    if (errors.length) throw new Error(`${t.id}: ${errors.join('; ')}`);
  }
  const template = templates.find((t) => t.id === pilot.template);
  if (!template) throw new Error(`no template ${pilot.template}`);
  const doc = await readAuthoring();
  const only = opt('--only') ? opt('--only').split(',') : null;
  const cut = await cutLibrary(pilot, doc, { only });
  const { library, report } = capLibrary(cut, templates, pilot.familyCap || {});
  const plannable = plannableFamilies(templates, library.pieces);
  console.log(JSON.stringify(report));
  console.log(JSON.stringify({ plannable }));
  // A template lists only the families its pieces can fill.
  for (const t of templates) t.families = plannable[t.id];
  if (args.includes('--catalog')) {
    // Piece packages and their pins, then the catalog that names them.
    await fs.mkdir(MASSIF_DIR, { recursive: true });
    const pins = new Map();
    let total = 0;
    for (const p of library.pieces) {
      const b = await bakePiece(p, library.sources[p.sourceView].label);
      await fs.writeFile(path.join(MASSIF_DIR, `${b.stem}.terrain.json`), b.manifestText);
      await fs.writeFile(path.join(MASSIF_DIR, `${b.stem}.terrain.bin.gz`), b.payload);
      pins.set(p.id, b.manifestSha256);
      total += b.payload.byteLength + Buffer.byteLength(b.manifestText);
    }
    const families = [...new Set(library.pieces.map((p) => p.family))];
    const materials = {};
    for (const f of families) {
      const url = `materials/${f}.json`;
      materials[f] = { manifestUrl: url, manifestSha256: sha(await fs.readFile(path.join(RUNTIME_DIR, url))) };
    }
    const text = '// Generated by tools/build-song-range-pilot.mjs --catalog. Do not edit.\n'
      + '// Massif pieces and stage templates for the song range planner (SongRangePlan.js)\n'
      + '// and assembler (StageAssembly.js). Piece packages: src/assets/range/v2/massif/.\n'
      + `export default ${JSON.stringify(massifCatalog(templates, library, pins, materials, pilot.layouts, template), null, 1)};\n`;
    await fs.writeFile(MASSIF_CATALOG_MODULE, text);
    console.log(`massif catalog: ${library.pieces.length} pieces (${(total / 1048576).toFixed(2)} MiB of packages), templates ${templates.map((t) => t.id).join(', ')}`);
    return;
  }
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
