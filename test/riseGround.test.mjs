import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { buildRiseGround, RiseGround, riseGroundBytes } from '../src/world/alpine/RiseGround.js';
import { sceneUniforms } from '../src/world/alpine/TerrainMaterial.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';

const data = () => ({ grid: { width: 5, height: 5, originM: [0, 0], cellSizeM: 1 },
  manifest: { boundsM: { min: [0, 100, 0], max: [4, 110, 4] } },
  groundAt: (x, z) => x <= 2 ? 100 + x + z : NaN });

test('inferred support is continuous, bounded and keeps every sampled DEM height', () => {
  const built = buildRiseGround(data(), { side: 5 });
  assert.equal(built.positions.length, 5 * 5 * 3);
  assert.equal(built.indices.length, 4 * 4 * 6);
  assert.equal(built.knownSamples, 15);
  for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) {
    const i = (z * 5 + x) * 3;
    assert.equal(built.positions[i], x);
    assert.equal(built.positions[i + 2], z);
    assert.ok(Number.isFinite(built.positions[i + 1]));
    if (x <= 2) assert.equal(built.positions[i + 1], 100 + x + z);
  }
  assert.deepEqual(buildRiseGround(data(), { side: 5 }), built);
  const full = buildRiseGround(data());
  assert.ok(full.positions.byteLength + full.indices.byteLength < 1024 ** 2);
  assert.ok(riseGroundBytes() >= 2 * (full.positions.byteLength + full.indices.byteLength));
  for (let k = 0; k < built.indices.length; k += 3) {
    const [a, b, c] = built.indices.subarray(k, k + 3);
    const at = n => new THREE.Vector3().fromArray(built.positions, n * 3);
    assert.ok(at(b).sub(at(a)).cross(at(c).sub(at(a))).y > 0, 'upward-facing complete cells');
  }
});

test('the support follows the exact shared rise and is absent at full height', () => {
  const uniforms = sceneUniforms(THREE, {}), ground = new RiseGround(THREE, data(), uniforms);
  assert.equal(ground.active, false);
  ground.setFrame({ rise01: 0, baseM: -12 });
  assert.equal(ground.active, true);
  assert.equal(ground.material.uniforms.uLandRise, uniforms.uLandRise);
  const cam = new THREE.PerspectiveCamera(); cam.position.set(900, 20, -600);
  ground.prepare(cam);
  assert.equal(ground.plane.position.x, cam.position.x);
  assert.equal(ground.plane.position.z, cam.position.z);
  assert.equal(ground.plane.position.y, -12);
  assert.equal(ground.plane.material.depthTest, false, 'the analytic horizon plane is beneath all inferred relief');
  ground.setFrame({ rise01: 1, baseM: -12 });
  assert.equal(ground.active, false);
  assert.deepEqual(uniforms.uLandRise.value.toArray(), [0, 0], 'full-height uniforms remain identical to the source scene');
  let disposals = 0;
  for (const resource of [ground.geometry, ground.plane.geometry, ground.material, ground.plane.material]) resource.addEventListener('dispose', () => disposals++);
  ground.dispose(); ground.dispose();
  assert.equal(disposals, 4);
});

test('an interrupted support construction disposes every allocated geometry and material', () => {
  const resources = [], FakeThree = { ...THREE };
  FakeThree.BufferGeometry = class extends THREE.BufferGeometry {
    constructor() { super(); this.addEventListener('dispose', () => { this.released = true; }); resources.push(this); }
  };
  let materials = 0;
  FakeThree.ShaderMaterial = class extends THREE.ShaderMaterial {
    constructor(options) {
      super(options);
      if (++materials === 2) throw new Error('allocation interrupted');
      this.addEventListener('dispose', () => { this.released = true; }); resources.push(this);
    }
  };
  assert.throws(() => new RiseGround(FakeThree, data(), sceneUniforms(THREE, {})), /allocation interrupted/);
  assert.ok(resources.every(r => r.released), 'unpublished partial geometry is released too');
});

test('inferred scenery retires continuously during the last eight percent of relief', () => {
  const ground = new RiseGround(THREE, data(), sceneUniforms(THREE, {})), camera = new THREE.PerspectiveCamera();
  const alphas = [];
  for (const rise01 of [0, .92, .94, .96, .98, .9999, 1]) {
    ground.setFrame({ rise01, baseM: 100 }); ground.prepare(camera);
    const meshAlpha = ground.material.uniforms.uRiseGroundOpacity?.value;
    const planeAlpha = ground.plane.material.uniforms.uRiseGroundOpacity?.value;
    assert.equal(meshAlpha, planeAlpha, 'the whole inferred backdrop shares one retirement envelope');
    assert.ok(Number.isFinite(meshAlpha));
    alphas.push(meshAlpha);
  }
  assert.equal(alphas[0], 1);
  assert.equal(alphas[1], 1);
  assert.equal(alphas.at(-1), 0);
  assert.ok(alphas.at(-2) < .00001, 'no opacity step on the completion frame');
  assert.ok(alphas.every((v, i) => !i || v <= alphas[i - 1]));
  for (const material of [ground.material, ground.plane.material]) assert.equal(material.transparent, true);
  ground.dispose();
});

function sceneFixture({ rise = 0, travel = false } = {}) {
  const camera = new THREE.PerspectiveCamera(), calls = [], uniforms = sceneUniforms(THREE, {});
  const ground = new RiseGround(THREE, data(), uniforms);
  ground.setFrame({ rise01: rise, baseM: 100 });
  const p = { view: {}, uniforms, riseGround: ground, forest: { counts: {} },
    scenes: { far: 'far', mid: 'mid', near: 'near' }, depthScene: 'depth',
    depthScenes: { far: 'far-depth', mid: 'mid-depth', near: 'near-depth' } };
  const target = { width: 320, height: 180 };
  const renderer = { setRenderTarget() {}, setClearColor() {},
    clear(...args) { calls.push(['clear', ...args]); },
    render(scene) { calls.push(['draw', scene === ground.scene ? 'support' : scene]); } };
  const scene = Object.assign(Object.create(RangeScene.prototype), { camera, renderer, target, canvas: {},
    prepared: new Map([['probe', p]]), size: { width: 320, height: 180 },
    depthCache: { A: { frame: -1 } }, stats: { depthPasses: 0 },
    _copy: { scene: 'copy', camera, mesh: { material: { uniforms: { uColor: {} } } } },
    _setCamera() {}, _setUniforms() {}, _prepareMirror() {}, _setCanvasSize() {}, _travelFringe() {} });
  return { scene, calls, p, options: travel ? { bandColumns: {} } : {} };
}

test('support color survives far while its depth is cleared before every real terrain layer', () => {
  for (const travel of [false, true]) {
    const { scene, calls, options } = sceneFixture({ travel });
    scene.renderPartition({ frameId: 1 }, 'far', 'probe', options);
    const support = calls.findIndex(c => c[1] === 'support');
    assert.ok(support >= 0);
    assert.deepEqual(calls[support + 1], ['clear', false, true, false]);
    const far = calls.findIndex(c => c[1] === 'far');
    assert.ok(calls.slice(support + 2, far).some(c => c[0] === 'draw' && c[1].includes('depth')));
    assert.ok(!calls.slice(support + 2, far).some(c => c[0] === 'clear' && c[1]), 'never erase support color before fine far color');
    for (const pass of ['mid', 'near']) scene.renderPartition({ frameId: 1 }, pass, 'probe', options);
    assert.equal(calls.filter(c => c[1] === 'support').length, 1);
  }
});

test('completed rise has no additional support draws or changed terrain prepass', () => {
  const { scene, calls } = sceneFixture({ rise: 1 });
  for (const pass of ['far', 'mid', 'near']) scene.renderPartition({ frameId: 1 }, pass, 'probe');
  assert.equal(calls.filter(c => c[1] === 'support').length, 0);
  assert.equal(calls.filter(c => c[1] === 'depth').length, 1);
});

test('multisample ownership starts with blank color and keeps only real terrain ownership', () => {
  const { scene, p, calls } = sceneFixture({ rise: .96 });
  let color = null, ownershipDraws = 0;
  scene.ownership = { A: { texture: {} } };
  const clear = scene.renderer.clear, render = scene.renderer.render;
  scene.renderer.clear = (...args) => { if (args[0]) color = null; clear(...args); };
  scene.renderer.render = (surface, camera) => {
    if (surface === p.riseGround.scene) color = 'inferred';
    if (surface === 'ownership') {
      assert.equal(color, null, 'uncovered ownership samples cannot contain inferred RGB');
      color = 'real owners'; ownershipDraws++;
    }
    render(surface, camera);
  };
  scene._renderOwnership = () => scene.renderer.render('ownership', scene.camera);
  scene._copyTexture = () => {};
  scene.renderPartition({ frameId: 1 }, 'far', 'probe');
  assert.equal(ownershipDraws, 1);
  const ownership = calls.findIndex(c => c[1] === 'ownership');
  const support = calls.findLastIndex(c => c[1] === 'support');
  assert.ok(support > ownership, 'the visible support is rebuilt after the clean ownership image');
  assert.deepEqual(calls[support + 1], ['clear', false, true, false]);
  assert.deepEqual(calls[support + 2], ['draw', 'depth']);
});
