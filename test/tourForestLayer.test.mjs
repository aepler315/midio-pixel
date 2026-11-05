// The tour forest layer (ForestGL createForest `tour`): its twins and
// demote boards draw every mesh-ring tree exactly once at every state, its
// shaders add only the tour's hide clause to the rail's, it costs what
// tourForestBytes says, a replan refills it at once and reaches the GPU as
// filled, and the lake layer's water-only pass draws none of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createForest, tourVertexShader } from '../src/world/alpine/ForestGL.js';
import { TourForestSchedule, tourForestBytes, tourMeshVisible, windowSet, tourUniverse, TOUR_CACHE_WINDOWS } from '../src/world/alpine/TourForest.js';
import { setTerrainDrawMode } from '../src/world/alpine/RailDraw.js';
import { keyTimeline, wanderKeys, syntheticPlaced, inRing, rng } from './helpers/tourForestFixtures.mjs';
import { staticMaterials, forestPins, MAIN_PINS, PIN_OPTIONS, pinPlaced } from './helpers/forestShaderPins.mjs';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { recordingWebGL2 } from './helpers/recordingWebGL2.mjs';

const SEED = 7;
let shared = null;
function layered() {
  if (shared) return shared;
  const placed = syntheticPlaced({ extent: 2400, spacing: 40 });
  const forest = createForest(THREE, placed, {}, { tour: { seed: SEED } });
  shared = { placed, forest };
  return shared;
}
const toTour = forest => { for (const g of forest.modeGeometries) setTerrainDrawMode(g, 'tour'); forest.tour.setMode('tour'); };
const toRail = forest => { for (const g of forest.modeGeometries) setTerrainDrawMode(g, 'rail'); forest.tour.setMode('rail'); };
const treeKey = (a, i) => `${a.iPos.getX(i)},${a.iPos.getY(i)},${a.iPos.getZ(i)},${a.iVar.getY(i)}`;

/** How many times each U tree draws at fade f: as a mesh from each twin
 *  slot below its count, as a board from its band's demote board. */
function draws(forest, f) {
  const out = new Map();
  const add = (key, n) => out.set(key, (out.get(key) || 0) + n);
  for (const { detail } of forest.tour.twins) {
    const a = detail.attributes;
    for (let j = 0; j < detail.instanceCount; j++) add(treeKey(a, j), tourMeshVisible(a.iTour.array[j], a.iVar.getY(j), f) ? 1 : 0);
  }
  for (const board of forest.tour.boards) {
    const a = board.attributes;
    for (let j = 0; j < board.instanceCount; j++) add(treeKey(a, j), tourMeshVisible(a.iTour.array[j], a.iVar.getY(j), f) ? 0 : 1);
  }
  return out;
}

test('twins and demote boards draw every mesh-ring tree exactly once, in each batch\'s own order', () => {
  const { placed, forest } = layered(), index = forest.tour.index, N = index.count;
  toTour(forest);
  const r = rng(3), half = new Uint32Array(index.words), other = new Uint32Array(index.words);
  for (let u = 0; u < N; u++) {
    if (r() < .3) half[u >>> 5] |= 1 << (u & 31);
    if (r() < .3) other[u >>> 5] |= 1 << (u & 31);
  }
  const A = { bits: half }, B = { bits: other };
  const states = [{ a: index.all, b: index.all, f: 1 }, { a: A, b: A, f: 1 }, { a: A, b: B, f: .37 }, { a: B, b: A, f: .9 }, { a: A, b: B, f: 0 }, { a: B, b: B, f: 1 }];
  // Static batches in their placement order, by tree.
  const staticOrder = new Map();
  for (const m of Object.values(forest.byBand).flat()) {
    const g = m.geometry;
    if (!m.userData.tourStatic || m.userData.nearLod === 'lite' || staticOrder.has(g)) continue;
    staticOrder.set(g, new Map(Array.from({ length: g.attributes.iPos.count }, (_, i) => [treeKey(g.attributes, i), i])));
  }
  let refills = 0;
  for (const state of states) {
    if (forest.tour.apply(state)) refills++;
    const f = forest.tour.uniforms.uTourFade.value;
    assert.equal(f, state.f);
    const counts = draws(forest, f);
    assert.equal(counts.size, N, 'every tree appears');
    for (const [key, n] of counts) assert.equal(n, 1, `tree ${key} draws ${n} times`);
    // A twin's trees are an ascending subsequence of one static batch's.
    for (const { detail, lite } of forest.tour.twins) {
      if (lite) assert.equal(lite.instanceCount, detail.instanceCount);
      if (!detail.instanceCount) continue;
      const order = [...staticOrder.values()].find(o => o.has(treeKey(detail.attributes, 0)));
      let last = -1;
      for (let j = 0; j < detail.instanceCount; j++) {
        const at = order.get(treeKey(detail.attributes, j));
        assert.ok(at > last, 'twin order follows its static batch');
        last = at;
      }
    }
  }
  assert.equal(refills, states.length);
  assert.equal(forest.tour.apply({ a: B, b: B, f: 1 }), false, 'the same sets: no refill');
  assert.equal(forest.tour.apply({ a: A, b: B, f: .5 }), true);
  const serial = forest.tour.serial;
  assert.equal(forest.tour.apply({ a: A, b: B, f: .6 }), false, 'a new fade only');
  assert.equal(forest.tour.uniforms.uTourFade.value, .6);
  assert.equal(forest.tour.serial, serial + 1);
  // Twin capacity: each static batch's own trees.
  assert.equal(forest.tour.twins.reduce((n, t) => n + t.n, 0), N);
  assert.equal(N, (placed.meshDetail.length + placed.mesh.length) / 8);
  toRail(forest);
});

test('the layer charges exactly what it builds', () => {
  const { placed, forest } = layered(), t = forest.tour, index = t.index;
  const len = a => a.byteLength;
  const gpu = new Set();
  let built = 0;
  // U records: CPU, and on the GPU as the demote boards' attributes.
  built += 2 * (len(index.pos) + len(index.size) + len(index.vars));
  for (const g of t.boards) for (const k of ['iPos', 'iSize', 'iVar']) gpu.add(g.attributes[k].array.buffer);
  assert.equal(gpu.size, 3, 'the boards view U\'s own arrays');
  // Twins: staging and GPU, flags included; detail and lite weights.
  for (const { detail, lite } of t.twins) {
    for (const k of ['iPos', 'iSize', 'iVar', 'iTour']) built += 2 * len(detail.attributes[k].array);
    if (lite) {
      assert.equal(lite.attributes.iTour, detail.attributes.iTour);
      built += 2 * (len(detail.attributes.iLodWeight.array) + len(lite.attributes.iLodWeight.array));
    }
  }
  // Board flags (one array, viewed per band), CPU and GPU.
  built += 2 * len(t.boardFlags);
  for (const g of t.boards) assert.equal(g.attributes.iTour.array.buffer, t.boardFlags.buffer);
  built += len(index.reach) + len(index.batchOf) + len(index.grid.items) + len(index.grid.start) + len(index.all.bits);
  const lru = TOUR_CACHE_WINDOWS * index.words * 4;
  assert.equal(t.bytes, built + lru);
  assert.equal(tourForestBytes(placed), t.bytes);
  assert.equal(tourForestBytes({ ...placed, railCount: undefined }), 0, 'one camera: no layer');
  assert.equal(createForest(THREE, { ...placed, railCount: undefined }, {}, { tour: { seed: SEED } }).tour, null);
});

test('the tour shaders are the rail\'s with one hide clause, over the same fragments, blending and uniforms', () => {
  const placed = { ...pinPlaced(), railCount: { meshDetail: 3, mesh: 3, billboard: 3 } };
  // The static materials stay main's with the layer built.
  assert.deepEqual(forestPins(placed, { tour: { seed: SEED } }), MAIN_PINS);
  const roles = ['mesh', 'meshDepth', 'meshCore', 'meshCoreDepth', 'board', 'boardDepth'];
  for (const [name, options] of PIN_OPTIONS) {
    const forest = createForest(THREE, placed, {}, { ...options, tour: { seed: SEED } });
    const plain = createForest(THREE, pinPlaced(), {}, options);
    const statics = staticMaterials(forest);
    const rails = new Map(staticMaterials(plain).map(m => [m.vertexShader + m.fragmentShader + JSON.stringify(m.defines), m]));
    const set = forest.tour.materials;
    for (const role of roles) {
      const m = set[role], board = role.startsWith('board');
      const hides = m.vertexShader.match(/if \(iVar\.y > uForestKeep \|\| hiddenByGlacier\(\)[^{]*\{/g);
      assert.deepEqual(hides, [`if (iVar.y > uForestKeep || hiddenByGlacier() || ${board ? '' : '!'}tourMesh()) {`], `${name} ${role}: one tour hide clause`);
      assert.equal(m.vertexShader.match(/in float iTour;/g)?.length, 1);
      assert.equal(m.vertexShader.match(/uniform float uTourFade;/g)?.length, 1);
      assert.match(m.vertexShader, /float key = fract\(iVar\.y \* 4099\.0\);\s*bool inA = mod\(iTour, 2\.0\) > \.5, inB = iTour > 1\.5;\s*return inB \? \(inA \|\| key < uTourFade\) : \(inA && key >= uTourFade\);/);
      assert.equal(m.uniforms, forest.tour.uniforms);
      assert.ok(m.id > Math.max(...statics.map(x => x.id)), 'created after the static set');
      // Without the tour's own lines it is the rail's material.
      const rail = m.vertexShader.replace(/ {2}\n {2}in float iTour;[\s\S]*?\n {2}\}\n\n {2}void main\(\) \{/, '  void main() {').replace(` || ${board ? '' : '!'}tourMesh()`, '');
      const { FOREST_TOUR, ...defines } = m.defines;
      assert.equal(FOREST_TOUR, 1);
      if (options.partitioned === false && /Core/.test(role)) continue;
      const twin = rails.get(rail + m.fragmentShader + JSON.stringify(defines));
      assert.ok(twin, `${name} ${role}: the rail's material plus the tour clause`);
      for (const k of ['transparent', 'premultipliedAlpha', 'blending', 'blendEquation', 'blendSrc', 'blendDst', 'blendEquationAlpha', 'blendSrcAlpha', 'blendDstAlpha', 'depthTest', 'depthWrite', 'depthFunc', 'colorWrite', 'side']) {
        assert.equal(m[k], twin[k], `${name} ${role} ${k}`);
      }
      assert.deepEqual(m.defaultAttributeValues, twin.defaultAttributeValues);
    }
    assert.deepEqual(Object.keys(set.mesh.uniforms).sort(), [...Object.keys(forest.uniforms), 'uTourFade'].sort());
    for (const k of Object.keys(forest.uniforms)) assert.equal(forest.tour.uniforms[k], forest.uniforms[k], 'shared uniform values');
    assert.equal(forest.uniforms.uTourFade, undefined, 'the rail\'s uniforms are untouched');
    forest.dispose(); plain.dispose();
  }
  assert.throws(() => tourVertexShader('void main() {}', false), /exactly once/);
});

test('a replan refills the drawn trees at once (R2 on what the layer draws)', () => {
  const placed = syntheticPlaced({ extent: 3000, spacing: 40 });
  const forest = createForest(THREE, placed, {}, { tour: { seed: SEED } }), index = forest.tour.index;
  toTour(forest);
  const oldKeys = wanderKeys({ speed: 150, seed: 9, box: 1400 }), heard = 28200;
  const newKeys = oldKeys.map((p, i) => {
    const off = Math.min(600, Math.max(0, i - 302) * 60);
    return [p[0] + off * .6, p[1], p[2] - off * .8];
  });
  const old = keyTimeline(oldKeys, 40000), next = keyTimeline(newKeys, 40000);
  const s = new TourForestSchedule(index);
  s.setTimeline(old);
  for (let t = 0; t <= heard; t += 20) { forest.tour.apply(s.stateAt(t)); s.prefetch(t); }
  const refills = forest.tour.refills;
  s.setTimeline(next);
  let misses = 0, checked = 0;
  const near = [];
  for (let t = heard; t <= 34000; t += 10) {
    forest.tour.apply(s.stateAt(t));
    if (t === heard) assert.equal(forest.tour.refills, refills + 1, 'the replanned playhead window refills at once');
    const f = forest.tour.uniforms.uTourFade.value;
    for (const u of inRing(index, next.poseAt(t).eyeM, near)) {
      checked++;
      if (!tourMeshVisible(forest.tour.boardFlags[u], index.vars[2 * u + 1], f)) misses++;
    }
  }
  assert.ok(checked > 1e5);
  assert.equal(misses, 0, `${misses} of ${checked} in-ring trees not drawn as meshes after the replan`);
  // The layer's index is the module's: same universe, same window sets.
  const universe = tourUniverse(placed, () => 0);
  assert.deepEqual(index.pos, universe.pos);
  assert.deepEqual(windowSet(index, next, 7).bits, s.stateAt(29000).a.bits);
  forest.dispose();
});

test('the lake layer\'s water-only pass draws no tree of the tour layer', () => {
  const placed = syntheticPlaced({ extent: 600, spacing: 60 });
  const forest = createForest(THREE, placed, {}, { tour: { seed: SEED } });
  const scenes = {};
  for (const band of ['far', 'mid', 'near']) {
    scenes[band] = new THREE.Scene();
    for (const m of [...forest.byBand[band], ...forest.tour.byBand[band]]) scenes[band].add(m);
  }
  toTour(forest);
  forest.tour.apply({ a: forest.tour.index.all, b: forest.tour.index.all, f: 1 });
  forest.applyVisibility({ shown: true, nearDetail: true });
  const camera = { layers: new THREE.Layers() };
  const drawn = list => list.filter(m => m.visible && camera.layers.test(m.layers) && m.geometry.instanceCount > 0);
  const layer0 = new THREE.Layers();
  const cores = Object.values(forest.tour.byBand).flat().filter(m => m.visible && m.layers.test(layer0) && m.geometry.instanceCount > 0);
  assert.ok(cores.length > 0, 'the tour shows twin cores on layer 0');
  const noop = () => {}, UINT = 1014, depthTexture = () => ({ type: UINT, format: 1026 });
  const uniforms = { uViewportPx: { value: { set: noop } }, uWaterOnly: { value: 0 } };
  const p = { view: {}, uniforms, depthScene: { name: 'depth' }, forest, scenes };
  const leaks = [];
  let waterRenders = 0;
  const target = { width: 320, height: 180, samples: 0, texture: {}, depthTexture: depthTexture() };
  const scene = Object.assign(Object.create(RangeScene.prototype), {
    THREE: { UnsignedIntType: UINT }, prepared: new Map([['lake', p]]), contextLost: false, target, sideTargets: { B: null },
    size: { width: 320, height: 180 }, stats: {}, depthCache: { A: { frame: -1 }, B: { frame: -1 } },
    renderer: { getContext: () => ({}), setRenderTarget: noop, setClearColor: noop, clear: noop, properties: { get: () => ({}) },
      render: s => {
        if (uniforms.uWaterOnly.value !== 1) return;
        waterRenders++;
        leaks.push(...drawn(s.children));
      } },
    camera, canvas: {},
    _setCamera: noop, _setUniforms: noop, _prepareMirror: noop, _setCanvasSize: noop, _clearCanvas: noop, _copyTexture: noop,
    _scenicTarget: (w, h) => ({ width: w, height: h, samples: 0, texture: {}, depthTexture: depthTexture(), dispose: noop }),
  });
  // The native mask, the output-resolution image and a capture.
  for (const [w, h, options] of [[320, 180, {}], [640, 360, {}], [640, 360, { capture: true }]]) {
    leaks.length = 0;
    assert.ok(scene.renderWater({ frameId: 7 }, 'lake', w, h, options));
    assert.ok(waterRenders > 0);
    assert.deepEqual(leaks.map(m => m.userData.tourLayer ? 'tour layer' : 'static'), [], `${w}x${h} ${JSON.stringify(options)}`);
    assert.deepEqual(cores.filter(m => !m.visible), [], 'the pass restores what the tour shows');
  }
  forest.dispose();
});

test('a refill reaches the GPU: each twin\'s trees, every board\'s flags, and draws of each twin\'s count', () => {
  const { gl, canvas, state } = recordingWebGL2(480, 270, { gpu: true });
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  const placed = syntheticPlaced({ extent: 2400, spacing: 40 });
  const forest = createForest(THREE, placed, {}, { tour: { seed: SEED } }), layer = forest.tour, index = layer.index;
  const scene = new THREE.Scene();
  for (const m of Object.values(layer.byBand).flat()) {
    scene.add(m);
    m.onBeforeRender = (r, s, c, geometry) => { state.drawing = geometry; };
  }
  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 1, 20000);
  camera.layers.enableAll();
  camera.position.set(0, 1500, -600); camera.lookAt(0, 1000, 0); camera.updateMatrixWorld();
  toTour(forest);
  // Detail and lite, cores and colour: every twin mesh draws.
  layer.setCompileVisible(true);
  // A detail twin's weight is one value for all its instances.
  for (const { detail, lite } of layer.twins) if (lite) for (const g of [detail, lite]) {
    assert.equal(g.attributes.iLodWeight.meshPerAttribute, g.attributes.iPos.count);
  }
  const where = (pred) => {
    const bits = new Uint32Array(index.words);
    for (let u = 0; u < index.count; u++) if (pred(u)) bits[u >>> 5] |= 1 << (u & 31);
    return { bits };
  };
  const west = where((u) => index.pos[3 * u] < 0), north = where((u) => index.pos[3 * u + 2] < 200);
  const same = (gpu, array, n) => !!gpu && n * array.BYTES_PER_ELEMENT <= gpu.length
    && Buffer.from(gpu.buffer, gpu.byteOffset, n * array.BYTES_PER_ELEMENT).equals(Buffer.from(array.buffer, array.byteOffset, n * array.BYTES_PER_ELEMENT));
  const bytesOf = (attribute) => state.bufferOf.get(attribute.array)?.bytes;
  // All, then fewer trees in other twin slots, then the sets swapped.
  for (const [name, S] of [['all', { a: index.all, b: index.all, f: 1 }], ['west to north', { a: west, b: north, f: .5 }], ['north to west', { a: north, b: west, f: .2 }]]) {
    assert.equal(layer.apply(S), true);
    state.draws.length = 0;
    renderer.render(scene, camera);
    let drawn = 0;
    layer.twins.forEach(({ detail, lite }, i) => {
      const k = detail.instanceCount;
      for (const key of ['iPos', 'iSize', 'iVar', 'iTour']) {
        const a = detail.attributes[key];
        assert.ok(same(bytesOf(a), a.array, k * a.itemSize), `${name}: twin ${i} ${key} on the GPU is its first ${k} trees`);
      }
      for (const g of lite ? [detail, lite] : [detail]) {
        const draws = state.draws.filter((d) => d.drawing === g);
        if (k) assert.ok(draws.length > 0, `${name}: twin ${i} draws`);
        for (const d of draws) assert.equal(d.instances, k, `${name}: twin ${i} draws its ${k} trees`);
        drawn += draws.length;
      }
    });
    assert.ok(drawn > 0);
    for (const [b, g] of layer.boards.entries()) {
      const a = g.attributes.iTour;
      assert.ok(same(bytesOf(a), a.array, a.count), `${name}: board ${b}'s flags on the GPU are boardFlags`);
      assert.ok(state.draws.some((d) => d.drawing === g && d.instances === g.instanceCount), `${name}: board ${b} draws`);
    }
    const short = state.draws.filter((d) => d.short?.length);
    assert.equal(short.length, 0, `${name}: ${short.length} draws read past an instanced attribute`);
  }
  renderer.dispose();
  forest.dispose();
});
