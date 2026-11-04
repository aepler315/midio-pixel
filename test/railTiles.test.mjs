import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bakeTerrain } from '../tools/lib/terrain-bake.mjs';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';
import { railTile, drawnTile, terrainHeightRange } from '../src/world/alpine/TerrainPackage.js';
import { waterLevel } from '../src/world/alpine/RangeScene.js';
import { mirrorLevelFor } from '../src/world/alpine/WaterMirror.js';
import { actorRoutes } from '../src/world/alpine/RangeActors.js';
import { castPlan } from '../src/world/alpine/CastJobs.js';
import { waterLevelOf } from '../tools/lib/scenic-cost.mjs';

// The terrainBakePoses fixture (4 x 4 tiles of 64 cells at 20 m, a rail at
// z = -600 looking north) with a deep, dead-flat lake south of the rail,
// behind it: only a tour pose looking south sees the lake.
function fixture() {
  const width = 257, depth = 257, cellSizeM = 20, originM = [-2560, -2560];
  const ground = (x, z) => 1000 + 150 * Math.sin(x / 900) * Math.cos(z / 800) + 0.3 * Math.sin(x / 37 + z / 53) + 0.15 * Math.cos(x / 23 - z / 31);
  const lake = (x, z) => x > 200 && x < 1400 && z > 1000 && z < 2200;
  const heightsM = new Float32Array(width * depth);
  for (let j = 0; j < depth; j++) for (let i = 0; i < width; i++) {
    const x = originM[0] + i * cellSizeM, z = originM[1] + j * cellSizeM;
    heightsM[j * width + i] = lake(x, z) ? 700 : ground(x, z);
  }
  const grid = { width, height: depth, cellSizeM, originM, heightsM, valid: new Uint8Array(width * depth).fill(1),
    horizontalCrs: 'synthetic', verticalReference: 'synthetic', sourceResolutionM: 20, outputSpacingM: 20 };
  const view = { id: 'rail-tiles', camera: { eyeStartM: [0, 1500, -600], eyeEndM: [0, 1500, -600],
    targetStartM: [0, 1000, -2400], targetEndM: [0, 1000, -2400], fovYDeg: 30 } };
  return { grid, view };
}
const behind = { eyeM: [800, 1500, 300], targetM: [800, 700, 1600], fovYDeg: 40 };
async function packages() {
  const { grid, view } = fixture();
  const rail = await bakeTerrain(grid, view);
  const tour = await bakeTerrain(grid, view, { poses: [behind] });
  return { view, rail: decodeTerrain(rail.manifest, rail.decoded), tour: decodeTerrain(tour.manifest, tour.decoded) };
}

test('railTile: shipped, visible and not marked as a tour pose\'s alone', () => {
  assert.equal(railTile({ visible: true }), true);
  assert.equal(railTile({ visible: true, rail: false }), false);
  assert.equal(railTile({ visible: false }), false);
  assert.equal(railTile(null), false);
  // A shot tour draws every shipped tile.
  assert.equal(drawnTile({ visible: true, rail: false }), false);
  assert.equal(drawnTile({ visible: true, rail: false }, { tour: true }), true);
  assert.equal(drawnTile({ visible: false }, { tour: true }), false);
});

test('terrainHeightRange prefers the rail tiles\' bounds', () => {
  const boundsM = { min: [0, 100, 0], max: [1, 900, 1] };
  assert.deepEqual(terrainHeightRange({ boundsM }), [100, 900]);
  assert.deepEqual(terrainHeightRange({ boundsM, railBoundsM: { min: [0, 300, 0], max: [1, 800, 1] } }), [300, 800]);
  assert.deepEqual(terrainHeightRange({ boundsM, railBoundsM: { min: [0, 300, 0], max: [1, 800, 1] } }, { tour: true }), [100, 900]);
  assert.equal(terrainHeightRange({}), null);
});

test('ground only a tour pose sees leaves the rail\'s height range, water and mirror alone, and gives the tour its own', async () => {
  const { rail, tour } = await packages();
  const lakeTiles = [...tour.tiles.values()].filter((t) => t.flowBytes.includes(255));
  assert.ok(lakeTiles.length > 0 && lakeTiles.every((t) => t.rail === false), 'the lake ships, only for the tour');
  assert.equal(waterLevel(rail), null, 'the rail sees no water');
  // Counting every shipped tile would put the view's water on the tour's lake.
  assert.equal(waterLevel({ ...tour, tiles: new Map([...tour.tiles].map(([k, t]) => [k, { ...t, rail: undefined }])) }), 700);
  assert.equal(waterLevel(tour), null);
  assert.equal(waterLevelOf(tour), null);
  assert.equal(mirrorLevelFor(tour, 700), null, 'no mirror for a lake the rail never draws');
  assert.notDeepEqual(terrainHeightRange(tour.manifest), [tour.manifest.boundsM.min[1], tour.manifest.boundsM.max[1]]);
  assert.deepEqual(terrainHeightRange(tour.manifest), terrainHeightRange(rail.manifest));
  // The tour that sees the lake has its water, its mirror and its depth.
  assert.equal(waterLevel(tour, { tour: true }), 700);
  assert.equal(waterLevelOf(tour, { tour: true }), 700);
  assert.equal(mirrorLevelFor(tour, 700, { tour: true }), 700);
  assert.deepEqual(terrainHeightRange(tour.manifest, { tour: true }), [tour.manifest.boundsM.min[1], tour.manifest.boundsM.max[1]]);
  // A package without tour ground is one camera's water either way.
  assert.equal(waterLevel(rail, { tour: true }), waterLevel(rail));
});

test('the cast plans and routes over the rail\'s ground only', async () => {
  const { view, rail, tour } = await packages();
  assert.deepEqual(castPlan(tour, view, { seed: 7 }), castPlan(rail, view, { seed: 7 }));
  assert.deepEqual(actorRoutes(tour, view, { seed: 7 }), actorRoutes(rail, view, { seed: 7 }));
  // With every tile marked as a tour pose's, the rail has nothing to route over.
  const none = { ...tour, tiles: new Map([...tour.tiles].map(([k, t]) => [k, { ...t, rail: false }])) };
  const routes = actorRoutes(none, view, { seed: 7 });
  assert.ok(Object.values(routes).every((r) => r == null), JSON.stringify(Object.keys(routes)));
});
