// When renderWater scissors the lake layer: only above the native grid,
// never with rivers or travel columns, and never left on afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';

function harness({ rivers = false } = {}) {
  const noop = () => {};
  const seen = [];
  let bound = null;
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 50000);
  camera.position.set(0, 200, 0); camera.lookAt(0, 0, -1000); camera.updateMatrixWorld();
  const band = new THREE.Mesh(new THREE.BufferGeometry(), [new THREE.MeshBasicMaterial()]);
  const sub = new THREE.BufferGeometry(); sub.setIndex(new THREE.BufferAttribute(Uint32Array.of(0, 1, 2), 1));
  const subsets = new Map([[band.geometry, sub]]);
  subsets.boxes = Float64Array.of(-20, 0, -1020, 20, 1, -980); // a small lake ahead
  const scenes = { far: new THREE.Scene(), mid: new THREE.Scene(), near: new THREE.Scene() };
  scenes.far.add(band);
  for (const s of Object.values(scenes)) s.updateMatrixWorld();
  const uniforms = { uViewportPx: { value: { set: noop } }, uWaterOnly: { value: 0 }, uDeformAmp: { value: 0 }, uDeformKick: { value: 0 }, uDeformStructural: { value: 0 }, uDeformMelodic: { value: 0 }, uDeformGesture: { value: 0 } };
  const p = { view: {}, uniforms, depthScene: { name: 'depth' }, forest: { byBand: {} }, scenes, waterSubsets: subsets,
    riverGeometries: rivers ? { far: {} } : {}, riverFringeGeometries: {}, depthScenes: { far: {}, mid: {}, near: {} } };
  const targets = {};
  const scene = Object.assign(Object.create(RangeScene.prototype), {
    THREE, prepared: new Map([['lake', p]]), contextLost: false, target: {}, sideTargets: { B: null },
    size: { width: 320, height: 180 }, stats: {}, depthCache: { A: { frame: -1 }, B: { frame: -1 } },
    renderer: { setRenderTarget: t => { bound = t; }, setClearColor: noop, clear: noop,
      render: s => seen.push({ s, scissorTest: bound?.scissorTest, scissor: bound?.scissor?.clone?.() }) },
    camera, canvas: {},
    _setCamera: noop, _setUniforms: noop, _prepareMirror: noop, _setCanvasSize: noop, _clearCanvas: noop, _copyTexture: noop,
    _travelDepth: noop, _travelFringe: noop,
    _scenicTarget: (w, h) => (targets[`${w}x${h}`] = new THREE.WebGLRenderTarget(w, h)),
  });
  return { scene, seen, targets, p };
}

test('output-resolution water is scissored, then the scissor is off again', () => {
  const h = harness();
  h.scene.renderWater({ frameId: 1 }, 'lake', 1280, 720);
  const t = h.targets['1280x720'];
  assert.ok(h.seen.length && h.seen.every(d => d.scissorTest), 'every scene render scissored');
  assert.ok(h.seen[0].scissor.z < 1280, 'narrowed');
  assert.equal(t.scissorTest, false);
});

test('native, rivers and travel columns are never scissored', () => {
  for (const [name, opts, w, hgt] of [['native', {}, 320, 180], ['rivers', { rivers: true }, 1280, 720], ['travel', { bandColumns: { mid: [0, 1] }, pass: 'far' }, 1280, 720]]) {
    const h = harness(opts);
    h.scene.renderWater({ frameId: 1 }, 'lake', w, hgt, opts.bandColumns ? opts : {});
    assert.ok(h.seen.every(d => !d.scissorTest), name);
  }
});

test('a throwing water pass leaves no scissor behind', () => {
  const h = harness();
  const render = h.scene.renderer.render;
  h.scene.renderer.render = s => { render(s); if (s === h.p.scenes.far) throw new Error('lost'); };
  assert.throws(() => h.scene.renderWater({ frameId: 1 }, 'lake', 1280, 720), /lost/);
  assert.equal(h.targets['1280x720'].scissorTest, false);
});

test('the mirror scissor reads main\'s vertex boxes, the water scissor the triangle boxes', () => {
  const h = harness();
  const calls = [];
  h.p.waterSubsets.mirrorBoxes = Float64Array.of(-5, 0, -1005, 5, 1, -995);
  h.scene._waterBoxes = function (p, which) { calls.push(which ?? 'boxes'); return RangeScene.prototype._waterBoxes.call(this, p, which); };
  h.scene._mirrorScissor(h.p, { matrix: new THREE.Matrix4(), target: { width: 64, height: 64 } });
  h.scene._waterScissor(h.p, 1280, 720);
  assert.deepEqual(calls, ['mirrorBoxes', 'boxes']);
});
