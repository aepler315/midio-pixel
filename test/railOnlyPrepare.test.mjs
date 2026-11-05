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
import { RangePresentation, shotTimelineOf } from '../src/world/alpine/RangePresentation.js';
import { RangeShotTours } from '../src/world/alpine/RangeShotTours.js';
import { rangeMusicState } from '../src/world/alpine/RangeFrame.js';
import { keyTimeline } from './helpers/tourForestFixtures.mjs';

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
/** A RangeScene without a GL context: a stub renderer whose programs link.
 *  Its tour forest layer is on, as the constructor sets it. */
function scene(budgetBytes = 1e9, budget = 'desktop', { tourForest = true } = {}) {
  const s = Object.assign(Object.create(RangeScene.prototype), { budget, THREE, residency: new GraphicsResidency({ budgetBytes }), tourForest,
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

test('a desktop whose trees placed do not fit both cameras keeps the rail for the song, and later songs decide without placing again', async () => {
  const reference = scene(), alone = await prepare(reference);
  const s = scene(30e6), rooms = watchRoom(s);
  await assert.rejects(prepare(s, footprint), (e) => e.reason === 'budget');
  const retried = await prepare(s, footprint);
  assert.equal(retried.railOnly, 'its tour did not fit this device');
  assert.deepEqual(retried.stats.trees, alone.stats.trees);
  assert.equal(gpuBytes(s, retried), gpuBytes(reference, alone));
  assert.deepEqual(rooms, ['placed']);
  // The next song, with the same room: the rail at once, no forest placed.
  const next = scene(30e6), nextRooms = watchRoom(next);
  await assert.rejects(prepare(next, footprint), (e) => e.reason === 'budget');
  const admitted = next.buildAdmission.requestedBytes;
  const song2 = await prepare(next, footprint, {}, 2);
  assert.deepEqual(nextRooms, ['placed', null]);
  assert.equal(song2.railOnly, 'its tour does not fit this device');
  assert.equal(next.buildAdmission.requestedBytes - admitted, reference.buildAdmission.requestedBytes, 'only the rail\'s forest was admitted');
  // With room freed since, both cameras again.
  const freed = scene(30e6), freedRooms = watchRoom(freed);
  await assert.rejects(prepare(freed, footprint), (e) => e.reason === 'budget');
  freed.residency.budgetBytes = 1e9;
  const both = await prepare(freed, footprint, {}, 2);
  assert.deepEqual(freedRooms, ['placed', 'fits']);
  assert.equal(both.railOnly, null);
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
  assert.equal(shotTimelineOf(presentation, 'v'), timeline);
  presentation.scene.prepared.get('v').railOnly = 'its tour does not fit this device';
  assert.equal(shotTimelineOf(presentation, 'v'), null);
  shots.keepRail('v', 'rail kept: its tour does not fit this device');
  assert.deepEqual([shots.views.get('v').state, shots.views.get('v').reason, shots.timeline('v')], ['rail', 'rail kept: its tour does not fit this device', null]);
});

test('a two-camera view with room holds the tour forest layer in its GPU entry, and one without room has today\'s', async () => {
  const off = scene(1e9, 'desktop', { tourForest: false }), today = await prepare(off, footprint);
  assert.equal(today.forest.tour, null);
  assert.equal(today.tourSchedule, null);
  assert.equal(today.stats.tourForest, 'static: no room or off');
  // (a) Ample room: the layer, charged in the view's GPU entry.
  const s = scene(), p = await prepare(s, footprint);
  assert.ok(p.forest.tour && p.tourSchedule);
  assert.ok(p.forest.tour.bytes > 0);
  assert.equal(gpuBytes(s, p), gpuBytes(off, today) + p.forest.tour.bytes);
  assert.deepEqual(p.stats.trees, today.stats.trees);
  assert.equal(p.stats.tourForest.bytes, p.forest.tour.bytes);
  assert.equal(p.stats.tourForest.trees, p.forest.tour.index.count);
  // (b) Room for both cameras but not the layer: both cameras, without it,
  // at today's bytes. Phones keep twice the layer free.
  // What the last two room checks asked for: both cameras, then the layer
  // beside them (nothing here is evictable).
  const need = async (budget) => {
    const r = scene(1e9, budget), fit = r.residency.canFit.bind(r.residency), asked = [];
    r.residency.canFit = (bytes, protect) => { asked.push(r.residency.usedBytes + bytes); return fit(bytes, protect); };
    const q = await prepare(r, footprint);
    return { without: asked.at(-2), with: asked.at(-1), layer: q.forest.tour.bytes };
  };
  for (const budget of ['desktop', 'mobile']) {
    const n = await need(budget);
    assert.equal(n.with - n.without, (budget === 'mobile' ? 2 : 1) * n.layer);
    const plain = scene(1e9, budget, { tourForest: false }), reference = await prepare(plain, footprint);
    // Between the two needs; on a phone, room for the layer once but not twice.
    const between = budget === 'mobile' ? n.without + 1.5 * n.layer : (n.without + n.with) / 2;
    const tight = scene(between, budget), q = await prepare(tight, footprint);
    assert.equal(q.railOnly, null, `${budget}: both cameras`);
    assert.equal(q.forest.tour, null, `${budget}: no layer`);
    assert.equal(q.stats.tourForest, 'static: no room or off');
    assert.equal(gpuBytes(tight, q), gpuBytes(plain, reference));
    assert.deepEqual(q.stats.trees, reference.stats.trees);
  }
  // A reservation that fails with the layer but fits without it.
  const racing = scene(), reserve = racing.residency.reserve.bind(racing.residency);
  racing.residency.reserve = (args) => (args.owner === 'range-terrain-gpu' && args.bytes > gpuBytes(off, today) ? null : reserve(args));
  const raced = await prepare(racing, footprint);
  assert.equal(raced.railOnly, null);
  assert.equal(raced.forest.tour, null);
  assert.equal(gpuBytes(racing, raced), gpuBytes(off, today));
  // (c) A view prepared for its rail alone has no layer to hold.
  const rail = scene(), alone = await prepare(rail);
  assert.equal(alone.railOnly, 'no shot tour');
  assert.equal(alone.forest.tour, null);
  assert.equal(alone.tourSchedule, null);
  assert.equal(alone.stats.tourForest, undefined);
});

test('the tour forest layer is built only in free room, never by evicting another view\'s mirror', async () => {
  // Both cameras' need, and the need with the layer, on an empty ledger.
  const need = async (budget) => {
    const r = scene(1e9, budget), fit = r.residency.canFit.bind(r.residency), asked = [];
    r.residency.canFit = (bytes, protect) => { asked.push(r.residency.usedBytes + bytes); return fit(bytes, protect); };
    await prepare(r, footprint);
    return { without: asked.at(-2), with: asked.at(-1) };
  };
  for (const budget of ['desktop', 'mobile']) {
    const n = await need(budget), mirrorBytes = n.with - n.without;
    const plain = scene(1e9, budget, { tourForest: false }), reference = await prepare(plain, footprint);
    // Another view's rail holds a mirror: live, unpinned, evictable, and
    // older than anything this preparation reserves.
    const withMirror = (budgetBytes) => {
      const s = scene(budgetBytes, budget), key = 'range:water-mirror-A';
      const mirror = { disposed: false };
      s.residency.commit(s.residency.reserve({ key, bytes: mirrorBytes, owner: 'range-mirror', protect: [...s.residency.entries.keys()] }),
        mirror, (m) => { m.disposed = true; });
      return { s, mirror, kept: () => s.residency.get(key) === mirror && !mirror.disposed };
    };
    // Free room for both cameras but not the layer; evicting the mirror
    // would make room for it. Both cameras, today's forest and bytes, and
    // the mirror stays.
    const tight = withMirror(n.with + mirrorBytes / 2), q = await prepare(tight.s, footprint);
    assert.equal(q.railOnly, null, `${budget}: both cameras`);
    // (Booleans: a failed comparison would print the whole forest.)
    assert.equal(!!q.forest.tour, false, `${budget}: no layer`);
    assert.equal(q.stats.tourForest, 'static: no room or off');
    assert.equal(gpuBytes(tight.s, q), gpuBytes(plain, reference));
    assert.ok(tight.kept(), `${budget}: the mirror is kept`);
    // With the layer's room free beside the mirror, both.
    const roomy = withMirror(n.with + mirrorBytes), r = await prepare(roomy.s, footprint);
    assert.equal(!!r.forest.tour, true, `${budget}: the layer in free room`);
    assert.equal(gpuBytes(roomy.s, r), gpuBytes(plain, reference) + r.forest.tour.bytes);
    assert.ok(roomy.kept(), `${budget}: the mirror is kept beside the layer`);
  }
});

test('on its tour a two-camera view draws the window sets of the frame\'s time, and a replan of the playhead window refills', async () => {
  const s = scene(), p = await prepare(s, footprint), layer = p.forest.tour, { index } = layer;
  const frame = (frameId, timeMs, extra = {}) => ({ frameId, timeMs, progress01: .5, music: rangeMusicState({}), qualityLevel: 0,
    scenicViewport: { nominalHeight: 720 }, light: { celestial: { xFrac: .7, yFrac: .08, body: 'sun', colorHex: '#ffffff', intensity: 1.6 },
      night01: 0, ambientMultiplier: 1, sky: { top: '#334455', horizon: '#778899', air: '#556677' } }, ...extra });
  const counts = () => layer.twins.map((t) => t.detail.instanceCount);
  // Each twin holds the trees of its batch in the drawn sets, each board
  // flag its tree's membership bits.
  const drawn = (state) => {
    const want = new Array(layer.twins.length).fill(0);
    for (let u = 0; u < index.count; u++) {
      const m = 1 << (u & 31), bits = (state.a.bits[u >>> 5] & m ? 1 : 0) | (state.b.bits[u >>> 5] & m ? 2 : 0);
      assert.equal(layer.boardFlags[u], bits);
      if (bits) want[index.batchOf[u]]++;
    }
    assert.deepEqual(counts(), want);
    for (const t of layer.twins) if (t.lite) assert.equal(t.lite.instanceCount, t.detail.instanceCount);
  };
  // On the rail the layer draws nothing and the schedule is not asked.
  s._setUniforms(p, frame(1, 6000));
  assert.ok(counts().every((n) => n === 0));
  assert.equal(layer.refills, 0);
  // A tour across the forest, played from 2 s (window 0) to 6 s (window 1),
  // clear of the fade at 4 s.
  const keys = Array.from({ length: 122 }, (_, i) => [-2000 + 30 * i, 1300, -1500 + 20 * i]);
  const tl = keyTimeline(keys, 12000);
  s.setCameraTour('rail-only', tl);
  assert.equal(p.terrainMode, 'tour');
  assert.equal(p.stats.tourForest.active, true);
  s._setUniforms(p, frame(2, 2000));
  drawn(p.tourSchedule.stateAt(2000));
  assert.equal(layer.refills, 1);
  s._setUniforms(p, frame(3, 6000));
  const first = p.tourSchedule.stateAt(6000);
  assert.equal(first.a.w, 1);
  assert.equal(first.b, first.a);
  drawn(first);
  assert.ok(counts().some((n) => n > 0));
  assert.ok(counts().reduce((a, b) => a + b, 0) < index.count, 'a window draws fewer trees than all');
  assert.deepEqual([layer.refills, p.stats.tourForest.refills, p.stats.tourForest.window, p.stats.tourForest.guardFails], [2, 2, 1, 0]);
  // Another pass of the frame, and a later frame in the window: no refill.
  s._setUniforms(p, frame(3, 6000));
  s._setUniforms(p, frame(4, 6500));
  assert.equal(layer.refills, 2);
  // The detail key holds the layer's serial: a refill within a frame
  // recomputes the twins' weights.
  const detail = () => { s._updateForestDetail(p, frame(4, 6500), s.camera, 640, 360, 'main'); return p.forestDetailState.key; };
  const before = detail();
  // A replan diverging inside the playhead's window, from 7 s: the same
  // window index, a new set, drawn at once. Window 0 carries over.
  const window0 = p.tourSchedule.cache.get(0);
  assert.ok(window0);
  const tl2 = keyTimeline(keys.map((k, i) => (i < 70 ? k : [k[0] + 600, k[1], k[2]])), 12000);
  s.setCameraTour('rail-only', tl2);
  assert.equal(p.tourSchedule.cache.get(0), window0);
  s._setUniforms(p, frame(4, 6500));
  assert.equal(layer.refills, 3);
  const second = p.tourSchedule.stateAt(6500);
  assert.notEqual(second.a.bits, first.a.bits);
  drawn(second);
  assert.notEqual(detail(), before);
  // A camera moved off the path draws every tree of the layer as a mesh.
  const moved = { ...tl2.poseAt(6500) };
  moved.eyeM = [moved.eyeM[0] + 4000, moved.eyeM[1], moved.eyeM[2]];
  const movedPose = s.movedPose;
  s.movedPose = () => ({ pose: moved });
  try {
    s._setUniforms(p, frame(5, 6500, { scenicViewport: { nominalHeight: 720, logicalWidth: 1280, logicalHeight: 720 } }));
  } finally { s.movedPose = movedPose; }
  assert.equal(p.stats.tourForest.guardFails, 1);
  assert.equal(p.stats.tourForest.window, -1);
  drawn(p.tourSchedule.all);
  assert.equal(counts().reduce((a, b) => a + b, 0), index.count);
  // Back on the rail: the twins draw nothing.
  s.setCameraTour('rail-only', null);
  assert.equal(p.terrainMode, 'rail');
  assert.equal(p.stats.tourForest.active, false);
  assert.ok(counts().every((n) => n === 0));
});
