// Range v2: a tour package (ground only its shot tour sees ships as
// `rail: false`, RailDraw.js) is prepared for both cameras only when the
// view comes with its tour's footprint and the device can hold both.
// Otherwise the view is prepared for its rail alone, at what its rail's
// package without a tour costs: phones keep the views they load today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { bakeTerrain } from '../tools/lib/terrain-bake.mjs';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';
import { RangeScene, staticViewBytes, terrainMeshEstimate } from '../src/world/alpine/RangeScene.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { RULE_DEFAULTS } from '../src/world/alpine/MaterialPackage.js';
import { railGroundData } from '../src/world/alpine/RailDraw.js';
import { RangePresentation } from '../src/world/alpine/RangePresentation.js';
import { RangeShotTours } from '../src/world/alpine/RangeShotTours.js';

// The rail at z = -600 looks north; two tour poses add ground only they see.
const camera = { eyeStartM: [0, 1500, -600], eyeEndM: [0, 1500, -600], targetStartM: [0, 1000, -2400], targetEndM: [0, 1000, -2400], fovYDeg: 30 };
const POSES = [{ eyeM: [800, 1500, 300], targetM: [800, 1000, 1600], fovYDeg: 40 }, { eyeM: [-1500, 6000, 2400], targetM: [-2400, 1000, 600], fovYDeg: 50 }];
const footprint = [POSES.map((p) => p.eyeM)];
let baked = null;
async function tourPackage() {
  if (baked) return baked;
  const width = 257, depth = 257, cellSizeM = 20, originM = [-2560, -2560];
  const ground = (x, z) => 1000 + 150 * Math.sin(x / 900) * Math.cos(z / 800) + 0.3 * Math.sin(x / 37 + z / 53) + 0.15 * Math.cos(x / 23 - z / 31);
  const heightsM = new Float32Array(width * depth);
  for (let j = 0; j < depth; j++) for (let i = 0; i < width; i++) heightsM[j * width + i] = ground(originM[0] + i * cellSizeM, originM[1] + j * cellSizeM);
  const grid = { width, height: depth, cellSizeM, originM, heightsM, valid: new Uint8Array(width * depth).fill(1),
    horizontalCrs: 'synthetic', verticalReference: 'synthetic', sourceResolutionM: 20, outputSpacingM: 20 };
  baked = await bakeTerrain(grid, { id: 'rail-only', camera }, { poses: POSES, poseErrorScale: 64 });
  return baked;
}

const material = JSON.parse(fs.readFileSync(new URL('../src/assets/range/v2/materials/wet-conifer.json', import.meta.url), 'utf8'));
/** A RangeScene without a GL context: a stub renderer whose programs link. */
function scene(budgetBytes = 1e9, budget = 'desktop') {
  const s = Object.assign(Object.create(RangeScene.prototype), { budget, THREE, residency: new GraphicsResidency({ budgetBytes }),
    prepared: new Map(), pending: new Map(), contextEpoch: 0, camera: new THREE.PerspectiveCamera(),
    renderer: { getContext: () => ({ getProgramParameter: () => true, isContextLost: () => false }), compile: () => [],
      properties: { get: () => ({ programs: new Map() }) }, initTexture() {} } });
  s._acquireMaterial = async () => ({ key: 'material', pack: { manifest: { ...material, rules: { ...RULE_DEFAULTS, ...material.rules, treelineM: 2000, forestDensity: 1 } } }, textures: { roles: {} } });
  s._releaseMaterial = () => {};
  return s;
}
async function prepare(s, cameraPaths, extra = {}, generation = 1) {
  const { manifest, payload } = await tourPackage();
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(String(url).endsWith('.json') ? JSON.stringify(manifest) : payload);
  try {
    return await s.prepare({ id: 'rail-only', camera, cameraPaths, terrainManifestUrl: 'rail-only.json', ...extra }, { baseUrl: 'http://test/', generation });
  } finally { globalThis.fetch = fetch; }
}
const gpuBytes = (s, p) => s.residency.entries.get(p.gpuKey).bytes;
const cpuEntry = (s) => s.residency.entries.get('range:terrain-cpu:rail-only');
const tileBytes = (data) => [...data.tiles.values()].reduce((n, t) => n + t.heightsM.byteLength + t.flowBytes.byteLength + (t.validMask?.byteLength || 0), 0);
const tourTiles = (data) => [...data.tiles.values()].filter((t) => t.rail === false).length;
const timeline = { durationMs: 1000 };
/** Records what each preparation's room check answered. */
function watchRoom(s) {
  const rooms = [], room = s._tourRoom;
  s._tourRoom = function (...args) { const r = room.apply(this, args); rooms.push(r); return r; };
  return rooms;
}

test('the bake\'s mesh estimate is the sum of the tiles a decoded package keeps', async () => {
  const { manifest, decoded } = await tourPackage();
  const data = decodeTerrain(manifest, decoded);
  for (const budget of ['desktop', 'mobile']) {
    const { vertices, triangles, meshBytes } = manifest.estimatedBytes[budget];
    assert.deepEqual(terrainMeshEstimate(data, budget), { vertices, triangles, meshBytes });
    assert.ok(terrainMeshEstimate(railGroundData(data), budget).meshBytes < meshBytes, 'the rail keeps fewer tiles');
  }
});

test('a tour package without its tour\'s footprint prepares the rail alone', async () => {
  const rail = scene(), both = scene();
  const alone = await prepare(rail), two = await prepare(both, footprint);
  assert.equal(alone.railOnly, 'no shot tour');
  assert.equal(two.railOnly, null);
  // The rail's ground: no tour-only tile, no second draw mode.
  assert.ok([...alone.data.tiles.values()].every((t) => t.rail !== false));
  assert.equal(alone.modeGeometries.length, 0);
  assert.ok(two.modeGeometries.length > 0);
  assert.equal(alone.stats.triangles, two.stats.railTriangles, 'the triangles the two-mode rail draws');
  assert.equal(alone.view.cameraPaths, undefined);
  // The forest of the view without a footprint: what the rail draws.
  const sum = (c) => c.meshDetail + c.mesh + c.billboard;
  assert.ok(sum(alone.stats.trees) < sum(two.stats.trees));
  // Charged as the rail's own package would be, and well under both modes.
  const est = { ...alone.manifest.estimatedBytes.desktop, ...terrainMeshEstimate(alone.data, 'desktop') };
  assert.equal(gpuBytes(rail, alone), staticViewBytes(alone.data, est, sum(alone.stats.trees), { budget: 'desktop' }));
  assert.ok(gpuBytes(rail, alone) < gpuBytes(both, two) * 0.6);
  // The decoded package keeps the rail's tiles alone, charged at what they hold.
  assert.equal(tourTiles(cpuEntry(rail).resource.data), 0);
  assert.ok(tourTiles(cpuEntry(both).resource.data) > 0);
  assert.equal(cpuEntry(rail).bytes, tileBytes(alone.data));
  assert.ok(cpuEntry(rail).bytes < tileBytes(two.data));
  // It never plays a tour: there is no tour ground to draw.
  rail.setCameraTour('rail-only', timeline);
  assert.equal(alone.cameraTour, null);
  assert.equal(alone.terrainMode, 'rail');
  both.setCameraTour('rail-only', timeline);
  assert.equal(two.terrainMode, 'tour');
});

test('a phone that cannot hold both cameras prepares the rail alone, never placing the tour\'s forest', async () => {
  const reference = scene(1e9, 'mobile'), alone = await prepare(reference);
  const small = scene(30e6, 'mobile'), fitted = await prepare(small, footprint);
  assert.equal(fitted.railOnly, 'its tour does not fit this device');
  assert.deepEqual(fitted.stats.trees, alone.stats.trees);
  assert.equal(fitted.stats.triangles, alone.stats.triangles);
  assert.equal(gpuBytes(small, fitted), gpuBytes(reference, alone));
  assert.equal(cpuEntry(small).bytes, cpuEntry(reference).bytes);
  assert.deepEqual(small.buildAdmission, reference.buildAdmission, 'only the rail\'s forest was admitted');
  const large = scene(60e6, 'mobile'), both = await prepare(large, footprint);
  assert.equal(both.railOnly, null);
});

test('a desktop places the tour\'s forest when its placement fits, and holds both cameras when the trees placed fit', async () => {
  // Room the bound's tree count would refuse, but the trees placed fit.
  const s = scene(36e6), rooms = watchRoom(s);
  const two = await prepare(s, footprint);
  assert.deepEqual(rooms, ['placed']);
  assert.equal(two.railOnly, null);
  assert.ok(two.modeGeometries.length > 0);
});

test('a desktop whose trees placed do not fit both cameras keeps the rail for the song, and tries both next song', async () => {
  const reference = scene(), alone = await prepare(reference);
  const s = scene(30e6), rooms = watchRoom(s);
  await assert.rejects(prepare(s, footprint), (e) => e.reason === 'budget');
  await assert.rejects(prepare(s, footprint, {}, 2), (e) => e.reason === 'budget');
  assert.deepEqual(rooms, ['placed', 'placed']);
  const retried = await prepare(s, footprint, {}, 2);
  assert.equal(retried.railOnly, 'its tour did not fit this device');
  assert.deepEqual(retried.stats.trees, alone.stats.trees);
  assert.equal(gpuBytes(s, retried), gpuBytes(reference, alone));
});

test('a phone whose room went between the check and the reservation retries its rail alone', async () => {
  const s = scene(30e6, 'mobile');
  s._tourRoom = () => 'fits';
  await assert.rejects(prepare(s, footprint), (e) => e.reason === 'budget');
  delete s._tourRoom;
  const retried = await prepare(s, footprint);
  assert.equal(retried.railOnly, 'its tour did not fit this device');
});

test('a package another preparation holds keeps its tour ground, and one kept for its rail prepares its variants for their rail', async () => {
  // A composition variant shares its source's decoded package (RangeAssets.js).
  const variant = { id: 'rail-only-variant', terrainSourceId: 'rail-only' };
  const shared = scene();
  const two = await prepare(shared, footprint, variant), alone = await prepare(shared);
  assert.equal(two.railOnly, null);
  assert.equal(alone.railOnly, 'no shot tour');
  assert.ok(tourTiles(cpuEntry(shared).resource.data) > 0, 'the variant still draws its tour ground');
  assert.equal(tourTiles(alone.data), 0);
  const kept = scene();
  await prepare(kept);
  const after = await prepare(kept, footprint, variant);
  assert.equal(after.railOnly, 'its terrain is loaded for its rail');
  assert.equal(tourTiles(after.data), 0);
  assert.equal(after.modeGeometries.length, 0);
});

test('presentation plays the rail of a view prepared for its rail alone, and says why', () => {
  const shots = Object.create(RangeShotTours.prototype);
  shots.views = new Map([['v', { viewId: 'v', state: 'ready', timeline, reason: null }]]);
  const presentation = Object.assign(Object.create(RangePresentation.prototype), { shots,
    scene: { prepared: new Map([['v', { railOnly: null }]]) } });
  assert.equal(presentation._shotTimeline('v'), timeline);
  presentation.scene.prepared.get('v').railOnly = 'its tour does not fit this device';
  assert.equal(presentation._shotTimeline('v'), null);
  shots.keepRail('v', 'rail kept: its tour does not fit this device');
  assert.deepEqual([shots.views.get('v').state, shots.views.get('v').reason, shots.timeline('v')], ['rail', 'rail kept: its tour does not fit this device', null]);
});
