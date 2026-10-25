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
    // Layer 3 (ink), with the cast (layer 4) where no smooth cast pass takes it.
    assert.deepEqual(draws.filter(([scene]) => scene === 'near'), [['near', 1], ['near', 2], ['near', 8 | 16]]);
    assert.deepEqual(draws.filter(([scene]) => scene === 'depth'), [['depth', 1], ['depth', 4]]);
  }
});

test('with a smooth cast pass the partitions leave the cast out, and it draws once after near against full depth', () => {
  const { s, draws } = fixture({ actor: true });
  s.renderer.clear = (...a) => draws.push(['clear', a.map(Number).join('')]);
  s.renderer.setRenderTarget = (t) => draws.push(['target', t === null ? 'canvas' : 'scene']);
  s.castInBands = false;
  assert.equal(s.renderCast(frame, 'probe'), null, 'nothing to draw before its near partition');
  for (const pass of ['far', 'mid', 'near']) s.renderPartition(frame, pass, 'probe');
  // The lanterns no longer cut combined depth into every partition.
  assert.equal(s.stats.depthPasses, 1);
  assert.ok(draws.every(([, mask]) => typeof mask !== 'number' || !(mask & 16)), 'no partition draws the cast layer');
  draws.length = 0;
  assert.equal(s.renderCast(frame, 'probe'), s.canvas);
  assert.deepEqual(draws, [
    ['target', 'scene'],
    ['depth', 4], // the trees' crown cut joins the opaque depth once
    ['clear', '100'], // colour only: every band's depth stays
    ['far', 16], ['mid', 16], ['near', 16],
    ['target', 'canvas'], ['clear', '110'], ['copy', 9],
  ]);
  assert.equal(s.stats.castPasses, 1);
  assert.equal(s.renderCast(frame, 'probe'), null, 'one cast pass per near partition');
  // When the near partition already cut the crowns (ink), the cast reuses it.
  const inked = fixture({ actor: true, ink: .02 });
  inked.s.castInBands = false;
  for (const pass of ['far', 'mid', 'near']) inked.s.renderPartition(frame, pass, 'probe');
  inked.draws.length = 0;
  inked.s.renderCast(frame, 'probe');
  assert.deepEqual(inked.draws.filter(([scene]) => scene === 'depth'), []);
  assert.deepEqual(inked.draws.filter(([scene]) => ['far', 'mid', 'near'].includes(scene)), [['far', 16], ['mid', 16], ['near', 16]]);
});

test('placed lights alone (no lantern on screen) still draw after the crown cut, and a travel keeps the cast in its bands', () => {
  const { s, draws } = fixture();
  s.prepared.get('probe').actors.sites = { drawn: () => true };
  s.renderPartition(frame, 'near', 'probe');
  assert.deepEqual(draws.filter(([scene]) => scene === 'near'), [['near', 1], ['near', 2], ['near', 8 | 16]]);
  // Laid out but dark (none kindled yet, or the cast absent): no crown cut
  // and no cast pass for nothing.
  const dark = fixture();
  dark.s.prepared.get('probe').actors.sites = { drawn: () => false };
  dark.s.renderPartition(frame, 'near', 'probe');
  assert.deepEqual(dark.draws.filter(([scene]) => scene === 'depth'), [['depth', 1]]);
  dark.s.castInBands = false;
  assert.equal(dark.s.renderCast(frame, 'probe'), null);
  const smooth = fixture();
  smooth.s.castInBands = false;
  smooth.s.prepared.get('probe').actors.sites = { drawn: () => true };
  smooth.s.renderPartition(frame, 'near', 'probe');
  assert.equal(smooth.s.renderCast(frame, 'probe'), smooth.s.canvas);
  const travel = fixture({ actor: true });
  travel.s.castInBands = false;
  travel.s.prepared.get('probe').depthScenes = { far: 'depth-far', mid: 'depth-mid', near: 'depth-near' };
  travel.s._travelDepth = () => {};
  travel.s._travelFringe = () => {};
  travel.s.renderPartition(frame, 'near', 'probe', { bandColumns: { mid: [0, 1], near: [0, 1] } });
  assert.deepEqual(travel.draws.filter(([scene]) => scene === 'near').at(-1), ['near', 8 | 16]);
  assert.equal(travel.s.renderCast(frame, 'probe'), null);
});

test('the lake mirror reflects the cast with every band, soft forest or not', () => {
  for (const soft of [true, false]) {
    const { s, draws } = fixture();
    const p = s.prepared.get('probe');
    if (!soft) p.forest.counts = { billboard: 0 };
    p.mirrorLevelM = 1000;
    s.THREE = THREE;
    s.mirrorCamera = new THREE.PerspectiveCamera();
    s.camera.position.set(0, 1500, 0); s.camera.updateMatrixWorld();
    s._ensureMirror = () => ({ target: { width: 64, height: 64, texture: {} }, matrix: new THREE.Matrix4(), frame: -1, view: null });
    s._updateForestDetail = () => {};
    s.renderer.render = (scene, cam) => draws.push([scene, cam.layers.mask, cam === s.mirrorCamera]);
    RangeScene.prototype._prepareMirror.call(s, p, { ...frame, narrative: null }, 'A', 'probe');
    const mirrored = draws.filter(([scene, , mirror]) => mirror && ['far', 'mid', 'near'].includes(scene));
    assert.ok(mirrored.length >= 3);
    assert.ok(mirrored.some(([, mask]) => mask & 16), `${soft ? 'soft' : 'plain'} forest: the cast is reflected`);
  }
});
