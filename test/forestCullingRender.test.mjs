// The forest culling through a real three.js render (vendored r186) on a
// recording WebGL2 context: a culled batch loses its draw call and nothing
// else. Every program bind, vertex array bind and remaining draw happens in
// the same order as an unculled render of the same scene.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from '../src/vendor/range/three-range.module.js';
import fs from 'node:fs';
import { attachForestCulling } from '../src/world/alpine/ForestCulling.js';
import { attachTerrainCulling, chunkTable, setChunks } from '../src/world/alpine/TerrainChunks.js';
import { createForest } from '../src/world/alpine/ForestGL.js';
import { recordingWebGL2 } from './helpers/recordingWebGL2.mjs';

// Rows: x, y, z, height, width, species, id, band. Species picks the family
// (below .5 or not), so each group below is its own batch.
const row = (x, z, species, band) => [x, 0, z, 14, 5, species, .5, band];
const FRONT = -120, BEHIND = 3000;

function forest() {
  const meshDetail = [], mesh = [], billboard = [];
  // Every batch its own size, so a count put back on the wrong batch shows.
  const each = (n, f) => { for (let i = 0; i < n; i++) f(i * 8 - 12); };
  each(4, x => mesh.push(...row(x, FRONT, .2, 1)));
  each(3, x => mesh.push(...row(x, BEHIND, .8, 1)));
  each(2, x => meshDetail.push(...row(x, FRONT - 10, .8, 2)));
  each(5, x => meshDetail.push(...row(x, BEHIND + 10, .2, 2)));
  each(4, x => billboard.push(...row(x, BEHIND + 20, .2, 0)));
  const uniforms = { uDeformAmp: { value: 3 }, uDeformKick: { value: 1 }, uDeformStructural: { value: 0 },
    uDeformMelodic: { value: 0 }, uDeformGesture: { value: 0 }, uLandDance: { value: new THREE.Vector4() } };
  return createForest(THREE, { meshDetail: new Float32Array(meshDetail), mesh: new Float32Array(mesh),
    billboard: new Float32Array(billboard), stride: 8, count: 18 }, uniforms);
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
