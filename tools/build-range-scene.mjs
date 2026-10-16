// Build one curated Range v2 scenic view: normalize its DEM corridor, turn
// its lon/lat-authored camera rail into local metres, and bake its terrain
// package. Authoring source: data/terrain/scenic-views.json.
//
//   node tools/build-range-scene.mjs --view <id> [--out DIR] [--publish] [--cell M]
//   node tools/build-range-scene.mjs --approve <id> --evidence <file,file>
//   node tools/build-range-scene.mjs --catalog
//
// Without --publish the output goes to .terrain-cache/views/<id>/ for review
// (tools/review-range-views.mjs). With --publish the package is written to
// src/assets/range/v2/terrain/ and the runtime catalog is regenerated.
// Normalized grids are cached by a hash of their parameters, so re-baking a
// camera change never re-downloads elevation.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDem, readDemGrid } from './lib/terrain-source.mjs';
import { bakeTerrain, viewSkyline, despikeGrid, smoothGentleGround } from './lib/terrain-bake.mjs';
import { skylineFeatures, characterFromFeatures, archetypeOf } from '../src/world/terrain/RangeCharacter.js';
import { cameraPoseAt } from '../src/world/terrain/SceneTravel.js';
import { cameraRailErrors } from '../src/world/terrain/SceneTravel.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const AUTHORING = path.join(root, 'data', 'terrain', 'scenic-views.json');
export const RUNTIME_DIR = path.join(root, 'src', 'assets', 'range', 'v2');
const CACHE = path.join(root, '.terrain-cache');

const sha = (s) => createHash('sha256').update(s).digest('hex');

export async function readAuthoring(file = AUTHORING) {
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(doc.views)) throw new Error('scenic-views.json has no views[]');
  return doc;
}

/** Every lon/lat point a view needs converted: rail anchors + landmarks. */
function viewPoints(view) {
  const pts = {};
  for (const k of ['eyeStart', 'eyeEnd', 'targetStart', 'targetEnd']) {
    const a = view.rail?.[k];
    if (!a?.lonLat) throw new Error(`${view.id}: rail.${k}.lonLat missing`);
    pts[k] = a.lonLat;
  }
  for (const l of view.landmarks || []) pts[`landmark:${l.name}`] = l.lonLat;
  return pts;
}

/** Local camera (metres) from a normalized grid's converted points. */
export function localCamera(view, points) {
  const vec = (k) => {
    const a = view.rail[k];
    const p = points[k];
    if (!p) throw new Error(`${view.id}: point ${k} not converted`);
    let y;
    if (Number.isFinite(a.heightM)) y = a.heightM;
    else if (Number.isFinite(a.aboveGroundM)) {
      if (!Number.isFinite(p.groundM)) throw new Error(`${view.id}: ${k} is outside valid terrain`);
      y = p.groundM + a.aboveGroundM;
    } else throw new Error(`${view.id}: rail.${k} needs heightM or aboveGroundM`);
    return [round(p.localM[0]), round(y), round(p.localM[1])];
  };
  const camera = {
    eyeStartM: vec('eyeStart'), eyeEndM: vec('eyeEnd'),
    targetStartM: vec('targetStart'), targetEndM: vec('targetEnd'),
    fovYDeg: view.rail.fovYDeg ?? 35,
  };
  for (const key of ['eyeArcM', 'targetArcM']) {
    if (view.rail[key] == null) continue;
    if (!Array.isArray(view.rail[key]) || view.rail[key].length !== 3 || !view.rail[key].every(Number.isFinite)) {
      throw new Error(`${view.id}: rail.${key} must be finite XYZ metres`);
    }
    camera[key] = [...view.rail[key]];
  }
  const errors = cameraRailErrors(camera);
  if (errors.length) throw new Error(`${view.id}: ${errors.join('; ')}`);
  return camera;
}
const round = (v) => Math.round(v * 10) / 10;

export async function buildView(view, { outDir, cell = null, log = console.log } = {}) {
  if (view.terrainSourceId) throw new Error(`${view.id}: shared terrain; rebuild ${view.terrainSourceId}, then regenerate --catalog`);
  const dem = { ...view.dem, cellM: cell || view.dem.cellM };
  const points = viewPoints(view);
  const key = sha(JSON.stringify({ dem, points })).slice(0, 16);
  const prefix = path.join(CACHE, 'views', `${view.id}-${key}`);
  let grid;
  try {
    grid = await readDemGrid(prefix);
    log(`${view.id}: cached DEM ${path.relative(root, prefix)}`);
  } catch {
    log(`${view.id}: normalizing ${dem.source} ${dem.extentM.join('x')} m at ${dem.cellM} m`);
    grid = await normalizeDem(dem.source, {
      out: prefix, centerLonLat: dem.centerLonLat, extentM: dem.extentM, offsetM: dem.offsetM,
      cellM: dem.cellM, zoom: dem.zoom, cache: CACHE, points, fill: dem.fill, fillZoom: dem.fillZoom,
    });
  }
  // Single-sample spikes in the elevation source (seen in Terrain Tiles)
  // would draw as needles; they are lowered to their neighbours, and the
  // count is recorded.
  const despiked = despikeGrid(grid);
  if (despiked) log(`${view.id}: despiked ${despiked} sample(s)`);
  // Terrain Tiles is a coarse global mosaic: soften its resampling steps on
  // gentle ground (3DEP sources are left as they are).
  const smoothedM = dem.source === 'terrarium' ? smoothGentleGround(grid) : null;
  if (smoothedM != null) log(`${view.id}: gentle ground smoothed (mean change ${smoothedM.toFixed(2)} m)`);
  const camera = localCamera(view, grid.points);
  const landmarks = (view.landmarks || []).map((l) => {
    const p = grid.points[`landmark:${l.name}`];
    return {
      name: l.name, lonLat: l.lonLat, publishedElevationM: l.elevationM ?? null,
      localM: p ? [round(p.localM[0]), round(p.localM[1])] : null,
      demGroundM: p?.groundM ?? null, demPeakWithin200mM: p?.peakWithin200mM ?? null,
    };
  });
  const runtimeView = { ...view, camera };
  const baked = await bakeTerrain(grid, runtimeView, {
    landmarks, dataUrl: `${view.id}.terrain.bin.gz`, ...(view.water === false ? { water: false } : {}),
    ...(camera.eyeArcM || camera.targetArcM ? { visibility: { stations: 61 } } : {}),
  });
  await fs.mkdir(outDir, { recursive: true });
  const manifestText = JSON.stringify(baked.manifest) + '\n';
  await fs.writeFile(path.join(outDir, `${view.id}.terrain.json`), manifestText);
  await fs.writeFile(path.join(outDir, `${view.id}.terrain.bin.gz`), baked.payload);
  // Character from the skyline actually seen, averaged over three stations.
  const scores = { energy: 0, rawness: 0, grandeur: 0, dominance: 0 };
  const features = [];
  for (const u of [0, 0.5, 1]) {
    const sky = viewSkyline(grid, cameraPoseAt(runtimeView, u));
    const f = skylineFeatures(sky.elevationsM, sky.spacingM);
    if (!f) throw new Error(`${view.id}: no measurable skyline at u=${u}`);
    features.push(f);
    const c = characterFromFeatures(f);
    for (const k of Object.keys(scores)) scores[k] += c[k] / 3;
  }
  for (const k of Object.keys(scores)) scores[k] = Math.round(scores[k] * 1000) / 1000;
  const providers = [grid.provenance?.product && 'USGS 3DEP 1/3 arc-second DEM'].filter(Boolean);
  if (/Terrain Tiles/.test(grid.provenance?.provider || '')) providers.splice(0, 1, 'AWS Terrain Tiles');
  if (grid.fill) providers.push('AWS Terrain Tiles (beyond 3DEP coverage)');
  const out = {
    credit: `Elevation: ${providers.join(' + ')}`,
    sourceSha256: (grid.provenance?.sha256 || []).concat(grid.fill?.provenance?.sha256 || []).filter(Boolean),
    view: runtimeView, characterScores: scores, archetype: archetypeOf(scores).archetype,
    skylineFeatures: features, manifestSha256: sha(manifestText), payloadSha256: baked.manifest.payload.sha256,
    payloadBytes: baked.payload.byteLength, stats: baked.stats, landmarks,
    achievedErrorPx: baked.manifest.lod.achievedErrorPx,
    despikedSamples: despiked,
    gentleGroundSmoothingM: smoothedM,
  };
  log(`${view.id}: ${baked.stats.tiles} tiles, ${(baked.payload.byteLength / 1048576).toFixed(2)} MiB payload, `
    + `desktop ${baked.stats.desktop.triangles} tris, mobile ${baked.stats.mobile.triangles} tris, `
    + `error ${JSON.stringify(out.achievedErrorPx)}; character ${JSON.stringify(scores)} (${out.archetype})`);
  for (const l of landmarks) {
    if (l.publishedElevationM != null && l.demPeakWithin200mM != null) {
      log(`  ${l.name}: published ${l.publishedElevationM} m, DEM peak ${l.demPeakWithin200mM.toFixed(0)} m`);
    }
  }
  return out;
}

export const CATALOG_MODULE = path.join(root, 'src', 'world', 'terrain', 'sceneCatalogData.js');
const DEFAULT_PACKS = {
  RAINFOREST: 'wet-conifer', CONIFER: 'dry-conifer', TAIGA: 'taiga', ICEFIELD: 'icefield', TUNDRA: 'tundra',
  PINE_OAK: 'pine-oak', BROADLEAF: 'broadleaf', CHAPARRAL: 'chaparral', STEPPE: 'steppe', CANYON: 'canyon', DESERT: 'desert',
};

/** The runtime catalog: every non-rejected authored view whose package is
 *  published, as the SceneView contract (plan §7.1). Rejected views stay
 *  in the authoring file with their reasons and never ship. */
export async function buildCatalog(doc) {
  const views = [];
  for (const v of doc.views) {
    if (v.status === 'rejected') continue;
    let build;
    try { build = JSON.parse(await fs.readFile(path.join(RUNTIME_DIR, 'terrain', `${v.terrainSourceId || v.id}.build.json`), 'utf8')); }
    catch { continue; } // not published yet
    // An approval holds only for the assets it reviewed: if the terrain
    // package, material pack or camera changed since, the view ships as a
    // candidate again until it is re-reviewed.
    const hashes = await approvalHashes(v, build);
    if (hashes.terrainManifestSha256 !== build.manifestSha256) {
      console.warn(`${v.id}: published terrain manifest differs from its build record (interrupted publish?)`);
    }
    let status = v.status;
    if (status === 'approved') {
      const a = v.approval || {};
      const keys = [...APPROVAL_KEYS, ...(v.tourManifestUrl || a.tourManifestSha256 ? ['tourManifestSha256'] : []), ...(v.glacier || a.glacierSha256 ? ['glacierSha256'] : []), ...(Object.hasOwn(v, 'composition') || a.compositionSha256 ? ['compositionSha256'] : [])];
      const stale = keys.filter((k) => !a[k] || a[k] !== hashes[k]);
      if (stale.length) {
        console.warn(`${v.id}: approval is stale (${stale.join(', ')} changed); shipping as candidate`);
        status = 'candidate';
      }
    }
    views.push({
      id: v.id, ...(v.terrainSourceId ? { terrainSourceId: v.terrainSourceId } : {}), regionId: v.regionId, biome: v.biome, status, catalogVersion: doc.catalogVersion,
      title: v.title || v.id, place: v.place || '',
      credit: build.credit || null,
      terrainManifestUrl: `terrain/${v.terrainSourceId || v.id}.terrain.json`,
      terrainManifestSha256: hashes.terrainManifestSha256,
      ...(v.tourManifestUrl ? { tourManifestUrl: v.tourManifestUrl, tourManifestSha256: hashes.tourManifestSha256 } : {}),
      materialManifestUrl: `materials/${v.materialPack || DEFAULT_PACKS[v.biome]}.json`,
      materialManifestSha256: hashes.materialManifestSha256,
      materialRules: v.materialRules || {},
      camera: build.view.camera,
      ...(Object.hasOwn(v, 'composition') ? { composition: v.composition } : {}),
      ...(v.glacier ? { glacier: v.glacier } : {}),
      characterScores: build.characterScores,
      archetype: build.archetype,
      evidence: {
        reviewPath: v.reviewPath || 'docs/range-v2-progress.md',
        review: v.review || null,
        approval: status === 'approved' ? v.approval : null,
        sourceHashes: [...new Set([...(build.sourceSha256 || []), build.payloadSha256])],
      },
    });
  }
  return { catalogVersion: doc.catalogVersion, views };
}

/** Mandatory approval identity. Optional glacierSha256 is checked when
 * authored or previously approved, preserving metadata-free old approvals. */
export const APPROVAL_KEYS = Object.freeze(['terrainManifestSha256', 'materialManifestSha256', 'materialRulesSha256', 'cameraSha256']);

/** Key-sorted JSON, so reordering an object never changes its hash. */
const canonical = (x) => (Array.isArray(x) ? `[${x.map(canonical).join(',')}]`
  : x && typeof x === 'object' ? `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`
    : JSON.stringify(x));

/** The hashes an approval is recorded against: the published terrain
 *  manifest as it is on disk (not the build record's copy of its hash), the
 *  material pack, the view's own material overrides, camera and optional ice. */
export async function approvalHashes(v, build) {
  const matUrl = `materials/${v.materialPack || DEFAULT_PACKS[v.biome]}.json`;
  const mat = await fs.readFile(path.join(RUNTIME_DIR, matUrl));
  const terrain = await fs.readFile(path.join(RUNTIME_DIR, 'terrain', `${v.terrainSourceId || v.id}.terrain.json`));
  return {
    terrainManifestSha256: sha(terrain), materialManifestSha256: sha(mat),
    materialRulesSha256: sha(canonical(v.materialRules || {})), cameraSha256: sha(JSON.stringify(build.view.camera ?? null)),
    ...(v.tourManifestUrl ? { tourManifestSha256: sha(await fs.readFile(path.join(RUNTIME_DIR, v.tourManifestUrl))) } : {}),
    ...(Object.hasOwn(v, 'composition') || v.approval?.compositionSha256 ? { compositionSha256: sha(canonical(v.composition ?? null)) } : {}),
    ...(v.glacier ? { glacierSha256: sha(canonical(v.glacier)) } : {}),
  };
}

/** Mark a published view approved against its current assets. Evidence is
 *  required: at least one review file, each of which must exist. Mutates
 *  `doc`; the caller writes it. */
export async function approveView(doc, id, { evidence = [] } = {}) {
  const v = doc.views.find((x) => x.id === id);
  if (!v) throw new Error(`no view ${id} in scenic-views.json`);
  if (!evidence.length) throw new Error(`${id}: --evidence <file,file> is required to approve a view`);
  for (const file of evidence) {
    try { await fs.access(path.resolve(root, file)); } catch { throw new Error(`${id}: evidence file ${file} does not exist`); }
  }
  const build = JSON.parse(await fs.readFile(path.join(RUNTIME_DIR, 'terrain', `${v.terrainSourceId || id}.build.json`), 'utf8'));
  // Legacy parity: the far range stays readable at every rail station.
  const { viewExposure, pairExposure, MIN_FAR_EXPOSED, MIN_FAR_CREST_COLUMNS } = await import('./lib/range-exposure.mjs');
  const exposureOf = (x, authored) => viewExposure(RUNTIME_DIR, {
    ...x, ...authored, camera: x.camera, terrainManifestUrl: `terrain/${authored.terrainSourceId || authored.id}.terrain.json`,
    materialManifestUrl: `materials/${authored.materialPack || DEFAULT_PACKS[x.biome]}.json`,
    materialRules: authored.materialRules || {},
  });
  const exposure = await exposureOf(build.view, v);
  if (exposure.min < MIN_FAR_EXPOSED) {
    throw new Error(`${id}: far crest only ${exposure.min.toFixed(2)} exposed at its worst station (needs ${MIN_FAR_EXPOSED}); not approved`);
  }
  // A fraction of a crest that barely exists is meaningless: the far range
  // must also span the frame at every station.
  if (exposure.minCrest < MIN_FAR_CREST_COLUMNS) {
    throw new Error(`${id}: far crest spans only ${exposure.minCrest.toFixed(2)} of the frame at its worst station (needs ${MIN_FAR_CREST_COLUMNS}); not approved`);
  }
  console.log(`${id}: far crest exposure ${exposure.stations.map((s) => s.fraction.toFixed(2)).join(' ')}`);
  // Travel to and from every view already approved, at the shared progress.
  for (const other of doc.views.filter((x) => x.status === 'approved' && x.id !== id)) {
    const ob = JSON.parse(await fs.readFile(path.join(RUNTIME_DIR, 'terrain', `${other.terrainSourceId || other.id}.build.json`), 'utf8'));
    const oe = await exposureOf(ob.view, other);
    for (const [a, b, name] of [[exposure, oe, `${id} -> ${other.id}`], [oe, exposure, `${other.id} -> ${id}`]]) {
      const r = pairExposure(a, b);
      if (r.min < MIN_FAR_EXPOSED) {
        throw new Error(`${name}: far crest only ${r.min.toFixed(2)} exposed in travel (station ${r.at.station}, seam ${r.at.p}); not approved`);
      }
      if (r.minCrest < MIN_FAR_CREST_COLUMNS) {
        throw new Error(`${name}: far crest spans only ${r.minCrest.toFixed(2)} of the frame in travel (station ${r.crestAt.station}, seam ${r.crestAt.p}); not approved`);
      }
    }
  }
  v.status = 'approved';
  v.approval = { date: new Date().toISOString().slice(0, 10), ...(await approvalHashes(v, build)), evidence };
  doc.catalogVersion = (doc.catalogVersion || 0) + 1;
  console.log(`${id}: approved; catalog version ${doc.catalogVersion}`);
  return doc;
}

async function writeCatalog(doc) {
  const catalog = await buildCatalog(doc);
  const text = '// Generated by tools/build-range-scene.mjs --catalog from data/terrain/scenic-views.json.\n'
    + '// Do not edit: change the authoring file and regenerate.\n'
    + `export default ${JSON.stringify(catalog, null, 1)};\n`;
  await fs.writeFile(CATALOG_MODULE, text);
  console.log(`catalog v${catalog.catalogVersion}: ${catalog.views.map((v) => `${v.id} (${v.status})`).join(', ')}`);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  if (args.includes('--catalog')) { await writeCatalog(await readAuthoring()); return; }
  if (opt('--approve')) {
    const doc = await readAuthoring();
    await approveView(doc, opt('--approve'), { evidence: (opt('--evidence') || '').split(',').filter(Boolean) });
    await fs.writeFile(AUTHORING, JSON.stringify(doc, null, 2) + '\n');
    await writeCatalog(doc);
    return;
  }
  const id = opt('--view');
  const doc = await readAuthoring();
  const views = id === 'all' ? doc.views.filter(v => !v.terrainSourceId) : doc.views.filter((v) => v.id === id);
  if (!views.length) throw new Error(`no view ${id} in scenic-views.json`);
  const publish = args.includes('--publish');
  for (const view of views) {
    const outDir = opt('--out') ? path.resolve(opt('--out'))
      : publish ? path.join(RUNTIME_DIR, 'terrain') : path.join(CACHE, 'views', view.id);
    const res = await buildView(view, { outDir, cell: Number(opt('--cell')) || null });
    await fs.writeFile(path.join(outDir, `${view.id}.build.json`), JSON.stringify(res, null, 1) + '\n');
  }
  if (publish) await writeCatalog(doc);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
