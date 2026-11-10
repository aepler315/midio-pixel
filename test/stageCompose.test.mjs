import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TILE_CELLS } from '../tools/lib/massif-cut.mjs';
import { templateErrors, stageFloor, stageCamera, composeStage, placeInSlot } from '../tools/lib/stage-compose.mjs';
import { waterMask, validateDemGrid } from '../tools/lib/terrain-bake.mjs';

const templates = JSON.parse(fs.readFileSync(new URL('../data/terrain/stage-templates.json', import.meta.url), 'utf8')).templates;

// A small stage with the shipped template's structure, for fast checks.
const small = {
  id: 'test-stage', families: ['dry-conifer'],
  grid: { width: 8 * TILE_CELLS + 1, height: 8 * TILE_CELLS + 1, cellSizeM: 20, originM: [-5120, -5120] },
  lake: { levelM: 2000, centerM: [0, 3800], radiiM: [3000, 700] },
  floor: { shoreRiseM: 1.5, slope: 0.03 },
  slots: [{ id: 'B', row: 'back', tiles: [1, 1, 3, 3] }, { id: 'F', row: 'front', tiles: [4, 3, 3, 2] }],
  principalSlot: 'B',
  camera: { eyeStart: { xzM: [0, 4900], aboveFloorM: 30 }, eyeEnd: { xzM: [-200, 4800], aboveFloorM: 40 },
    targetStart: { xzM: [0, -2000], aboveFloorM: 500 }, targetEnd: { xzM: [-100, -2000], aboveFloorM: 500 }, fovYDeg: 38 },
};

function cone(tiles, peakM) {
  const W = tiles[0] * TILE_CELLS + 1, H = tiles[1] * TILE_CELLS + 1, relief = new Float32Array(W * H);
  const cx = (W - 1) / 2, cy = (H - 1) / 2, r = Math.min(cx, cy) - 3;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) relief[j * W + i] = Math.max(0, peakM * (1 - Math.hypot(i - cx, j - cy) / r));
  return { id: `cone-${tiles.join('x')}`, name: 'Cone', cellSizeM: 20, tiles, width: W, height: H, relief };
}

test('the shipped stage templates are valid and their rails pass the camera checks', () => {
  assert.ok(templates.length >= 1);
  for (const t of templates) {
    assert.deepEqual(templateErrors(t), [], t.id);
    const floor = stageFloor(t);
    const cam = stageCamera(t, floor);
    // The eye stands on land, close above the floor.
    for (const k of ['eyeStartM', 'eyeEndM']) assert.ok(cam[k][1] > t.lake.levelM, `${t.id} ${k}`);
  }
});

test('template checks catch overlapping slots, unknown principal slots and bad grids', () => {
  assert.deepEqual(templateErrors(small), []);
  assert.ok(templateErrors({ ...small, slots: [...small.slots, { id: 'X', row: 'front', tiles: [2, 2, 2, 2] }] }).some((e) => /overlap/.test(e)));
  assert.ok(templateErrors({ ...small, principalSlot: 'nope' }).includes('principalSlot'));
  assert.deepEqual(templateErrors({ ...small, grid: { ...small.grid, width: 500 } }), ['grid must be whole tiles']);
});

test('the floor is a level lake inside rising land the baker never mistakes for water', () => {
  const f = stageFloor(small);
  const { width: W, height: H } = small.grid;
  const water = waterMask(f.heightsM, new Uint8Array(W * H).fill(1), W, H);
  let lakeCells = 0, wrong = 0;
  for (let k = 0; k < W * H; k++) {
    if (f.lake[k]) { lakeCells++; assert.equal(f.heightsM[k], small.lake.levelM); }
    else assert.ok(f.heightsM[k] >= small.lake.levelM + small.floor.shoreRiseM);
    // Land is never water; the lake interior is (its rim cells may not be).
    if (!f.lake[k] && water[k]) wrong++;
  }
  assert.ok(lakeCells > 1000);
  assert.equal(wrong, 0, 'land cells marked water');
});

test('composition places pieces in their slots, tile aligned, with zero no-data', () => {
  const pieces = [{ slotId: 'B', piece: cone([3, 3], 1200) }, { slotId: 'F', piece: cone([2, 2], 600), mirrored: true }];
  const g = composeStage(small, pieces);
  assert.deepEqual(validateDemGrid(g).errors, []);
  assert.ok(g.valid.every((v) => v === 1));
  assert.ok(g.heightsM.every(Number.isFinite));
  const floor = stageFloor(small);
  // Outside every block the stage is exactly the floor.
  const { width: W } = small.grid;
  for (const p of g.placed) {
    const [ix, iz] = p.tileOrigin, [tw, td] = p.tiles;
    // Block border rows equal the floor: zero relief there.
    for (let i = ix * TILE_CELLS; i <= (ix + tw) * TILE_CELLS; i++) {
      for (const j of [iz * TILE_CELLS, (iz + td) * TILE_CELLS]) assert.equal(g.heightsM[j * W + i], floor.heightsM[j * W + i]);
    }
    assert.ok(Math.abs(p.peakReliefM - (p.slotId === 'B' ? 1200 : 600)) < 1);
  }
  assert.equal(g.placed[0].tileOrigin[0], 1);
  assert.equal(g.placed[1].tileOrigin[0], 4 + Math.floor((3 - 2) / 2));
});

test('composition is deterministic and refuses misfits', () => {
  const run = () => composeStage(small, [{ slotId: 'B', piece: cone([3, 2], 900) }]);
  assert.equal(run().meta.payload.heights.sha256, run().meta.payload.heights.sha256);
  assert.throws(() => composeStage(small, [{ slotId: 'F', piece: cone([3, 3], 500) }]), /do not fit/);
  assert.throws(() => composeStage(small, [{ slotId: 'B', piece: cone([1, 1], 500) }, { slotId: 'B', piece: cone([1, 1], 500) }]), /used twice/);
  assert.equal(placeInSlot({ tiles: [0, 0, 2, 2] }, [3, 1]), null);
});
