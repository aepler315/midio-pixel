// The chunk culling through a real three.js render (vendored r186) on a
// recording WebGL2 context: what is actually submitted, in what order.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { attachTerrainCulling, chunkTable, setChunks } from '../src/world/alpine/TerrainChunks.js';
import { recordingWebGL2 } from './helpers/recordingWebGL2.mjs';

const PER_TILE = 3 * 4000; // indices: above the draw-through gap, so culled tiles split runs

function tiled(xs) {
  const positions = [], index = [], start = [], count = [], box = [];
  let v = 0;
  for (const x of xs) {
    start.push(index.length);
    for (let t = 0; t < PER_TILE / 3; t++) { positions.push(x, 0, 0, x + 10, 0, 0, x, 0, 10); index.push(v, v + 1, v + 2); v += 3; }
    count.push(PER_TILE); box.push(x, 0, 0, x + 10, 0, 10);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1));
  g.computeBoundingSphere();
  return setChunks(g, chunkTable(Uint32Array.from(start), Uint32Array.from(count), Float64Array.from(box)));
}

function setup() {
  const { gl, canvas, state } = recordingWebGL2(300, 150);
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  renderer.autoClear = false;
  const material = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3,
    vertexShader: 'void main(){gl_Position=projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.);}',
    fragmentShader: 'out vec4 c; void main(){c=vec4(1);}' });
  // Tiles out of x order in the index: x 0..1100 is in view.
  const xs = [0, 3000, 1000, 4000, 2000, 5000, 500];
  const a = new THREE.Mesh(tiled(xs), [material]), b = new THREE.Mesh(tiled(xs), [material]);
  const whole = new THREE.Mesh(tiled([0]), material); // single material: groups ignored
  b.geometry.boundingSphere = whole.geometry.boundingSphere = a.geometry.boundingSphere; // equal sort depth
  for (const m of [a, b, whole]) m.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(b, a, whole); // b is pushed first but sorts after a (object id)
  attachTerrainCulling(scene, () => ({ lo: 0, hi: 0 }));
  const camera = new THREE.OrthographicCamera(-100, 1100, 100, -100, 1, 1000);
  camera.position.set(0, 500, 0); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const target = new THREE.WebGLRenderTarget(300, 150);
  const name = d => d.index === a.geometry.index.array ? 'a' : d.index === b.geometry.index.array ? 'b' : 'whole';
  const draws = () => state.draws.splice(0).map(d => `${name(d)}:${d.offset / 4}+${d.count}`);
  return { renderer, scene, camera, target, a, b, whole, draws };
}

test('a real render submits each band\'s visible tiles as consecutive runs in index order, then restores the whole index', () => {
  const { renderer, scene, camera, target, a, b, draws } = setup();
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  // Tiles 0 (x 0), 2 (x 1000) and 6 (x 500) are in view: three runs per band.
  const runs = ['0+12000', '24000+12000', '72000+12000'];
  assert.deepEqual(draws(), [...runs.map(r => `a:${r}`), ...runs.map(r => `b:${r}`), 'whole:0+12000']);
  for (const g of [a.geometry, b.geometry]) assert.deepEqual(g.groups.map(x => [x.start, x.count]), [[0, Infinity]]);
});

test('a scissored target culls to its rectangle; a viewport set on the bound target turns that off', () => {
  const { renderer, scene, camera, target, draws } = setup();
  // The left tenth of the target: x up to about 20 m.
  target.scissor.set(0, 0, 30, 150); target.scissorTest = true;
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  assert.deepEqual(draws(), ['a:0+12000', 'b:0+12000', 'whole:0+12000']);
  // A rectangle left behind with the test off (what the travel columns and
  // the water pass leave) does not narrow anything.
  target.scissorTest = false;
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  const all = ['0+12000', '24000+12000', '72000+12000'];
  assert.deepEqual(draws(), [...all.map(r => `a:${r}`), ...all.map(r => `b:${r}`), 'whole:0+12000']);
  target.scissorTest = true;
  renderer.setRenderTarget(target);
  // GL's viewport is no longer the target's: the scissor's NDC is unknown,
  // so every tile in the frustum draws (GL still scissors).
  renderer.setViewport(0, 0, 150, 150);
  renderer.render(scene, camera);
  const runs = ['0+12000', '24000+12000', '72000+12000'];
  assert.deepEqual(draws(), [...runs.map(r => `a:${r}`), ...runs.map(r => `b:${r}`), 'whole:0+12000']);
});

test('a render that throws after culling is restored by the scene\'s next render', () => {
  const { renderer, scene, camera, target, a, draws } = setup();
  renderer.setRenderTarget(target);
  a.onBeforeRender = () => { throw new Error('boom'); };
  assert.throws(() => renderer.render(scene, camera), /boom/);
  assert.notDeepEqual(a.geometry.groups.map(x => [x.start, x.count]), [[0, Infinity]]); // left culled
  a.onBeforeRender = () => {};
  draws();
  // Next render the mesh is not culled (moved: its boxes no longer hold
  // it), so only the restore gives it its whole index back.
  a.position.x = 1; a.updateMatrixWorld();
  renderer.render(scene, camera);
  assert.deepEqual(draws().filter(d => d.startsWith('a:')), ['a:0+84000']);
  assert.deepEqual(a.geometry.groups.map(x => [x.start, x.count]), [[0, Infinity]]);
});
