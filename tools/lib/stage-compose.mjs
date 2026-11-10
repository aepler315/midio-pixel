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
import { inStageLake, stageFloorHeight, slotOrigin } from '../../src/world/terrain/StageFloor.js';

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
    if (s.reliefM != null && !(Array.isArray(s.reliefM) && s.reliefM.length === 2 && Number.isFinite(s.reliefM[0])
      && (s.reliefM[1] === null || s.reliefM[1] > s.reliefM[0]))) errors.push(`slot ${s.id} reliefM`);
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
  return inStageLake(t.lake, x, z);
}

/**
 * The stage floor sampled on the template grid (StageFloor.js): lake cells at
 * the lake level; land at level + shoreRise + slope * (exact distance to the
 * lake). Returns { heightsM: Float32Array, lake: Uint8Array }.
 */
export function stageFloor(t) {
  const { width: W, height: H, cellSizeM: c, originM } = t.grid;
  const lake = new Uint8Array(W * H);
  const heightsM = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, x = originM[0] + i * c, z = originM[1] + j * c;
    lake[k] = inStageLake(t.lake, x, z) ? 1 : 0;
    heightsM[k] = stageFloorHeight(t, x, z);
  }
  return { heightsM, lake };
}

/** The template's camera rail in local metres, heights above the floor. */
export function stageCamera(t) {
  const at = (p) => [p.xzM[0], Math.round((stageFloorHeight(t, p.xzM[0], p.xzM[1]) + p.aboveFloorM) * 10) / 10, p.xzM[1]];
  const cam = t.camera;
  const camera = { eyeStartM: at(cam.eyeStart), eyeEndM: at(cam.eyeEnd), targetStartM: at(cam.targetStart),
    targetEndM: at(cam.targetEnd), fovYDeg: cam.fovYDeg };
  const errors = cameraRailErrors(camera);
  if (errors.length) throw new Error(`${t.id}: ${errors.join('; ')}`);
  return camera;
}

/** Tile offset that centres a piece of [w, d] tiles in a slot, or null if
 *  it does not fit (StageFloor.js slotOrigin, shared with the runtime). */
export const placeInSlot = slotOrigin;

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
