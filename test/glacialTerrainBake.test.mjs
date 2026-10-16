import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { bakeTerrain } from '../tools/lib/terrain-bake.mjs';
import { decodeTerrain, terrainHeightAt } from '../src/world/alpine/TerrainMesh.js';

function grid() {
  const size = 257, cell = 10;
  const heightsM = new Float32Array(size * size), valid = new Uint8Array(size * size).fill(1);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    const z = -1280 + r * cell;
    heightsM[r * size + c] = 1000 + (z > 900 && z < 1000 ? 300 : 0);
  }
  return { width: size, height: size, cellSizeM: cell, originM: [-1280, -1280], heightsM, valid,
    horizontalCrs: 'synthetic', verticalReference: 'synthetic', sourceResolutionM: cell, outputSpacingM: cell };
}
const camera = { eyeStartM: [0, 1100, 1250], eyeEndM: [0, 1100, 1250], targetStartM: [0, 1000, -1000], targetEndM: [0, 1000, -1000], fovYDeg: 35 };
const glacier = { axisStartM: [0, 1250], axisEndM: [0, -1250], halfWidthM: 800, surfaceStartM: 1450, surfaceEndM: 1700, maxThicknessM: 700 };

test('glacier bake retains buried valley tiles that raised ice can reveal without changing bed heights', async () => {
  const g = grid();
  const plain = await bakeTerrain(g, { id: 'plain', camera });
  assert.equal(plain.manifest.tiles.filter((t) => t.iz === 0).length, 0);
  const frozen = await bakeTerrain(g, { id: 'frozen', camera, glacier });
  const buried = frozen.manifest.tiles.filter((t) => t.iz === 0 && t.visible);
  assert.ok(buried.length > 0, 'raised glacier must retain originally occluded floor');
  assert.ok(buried.every((t) => t.stride <= 8), 'flat bed still needs vertices for rounded ice surface');
  assert.ok(frozen.manifest.boundsM.max[1] === 1700, 'manifest bounds include shader displacement');
  const data = decodeTerrain(frozen.manifest, new Uint8Array(zlib.gunzipSync(frozen.payload)));
  assert.ok(Math.abs(terrainHeightAt(data, 0, -1000) - 1000) <= frozen.manifest.quantization.stepM);
});

test('ordinary terrain bake remains byte-for-byte unchanged for disabled glacier', async () => {
  const g = grid();
  const plain = await bakeTerrain(g, { id: 'same', camera });
  const disabled = await bakeTerrain(g, { id: 'same', camera, glacier: null });
  assert.deepEqual(disabled.manifest, plain.manifest);
  assert.deepEqual(disabled.payload, plain.payload);
});

test('nonlinear ice displacement uses one shared grid stride across every tile and quality budget', async () => {
  const frozen = await bakeTerrain(grid(), { id: 'frozen', camera, glacier });
  // Snapping the bed midpoint to a coarse edge is insufficient: its
  // nonlinear ice height can still differ from the coarse interpolant.
  // An identical grid prevents that T-junction for every retreat state.
  assert.ok(frozen.manifest.tiles.length > 2);
  assert.ok(frozen.manifest.tiles.every((t) => t.stride === 2 && t.lod.desktop === 2 && t.lod.mobile === 2),
    'all ice-view edges must have the same displaced sample positions');
});
