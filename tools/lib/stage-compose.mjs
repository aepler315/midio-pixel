// Compose a song range stage from massif pieces (song range composition,
// Phase 1). Offline only. The result is shaped like readDemGrid's output so the
// existing baker (tools/lib/terrain-bake.mjs) consumes it unchanged.
//
// Stage height = floor + piece relief. The floor is the only invented ground:
// a level lake wherever the template's lake reaches (pieces may stand in it and
// rise straight out of the water), and land that rises from its shore at a
// constant gradient (stage-templates.json `floor`). Land is never level, because the baker
// treats any 3 x 3 patch within 0.35 m as water (waterMask). Pieces are
// tile-aligned blocks with zero relief on their outline, so they meet the floor
// exactly wherever they are placed.
import { createHash } from 'node:crypto';
import { cameraRailErrors } from '../../src/world/terrain/SceneTravel.js';
import { TILE_CELLS, mirrorX } from './massif-cut.mjs';

/** Problems with a stage template (empty = ok). */
export function templateErrors(t) {
  const errors = [];
  const g = t?.grid;
  if (!g || !Number.isInteger(g.width) || !Number.isInteger(g.height) || !(g.cellSizeM > 0)) return ['grid'];
  if ((g.width - 1) % TILE_CELLS || (g.height - 1) % TILE_CELLS) errors.push('grid must be whole tiles');
  const tilesX = (g.width - 1) / TILE_CELLS, tilesZ = (g.height - 1) / TILE_CELLS;
  if (!Array.isArray(t.families) || !t.families.length) errors.push('families');
  const ids = new Set();
  for (const s of t.slots || []) {
    const [ix, iz, w, d] = s.tiles || [];
    if (ids.has(s.id)) errors.push(`slot ${s.id} repeated`);
    ids.add(s.id);
    if (![ix, iz, w, d].every(Number.isInteger) || w < 1 || d < 1 || ix < 0 || iz < 0 || ix + w > tilesX || iz + d > tilesZ) {
      errors.push(`slot ${s.id} outside the grid`);
    }
    if (!['horizon', 'back', 'front'].includes(s.row)) errors.push(`slot ${s.id} row`);
  }
  const slots = t.slots || [];
  for (let a = 0; a < slots.length; a++) for (let b = a + 1; b < slots.length; b++) {
    const [ax, az, aw, ad] = slots[a].tiles, [bx, bz, bw, bd] = slots[b].tiles;
    if (ax < bx + bw && bx < ax + aw && az < bz + bd && bz < az + ad) errors.push(`slots ${slots[a].id} and ${slots[b].id} overlap`);
  }
  if (!ids.has(t.principalSlot)) errors.push('principalSlot');
  const lake = t.lake;
  if (!lake || !Number.isFinite(lake.levelM) || !(lake.radiiM?.[0] > 0 && lake.radiiM?.[1] > 0)) errors.push('lake');
  if (!(t.floor?.slope > 0) || !(t.floor?.shoreRiseM >= 0)) errors.push('floor');
  return errors;
}

export function inLake(t, x, z) {
  const [cx, cz] = t.lake.centerM, [rx, rz] = t.lake.radiiM;
  return ((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2 <= 1;
}

/**
 * The stage floor: lake cells at the lake level; land at
 * level + shoreRise + slope * (distance to the lake). Distance is a two-pass
 * chamfer transform with weights 1 and sqrt(2) cells. Returns
 * { heightsM: Float32Array, lake: Uint8Array }.
 */
export function stageFloor(t) {
  const { width: W, height: H, cellSizeM: c, originM } = t.grid;
  const lake = new Uint8Array(W * H);
  const dist = new Float64Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    lake[k] = inLake(t, originM[0] + i * c, originM[1] + j * c) ? 1 : 0;
    dist[k] = lake[k] ? 0 : Infinity;
  }
  const D = Math.SQRT2;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    if (!dist[k]) continue;
    let d = dist[k];
    if (i > 0) d = Math.min(d, dist[k - 1] + 1);
    if (j > 0) { d = Math.min(d, dist[k - W] + 1); if (i > 0) d = Math.min(d, dist[k - W - 1] + D); if (i < W - 1) d = Math.min(d, dist[k - W + 1] + D); }
    dist[k] = d;
  }
  for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
    const k = j * W + i;
    if (!dist[k]) continue;
    let d = dist[k];
    if (i < W - 1) d = Math.min(d, dist[k + 1] + 1);
    if (j < H - 1) { d = Math.min(d, dist[k + W] + 1); if (i < W - 1) d = Math.min(d, dist[k + W + 1] + D); if (i > 0) d = Math.min(d, dist[k + W - 1] + D); }
    dist[k] = d;
  }
  const heightsM = new Float32Array(W * H);
  const { levelM } = t.lake, { shoreRiseM, slope } = t.floor;
  for (let k = 0; k < W * H; k++) heightsM[k] = lake[k] ? levelM : levelM + shoreRiseM + slope * dist[k] * c;
  return { heightsM, lake };
}

function sampleFloor(t, floor, [x, z]) {
  const { width: W, height: H, cellSizeM: c, originM } = t.grid;
  const i = Math.max(0, Math.min(W - 1, Math.round((x - originM[0]) / c)));
  const j = Math.max(0, Math.min(H - 1, Math.round((z - originM[1]) / c)));
  return floor.heightsM[j * W + i];
}

/** The template's camera rail in local metres, heights above the floor. */
export function stageCamera(t, floor) {
  const at = (p) => [p.xzM[0], Math.round((sampleFloor(t, floor, p.xzM) + p.aboveFloorM) * 10) / 10, p.xzM[1]];
  const cam = t.camera;
  const camera = { eyeStartM: at(cam.eyeStart), eyeEndM: at(cam.eyeEnd), targetStartM: at(cam.targetStart),
    targetEndM: at(cam.targetEnd), fovYDeg: cam.fovYDeg };
  const errors = cameraRailErrors(camera);
  if (errors.length) throw new Error(`${t.id}: ${errors.join('; ')}`);
  return camera;
}

/** Tile offset that centres a piece of [w, d] tiles in a slot, or null if
 *  it does not fit. */
export function placeInSlot(slot, [w, d]) {
  const [ix, iz, sw, sd] = slot.tiles;
  if (w > sw || d > sd) return null;
  return [ix + Math.floor((sw - w) / 2), iz + Math.floor((sd - d) / 2)];
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Compose a stage. placements: [{ slotId, piece, mirrored }], where piece is
 * a cutMassif piece (relief in its facing frame). Returns a readDemGrid-shaped
 * grid plus `placed` records. Throws on an unknown slot, a slot used twice or
 * a piece that does not fit its slot.
 */
export function composeStage(t, placements, { floor = stageFloor(t) } = {}) {
  const errors = templateErrors(t);
  if (errors.length) throw new Error(`${t.id}: ${errors.join('; ')}`);
  const { width: W, height: H, cellSizeM: c, originM } = t.grid;
  const heightsM = Float32Array.from(floor.heightsM);
  const used = new Set();
  const placed = [];
  for (const p of placements) {
    const slot = t.slots.find((s) => s.id === p.slotId);
    if (!slot) throw new Error(`${t.id}: no slot ${p.slotId}`);
    if (used.has(slot.id)) throw new Error(`${t.id}: slot ${slot.id} used twice`);
    used.add(slot.id);
    const pc = p.piece;
    if (pc.cellSizeM !== c) throw new Error(`${pc.id || pc.name}: cell ${pc.cellSizeM} m on a ${c} m stage`);
    const at = placeInSlot(slot, pc.tiles);
    if (!at) throw new Error(`${pc.id || pc.name}: ${pc.tiles.join('x')} tiles do not fit slot ${slot.id}`);
    const relief = p.mirrored ? mirrorX(pc.relief, pc.width, pc.height) : pc.relief;
    const i0 = at[0] * TILE_CELLS, j0 = at[1] * TILE_CELLS;
    let peak = -1, peakR = -Infinity;
    for (let y = 0; y < pc.height; y++) for (let x = 0; x < pc.width; x++) {
      const r = relief[y * pc.width + x];
      if (!r) continue;
      const k = (j0 + y) * W + (i0 + x);
      heightsM[k] += r;
      if (r > peakR) { peakR = r; peak = k; }
    }
    const pi = peak % W, pj = (peak - pi) / W;
    placed.push({ slotId: slot.id, row: slot.row, pieceId: pc.id || null, name: pc.name, mirrored: !!p.mirrored,
      tileOrigin: at, tiles: [...pc.tiles], peakLocalM: [originM[0] + pi * c, originM[1] + pj * c],
      floorAtPeakM: floor.heightsM[peak], peakReliefM: peakR, stagePeakM: heightsM[peak] });
  }
  const valid = new Uint8Array(W * H).fill(1);
  const bytes = Buffer.from(heightsM.buffer, heightsM.byteOffset, heightsM.byteLength);
  return {
    width: W, height: H, cellSizeM: c, originM: [...originM], heightsM, valid,
    centerLonLat: null, upsampled: false,
    horizontalCrs: 'Local stage metres; composed pieces carry their own source CRS',
    verticalReference: 'Stage floor plus measured relief above each piece base (metres)',
    sourceResolutionM: c, outputSpacingM: c,
    meta: { payload: { heights: { sha256: sha256(bytes), byteLength: bytes.byteLength } } },
    lake: floor.lake, placed,
  };
}
