// Runtime assembly of a song's composed mountain range (song range
// composition, Phase 3). A plan (SongRangePlan.js) names a stage template and
// the massif piece in each slot; this module turns the template floor
// (StageFloor.js) and the decoded piece packages into an ordinary
// `midio.terrain` manifest plus decoded payload bytes, which go through the
// same validateTerrainManifest/decodeTerrain path as every catalog view. Nothing
// downstream knows a stage was assembled.
//
// Tile by tile, never a whole-grid array: each 64-cell tile's 65 x 65 heights
// are the floor plus the relief of the (at most one) piece block covering it.
// Per tile it then measures the triangulation error of every stride and picks
// a stride per quality budget with the baker's rail-only rule (TerrainTiles.js)
// against the template's camera rail. Occlusion is not tested and every tile
// is kept, so the stage has no holes: more tiles than a baked view, never
// fewer, and no RiseGround backdrop is needed.
//
// Hydrology: a piece sample keeps its own package's flow byte (its own water,
// such as a caldera lake); floor samples are water inside the lake and dry
// land outside it. No hydrology runs at runtime.
import { TERRAIN_SCHEMA, TERRAIN_VERSION, STRIDES, WATER_FLOW, validateTerrainManifest } from './TerrainPackage.js';
import { TILE_CELLS, LOD_BUDGETS, VISIBILITY, FRAMINGS, SHORE_MAX_STRIDE, tileStrideError, encodeResiduals, splitPlanes, quantizationFor } from './TerrainTiles.js';
import { decodeTerrain } from './TerrainMesh.js';
import { cameraPoseAt, boxMayBeVisible, viewDepthToBox, focalPx } from '../terrain/SceneTravel.js';
import { stageFloorHeight, inStageLake, slotOrigin } from '../terrain/StageFloor.js';
import { songRangeKey } from '../terrain/SongRangePlan.js';

export const STAGE_KIND = 'song-range-stage';
export const PIECE_KIND = 'massif-piece';
const BANDS = Object.freeze({ nearM: 1800, midM: 7000 });

/** A decoded piece package (stride-1 tiles) as one relief/flow block. */
export function pieceBlock(data) {
  const m = data.manifest;
  if (m.kind !== PIECE_KIND) throw new Error(`${m.viewId}: not a massif piece package`);
  const W = m.grid.width, H = m.grid.height, cells = m.tileCells;
  const relief = new Float32Array(W * H), flow = new Uint8Array(W * H);
  for (const t of data.tiles.values()) {
    if (t.stride !== 1) throw new Error(`${m.viewId}: piece tile ${t.id} is stride ${t.stride}, not 1`);
    for (let v = 0; v < t.samples; v++) for (let u = 0; u < t.samples; u++) {
      const x = t.ix * cells + u, y = t.iz * cells + v;
      if (x >= W || y >= H) continue;
      const k = v * t.samples + u;
      // Quantized zero can decode a hair either side of 0: under a
      // millimetre is the outline, not relief.
      relief[y * W + x] = t.heightsM[k] > 1e-3 ? t.heightsM[k] : 0;
      flow[y * W + x] = t.flowBytes[k];
    }
  }
  return { id: m.piece?.id, width: W, height: H, relief, flow, tiles: [(W - 1) / cells, (H - 1) / cells] };
}

function mirrored(block) {
  const { width: W, height: H } = block;
  const relief = new Float32Array(W * H), flow = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    relief[j * W + (W - 1 - i)] = block.relief[j * W + i];
    flow[j * W + (W - 1 - i)] = block.flow[j * W + i];
  }
  return { ...block, relief, flow };
}

/** The template a plan uses, from a massif catalog. */
export function stageTemplate(catalog, plan) {
  const t = catalog.templates.find((x) => x.id === plan.templateId);
  if (!t) throw new Error(`no stage template ${plan.templateId}`);
  return t;
}

/**
 * Assemble a stage. Pure and synchronous.
 *   plan     planSongRange result
 *   blocks   Map pieceId -> pieceBlock(...)
 *   options  { catalog, id, forceStride, landmarks }
 * Returns { manifest, decoded (Uint8Array), placed }.
 */
export function assembleStage(plan, blocks, { catalog, id = `song-range-${stageHash(plan)}`, forceStride = null } = {}) {
  const t = stageTemplate(catalog, plan);
  const { width: W, height: H, cellSizeM: c, originM } = t.grid;
  const cells = TILE_CELLS;
  const tilesX = (W - 1) / cells, tilesZ = (H - 1) / cells;
  if (!Number.isInteger(tilesX) || !Number.isInteger(tilesZ)) throw new Error(`${t.id}: grid is not whole tiles`);
  // Which piece block covers each stage tile (slots never overlap).
  const owner = new Array(tilesX * tilesZ).fill(null);
  const placed = [];
  let maxRelief = 0;
  for (const s of plan.slots) {
    const slot = t.slots.find((x) => x.id === s.slotId);
    let block = blocks.get(s.pieceId);
    if (!slot || !block) throw new Error(`${id}: slot ${s.slotId} or piece ${s.pieceId} missing`);
    if (s.mirrored) block = mirrored(block);
    const at = slotOrigin(slot, block.tiles);
    if (!at) throw new Error(`${s.pieceId} does not fit slot ${s.slotId}`);
    for (let dz = 0; dz < block.tiles[1]; dz++) for (let dx = 0; dx < block.tiles[0]; dx++) {
      const k = (at[1] + dz) * tilesX + at[0] + dx;
      if (owner[k]) throw new Error(`${id}: slots ${owner[k].slotId} and ${s.slotId} overlap`);
      owner[k] = { block, at, slotId: s.slotId };
    }
    let peak = 0, pk = 0;
    for (let k = 0; k < block.relief.length; k++) if (block.relief[k] > peak) { peak = block.relief[k]; pk = k; }
    maxRelief = Math.max(maxRelief, peak);
    const px = originM[0] + (at[0] * cells + pk % block.width) * c, pz = originM[1] + (at[1] * cells + Math.floor(pk / block.width)) * c;
    placed.push({ slotId: s.slotId, pieceId: s.pieceId, mirrored: !!s.mirrored, tileOrigin: at, peakReliefM: peak,
      peakLocalM: [px, pz], stagePeakM: stageFloorHeight(t, px, pz) + peak });
  }
  // Global quantization: the floor is highest at a grid corner (distance to
  // a convex lake is convex), and relief only adds to the floor.
  const corners = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]].map(([i, j]) => stageFloorHeight(t, originM[0] + i * c, originM[1] + j * c));
  const { offsetM, stepM } = quantizationFor(t.lake.levelM, Math.max(...corners) + maxRelief);
  const quant = (v) => Math.max(1, Math.min(65535, Math.round((v - offsetM) / stepM)));
  // Rail stations and lenses, exactly as a rail-only bake sees them.
  const view = { camera: t.camera };
  const stations = Array.from({ length: VISIBILITY.stations }, (_, k) => cameraPoseAt(view, k / (VISIBILITY.stations - 1)));
  const focal = Object.fromEntries(Object.entries(LOD_BUDGETS).map(([k, b]) => [k, focalPx(t.camera.fovYDeg, b.heightPx)]));
  const n1 = cells + 1, valid = new Uint8Array(n1 * n1).fill(1);
  const h = new Float32Array(n1 * n1), fl = new Uint8Array(n1 * n1);
  const chunks = [];
  let byteOffset = 0;
  const push = (buf) => { const at = byteOffset; chunks.push(buf); byteOffset += buf.byteLength; return at; };
  const tiles = [];
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const achieved = Object.fromEntries(Object.keys(LOD_BUDGETS).map((k) => [k, 0]));
  for (let iz = 0; iz < tilesZ; iz++) for (let ix = 0; ix < tilesX; ix++) {
    const own = owner[iz * tilesX + ix];
    let minY = Infinity, maxY = -Infinity, wet = 0, land = 0;
    for (let v = 0; v < n1; v++) for (let u = 0; u < n1; u++) {
      const gi = ix * cells + u, gj = iz * cells + v, x = originM[0] + gi * c, z = originM[1] + gj * c;
      let r = 0, pf = 0;
      if (own) {
        const bi = gi - own.at[0] * cells, bj = gj - own.at[1] * cells;
        const bk = bj * own.block.width + bi;
        r = own.block.relief[bk]; pf = own.block.flow[bk];
      }
      const y = stageFloorHeight(t, x, z) + r;
      const k = v * n1 + u;
      h[k] = y;
      fl[k] = r > 0 ? pf : inStageLake(t.lake, x, z) ? WATER_FLOW : 0;
      if (fl[k] === WATER_FLOW) wet++; else land++;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const x0 = originM[0] + ix * cells * c, z0 = originM[1] + iz * cells * c;
    const box = { min: [x0, minY, z0], max: [x0 + cells * c, maxY, z0 + cells * c] };
    const errorsM = {};
    for (const s of STRIDES) if (s <= cells) errorsM[s] = tileStrideError(h, valid, n1, n1, 0, 0, cells, s);
    const reach = Object.fromEntries(FRAMINGS.map((f) => [f, Infinity]));
    for (const pose of stations) for (const f of FRAMINGS) {
      if (!boxMayBeVisible(pose, VISIBILITY[f].aspect, box, VISIBILITY[f].fovScale)) continue;
      const d = Math.max(0, viewDepthToBox(pose, box));
      if (d < reach[f]) reach[f] = d;
    }
    const framing = Number.isFinite(reach.core) ? 'core' : Number.isFinite(reach.extended) ? 'extended' : null;
    const dist = framing ? Math.max(VISIBILITY.minDistanceM, reach[framing]) : Infinity;
    const cap = wet && land ? SHORE_MAX_STRIDE : Infinity;
    const lod = Object.fromEntries(Object.entries(LOD_BUDGETS).map(([k, b]) => {
      if (forceStride) return [k, forceStride];
      if (!framing) return [k, Math.min(cells, cap)];
      let best = 1;
      for (const s of STRIDES) {
        if (s > cells || s > cap) break;
        if (errorsM[s] * focal[k] / dist <= b.errorPx * VISIBILITY[framing].budgetScale) best = s;
      }
      return [k, best];
    }));
    for (const k of Object.keys(lod)) if (framing === 'core') achieved[k] = Math.max(achieved[k], errorsM[lod[k]] * focal[k] / dist);
    const stride = Math.min(...Object.values(lod));
    const n = cells / stride + 1;
    const q = new Uint16Array(n * n), flow = new Uint8Array(n * n);
    for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) {
      const k = (v * stride) * n1 + u * stride;
      q[v * n + u] = quant(h[k]);
      flow[v * n + u] = fl[k];
    }
    const residual = splitPlanes(encodeResiduals(q, n));
    const hAt = push(residual), fAt = push(flow);
    tiles.push({
      id: `t${ix}_${iz}`, ix, iz, stride, samples: n,
      heights: { byteOffset: hAt, byteLength: residual.byteLength, count: n * n, type: 'uint16', predictor: 'planar', planes: 'lo-hi' },
      flow: { byteOffset: fAt, byteLength: flow.byteLength, count: n * n, type: 'uint8', water: WATER_FLOW },
      validity: { mode: 'all' }, minY, maxY, visible: true, framing: framing || 'outside',
      closestM: framing ? Math.round(dist) : null,
      band: dist < BANDS.nearM ? 'near' : dist < BANDS.midM ? 'mid' : 'far', lod,
      errorsM: Object.fromEntries(Object.entries(errorsM).filter(([s]) => Number(s) >= stride).map(([s, e]) => [s, Math.round(e * 1000) / 1000])),
    });
    for (let a = 0; a < 3; a++) { bounds.min[a] = Math.min(bounds.min[a], box.min[a]); bounds.max[a] = Math.max(bounds.max[a], box.max[a]); }
  }
  const decoded = new Uint8Array(byteOffset);
  let at = 0;
  for (const ch of chunks) { decoded.set(ch, at); at += ch.byteLength; }
  const estimate = (budget) => {
    let vertices = 0, triangles = 0;
    for (const tile of tiles) { const m = cells / tile.lod[budget]; vertices += (m + 1) * (m + 1); triangles += 2 * m * m; }
    return { vertices, triangles, meshBytes: vertices * 12 + triangles * 3 * 4, surfaceTextureBytes: Math.round(W * H * 4 * 4 / 3) };
  };
  const manifest = {
    schema: TERRAIN_SCHEMA, version: TERRAIN_VERSION, kind: STAGE_KIND,
    viewId: id, regionId: 'song-range-stage',
    source: { demSha256: null, provenance: { composition: { songRangeVersion: plan.version, key: songRangeKey(plan), template: t.id,
      pieces: placed.map((p) => ({ slotId: p.slotId, pieceId: p.pieceId, mirrored: p.mirrored })) } },
    fill: null, horizontalCrs: 'Local stage metres; pieces carry their own source CRS',
    verticalReference: 'Stage floor plus measured relief above each piece base (metres)', centerLonLat: null,
    sourceResolutionM: c, outputSpacingM: c },
    grid: { width: W, height: H, cellSizeM: c, originM: [...originM] },
    axes: 'X east, Y up, Z south (metres)', tileCells: cells, tilesX, tilesZ,
    quantization: { offsetM, stepM }, boundsM: bounds, bands: { ...BANDS },
    lod: { budgets: LOD_BUDGETS, fovYDeg: t.camera.fovYDeg, visibility: VISIBILITY,
      framings: 'assembled at runtime against the template rail without occlusion culling; every tile is kept',
      achievedErrorPx: Object.fromEntries(Object.entries(achieved).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
      triangulation: 'quads split along the (0,0)-(1,1) diagonal; finer edges snap to the coarser neighbour' },
    hydrology: { flow: 'each piece keeps its own package flow; floor flow 0', water: 'piece water from its own bake; floor water inside the template lake' },
    payload: { url: null, encoding: 'none', byteLength: decoded.byteLength, sha256: null, decodedByteLength: decoded.byteLength, decodedSha256: null },
    estimatedBytes: { desktop: estimate('desktop'), mobile: estimate('mobile') },
    landmarks: placed.map((p) => ({ name: catalog.pieces.find((x) => x.id === p.pieceId)?.name || p.pieceId, lonLat: null,
      publishedElevationM: null, localM: p.peakLocalM, demGroundM: p.stagePeakM, demPeakWithin200mM: p.stagePeakM })),
    tiles,
  };
  const check = validateTerrainManifest(manifest, { decoded: decoded.byteLength });
  if (!check.ok) throw new Error(`assembled stage rejected: ${check.errors.slice(0, 3).join('; ')}`);
  return { manifest, decoded, placed };
}

/** A short stable id for a plan's layout. */
export function stageHash(plan) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (const ch of songRangeKey(plan)) { const c = ch.charCodeAt(0); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}

/**
 * The catalog-shaped view record for a planned stage. It carries `songRange`
 * (the plan and its piece pins) in place of a terrain manifest URL.
 *   sceneCatalog  the scene catalog the song's other views come from (for the
 *                 catalog version)
 */
export function songRangeView(plan, { catalog, sceneCatalog }) {
  const t = stageTemplate(catalog, plan);
  const pieces = plan.slots.map((s) => {
    const p = catalog.pieces.find((x) => x.id === s.pieceId);
    if (!p?.manifestUrl || !/^[a-f0-9]{64}$/.test(p.manifestSha256 || '')) throw new Error(`piece ${s.pieceId} has no pinned package`);
    return { id: p.id, manifestUrl: p.manifestUrl, manifestSha256: p.manifestSha256, name: p.name, place: p.place };
  });
  const material = catalog.materials?.[plan.family];
  if (!material) throw new Error(`no material for family ${plan.family}`);
  const principal = catalog.pieces.find((x) => x.id === plan.principal.pieceId);
  const places = [...new Set(pieces.map((p) => p.place).filter(Boolean))];
  return {
    id: `song-range-${stageHash(plan)}`, regionId: 'song-range-stage', biome: plan.biome,
    // A composed range is an experiment the song itself selected.
    status: 'candidate', experimental: true, catalogVersion: sceneCatalog.catalogVersion,
    title: `${plan.principal.name} range`, place: `Composed range: ${places.join('; ')}`,
    credit: `Elevation: USGS 3DEP 1/3 arc-second DEM; composed range of measured massifs from ${places.join('; ')}`,
    materialManifestUrl: material.manifestUrl, materialManifestSha256: material.manifestSha256, materialRules: {},
    camera: { ...t.camera }, characterScores: { ...principal.characterScores },
    evidence: { reviewPath: 'docs/superpowers/specs/2026-11-10-song-range-composition-design.md', review: null, approval: null,
      sourceHashes: pieces.map((p) => p.manifestSha256) },
    songRange: { version: plan.version, key: songRangeKey(plan), plan, pieces },
  };
}

export { songRangeViewErrors } from '../terrain/SongRangeView.js';

const stageCache = new Map();
/**
 * Fetch, verify and assemble a song range view's terrain. Cached per stage id
 * (the two most recent stages), so the song terrain step can validate a
 * stage early and the scene reuses the result.
 *   loadPackage  RangeAssets.loadTerrainPackage (passed in, not imported)
 *   sha256Hex    RangeAssets.sha256Hex
 * Resolves { manifest, data, bytes, identity, timings }.
 */
export function loadSongRangeStage(view, { catalog, baseUrl, fetchImpl, signal = null, loadPackage, sha256Hex }) {
  const hit = stageCache.get(view.id);
  if (hit) return hit;
  const promise = (async () => {
    const t0 = globalThis.performance?.now?.() ?? Date.now();
    const loaded = await Promise.all(view.songRange.pieces.map((p) => loadPackage(new URL(p.manifestUrl, baseUrl).href,
      { signal, fetchImpl, expectManifestSha256: p.manifestSha256 })));
    const t1 = globalThis.performance?.now?.() ?? Date.now();
    const blocks = new Map(loaded.map((pkg) => [pkg.manifest.piece?.id, pieceBlock(pkg.data)]));
    const { manifest, decoded } = assembleStage(view.songRange.plan, blocks, { catalog, id: view.id });
    const decodedSha256 = await sha256Hex(decoded);
    manifest.payload.decodedSha256 = decodedSha256;
    const data = decodeTerrain(manifest, decoded);
    const t2 = globalThis.performance?.now?.() ?? Date.now();
    return { manifest, data, bytes: { compressed: loaded.reduce((n, p) => n + p.bytes.compressed, 0), decoded: decoded.byteLength },
      identity: { payloadSha256: null, decodedSha256 }, timings: { downloadMs: t1 - t0, assembleMs: t2 - t1 } };
  })();
  stageCache.set(view.id, promise);
  while (stageCache.size > 2) stageCache.delete(stageCache.keys().next().value);
  promise.catch(() => { if (stageCache.get(view.id) === promise) stageCache.delete(view.id); });
  return promise;
}
