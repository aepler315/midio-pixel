// The forest culling through a real three.js render (vendored r186) on a
// recording WebGL2 context: a culled batch loses its draw call and nothing
// else. Every program bind, vertex array bind and remaining draw happens in
// the same order as an unculled render of the same scene.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from '../src/vendor/range/three-range.module.js';
import fs from 'node:fs';
import { attachForestCulling, restoreForestCulling, SPAN_ALIGN } from '../src/world/alpine/ForestCulling.js';
import { attachTerrainCulling, chunkTable, setChunks } from '../src/world/alpine/TerrainChunks.js';
import { createForest } from '../src/world/alpine/ForestGL.js';
import { setTerrainDrawMode } from '../src/world/alpine/RailDraw.js';
import { recordingWebGL2 } from './helpers/recordingWebGL2.mjs';

// Rows: x, y, z, height, width, species, id, band. Species picks the family
// (below .5 or not), so each group below is its own batch.
const row = (x, z, species, band) => [x, 0, z, 14, 5, species, .5, band];
const FRONT = -120, BEHIND = 3000;

function forest({ mixed = false, mixedDetail = false, ...options } = {}) {
  const meshDetail = [], mesh = [], billboard = [];
  // Every batch its own size, so a count put back on the wrong batch shows.
  const each = (n, f) => { for (let i = 0; i < n; i++) f(i * 8 - 12); };
  each(4, x => mesh.push(...row(x, FRONT, .2, 1)));
  each(3, x => mesh.push(...row(x, BEHIND, .8, 1)));
  // mixed: as many trees of the first batch again, behind the camera.
  if (mixed) each(4, x => mesh.push(...row(x, BEHIND + 30, .2, 1)));
  each(2, x => meshDetail.push(...row(x, FRONT - 10, .8, 2)));
  each(5, x => meshDetail.push(...row(x, BEHIND + 10, .2, 2)));
  // mixedDetail: four trees of the detail batch behind, in front of the
  // camera after its five behind it (a detail batch, so it has a lite twin).
  if (mixedDetail) each(4, x => meshDetail.push(...row(x, FRONT - 20, .2, 2)));
  each(4, x => billboard.push(...row(x, BEHIND + 20, .2, 0)));
  const uniforms = { uDeformAmp: { value: 3 }, uDeformKick: { value: 1 }, uDeformStructural: { value: 0 },
    uDeformMelodic: { value: 0 }, uDeformGesture: { value: 0 }, uLandDance: { value: new THREE.Vector4() } };
  return createForest(THREE, { meshDetail: new Float32Array(meshDetail), mesh: new Float32Array(mesh),
    billboard: new Float32Array(billboard), stride: 8, count: (meshDetail.length + mesh.length + billboard.length) / 8,
    ...(options.railCount ? { railCount: options.railCount } : {}) }, uniforms, options);
}

function setup({ terrain = null } = {}) {
  const { gl, canvas, state } = recordingWebGL2(300, 150);
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  renderer.autoClear = false;
  const f = forest();
  const scene = new THREE.Scene();
  const meshes = [...f.byBand.far, ...f.byBand.mid, ...f.byBand.near, ...f.depth];
  scene.add(...meshes);
  if (terrain) scene.add(terrain);
  // Each object marks the timeline as three reaches it, so a draw can be
  // traced to its batch.
  let thrower = null;
  for (const m of scene.children) m.onBeforeRender = () => { if (m === thrower) throw new Error('mid-render'); state.ops.push(['object', m]); };
  const camera = new THREE.PerspectiveCamera(60, 2, 1, 6000);
  camera.layers.enable(1); camera.layers.enable(2);
  const look = z => { camera.position.set(0, 7, 0); camera.lookAt(0, 7, z); camera.updateMatrixWorld(); };
  look(-1);
  const target = new THREE.WebGLRenderTarget(300, 150);
  const ids = new Map();
  const id = o => { if (!ids.has(o)) ids.set(o, ids.size); return ids.get(o); };
  // The timeline as text: which object, program, vertex array, and draw.
  const timeline = () => state.ops.splice(0).map(([op, v]) => op === 'object' ? `object ${scene.children.indexOf(v)}`
    : op === 'draw' ? `draw ${v.count}x${v.instances ?? 1}@${v.offset}` : `${op} ${id(v)}`);
  const render = () => { renderer.setRenderTarget(target); renderer.render(scene, camera); state.draws.length = 0; return timeline(); };
  // Its trees' z: every tree of a batch is in front of the camera or behind it.
  const side = g => g.attributes.iPos.getZ(0) < 0 ? 'front' : 'behind';
  const forestGeos = [...new Set(meshes.map(m => m.geometry))];
  const counts = () => forestGeos.map(g => g.instanceCount);
  const discard = () => { state.ops.length = 0; state.draws.length = 0; };
  return { renderer, scene, camera, look, target, f, meshes, forestGeos, counts, render, discard, side, setThrower: m => { thrower = m; } };
}

// True when a draw follows `mesh`'s object before the next object.
function drew(timeline, scene, mesh) {
  const at = timeline.indexOf(`object ${scene.children.indexOf(mesh)}`);
  assert.ok(at >= 0, 'three reached the object');
  for (const line of timeline.slice(at + 1)) {
    if (line.startsWith('draw ')) return true;
    if (line.startsWith('object ')) return false;
  }
  return false;
}

// What an unculled timeline becomes when the batches `culled` lose their
// draw calls: every draw that follows one of their objects goes.
function withoutDraws(timeline, scene, culled) {
  let current = null;
  return timeline.filter(line => {
    if (line.startsWith('object ')) current = scene.children[+line.slice(7)];
    return !(line.startsWith('draw ') && current && culled.has(current.geometry));
  });
}

test('a culled batch loses only its draw call: every bind and every other draw stays in order', () => {
  const s = setup();
  s.render(); // compile and upload
  const plain = s.render();
  const before = s.counts();
  const stats = { kept: 0, total: 0, batches: 0 };
  attachForestCulling(s.scene, stats);
  const culledRender = s.render();
  // Mesh batches behind the camera; billboards are never culled.
  const behind = new Set(s.forestGeos.filter(g => g.userData.forestCull && s.side(g) === 'behind'));
  assert.equal(behind.size, 3, 'a mesh-ring batch, and a detail-ring batch with its lite twin, behind');
  const drawn = new Set(s.meshes.filter(m => m.visible).map(m => m.geometry));
  const culled = new Set([...behind].filter(g => drawn.has(g)));
  assert.equal(culled.size, 2, 'the lite twins are hidden: only the mesh ring and the detail batches draw');
  assert.ok(plain.filter(l => l.startsWith('draw ')).length > culledRender.filter(l => l.startsWith('draw ')).length);
  assert.deepEqual(culledRender, withoutDraws(plain, s.scene, culled));
  // The billboards behind the camera still draw.
  const boards = s.meshes.filter(m => !m.geometry.userData.forestCull);
  assert.ok(boards.length > 0);
  for (const b of boards) assert.ok(drew(culledRender, s.scene, b), 'billboard');
  // Counts are back after the render; stats count each geometry once.
  assert.deepEqual(s.counts(), before);
  const trees = [...drawn].filter(g => g.userData.forestCull).reduce((n, g) => n + g.instanceCount, 0);
  assert.deepEqual(stats, { kept: trees - 3 - 5, total: trees, batches: 2 });
  assert.deepEqual([...culled].map(g => g.instanceCount).sort(), [3, 5]);
});

test('each render culls for its own camera: turned around, the other batches go', () => {
  const s = setup();
  s.render();
  s.look(1);
  const plain = s.render();
  attachForestCulling(s.scene);
  const culledRender = s.render();
  const culled = new Set(s.meshes.filter(m => m.visible && m.geometry.userData.forestCull && s.side(m.geometry) === 'front').map(m => m.geometry));
  assert.equal(culled.size, 2);
  assert.deepEqual(culledRender, withoutDraws(plain, s.scene, culled));
  // Back again in the same frame: the first set is culled, the second drawn.
  s.look(-1);
  const ahead = s.render();
  assert.ok(ahead.some(l => l.startsWith('draw ')));
  for (const m of s.meshes) {
    if (m.visible && culled.has(m.geometry)) assert.ok(drew(ahead, s.scene, m), 'a front batch draws when the camera faces it');
  }
});

test('a scissored target culls what falls outside its rectangle', () => {
  const s = setup();
  s.render();
  // Left fifth of the target: the trees (x from -12 to 12 m at 120 m) sit in
  // the middle of the view, so every front batch is outside.
  s.target.scissor.set(0, 0, 60, 150); s.target.scissorTest = true;
  const plain = s.render();
  attachForestCulling(s.scene);
  const culledRender = s.render();
  const culled = new Set(s.meshes.filter(m => m.visible && m.geometry.userData.forestCull).map(m => m.geometry));
  assert.equal(culled.size, 4);
  assert.deepEqual(culledRender, withoutDraws(plain, s.scene, culled));
});

test('a render that throws leaves its counts to the next render, which restores them before culling', () => {
  const s = setup();
  s.render();
  const before = s.counts();
  attachForestCulling(s.scene);
  const good = s.render();
  // The last object three reaches throws after the cull.
  const last = s.scene.children[+good.filter(l => l.startsWith('object ')).at(-1).slice(7)];
  s.setThrower(last);
  assert.throws(() => s.render(), /mid-render/);
  s.discard();
  const left = s.counts();
  assert.ok(left.some((c, i) => c === 0 && before[i] > 0), 'the culled counts are still 0');
  s.setThrower(null);
  // The next render faces the other way: the batches the aborted render
  // culled are in view, so they must have their counts back and draw.
  s.look(1);
  const turned = s.render();
  const stale = s.meshes.filter(m => m.visible && m.geometry.userData.forestCull && s.side(m.geometry) === 'behind');
  assert.ok(stale.length > 0);
  for (const m of stale) assert.ok(drew(turned, s.scene, m), 'a batch the aborted render culled draws again');
  assert.deepEqual(s.counts(), before);
  // three keeps the aborted render's state on its stack, so a later render
  // may bind differently; the draws must not differ.
  s.look(-1);
  const again = s.render().filter(l => l.startsWith('draw ') || l.startsWith('object '));
  assert.deepEqual(again, good.filter(l => l.startsWith('draw ') || l.startsWith('object ')));
  assert.deepEqual(s.counts(), before);
});

test('what a render that throws leaves at 0 is back before another scene draws it or the detail view reads it', () => {
  const { gl, canvas, state } = recordingWebGL2(300, 150);
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  renderer.autoClear = false;
  const f = forest();
  // The colour meshes and the depth meshes of the same batches: two scenes,
  // one geometry each batch, as RangeScene's band and depth scenes.
  const colour = new THREE.Scene(), depth = new THREE.Scene();
  colour.add(...f.byBand.far, ...f.byBand.mid, ...f.byBand.near);
  depth.add(...f.depth);
  const camera = new THREE.PerspectiveCamera(60, 2, 1, 6000);
  camera.layers.enable(1); camera.layers.enable(2);
  const look = z => { camera.position.set(0, 7, 0); camera.lookAt(0, 7, z); camera.updateMatrixWorld(); };
  look(-1);
  const target = new THREE.WebGLRenderTarget(300, 150);
  const render = scene => { renderer.setRenderTarget(target); renderer.render(scene, camera); };
  render(colour); render(depth);
  const geos = [...new Set([...colour.children, ...depth.children].map(m => m.geometry))];
  const before = geos.map(g => g.instanceCount);
  attachForestCulling(colour); attachForestCulling(depth);
  let fail = true;
  // A batch in front of the camera: three reaches it after the cull.
  const front = colour.children.find(m => m.visible && m.geometry.userData.forestCull && m.geometry.attributes.iPos.getZ(0) < 0);
  front.onBeforeRender = () => { if (fail) throw new Error('mid-render'); };
  assert.throws(() => render(colour), /mid-render/);
  const behind = geos.filter(g => g.userData.forestCull && g.attributes.iPos.getZ(0) > 0);
  assert.ok(behind.some(g => g.instanceCount === 0), 'the colour scene left its culled batches at 0');
  // The depth scene, turned towards them, draws them in full.
  fail = false;
  look(1);
  const drawn = [];
  for (const m of depth.children) m.onBeforeRender = () => drawn.push([m.geometry, m.geometry.instanceCount]);
  state.draws.length = 0;
  render(depth);
  // (The batches now behind the camera are this render's own culls.)
  const faced = drawn.filter(([g]) => behind.includes(g));
  assert.ok(faced.length > 0);
  for (const [g, n] of faced) assert.equal(n, before[geos.indexOf(g)], 'a batch the colour scene culled draws its own count');
  assert.deepEqual(geos.map(g => g.instanceCount), before);
  // A throw again, then the detail view: its footprints read the real counts.
  look(-1);
  fail = true;
  assert.throws(() => render(colour), /mid-render/);
  assert.ok(behind.some(g => g.instanceCount === 0));
  f.updateDetailView({ camera, width: 300, height: 150, pixelated: true });
  assert.deepEqual(geos.map(g => g.instanceCount), before);
});

test('RangeScene puts culled counts back before it switches a view between rail and tour', () => {
  const src = fs.readFileSync(new URL('../src/world/alpine/RangeScene.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('  _setTerrainMode(p) {'));
  assert.match(body.slice(0, body.indexOf('\n  }\n')), /restoreForestCulling\(\);\s*for \(const g of p\.modeGeometries \|\| \[\]\) setTerrainDrawMode\(g, mode\);/);
});

test('chained after the terrain culling, both cull and both restore', () => {
  // One chunked band: a tile in front of the camera and one behind it.
  const PER_TILE = 3 * 4000, positions = [], index = [];
  let v = 0;
  for (const z of [FRONT, BEHIND]) for (let t = 0; t < PER_TILE / 3; t++) {
    positions.push(-5, 0, z, 5, 0, z, 0, 0, z - 10); index.push(v, v + 1, v + 2); v += 3;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1));
  g.computeBoundingSphere();
  setChunks(g, chunkTable(Uint32Array.from([0, PER_TILE]), Uint32Array.from([PER_TILE, PER_TILE]),
    Float64Array.from([-5, 0, FRONT - 10, 5, 0, FRONT, -5, 0, BEHIND - 10, 5, 0, BEHIND])));
  const material = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3,
    vertexShader: 'void main(){gl_Position=projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.);}',
    fragmentShader: 'out vec4 c; void main(){c=vec4(1);}' });
  const band = new THREE.Mesh(g, [material]); band.frustumCulled = false;
  const s = setup({ terrain: band });
  s.render();
  const before = s.counts();
  const terrainStats = { kept: 0, total: 0, groups: 0 }, forestStats = { kept: 0, total: 0, batches: 0 };
  attachTerrainCulling(s.scene, () => ({ lo: 0, hi: 0 }), terrainStats);
  // The terrain's hooks run inside the forest's: before the forest culls,
  // and after it restores.
  const seen = {};
  const terrainBefore = s.scene.onBeforeRender, terrainAfter = s.scene.onAfterRender;
  s.scene.onBeforeRender = function (...a) { seen.before = s.counts(); terrainBefore.apply(this, a); };
  s.scene.onAfterRender = function (...a) { seen.after = s.counts(); seen.culled = g.groups.length; terrainAfter.apply(this, a); };
  attachForestCulling(s.scene, forestStats);
  const out = s.render();
  const terrainLine = out.indexOf(`object ${s.scene.children.indexOf(band)}`);
  assert.equal(out[terrainLine + 1 + out.slice(terrainLine + 1).findIndex(l => l.startsWith('draw '))], `draw ${PER_TILE}x1@0`);
  assert.equal(out.filter(l => l.startsWith(`draw ${PER_TILE}x1@`)).length, 1, 'the tile behind is culled');
  assert.equal(forestStats.batches, 2);
  assert.ok(terrainStats.total > 0);
  assert.deepEqual(seen, { before, after: before, culled: 1 });
  assert.deepEqual(s.counts(), before);
  assert.deepEqual(g.groups.map(x => [x.start, x.count]), [[0, Infinity]]);
});

// A two-camera forest: the rail draws the leading trees of each ring.
const RAIL = { meshDetail: 2, mesh: 5, billboard: 2 };

// gpu: the context keeps buffer bytes, and each instanced draw records the
// mesh it draws with the attribute objects it draws from (drawing), and the
// bytes its instances read (reads).
function tourScene({ tour = null, mixed = false, mixedDetail = false, gpu = false } = {}) {
  const { gl, canvas, state } = recordingWebGL2(300, 150, { gpu });
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  renderer.autoClear = false;
  const f = forest({ railCount: RAIL, tour, mixed, mixedDetail });
  const scene = new THREE.Scene();
  scene.add(...f.byBand.far, ...f.byBand.mid, ...f.byBand.near, ...f.depth);
  // As RangeScene adds them: after the static forest, hidden.
  if (f.tour) scene.add(...f.tour.byBand.far, ...f.tour.byBand.mid, ...f.tour.byBand.near, ...f.tour.depth);
  let thrower = null;
  for (const m of scene.children) m.onBeforeRender = () => {
    if (m === thrower) throw new Error('mid-render');
    state.drawing = { mesh: m, attributes: { ...m.geometry.attributes } };
    state.ops.push(['object', m, m.geometry.instanceCount]);
  };
  const camera = new THREE.PerspectiveCamera(60, 2, 1, 6000);
  camera.layers.enable(1); camera.layers.enable(2);
  const look = z => { camera.position.set(0, 7, 0); camera.lookAt(0, 7, z); camera.updateMatrixWorld(); };
  look(-1);
  const target = new THREE.WebGLRenderTarget(300, 150);
  const ids = new Map();
  const id = o => { if (!ids.has(o)) ids.set(o, ids.size); return ids.get(o); };
  const timeline = () => state.ops.splice(0).map(([op, v]) => op === 'object' ? `object ${scene.children.indexOf(v)}`
    : op === 'draw' ? `draw ${v.count}x${v.instances ?? 1}@${v.offset}` : `${op} ${id(v)}`);
  const objects = () => state.ops.filter(([op]) => op === 'object').map(([, m, n]) => [m, n]);
  // The render's draw records (its timeline stays in state.ops).
  const render = () => { renderer.setRenderTarget(target); renderer.render(scene, camera); return state.draws.splice(0); };
  return { f, scene, state, camera, render, timeline, objects, look, setThrower: m => { thrower = m; } };
}

test('with the tour layer the rail\'s render is the same render, call for call', () => {
  const plain = tourScene(), layered = tourScene({ tour: { seed: 5 } });
  for (const s of [plain, layered]) {
    s.f.applyVisibility();
    attachForestCulling(s.scene, { kept: 0, total: 0, batches: 0 });
  }
  for (const s of [plain, layered]) s.render();
  const [a, b] = [plain, layered].map(s => { s.render(); return s.timeline(); });
  assert.ok(a.filter(l => l.startsWith('draw ')).length > 0);
  assert.deepEqual(b, a);
  // Among them a fully shared batch, which the layer gave { rail: n, tour: 0 }.
  assert.ok(layered.f.modeGeometries.some(g => g.attributes.aBranch && g.instanceCount === g.attributes.iPos.count && g.userData.instanceCounts.tour === 0));
});

// tour.spans false is the kill switch: each twin is culled whole, as a
// static batch (main's path).
test('with spans off (the kill switch) a tour render draws no static mesh-ring batch and only the twins that hold trees; a twin is culled whole, over the trees it now holds', () => {
  const s = tourScene({ tour: { seed: 5, spans: false }, mixed: true }), t = s.f.tour, index = t.index;
  for (const g of s.f.modeGeometries) setTerrainDrawMode(g, 'tour');
  t.setMode('tour');
  // Window sets by side of the camera (it looks down -z).
  const fill = keep => {
    const bits = new Uint32Array(index.words);
    for (let u = 0; u < index.count; u++) if (keep(index.pos[3 * u + 2])) bits[u >>> 5] |= 1 << (u & 31);
    assert.ok(t.apply({ a: { bits }, b: { bits }, f: 1 }));
    s.f.applyVisibility();
  };
  const twinGeos = t.twins.flatMap(({ detail, lite }) => lite ? [detail, lite] : [detail]);
  const counts = () => twinGeos.map(g => g.instanceCount);
  const front = g => g.instanceCount > 0 && [...Array(g.instanceCount).keys()].some(j => g.attributes.iPos.getZ(j) < 0);
  const tourMeshes = new Set(t.byBand.far.concat(t.byBand.mid, t.byBand.near, t.depth));
  const statics = new Set([...s.f.byBand.far, ...s.f.byBand.mid, ...s.f.byBand.near, ...s.f.depth].filter(m => m.userData.tourStatic));
  assert.ok(statics.size > 0);
  // The draws of each reached object, in order.
  const drawsOf = lines => {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('object ')) continue;
      const m = s.scene.children[+lines[i].slice(7)];
      const next = lines.slice(i + 1).find(l => l.startsWith('draw ') || l.startsWith('object '));
      out.push([m, !!next?.startsWith('draw ')]);
    }
    return out;
  };
  // Unculled, every tree: a twin draws exactly when it holds trees.
  fill(() => true);
  s.render(); s.state.ops.length = 0;
  const all = counts();
  s.render();
  const plain = s.timeline();
  const reachedPlain = drawsOf(plain);
  assert.ok(reachedPlain.every(([m]) => !statics.has(m)), 'no static mesh-ring batch is reached');
  for (const [m, drew] of reachedPlain) {
    if (twinGeos.includes(m.geometry)) assert.equal(drew, m.geometry.instanceCount > 0, 'a twin draws exactly when it holds trees');
    if (drew && !tourMeshes.has(m)) assert.ok(!m.geometry.attributes.aBranch, 'only boards draw beside the twins');
  }
  // The mixed twin holds trees on both sides; the others on one.
  const mixedTwin = twinGeos.find(g => g.instanceCount === 8);
  assert.ok(mixedTwin && front(mixedTwin));
  // Culled: the twins whose every tree is behind lose their draws, and only those.
  const stats = { kept: 0, total: 0, batches: 0 };
  attachForestCulling(s.scene, stats);
  s.render();
  const culledAll = s.timeline();
  const behind = new Set(twinGeos.filter(g => g.instanceCount > 0 && !front(g)));
  assert.ok(behind.size > 0);
  assert.deepEqual(culledAll, withoutDraws(plain, s.scene, behind));
  assert.deepEqual(counts(), all, 'every twin has its count back');
  assert.ok(stats.total > 0 && stats.batches > 0, 'the twins were tested');
  // Refill in place with the trees in front: every twin holding trees draws.
  // The mixed twin then holds four, as it does when refilled with those behind:
  // only the refill (not the count) can tell its bound apart.
  const check = (keep, side) => {
    fill(keep);
    const n = counts();
    assert.equal(mixedTwin.instanceCount, 4);
    s.render();
    for (const [m, drew] of drawsOf(s.timeline())) {
      if (!twinGeos.includes(m.geometry) || !(m.geometry.instanceCount > 0)) continue;
      assert.equal(drew, side === 'front', `${side}: a twin holding trees ${side === 'front' ? 'draws' : 'is culled'}`);
    }
    assert.deepEqual(counts(), n);
  };
  check(z => z < 0, 'front');
  check(z => z > 0, 'behind');
  check(z => z < 0, 'front');
  check(z => z > 0, 'behind');
});

test('with spans off (the kill switch) a tour refill and a switch to the rail put back what a thrown render culled before they set the twins\' counts', () => {
  const s = tourScene({ tour: { seed: 5, spans: false }, mixed: true }), t = s.f.tour, index = t.index;
  for (const g of s.f.modeGeometries) setTerrainDrawMode(g, 'tour');
  t.setMode('tour');
  const fill = keep => {
    const bits = new Uint32Array(index.words);
    for (let u = 0; u < index.count; u++) if (keep(index.pos[3 * u + 2])) bits[u >>> 5] |= 1 << (u & 31);
    assert.ok(t.apply({ a: { bits }, b: { bits }, f: 1 }));
    s.f.applyVisibility();
  };
  const twinGeos = t.twins.flatMap(({ detail, lite }) => lite ? [detail, lite] : [detail]);
  const counts = () => twinGeos.map(g => g.instanceCount);
  // The last object three reaches throws, after the cull has set its 0s.
  const throwAfterCull = () => {
    s.state.ops.length = 0;
    s.render();
    s.setThrower(s.objects().at(-1)[0]);
    const set = counts();
    assert.throws(() => s.render(), /mid-render/);
    s.setThrower(null);
    s.state.ops.length = 0;
    assert.ok(counts().some((n, i) => n === 0 && set[i] > 0), 'the thrown render left a twin at 0');
  };
  attachForestCulling(s.scene);
  // Window 1, the trees behind the camera (it looks down -z): the mixed
  // twin holds its 4 trees there, is culled, and the render throws.
  fill(z => z > 0);
  const mixedTwin = twinGeos.find(g => g.instanceCount === 4 && g.attributes.iPos.getZ(0) > 0);
  throwAfterCull();
  assert.equal(mixedTwin.instanceCount, 0);
  // Window 2, every tree: apply() refills the mixed twin to 8 in place, its
  // 4 trees in front of the camera first. Turned to face the others, the
  // stale 4 would bound those front trees alone and cull trees in view.
  fill(() => true);
  const want = counts();
  assert.equal(mixedTwin.instanceCount, 8);
  s.look(1);
  s.state.ops.length = 0;
  s.render();
  const faces = g => [...Array(want[twinGeos.indexOf(g)]).keys()].some(j => g.attributes.iPos.getZ(j) > 0);
  const reached = s.objects().filter(([m]) => twinGeos.includes(m.geometry) && faces(m.geometry));
  assert.ok(reached.some(([m]) => m.geometry === mixedTwin));
  for (const [m, n] of reached) assert.equal(n, want[twinGeos.indexOf(m.geometry)], 'a twin in view draws the count apply() set');
  assert.deepEqual(counts(), want, 'every twin keeps apply()\'s count');
  // A throw again, then the rail: setMode's 0s must outlast the next render.
  throwAfterCull();
  t.setMode('rail');
  for (const g of s.f.modeGeometries) setTerrainDrawMode(g, 'rail');
  s.f.applyVisibility();
  s.render();
  assert.ok(!s.objects().some(([m]) => twinGeos.includes(m.geometry)), 'the rail reaches no twin');
  assert.deepEqual(counts(), twinGeos.map(() => 0), 'no culled twin count comes back on the rail');
});

// Twin spans (forestCull.spans, on unless tour.spans is false). Every tree
// here stands far ahead of the camera or far behind it, so the trees a
// render can see are known exactly.

// The per-tree attributes a span reads from an offset.
const PER_TREE = ['iPos', 'iSize', 'iVar', 'iTour'];
const hex = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('hex');
// Trees first to last of a twin's per-tree attribute, as apply() wrote them.
const treeBytes = (g, name, first, last) => {
  const { data } = g.attributes[name], bpe = data.array.BYTES_PER_ELEMENT;
  return hex(new Uint8Array(data.array.buffer, data.array.byteOffset + first * data.stride * bpe, (last - first + 1) * data.stride * bpe));
};
// The trees of a twin's prefix that a camera seeing the z values `sees` sees.
const inView = (g, sees) => [...Array(g.instanceCount).keys()].filter(j => sees(g.attributes.iPos.getZ(j)));
// The span a twin must draw: from its first tree in view, rounded down to
// SPAN_ALIGN, to its last; null when it holds none.
const spanOf = (g, sees) => {
  const seen = inView(g, sees);
  return seen.length ? [seen[0] - seen[0] % SPAN_ALIGN, seen.at(-1)] : null;
};

// The draws of each object three reached, in order: [mesh, drew].
function reachedDraws(lines, scene) {
  const out = [];
  lines.forEach((line, i) => {
    if (!line.startsWith('object ')) return;
    const next = lines.slice(i + 1).find(l => l.startsWith('draw ') || l.startsWith('object '));
    out.push([scene.children[+line.slice(7)], !!next?.startsWith('draw ')]);
  });
  return out;
}

// A tour scene on the tour, with its twins and window fills: keep(x, z)
// picks the trees of the window set.
function onTour(s) {
  const t = s.f.tour, index = t.index;
  for (const g of s.f.modeGeometries) setTerrainDrawMode(g, 'tour');
  t.setMode('tour');
  const twinGeos = t.twins.flatMap(({ detail, lite }) => lite ? [detail, lite] : [detail]);
  const apply = keep => {
    const bits = new Uint32Array(index.words);
    for (let u = 0; u < index.count; u++) if (keep(index.pos[3 * u], index.pos[3 * u + 2])) bits[u >>> 5] |= 1 << (u & 31);
    assert.ok(t.apply({ a: { bits }, b: { bits }, f: 1 }));
  };
  const fill = keep => { apply(keep); s.f.applyVisibility(); };
  const counts = () => twinGeos.map(g => g.instanceCount);
  // Each twin's own per-tree attributes, as built: offset 0.
  const own = twinGeos.map(g => PER_TREE.map(name => g.attributes[name]));
  const isOwn = g => PER_TREE.every((name, k) => g.attributes[name] === own[twinGeos.indexOf(g)][k] && g.attributes[name].offset === 0);
  // A render that throws after the cull: the last object three reaches throws.
  const throwAfterCull = () => {
    s.state.ops.length = 0;
    s.render();
    s.setThrower(s.objects().at(-1)[0]);
    assert.throws(() => s.render(), /mid-render/);
    s.setThrower(null);
    // The thrown render's draws are not the next render's.
    s.state.ops.length = 0; s.state.draws.length = 0;
  };
  return { t, twinGeos, apply, fill, counts, own, isOwn, throwAfterCull };
}

// Checks every twin draw of one render with spans: it draws its span, each
// per-tree attribute read from the span's first tree on, and every twin mesh
// three reached draws exactly when its twin holds a tree in view. Returns
// the draws whose span starts past tree 0.
function checkSpans(draws, lines, scene, twinGeos, sees, label) {
  let offset = 0;
  for (const d of draws) {
    const { mesh, attributes } = d.drawing, g = mesh.geometry;
    if (!twinGeos.includes(g)) continue;
    // The span this draw read: its per-tree attributes' offset, its instances.
    const first = attributes.iPos.offset / attributes.iPos.data.stride, last = first + d.instances - 1;
    for (const name of PER_TREE) assert.equal(attributes[name].offset, first * attributes[name].data.stride, `${label}: ${name} starts at tree ${first} too`);
    for (const j of inView(g, sees)) assert.ok(first <= j && j <= last, `${label}: tree ${j} in view is in the span ${first}..${last}`);
    const span = spanOf(g, sees);
    assert.ok(span, `${label}: a twin with no tree in view draws nothing`);
    assert.deepEqual([first, last], span, `${label}: the span runs from the first tree in view, rounded down to ${SPAN_ALIGN}, to the last`);
    assert.deepEqual(d.short, [], `${label}: no attribute reads past its buffer`);
    for (const name of PER_TREE) assert.equal(hex(d.reads[name]), treeBytes(g, name, ...span), `${label}: ${name} reads trees ${span[0]} to ${span[1]}, as apply() wrote them`);
    if (first > 0) offset++;
  }
  for (const [m, drew] of reachedDraws(lines, scene)) {
    if (twinGeos.includes(m.geometry)) assert.equal(drew, !!spanOf(m.geometry, sees), `${label}: a twin draws exactly when it holds a tree in view`);
  }
  return offset;
}

// What a spans-off timeline becomes with spans: the same lines in the same
// order, each twin draw's instance count its span's.
function withSpans(lines, scene, twinGeos, sees) {
  let current = null;
  return lines.map(line => {
    if (line.startsWith('object ')) current = scene.children[+line.slice(7)];
    if (!line.startsWith('draw ') || !twinGeos.includes(current.geometry)) return line;
    const span = spanOf(current.geometry, sees);
    assert.ok(span, 'spans off, a twin draws only when it holds a tree in view');
    return line.replace(/x\d+@/, `x${span[1] - span[0] + 1}@`);
  });
}

test('with spans a twin in view draws only its span, read from its first tree on, and the render adds no draw to spans off', () => {
  // The same forest twice: spans on (the default) and off (the kill switch).
  const on = tourScene({ tour: { seed: 5 }, mixed: true, mixedDetail: true, gpu: true });
  const off = tourScene({ tour: { seed: 5, spans: false }, mixed: true, mixedDetail: true, gpu: true });
  const [a, b] = [on, off].map(onTour);
  assert.ok(a.twinGeos.every(g => g.userData.forestCull.spans) && b.twinGeos.every(g => !g.userData.forestCull.spans));
  const stats = { kept: 0, total: 0, batches: 0 };
  attachForestCulling(on.scene, stats); attachForestCulling(off.scene);
  // Every tree: the first render uploads each twin's whole buffers.
  for (const s of [a, b]) s.fill(() => true);
  on.render(); off.render(); on.timeline(); off.timeline();
  const held = a.counts();
  let offset = 0;
  // keep picks the window set; z the way the camera looks (down -z sees the
  // trees at FRONT, up +z those at BEHIND).
  const check = (keep, z, label) => {
    for (const s of [a, b]) s.fill(keep);
    on.look(z); off.look(z);
    const sees = z < 0 ? v => v < 0 : v => v > 0;
    const n = a.counts();
    assert.deepEqual(b.counts(), n);
    const draws = on.render(), lines = on.timeline();
    const whole = off.render(), plain = off.timeline();
    assert.ok(plain.some(l => l.startsWith('draw ')));
    offset += checkSpans(draws, lines, on.scene, a.twinGeos, sees, label);
    // Spans off culls a twin whole: with spans the render is that render,
    // line for line, only with each twin draw's count its span's ...
    assert.deepEqual(lines, withSpans(plain, off.scene, b.twinGeos, sees), `${label}: the spans-off render, with spans`);
    // ... and each draw reads the same bytes, a twin's only those of its span.
    assert.equal(draws.length, whole.length);
    draws.forEach((d, i) => {
      const w = whole[i], g = d.drawing.mesh.geometry;
      assert.equal(on.scene.children.indexOf(d.drawing.mesh), off.scene.children.indexOf(w.drawing.mesh));
      assert.deepEqual(Object.keys(d.reads), Object.keys(w.reads));
      const span = a.twinGeos.includes(g) ? spanOf(g, sees) : null;
      // Each attribute is read as spans off reads it (type, normalization,
      // stride, divisor); only a per-tree one's start may move.
      assert.deepEqual(Object.keys(d.pointers).sort(), Object.keys(w.pointers).sort());
      for (const [name, p] of Object.entries(w.pointers)) {
        const { offsetBytes, ...how } = d.pointers[name], { offsetBytes: wholeOffset, ...want } = p;
        assert.deepEqual(how, want, `${label}: ${name} is read as spans off reads it`);
        if (!(span && PER_TREE.includes(name))) assert.equal(offsetBytes, wholeOffset, `${label}: ${name} starts where it does spans off`);
      }
      for (const [name, bytes] of Object.entries(w.reads)) {
        const each = bytes.length / w.instances;
        const want = span && PER_TREE.includes(name) ? bytes.subarray(span[0] * each, (span[1] + 1) * each) : bytes;
        assert.equal(hex(d.reads[name]), hex(want), `${label}: ${name} reads the spans-off draw's bytes${span ? ' of the span' : ''}`);
      }
    });
    // Counts and per-tree attributes are back after the render.
    assert.deepEqual(a.counts(), n, `${label}: every twin has its count back`);
    assert.ok(a.twinGeos.every(a.isOwn), `${label}: every twin has its own per-tree attributes back`);
    return draws;
  };
  // Every tree, seen down -z: the mixed twin (4 trees there, then 4 behind)
  // draws its first 4; the detail twin (5 behind, then 4 there) trees 4 to
  // 8, its fifth behind kept by the alignment.
  const mixed = a.twinGeos.find(g => g.instanceCount === 8), detail = a.twinGeos.find(g => g.instanceCount === 9);
  assert.ok(mixed && detail && held.filter(n => n > 0).length >= 4);
  const ahead = check(() => true, -1, 'every tree, down -z');
  assert.ok(ahead.some(d => d.drawing.mesh.geometry === mixed && d.drawing.attributes.iPos.offset === 0 && d.instances === 4));
  assert.ok(ahead.some(d => d.drawing.mesh.geometry === detail && d.drawing.attributes.iPos.offset === 4 * 3 && d.instances === 5));
  // Up +z: the mixed twin draws its last 4, from tree 4.
  const back = check(() => true, 1, 'every tree, up +z');
  assert.ok(back.some(d => d.drawing.mesh.geometry === mixed && d.drawing.attributes.iPos.offset === 4 * 3 && d.instances === 4));
  // Refills in place (same buffers, update ranges): each refill's span reads
  // the bytes this refill wrote, the last of its trees included.
  check((x, z) => z < 0, -1, 'the trees down -z, seen');
  check((x, z) => z > 0, 1, 'the trees up +z, seen');
  check((x, z) => z > 0, -1, 'the trees up +z, unseen');
  check((x, z) => !(x === -12 && z === BEHIND + 30), 1, 'every tree but one, up +z');
  check(() => true, -1, 'every tree again, down -z');
  assert.ok(offset > 0, 'some spans started past tree 0');
  assert.ok(stats.total > 0 && stats.kept < stats.total && stats.batches > 0, 'the twins were tested, and some culled');
});

test('with spans a tour refill and a switch to the rail put back the span a thrown render left in a twin before they set its count', () => {
  const s = tourScene({ tour: { seed: 5 }, mixed: true, gpu: true });
  const { t, twinGeos, apply, fill, counts, isOwn, throwAfterCull } = onTour(s);
  attachForestCulling(s.scene);
  // Up +z the camera sees the trees at BEHIND.
  const sees = z => z > 0;
  const render = label => {
    const n = counts(), draws = s.render(), lines = s.timeline();
    const offset = checkSpans(draws, lines, s.scene, twinGeos, sees, label);
    assert.deepEqual(counts(), n, `${label}: every twin keeps apply()'s count`);
    assert.ok(twinGeos.every(isOwn), `${label}: every twin has its own per-tree attributes back`);
    return { draws, lines, offset };
  };
  // Window 1, every tree: the mixed twin holds 4 trees at FRONT, then 4 in
  // view. The render throws after the cull has put in its span, trees 4 to 7.
  fill(() => true);
  s.look(1);
  const mixed = twinGeos.find(g => g.instanceCount === 8);
  assert.ok(mixed);
  assert.ok(render('every tree').offset > 0);
  throwAfterCull();
  assert.equal(mixed.attributes.iPos.offset, 4 * 3, 'the thrown render left the span in: per-tree attributes from tree 4');
  assert.equal(mixed.instanceCount, 4, 'and the span\'s count');
  assert.ok(twinGeos.some(g => g.instanceCount === 0 && g.attributes.iPos.getZ(0) < 0), 'and a twin out of view at 0');
  // Window 2, every tree but the mixed twin's first in view: apply() refills
  // it to 7 in place. Right after, before anything else restores, every
  // twin has apply()'s count and its own attributes: had the span stayed,
  // the next restore would put the thrown render's 8 back over the 7.
  apply((x, z) => !(x === -12 && z === BEHIND + 30));
  assert.equal(mixed.instanceCount, 7, 'apply() sets its count after the restore');
  assert.ok(twinGeos.every(isOwn), 'apply() put back every twin\'s own per-tree attributes');
  const want = counts();
  s.f.applyVisibility();
  assert.deepEqual(counts(), want);
  // The next render draws the span of apply()'s 7: trees 4 to 6.
  const next = render('the refill after a throw');
  assert.ok(next.draws.some(d => d.drawing.mesh.geometry === mixed && d.instances === 3 && d.drawing.attributes.iPos.offset === 4 * 3));
  assert.deepEqual(counts(), want);
  // A throw again, then the rail: setMode's 0s must outlast the next render,
  // and no span may stay in a twin.
  throwAfterCull();
  assert.ok(mixed.attributes.iPos.offset > 0);
  t.setMode('rail');
  assert.deepEqual(counts(), twinGeos.map(() => 0), 'setMode sets its 0s after the restore');
  assert.ok(twinGeos.every(isOwn), 'setMode put back every twin\'s own per-tree attributes');
  for (const g of s.f.modeGeometries) setTerrainDrawMode(g, 'rail');
  s.f.applyVisibility();
  s.render();
  assert.ok(!s.objects().some(([m]) => twinGeos.includes(m.geometry)), 'the rail reaches no twin');
  assert.deepEqual(counts(), twinGeos.map(() => 0), 'no culled twin count comes back on the rail');
  assert.ok(twinGeos.every(isOwn));
  s.state.ops.length = 0;
  // Back on the tour, every tree: the spans are those of the new counts.
  for (const g of s.f.modeGeometries) setTerrainDrawMode(g, 'tour');
  t.setMode('tour');
  fill(() => true);
  const back = render('back on the tour');
  assert.ok(back.draws.some(d => d.drawing.mesh.geometry === mixed && d.instances === 4 && d.drawing.attributes.iPos.offset === 4 * 3));
});

test('with spans a lite twin whose asset swaps after a thrown render takes its index and base attributes from one asset, and its per-tree attributes are its own', () => {
  const s = tourScene({ tour: { seed: 5 }, mixedDetail: true, gpu: true });
  const { t, twinGeos, fill, isOwn, throwAfterCull } = onTour(s);
  attachForestCulling(s.scene);
  // Down -z the camera sees the trees at FRONT.
  const sees = z => z < 0;
  fill(() => true);
  // The detail batch's twin: 5 trees behind the camera, then 4 in view.
  const group = t.detailGroups.find(g => g.detail.instanceCount === 9), lite = group.lite;
  assert.ok(group && group.pixelBase.index !== group.qualityBase.index);
  const liteMeshes = [...t.byBand.far, ...t.byBand.mid, ...t.byBand.near, ...t.depth].filter(m => m.geometry === lite);
  // Pixelated with nearDetail off, the lites draw, over the quality asset.
  s.f.updateDetailView({ camera: s.camera, width: 300, height: 150, pixelated: true, nearDetail: false });
  assert.equal(lite.index, group.qualityBase.index);
  assert.ok(liteMeshes.length > 0 && liteMeshes.every(m => m.visible));
  // The lite's index and every base attribute are `base`'s, and none is
  // `other`'s.
  const fromOne = (base, other, label) => {
    assert.equal(lite.index, base.index, `${label}: the asset's index`);
    for (const [name, a] of Object.entries(base.attributes)) assert.equal(lite.attributes[name], a, `${label}: the asset's ${name}`);
    const theirs = new Set(Object.values(other.attributes));
    assert.ok(Object.values(lite.attributes).every(a => !theirs.has(a)), `${label}: nothing of the other asset`);
  };
  // A render of the lite: its span, over `base`'s index.
  const renderLite = (base, label) => {
    const draws = s.render(), lines = s.timeline();
    checkSpans(draws, lines, s.scene, twinGeos, sees, label);
    const mine = draws.filter(d => d.drawing.mesh.geometry === lite);
    assert.ok(mine.length > 0, `${label}: the lite draws`);
    for (const d of mine) {
      assert.equal(d.index, base.index.array, `${label}: the lite draws the asset's index`);
      assert.equal(d.drawing.attributes.position, base.attributes.position, `${label}: over the asset's positions`);
      assert.equal(d.drawing.attributes.iPos.offset, 4 * 3, `${label}: from tree 4`);
      assert.equal(d.instances, 5);
    }
  };
  renderLite(group.qualityBase, 'the quality lite');
  // Through applyVisibility: a render throws with the span in the lite, then
  // nearDetail on swaps the lite to the pixel asset (RangeScene's per-frame
  // applyVisibility, before any other restore).
  throwAfterCull();
  assert.equal(lite.attributes.iPos.offset, 4 * 3, 'the thrown render left a span in the lite');
  s.f.applyVisibility({ nearDetail: true });
  // applyVisibility puts the span back before it swaps the asset.
  assert.ok(isOwn(lite), 'applyVisibility put back the thrown render\'s span');
  fromOne(group.pixelBase, group.qualityBase, 'applyVisibility');
  restoreForestCulling();
  fromOne(group.pixelBase, group.qualityBase, 'applyVisibility, then the restore');
  assert.ok(isOwn(lite), 'applyVisibility, then the restore: the lite\'s own per-tree attributes');
  assert.ok(liteMeshes.every(m => m.visible));
  renderLite(group.pixelBase, 'the pixel lite');
  // By hand: setLiteAsset's own swap, back to the quality asset, with no
  // restore before it; then the restore must not bring back the pixel
  // asset's attributes under the quality asset's index.
  throwAfterCull();
  assert.equal(lite.attributes.iPos.offset, 4 * 3, 'the thrown render left a span in the lite');
  lite.userData.asset = group.qualityBase.userData.asset;
  lite.setIndex(group.qualityBase.index);
  for (const [name, a] of Object.entries(group.qualityBase.attributes)) lite.setAttribute(name, a);
  restoreForestCulling();
  fromOne(group.qualityBase, group.pixelBase, 'swapped by hand, then the restore');
  assert.ok(isOwn(lite), 'swapped by hand, then the restore: the lite\'s own per-tree attributes');
  renderLite(group.qualityBase, 'the quality lite again');
});
