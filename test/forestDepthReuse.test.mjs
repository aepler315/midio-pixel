import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { sceneUniforms } from '../src/world/alpine/TerrainMaterial.js';
import * as THREE from '../src/vendor/range/three-range.module.js';

function fixture({ ink = 0, actor = false, shafts = false } = {}) {
  const camera = new THREE.PerspectiveCamera(), draws = [];
  const p = { view: {}, uniforms: sceneUniforms(THREE, {}), forest: { counts: { billboard: 1 } },
    actors: { groups: { light: { visible: actor } } }, depthScene: 'depth',
    scenes: { far: 'far', mid: 'mid', near: 'near' } };
  p.uniforms.uNarrativeInk.value = ink;
  const renderer = { setRenderTarget() {}, setClearColor() {}, clear() {},
    render(scene, cam) { draws.push([scene, cam.layers.mask]); } };
  const s = Object.assign(Object.create(RangeScene.prototype), { camera, renderer, target: {}, canvas: {},
    size: { width: 256, height: 256 }, prepared: new Map([['probe', p]]), depthCache: { A: { frame: -1 } },
    stats: { depthPasses: 0 }, _copy: { mesh: { material: { uniforms: { uColor: {} } } }, scene: 'copy', camera },
    _setCamera() {}, _setUniforms() {}, _prepareMirror() {}, _setCanvasSize() {} });
  if (shafts) s.shafts = { render() { draws.push(['shafts', 0]); }, compositeToScreen() {} };
  return { s, draws };
}
const frame = { frameId: 1, qualityLevel: 0, light: { celestial: { body: 'sun', visibility: 1, intensity: 1, xFrac: .5, yFrac: .2 } } };

test('empty post-forest stages retain opaque depth across all three partitions', () => {
  const { s, draws } = fixture();
  for (const pass of ['far', 'mid', 'near']) s.renderPartition(frame, pass, 'probe');
  assert.equal(s.stats.depthPasses, 1);
  assert.deepEqual(draws.filter(([scene]) => scene === 'depth'), [['depth', 1]]);
});

test('actor lights and visible ink invalidate combined depth before the next partition', () => {
  for (const options of [{ actor: true }, { ink: .005 }]) {
    const { s, draws } = fixture(options);
    for (const pass of ['far', 'mid', 'near']) s.renderPartition(frame, pass, 'probe');
    assert.equal(s.stats.depthPasses, 3);
    assert.deepEqual(draws.filter(([scene]) => scene === 'depth'), Array.from({ length: 3 }, () => [['depth', 1], ['depth', 4]]).flat());
  }
});

test('solar scattering sees hard forest depth, then the next partition rebuilds opaque depth', () => {
  const { s, draws } = fixture({ shafts: true });
  for (const pass of ['far', 'mid', 'near']) s.renderPartition(frame, pass, 'probe');
  assert.equal(s.stats.depthPasses, 2);
  assert.deepEqual(draws.filter(([scene]) => ['depth', 'shafts'].includes(scene)), [['depth', 1], ['depth', 4], ['shafts', 0], ['depth', 1]]);
});

test('discarded ink and a disabled solar quality rung do not poison reusable opaque depth', () => {
  const { s, draws } = fixture({ ink: .004, shafts: true });
  for (const pass of ['far', 'mid', 'near']) s.renderPartition({ ...frame, qualityLevel: 6 }, pass, 'probe');
  assert.equal(s.stats.depthPasses, 1);
  assert.deepEqual(draws.filter(([scene]) => ['depth', 'shafts'].includes(scene)), [['depth', 1]]);
});

test('a stand containing only either mesh LOD uses soft coverage and hard depth for ink', () => {
  for (const kind of ['mesh', 'meshDetail']) {
    const { s, draws } = fixture({ ink: .02 });
    s.prepared.get('probe').forest.counts = { billboard: 0, mesh: 0, meshDetail: 0, [kind]: 1 };
    s.renderPartition(frame, 'near', 'probe');
    assert.deepEqual(draws.filter(([scene]) => scene === 'near'), [['near', 1], ['near', 2], ['near', 8]]);
    assert.deepEqual(draws.filter(([scene]) => scene === 'depth'), [['depth', 1], ['depth', 4]]);
  }
});
