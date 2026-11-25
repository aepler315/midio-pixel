// Runtime assembly of a song's composed mountain range (song range
// composition, Phase 3). A plan (SongRangePlan.js) names a stage template and
// the massif piece in each slot; this module turns the template floor
// (StageFloor.js) and the decoded piece packages into an ordinary
// `midio.terrain` manifest plus decoded payload bytes, which go through the
// same validateTerrainManifest/decodeTerrain path as every catalog view.
//
// Tile by tile, never a whole-grid array: each 64-cell tile's 65 x 65 heights
// are the floor plus the relief of the (at most one) piece block covering it.
// Per tile it then measures the triangulation error of every stride and picks
// a stride per quality budget with the baker's rail-only rule (TerrainTiles.js)
// against the template's camera rail. Occlusion is not tested and every tile
// is kept, so the stage has no holes: more tiles than a baked view, never
// fewer, and no RiseGround backdrop is needed.
// Inland stages use a sampled height field throughout the expanded grid,
// with a finer core and coarser surroundings that do not depend on the rail.
//
// Hydrology: on lake stages a piece sample keeps its own package's flow byte
// (its own water, such as a caldera lake); floor samples are water inside the
// lake and dry land outside it. Inland stages build one regional landform
// (InlandRegion.js): its drainage network supplies the rivers and the flow
// byte, and the measured massifs stand on its ranges.
import { TERRAIN_SCHEMA, TERRAIN_VERSION, STRIDES, WATER_FLOW, INLAND_RIVER_FLOW, INLAND_MAX_DRY_FLOW, INLAND_SURFACE_STRIDE,
  validateTerrainManifest } from './TerrainPackage.js';
import { TILE_CELLS, LOD_BUDGETS, VISIBILITY, FRAMINGS, SHORE_MAX_STRIDE, tileStrideError, encodeResiduals, splitPlanes, quantizationFor } from './TerrainTiles.js';
import { decodeTerrain, tileMeshShape } from './TerrainMesh.js';
import { cameraPoseAt, boxMayBeVisible, viewDepthToBox, focalPx, projectPoint, cameraRailErrors } from '../terrain/SceneTravel.js';
import { stageFloorHeight, inStageLake, slotOrigin } from '../terrain/StageFloor.js';
import { inlandRegionSteps, regionAnchors } from '../terrain/InlandRegion.js';
import { bakeRiverBankAtlasSteps } from '../terrain/RiverBankAtlas.js';
import { songRangeKey, songReliefJitter } from '../terrain/SongRangePlan.js';
import { SLOT_RISE_SLOTS } from './LandRise.js';
import { finishPreparation, prepareInSlices } from './PreparationSteps.js';
import { settingValue } from '../../config/appSettings.js';

export const STAGE_KIND = 'song-range-stage';
export const PIECE_KIND = 'massif-piece';
const BANDS = Object.freeze({ nearM: 1800, midM: 7000 });
import { INLAND_PAD_LOW, INLAND_PAD_HIGH } from '../terrain/MeasuredRange.js';
export { INLAND_SURFACE_STRIDE };

// Before the region exists, the template rail is lifted by a conservative
// allowance; RangeLibrary re-seats it on the assembled ground.
const INLAND_RAIL_LIFT_M = 2600;
function inlandTemplate(t, field, baseM) {
  const { width, height, cellSizeM, originM } = t.grid;
  const extraCells = (INLAND_PAD_LOW + INLAND_PAD_HIGH) * TILE_CELLS;
  const offsetM = INLAND_PAD_LOW * TILE_CELLS * cellSizeM;
  const camera = { ...t.camera };
  for (const name of ['eyeStartM', 'eyeEndM', 'targetStartM', 'targetEndM']) {
    const [x, y, z] = camera[name];
    camera[name] = [x, y + INLAND_RAIL_LIFT_M, z];
  }
  const slots = t.slots.map(s => {
    const [x, z, w, h] = s.tiles;
    return { ...s, tiles: [x + INLAND_PAD_LOW, z + INLAND_PAD_LOW, w, h] };
  });
  return { ...t, camera, slots, grid: { width: width + extraCells, height: height + extraCells,
    cellSizeM, originM: originM.map(value => value - offsetM) } };
}

/** Inland geometry: valley corridors where the camera flies low keep the
 * finest samples, hillsides of the travelling area a middle grid, and the
 * exterior one continuous coarse ground. Measured massifs keep their native
 * lattice with fewer samples retained for the mobile mesh. */
function inlandTileLod(ix, iz, tilesX, tilesZ, own, corridor, forceStride) {
  if (forceStride) return { desktop: forceStride, mobile: forceStride };
  const outside = Math.max(INLAND_PAD_LOW - ix, INLAND_PAD_LOW - iz,
    ix - tilesX + INLAND_PAD_HIGH + 1, iz - tilesZ + INLAND_PAD_HIGH + 1, 0);
  if (own) return { desktop: 2, mobile: 4 };
  if (corridor === 3 && outside <= 1) return { desktop: 1, mobile: 2 };
  if (corridor >= 2 && outside <= 1) return { desktop: 2, mobile: 4 };
  if (corridor && outside <= 3) return { desktop: 4, mobile: 8 };
  const desktop = outside <= 1 ? 4 : outside <= 6 ? 16 : 32;
  return { desktop, mobile: Math.min(32, desktop * 2), ...(outside <= 6 ? { store: INLAND_SURFACE_STRIDE } : {}) };
}

/** The measured massifs as the region sees them: where each stands and how
 *  large its footprint is, from the catalog alone (no package needed). */
export function inlandMassifs(plan, catalog, t = stageTemplate(catalog, plan)) {
  const { cellSizeM: c, originM } = t.grid;
  const tileM = TILE_CELLS * c;
  return plan.slots.map((s) => {
    const slot = t.slots.find((x) => x.id === s.slotId);
    const piece = catalog.pieces.find((x) => x.id === s.pieceId);
    const at = slot && piece && slotOrigin(slot, piece.tiles);
    if (!at) return null;
    return { slotId: s.slotId, x: originM[0] + (at[0] + piece.tiles[0] / 2) * tileM, z: originM[1] + (at[1] + piece.tiles[1] / 2) * tileM,
      radiusM: .5 * Math.max(...piece.tiles) * tileM * .85, weight: s.slotId === plan.principal?.slotId ? 1 : .7 };
  }).filter(Boolean);
}

/** The region generator for a stage, centred on its grid. */
function inlandRegionFor(plan, t, baseM, catalog) {
  const { width: W, height: H, cellSizeM: c, originM } = t.grid;
  const centre = [originM[0] + (W - 1) * c / 2, originM[1] + (H - 1) * c / 2];
  const massifs = inlandMassifs(plan, catalog, t).map((m) => ({ ...m, x: m.x - centre[0], z: m.z - centre[1] }));
  return { centre, steps: inlandRegionSteps(plan.inland, baseM, { halfM: (W - 1) * c / 2, massifs }) };
}

/**
 * A composed range's finale: its massifs' relief is stretched vertically
 * until, from the template's rail, the tallest-looking peak reaches
 * `targetY` of the frame (normalized device y; the horizon sits near -0.12
 * and the measured pieces stop near 0). Scale 1 keeps the measured relief;
 * the floor and the lake never move. `maxScale` keeps a steppe of hills from
 * turning into needles.
 */
export const STAGE_RELIEF = Object.freeze({ targetY: 0.4, maxScale: 3, aspect: 16 / 9 });

/** Diagnostic `?rangeRelief=<scale>`: a fixed relief scale (1 = measured) for
 *  review captures, in place of the framing rule. Null when absent or invalid. */
export function reliefScaleFrom(search) {
  return settingValue('rangeRelief', search);
}

/**
 * The relief scale that brings a stage's tallest-looking peak to
 * STAGE_RELIEF.targetY, seen from the template rail: for each rail station
 * the highest projected in-frame peak, the median over stations. Peaks are
 * [{ x, z, floorM, reliefM }]. Rounded to hundredths, so a stage's scale is a
 * stable function of its plan.
 */
export function stageReliefScale(template, peaks, { targetY = STAGE_RELIEF.targetY, maxScale = STAGE_RELIEF.maxScale, aspect = STAGE_RELIEF.aspect } = {}) {
  const stations = Array.from({ length: VISIBILITY.stations }, (_, k) => cameraPoseAt({ camera: template.camera }, k / (VISIBILITY.stations - 1)));
  const lookAt = (scale) => {
    const tops = stations.map((pose) => {
      let top = -Infinity;
      for (const p of peaks) {
        const q = projectPoint(pose, aspect, [p.x, p.floorM + scale * p.reliefM, p.z]);
        if (q && Math.abs(q.x) <= 1 && q.y > top) top = q.y;
      }
      return top;
    }).sort((a, b) => a - b);
    return tops[Math.floor(tops.length / 2)];
  };
  if (!peaks.length || !(lookAt(1) < targetY)) return 1;
  if (!(lookAt(maxScale) > targetY)) return maxScale;
  let lo = 1, hi = maxScale;
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (lookAt(mid) < targetY) lo = mid; else hi = mid; }
  return Math.round(hi * 100) / 100;
}

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
  const original = catalog.templates.find((x) => x.id === plan.templateId);
  if (!original) throw new Error(`no stage template ${plan.templateId}`);
  const t = plan.inland ? inlandTemplate(original, plan.inland, plan.baseM ?? original.lake.levelM) : original;
  if (plan.slots[0]?.tiles) {
    t.slots = plan.slots.map(s => ({ ...original.slots.find(slot => slot.id === s.slotId), tiles: s.tiles }));
  }
  if (!plan.camera && !plan.slotOffsets) return t;
  if (plan.camera) {
    const errors = cameraRailErrors(plan.camera);
    if (errors.length) throw new Error(`invalid stage camera: ${errors.join('; ')}`);
  }
  const offsets = plan.slotOffsets || {};
  for (const [id, offset] of Object.entries(offsets)) {
    if (!t.slots.some(s => s.id === id) || !Array.isArray(offset) || offset.length !== 2 || !offset.every(Number.isInteger))
      throw new Error(`invalid stage slot offset: ${id}`);
  }
  const slots = t.slots.map(s => {
    if (!offsets[s.id]) return s;
    const tiles = [...s.tiles];
    tiles[0] += offsets[s.id][0]; tiles[1] += offsets[s.id][1];
    if (tiles[0] < 0 || tiles[1] < 0 || tiles[0] + tiles[2] > (t.grid.width - 1) / TILE_CELLS
      || tiles[1] + tiles[3] > (t.grid.height - 1) / TILE_CELLS) throw new Error(`stage slot outside grid: ${s.id}`);
    return { ...s, tiles };
  });
  return { ...t, camera: plan.camera || t.camera, slots };
}

/** A stage's slots for the song's rise (song range composition, Phase 4):
 *  { slots: [{ slotId, row }], principal, companion? }, from the plan and its template. */
export function stageRiseSlots(plan, catalog) {
  const t = stageTemplate(catalog, plan);
  return {
    slots: plan.slots.map((s) => ({ slotId: s.slotId, row: t.slots.find((x) => x.id === s.slotId)?.row ?? null })),
    principal: plan.principal?.slotId ?? null,
    ...(plan.inland ? { inland: true } : {}),
    ...(plan.companionSlot ? { companion: plan.companionSlot } : {}),
  };
}

/**
 * Which slot owns each stage tile, for the per-slot rise in the shaders:
 *   { tilesX, tilesZ, originM, tileM, slotIds, owners }
 * `owners[iz * tilesX + ix]` is an index into `slotIds`, whose entry 0 is
 * 'floor' (tiles no piece block covers). A block covers its whole tile
 * rectangle, zero-relief ring included, exactly as assembleStage places it,
 * from the catalog's piece footprints alone (no package needed).
 */
export function stageSlotOwners(plan, catalog) {
  const t = stageTemplate(catalog, plan);
  const { width: W, height: H, cellSizeM: c, originM } = t.grid;
  const tilesX = (W - 1) / TILE_CELLS, tilesZ = (H - 1) / TILE_CELLS;
  const slotIds = ['floor'], owners = new Uint8Array(tilesX * tilesZ);
  for (const s of plan.slots) {
    const slot = t.slots.find((x) => x.id === s.slotId);
    const piece = catalog.pieces.find((x) => x.id === s.pieceId);
    if (!slot || !piece) throw new Error(`slot ${s.slotId} or piece ${s.pieceId} missing`);
    const at = slotOrigin(slot, piece.tiles);
    if (!at) throw new Error(`${s.pieceId} does not fit slot ${s.slotId}`);
    const index = slotIds.push(s.slotId) - 1;
    for (let dz = 0; dz < piece.tiles[1]; dz++) for (let dx = 0; dx < piece.tiles[0]; dx++) {
      const k = (at[1] + dz) * tilesX + at[0] + dx;
      if (owners[k]) throw new Error(`slots ${slotIds[owners[k]]} and ${s.slotId} overlap`);
      owners[k] = index;
    }
  }
  if (slotIds.length > SLOT_RISE_SLOTS) throw new Error(`${t.id}: ${slotIds.length - 1} slots, the rise addresses ${SLOT_RISE_SLOTS - 1}`);
  return { tilesX, tilesZ, originM: [...originM], tileM: TILE_CELLS * c, slotIds, owners };
}

/**
 * Assemble a stage. Pure and synchronous.
 *   plan     planSongRange result
 *   blocks   Map pieceId -> pieceBlock(...)
 *   options  { catalog, id, forceStride, landmarks }
 * Returns { manifest, decoded (Uint8Array), placed }.
 */
export function assembleStage(plan, blocks, options) {
  return finishPreparation(assembleStageSteps(plan, blocks, options));
}

function* assembleStageSteps(plan, blocks, { catalog, id = `song-range-${stageHash(plan)}`, forceStride = null, reliefScale = 1 } = {}) {
  const t = stageTemplate(catalog, plan);
  const inland = plan.inland;
  const baseM = plan.baseM ?? t.lake.levelM;
  let region = null, centre = [0, 0];
  if (inland) {
    const built = inlandRegionFor(plan, t, baseM, catalog);
    centre = built.centre;
    region = yield* built.steps;
  }
  const regionSample = {};
  const sampleRegion = (x, z) => region.sample(x - centre[0], z - centre[1], regionSample);
  const floorAt = inland ? (x, z) => sampleRegion(x, z).heightM : (x, z) => stageFloorHeight(t, x, z);
  const { width: W, height: H, cellSizeM: c, originM } = t.grid;
  const cells = TILE_CELLS;
  const tilesX = (W - 1) / cells, tilesZ = (H - 1) / cells;
  if (!Number.isInteger(tilesX) || !Number.isInteger(tilesZ)) throw new Error(`${t.id}: grid is not whole tiles`);
  // A ledge is often shorter than one 40–80 m mobile triangle. Keep both
  // elevations of the drop on the native lattice in the affected tiles.
  const fallTiles = new Map(), tileM = cells * c;
  for (const river of region?.rivers ?? []) for (const f of river.falls ?? []) {
    const pad = .5 * f.widthM + c;
    const left = Math.max(0, Math.floor((Math.min(f.x, f.footX) + centre[0] - pad - originM[0]) / tileM));
    const right = Math.min(tilesX - 1, Math.floor((Math.max(f.x, f.footX) + centre[0] + pad - originM[0]) / tileM));
    const top = Math.max(0, Math.floor((Math.min(f.z, f.footZ) + centre[1] - pad - originM[1]) / tileM));
    const bottom = Math.min(tilesZ - 1, Math.floor((Math.max(f.z, f.footZ) + centre[1] + pad - originM[1]) / tileM));
    for (let iz = top; iz <= bottom; iz++) for (let ix = left; ix <= right; ix++) {
      const x0 = ix * tileM + originM[0] - centre[0], z0 = iz * tileM + originM[1] - centre[1], key = iz * tilesX + ix;
      const detail = [Math.max(0, Math.floor((Math.min(f.x, f.footX) - pad - x0) / c)),
        Math.max(0, Math.floor((Math.min(f.z, f.footZ) - pad - z0) / c)),
        Math.min(cells, Math.ceil((Math.max(f.x, f.footX) + pad - x0) / c)),
        Math.min(cells, Math.ceil((Math.max(f.z, f.footZ) + pad - z0) / c))];
      if (!fallTiles.has(key)) fallTiles.set(key, []);
      fallTiles.get(key).push(detail);
    }
  }
  // Which piece block covers each stage tile (slots never overlap).
  const owner = new Array(tilesX * tilesZ).fill(null);
  const placed = [];
  let maxRelief = 0;
  for (const s of plan.slots) {
    const slot = t.slots.find((x) => x.id === s.slotId);
    let block = blocks.get(s.pieceId);
    if (!slot || !block) throw new Error(`${id}: slot ${s.slotId} or piece ${s.pieceId} missing`);
    if (s.mirrored) block = mirrored(block);
    const slotScale = s.reliefScale ?? 1;
    if (!Number.isFinite(slotScale) || slotScale < .92 || slotScale > 1.08) throw new Error(`invalid relief for slot ${s.slotId}`);
    const at = slotOrigin(slot, block.tiles);
    if (!at) throw new Error(`${s.pieceId} does not fit slot ${s.slotId}`);
    for (let dz = 0; dz < block.tiles[1]; dz++) for (let dx = 0; dx < block.tiles[0]; dx++) {
      const k = (at[1] + dz) * tilesX + at[0] + dx;
      if (owner[k]) throw new Error(`${id}: slots ${owner[k].slotId} and ${s.slotId} overlap`);
      owner[k] = { block, at, slotId: s.slotId, slotScale };
    }
    let peak = 0, pk = 0;
    for (let k = 0; k < block.relief.length; k++) if (block.relief[k] > peak) { peak = block.relief[k]; pk = k; }
    peak *= slotScale;
    maxRelief = Math.max(maxRelief, peak);
    const px = originM[0] + (at[0] * cells + pk % block.width) * c, pz = originM[1] + (at[1] * cells + Math.floor(pk / block.width)) * c;
    placed.push({ slotId: s.slotId, pieceId: s.pieceId, mirrored: !!s.mirrored, tileOrigin: at, peakReliefM: peak,
      ...(s.reliefScale === undefined ? {} : { reliefScale: slotScale }),
      peakLocalM: [px, pz], floorM: floorAt(px, pz) });
    yield;
  }
  // 'frame' scales the relief to the template's framing (stageReliefScale);
  // a number is used as given (1 = measured relief). A planned song carries a
  // seed: its small relief variation keeps two otherwise identical layouts
  // from standing in byte-for-byte identical terrain. Pilots keep measured
  // relief so offline bake comparisons stay exact.
  const framed = reliefScale === 'frame'
    ? stageReliefScale(t, placed.map((p) => ({ x: p.peakLocalM[0], z: p.peakLocalM[1], floorM: p.floorM, reliefM: p.peakReliefM })))
    : Number.isFinite(reliefScale) && reliefScale > 0 ? reliefScale : 1;
  const scale = framed * songReliefJitter(plan.songSeed);
  for (const p of placed) { p.peakReliefM *= scale; p.stagePeakM = p.floorM + p.peakReliefM; delete p.floorM; }
  maxRelief *= scale;
  // Shared quantization keeps height samples identical along tile joins.
  // The lake floor peaks at a grid corner; the inland field has global bounds.
  const floorBounds = inland ? region.boundsM : [
    t.lake.levelM,
    Math.max(...[[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]].map(([i, j]) => floorAt(originM[0] + i * c, originM[1] + j * c))),
  ];
  const { offsetM, stepM } = quantizationFor(floorBounds[0], floorBounds[1] + maxRelief);
  const quant = (v) => Math.max(1, Math.min(65535, Math.round((v - offsetM) / stepM)));
  // Rail stations and lenses, exactly as a rail-only bake sees them.
  const view = { camera: t.camera };
  const stations = inland ? [] : Array.from({ length: VISIBILITY.stations }, (_, k) => cameraPoseAt(view, k / (VISIBILITY.stations - 1)));
  const [eyeX, , eyeZ] = t.camera.eyeStartM;
  const lodFovYDeg = plan.lodFovYDeg ?? t.camera.fovYDeg;
  if (!(Number.isFinite(lodFovYDeg) && lodFovYDeg > 0 && lodFovYDeg <= t.camera.fovYDeg)) throw new Error(`${id}: invalid stage LOD field of view`);
  const focal = Object.fromEntries(Object.entries(LOD_BUDGETS).map(([k, b]) => [k, focalPx(lodFovYDeg, b.heightPx)]));
  const scratchCount = (cells + 1) ** 2, valid = new Uint8Array(scratchCount).fill(1);
  const h = new Float32Array(scratchCount), fl = new Uint8Array(scratchCount);
  const chunks = [];
  let byteOffset = 0;
  const push = (buf) => { const at = byteOffset; chunks.push(buf); byteOffset += buf.byteLength; return at; };
  const tiles = [];
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const achieved = Object.fromEntries(Object.keys(LOD_BUDGETS).map((k) => [k, 0]));
  for (let iz = 0; iz < tilesZ; iz++) for (let ix = 0; ix < tilesX; ix++) {
    const own = owner[iz * tilesX + ix];
    const pieceScale = scale * (own?.slotScale ?? 1);
    const tx0 = originM[0] + ix * cells * c, tz0 = originM[1] + iz * cells * c;
    const corridor = inland ? region.corridor(tx0 - centre[0], tz0 - centre[1], tx0 + cells * c - centre[0], tz0 + cells * c - centre[1]) : 0;
    const inlandLod = inland ? inlandTileLod(ix, iz, tilesX, tilesZ, own, corridor, forceStride) : null;
    const fallDetail = !forceStride && fallTiles.get(iz * tilesX + ix);
    // Inland tiles near the travelled area store samples at the surface
    // atlas spacing even where the mesh draws fewer: rivers and hillside
    // shading come out of the atlas at full detail.
    const sourceStride = inlandLod && !fallDetail ? Math.min(inlandLod.desktop, inlandLod.mobile, inlandLod.store ?? Infinity) : 1;
    const n1 = cells / sourceStride + 1;
    let minY = Infinity, maxY = -Infinity, wet = 0, land = 0;
    for (let v = 0; v < n1; v++) for (let u = 0; u < n1; u++) {
      const gi = ix * cells + u * sourceStride, gj = iz * cells + v * sourceStride;
      const x = originM[0] + gi * c, z = originM[1] + gj * c;
      let r = 0, pf = 0;
      if (own) {
        const bi = gi - own.at[0] * cells, bj = gj - own.at[1] * cells;
        const bk = bj * own.block.width + bi;
        r = own.block.relief[bk] * pieceScale; pf = own.block.flow[bk];
      }
      let y, flow;
      if (inland) {
        const ground = sampleRegion(x, z);
        y = (r > 1 ? ground.heightM : ground.renderHeightM) + r;
        // Measured relief is dry ground: no channel runs over a massif.
        flow = r > 1 ? Math.min(ground.flowByte, INLAND_MAX_DRY_FLOW >> 1) : ground.flowByte;
      } else {
        y = floorAt(x, z) + r;
        flow = r > 0 ? pf : inStageLake(t.lake, x, z) ? WATER_FLOW : 0;
      }
      const k = v * n1 + u;
      h[k] = y;
      fl[k] = flow;
      if (fl[k] === WATER_FLOW) wet++; else land++;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const x0 = originM[0] + ix * cells * c, z0 = originM[1] + iz * cells * c;
    const box = { min: [x0, minY, z0], max: [x0 + cells * c, maxY, z0 + cells * c] };
    const errorsM = {};
    for (const s of STRIDES) if (s >= sourceStride && s <= cells)
      errorsM[s] = tileStrideError(h, valid, n1, n1, 0, 0, n1 - 1, s / sourceStride);
    const reach = Object.fromEntries(FRAMINGS.map((f) => [f, Infinity]));
    for (const pose of stations) for (const f of FRAMINGS) {
      if (!boxMayBeVisible(pose, VISIBILITY[f].aspect, box, VISIBILITY[f].fovScale)) continue;
      const d = Math.max(0, viewDepthToBox(pose, box));
      if (d < reach[f]) reach[f] = d;
    }
    const drawn = inlandLod ? Math.min(inlandLod.desktop, inlandLod.mobile) : 1;
    const framing = inland ? (drawn <= 8 ? 'core' : drawn <= 16 ? 'extended' : null)
      : Number.isFinite(reach.core) ? 'core' : Number.isFinite(reach.extended) ? 'extended' : null;
    const dist = inland
      ? Math.hypot(Math.max(x0 - eyeX, eyeX - box.max[0], 0), Math.max(z0 - eyeZ, eyeZ - box.max[2], 0))
      : framing ? Math.max(VISIBILITY.minDistanceM, reach[framing]) : Infinity;
    const cap = wet && land ? SHORE_MAX_STRIDE : Infinity;
    const lod = inlandLod ? { desktop: inlandLod.desktop, mobile: inlandLod.mobile } : Object.fromEntries(Object.entries(LOD_BUDGETS).map(([k, b]) => {
      if (forceStride) return [k, forceStride];
      if (!framing) return [k, Math.min(cells, cap)];
      let best = 1;
      for (const s of STRIDES) {
        if (s > cells || s > cap) break;
        if (errorsM[s] * focal[k] / dist <= b.errorPx * VISIBILITY[framing].budgetScale) best = s;
      }
      return [k, best];
    }));
    for (const k of Object.keys(lod)) if (!inland && framing === 'core') achieved[k] = Math.max(achieved[k], errorsM[lod[k]] * focal[k] / dist);
    const stride = inland ? sourceStride : Math.min(...Object.values(lod));
    const storeStep = stride / sourceStride;
    const n = cells / stride + 1;
    const q = new Uint16Array(n * n), flow = new Uint8Array(n * n);
    for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) {
      const k = (v * storeStep) * n1 + u * storeStep;
      q[v * n + u] = quant(h[k]);
      flow[v * n + u] = fl[k];
    }
    const residual = splitPlanes(encodeResiduals(q, n));
    const hAt = push(residual), fAt = push(flow);
    tiles.push({
      id: `t${ix}_${iz}`, ix, iz, stride, samples: n, ...(fallDetail ? { fallDetail } : {}),
      heights: { byteOffset: hAt, byteLength: residual.byteLength, count: n * n, type: 'uint16', predictor: 'planar', planes: 'lo-hi' },
      flow: { byteOffset: fAt, byteLength: flow.byteLength, count: n * n, type: 'uint8', water: WATER_FLOW },
      validity: { mode: 'all' }, minY, maxY, visible: true, framing: framing || 'outside',
      closestM: framing ? Math.round(dist) : null,
      band: dist < BANDS.nearM ? 'near' : dist < BANDS.midM ? 'mid' : 'far', lod,
      errorsM: Object.fromEntries(Object.entries(errorsM).filter(([s]) => Number(s) >= stride).map(([s, e]) => [s, Math.round(e * 1000) / 1000])),
    });
    for (let a = 0; a < 3; a++) { bounds.min[a] = Math.min(bounds.min[a], box.min[a]); bounds.max[a] = Math.max(bounds.max[a], box.max[a]); }
    yield;
  }
  let riverBankAtlas;
  if (region) {
    // Use the same scaled DEM relief that keeps water off each placed
    // massif. Bank posts fall between the DEM's 20 m elevation samples.
    const isDryGround = (x, z) => {
      const gx = (x - originM[0]) / c, gz = (z - originM[1]) / c;
      if (gx < 0 || gz < 0 || gx > W - 1 || gz > H - 1) return true;
      const ix = Math.min(tilesX - 1, Math.floor(gx / cells));
      const iz = Math.min(tilesZ - 1, Math.floor(gz / cells));
      const own = owner[iz * tilesX + ix];
      if (!own) return false;
      const { width, height, relief } = own.block;
      const u = gx - own.at[0] * cells, v = gz - own.at[1] * cells;
      const i = Math.min(width - 2, Math.floor(u)), j = Math.min(height - 2, Math.floor(v));
      const k = j * width + i, a = u - i, b = v - j;
      const north = relief[k] + a * (relief[k + 1] - relief[k]);
      const south = relief[k + width] + a * (relief[k + width + 1] - relief[k + width]);
      return (north + b * (south - north)) * scale * own.slotScale > 1;
    };
    const banks = yield* bakeRiverBankAtlasSteps(region.rivers, t.grid, centre, isDryGround);
    if (banks) {
      const { data, pageTable, ...layout } = banks;
      riverBankAtlas = { ...layout, byteOffset: push(data), byteLength: data.byteLength + pageTable.byteLength };
      push(pageTable);
    }
  }
  const decoded = new Uint8Array(byteOffset);
  let at = 0;
  for (const ch of chunks) { decoded.set(ch, at); at += ch.byteLength; }
  const estimate = (budget) => {
    let vertices = 0, triangles = 0;
    for (const tile of tiles) {
      const { cols, rows } = tileMeshShape(tile, cells, tile.lod[budget]);
      vertices += cols * rows; triangles += 2 * (cols - 1) * (rows - 1);
    }
    const stride = inland ? INLAND_SURFACE_STRIDE : 1;
    const texturePixels = ((W - 1) / stride + 1) * ((H - 1) / stride + 1);
    return { vertices, triangles, meshBytes: vertices * 12 + triangles * 3 * 4, surfaceTextureBytes: Math.round(texturePixels * 4 * 4 / 3) };
  };
  const manifest = {
    schema: TERRAIN_SCHEMA, version: TERRAIN_VERSION, kind: STAGE_KIND,
    viewId: id, regionId: 'song-range-stage',
    source: { demSha256: null, provenance: { composition: { songRangeVersion: plan.version, key: songRangeKey(plan), template: t.id, reliefScale: scale,
      ...(inland ? { inland } : {}),
      pieces: placed.map((p) => ({ slotId: p.slotId, pieceId: p.pieceId, mirrored: p.mirrored,
        ...(p.reliefScale === undefined ? {} : { reliefScale: p.reliefScale }) })) } },
    fill: null, horizontalCrs: 'Local stage metres; pieces carry their own source CRS',
    verticalReference: inland ? 'Generated eroded regional landform plus scaled measured relief (metres)'
      : plan.songprintVersion ? 'Stage floor plus measured relief times piece and composition relief scales (metres)'
      : 'Stage floor plus measured relief above each piece base, times composition.reliefScale (metres)', centerLonLat: null,
    sourceResolutionM: c, outputSpacingM: c },
    grid: { width: W, height: H, cellSizeM: c, originM: [...originM] },
    axes: 'X east, Y up, Z south (metres)', tileCells: cells, tilesX, tilesZ,
    quantization: { offsetM, stepM }, boundsM: bounds, bands: { ...BANDS },
    lod: { budgets: LOD_BUDGETS, fovYDeg: lodFovYDeg, visibility: VISIBILITY,
      framings: inland ? 'finest samples along flown valley corridors and measured relief, coarser continuous ground towards all edges'
        : 'assembled at runtime against the template rail without occlusion culling; every tile is kept',
      ...(inland ? {} : { achievedErrorPx: Object.fromEntries(Object.entries(achieved).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) }),
      triangulation: 'quads split along the (0,0)-(1,1) diagonal; finer edges snap to the coarser neighbour' },
    hydrology: inland ? {
      flow: 'Drainage network of the generated regional landform; rivers follow its low ground and join downhill',
      water: 'Inland channels shaded directly on the terrain', riverFlow: INLAND_RIVER_FLOW,
      region: regionAnchors(region, centre),
      ...(riverBankAtlas ? { riverBankAtlas } : {}),
    }
      : { flow: 'each piece keeps its own package flow; floor flow 0', water: 'piece water from its own bake; floor water inside the template lake' },
    payload: { url: null, encoding: 'none', byteLength: decoded.byteLength, sha256: null, decodedByteLength: decoded.byteLength, decodedSha256: null },
    estimatedBytes: { desktop: estimate('desktop'), mobile: estimate('mobile') },
    landmarks: placed.map((p) => ({ name: catalog.pieces.find((x) => x.id === p.pieceId)?.name || p.pieceId, lonLat: null,
      publishedElevationM: null, localM: p.peakLocalM, demGroundM: p.stagePeakM, demPeakWithin200mM: p.stagePeakM })),
    tiles,
  };
  const check = validateTerrainManifest(manifest, { decoded: decoded.byteLength });
  if (!check.ok) throw new Error(`assembled stage rejected: ${check.errors.slice(0, 3).join('; ')}`);
  return { manifest, decoded, placed, reliefScale: scale };
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
    return { id: p.id, manifestUrl: p.manifestUrl, manifestSha256: p.manifestSha256, name: p.name, place: p.place,
      elevation: p.elevation || 'USGS 3DEP 1/3 arc-second DEM' };
  });
  const material = catalog.materials?.[plan.family];
  if (!material) throw new Error(`no material for family ${plan.family}`);
  const principal = catalog.pieces.find((x) => x.id === plan.principal.pieceId);
  const places = [...new Set(pieces.map((p) => p.place).filter(Boolean))];
  const elevations = [...new Set(pieces.map((p) => p.elevation))];
  // The caption names the principal massif and where it really stands, then
  // the ranges the rest of the stage comes from.
  const others = places.filter((x) => x !== principal.place);
  const place = plan.inland ? 'Generated inland terrain' : others.length ? `${principal.place}, with massifs from ${others.join('; ')}` : principal.place;
  return {
    id: `song-range-${stageHash(plan)}`, regionId: 'song-range-stage', biome: plan.biome,
    // A composed range is an experiment the song itself selected.
    status: 'candidate', experimental: true, catalogVersion: sceneCatalog.catalogVersion,
    title: `${plan.principal.name} range`, place,
    credit: plan.inland ? `Generated inland region with measured massifs from ${places.join('; ')}. Elevation: ${elevations.join('; ')}.`
      : `Elevation: ${elevations.join('; ')}; composed range of measured massifs from ${places.join('; ')}`,
    materialManifestUrl: material.manifestUrl, materialManifestSha256: material.manifestSha256, materialRules: {},
    camera: { ...t.camera }, characterScores: { ...principal.characterScores },
    evidence: { reviewPath: 'docs/superpowers/specs/2026-11-10-song-range-composition-design.md', review: null, approval: null,
      sourceHashes: pieces.map((p) => p.manifestSha256) },
    songRange: { version: plan.version, key: songRangeKey(plan), plan, pieces },
  };
}

export { songRangeViewErrors } from '../terrain/SongRangeView.js';

function* loadedStageSteps(plan, loaded, options) {
  const blocks = new Map();
  for (const pkg of loaded) {
    blocks.set(pkg.manifest.piece?.id, pieceBlock(pkg.data));
    yield;
  }
  return yield* assembleStageSteps(plan, blocks, options);
}

const stageCache = new Map();
/**
 * Fetch, verify and assemble a song range view's terrain. Cached per stage id
 * (the two most recent stages), so the song terrain step can validate a
 * stage early and the scene reuses the result.
 *   loadPackage  RangeAssets.loadTerrainPackage (passed in, not imported)
 *   sha256Hex    RangeAssets.sha256Hex
 * Resolves { manifest, data, bytes, identity, timings }.
 */
export function loadSongRangeStage(view, { catalog, baseUrl, fetchImpl, signal = null, loadPackage, sha256Hex, reliefScale = undefined }) {
  const hit = stageCache.get(view.id);
  if (hit) return hit;
  const promise = (async () => {
    const t0 = globalThis.performance?.now?.() ?? Date.now();
    const loaded = await Promise.all([...new Map(view.songRange.pieces.map(p => [p.id, p])).values()].map((p) => loadPackage(new URL(p.manifestUrl, baseUrl).href,
      { signal, fetchImpl, expectManifestSha256: p.manifestSha256 })));
    const t1 = globalThis.performance?.now?.() ?? Date.now();
    const { plan } = view.songRange;
    // A song's range ends looming over the lake (stageReliefScale). A pilot
    // layout keeps its measured relief, to compare with its offline bake.
    // An inland region keeps its measured relief on its own ranges.
    const scale = reliefScale ?? reliefScaleFrom() ?? (plan.pilot || plan.inland ? 1 : 'frame');
    const steps = loadedStageSteps(plan, loaded, { catalog, id: view.id, reliefScale: scale });
    // Inland regions are long builds: leave room for frames between slices.
    const { manifest, decoded } = plan.inland ? await prepareInSlices(steps, { signal }) : finishPreparation(steps);
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
