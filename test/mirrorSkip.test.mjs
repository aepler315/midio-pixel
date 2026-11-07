import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RangeScene, MIRROR_INK_SKIP } from '../src/world/alpine/RangeScene.js';
import { sceneUniforms, FEATURE_FRAG } from '../src/world/alpine/TerrainMaterial.js';
import { createForest } from '../src/world/alpine/ForestGL.js';
import { ActorsGL, actorUniforms } from '../src/world/alpine/ActorsGL.js';
import { setTerrainDrawMode } from '../src/world/alpine/RailDraw.js';
import { syntheticPlaced } from './helpers/tourForestFixtures.mjs';
import * as THREE from '../src/vendor/range/three-range.module.js';

// _prepareMirror against a renderer that records what it is asked to do.
function fixture({ ink = 0, actor = false, scissor = null, soft = true, sites = null } = {}) {
  const ops = [];
  const p = { view: {}, uniforms: sceneUniforms(THREE, {}), mirrorLevelM: 100,
    forest: { counts: soft ? { billboard: 1 } : {} },
    actors: { groups: { light: { visible: actor } }, ...(sites ? { sites } : {}) },
    depthScene: 'depth', scenes: { far: 'far', mid: 'mid', near: 'near' } };
  p.uniforms.uNarrativeInk.value = ink;
  const target = { width: 64, height: 32, scissor: new THREE.Vector4(), scissorTest: false, texture: 'mirror-texture' };
  const m = { target, frame: -1, view: null, matrix: new THREE.Matrix4() };
  const renderer = {
    setRenderTarget() {}, setClearColor() {}, clear() {},
    render(scene, cam) { ops.push(`${scene}:${cam.layers.mask}`); },
  };
  const s = Object.assign(Object.create(RangeScene.prototype), {
    THREE, renderer, camera: new THREE.PerspectiveCamera(), mirrorCamera: new THREE.PerspectiveCamera(),
    size: { width: 32, height: 16 }, stats: {}, mirrors: { A: m },
    _ensureMirror: () => m, _mirrorScissor: () => scissor, _updateForestDetail() {}, _bindBackdrop() {},
  });
  s.camera.position.set(0, 300, 0); s.camera.lookAt(0, 0, -1000); s.camera.updateMatrixWorld();
  return { s, p, ops };
}
const frame = { frameId: 7, timeMs: 1000, qualityLevel: 0, narrative: { materials: 1 } };
const BANDS3 = (mask) => ['far', 'mid', 'near'].map(b => `${b}:${mask}`);
const FULL = ['depth:1', ...BANDS3(1), ...BANDS3(2), 'depth:4', ...BANDS3(8 | 16 | 32)];
const NO_CUT = ['depth:1', ...BANDS3(1), ...BANDS3(2)];

test('the mirror leaves out its crown cut, ink and cast only when the ink discards and no cast shows', () => {
  for (const [opts, want] of [
    [{}, NO_CUT],
    [{ ink: MIRROR_INK_SKIP * 0.999 }, NO_CUT],
    [{ ink: -1 }, NO_CUT],
    [{ ink: MIRROR_INK_SKIP }, FULL],
    [{ ink: .005 }, FULL],
    [{ ink: .02 }, FULL],
    // The shader keeps NaN and Infinity (its discard test is false), so
    // the mirror draws them as before.
    [{ ink: NaN }, FULL],
    [{ ink: Infinity }, FULL],
    [{ actor: true }, FULL],
  ]) {
    const { s, p, ops } = fixture(opts);
    s._prepareMirror(p, frame, 'A', 'v');
    assert.deepEqual(ops, want, JSON.stringify(opts));
  }
});

test('a laid-out light with gain counts as a shown cast in the mirror', () => {
  const geometry = { attributes: { aState: { getX: () => 1 } } };
  const sites = { _slots: [{ band: 'near', i: 0 }], meshes: { near: { geometry } }, uniforms: { uGain: { value: .3 } },
    drawn() { return this.uniforms.uGain.value > 0 && this._slots.some(({ band, i }) => this.meshes[band].geometry.attributes.aState.getX(i) > 0); } };
  const a = fixture({ sites });
  a.s._prepareMirror(a.p, frame, 'A', 'v');
  assert.deepEqual(a.ops, FULL);
  sites.uniforms.uGain.value = 0;
  const b = fixture({ sites });
  b.s._prepareMirror(b.p, frame, 'A', 'v');
  assert.deepEqual(b.ops, NO_CUT);
});

test('a laid-out thread or fixed line with gain counts as a shown cast in the mirror', () => {
  for (const key of ['threads', 'rope']) {
    for (const [gain, want] of [[.5, FULL], [0, NO_CUT]]) {
      const actors = new ActorsGL(THREE, actorUniforms(THREE));
      try {
        actors[key].setThreads([{ a: [0, 0, -400], b: [100, 0, -400], band: 'near' }]);
        actors[key].setState(0, .3, 1);
        actors[key].setLook(new THREE.Color(1, 1, 1), gain);
        const { s, p, ops } = fixture();
        p.actors = actors; // no lantern out, no light laid out
        s._prepareMirror(p, frame, 'A', 'v');
        assert.deepEqual(ops, want, `${key} at gain ${gain}`);
      } finally { actors.dispose(); }
    }
  }
});

// The mirror reflects the cast with each band even when the main view draws
// it in its own pass (castInBands false), so the gate must not follow that.
test('the mirror reflects a shown cast whether or not the main view keeps it in the bands', () => {
  for (const castInBands of [true, false]) {
    for (const [opts, want] of [[{}, NO_CUT], [{ actor: true }, FULL]]) {
      const { s, p, ops } = fixture(opts);
      s.castInBands = castInBands;
      s._prepareMirror(p, frame, 'A', 'v');
      assert.deepEqual(ops, want, `castInBands ${castInBands} ${JSON.stringify(opts)}`);
    }
  }
});

test('the mirror decides the skip afresh on every redraw of one view and target', () => {
  const { s, p, ops } = fixture();
  const steps = [[0, false, NO_CUT], [0, true, FULL], [.02, false, FULL], [0, false, NO_CUT], [0, true, FULL]];
  steps.forEach(([ink, lit, want], i) => {
    p.uniforms.uNarrativeInk.value = ink;
    p.actors.groups.light.visible = lit;
    ops.length = 0;
    s._prepareMirror(p, { ...frame, frameId: 11 + i }, 'A', 'v');
    assert.deepEqual(ops, want, `frame ${11 + i}`);
  });
});

test('the skip threshold stays below the ink shader discard, in float32', () => {
  const discard = Number(/uNarrativeInk < ([.\d]+)\)/.exec(FEATURE_FRAG)[1]);
  assert.equal(discard, .005);
  // Every skipped value uploads (float32) below the shader's literal, with
  // room for the literal itself rounding a few ulps either way.
  assert.ok(Math.fround(MIRROR_INK_SKIP) < Math.fround(discard) * (1 - 1e-6));
});

test('a scissored mirror makes the same choice', () => {
  for (const scissor of [{ x: 0, y: 0, width: 1, height: 1 }, { x: 3, y: 2, width: 40, height: 20 }]) {
    for (const [opts, want] of [[{}, NO_CUT], [{ actor: true }, FULL], [{ ink: .02 }, FULL]]) {
      const { s, p, ops } = fixture({ ...opts, scissor });
      s._prepareMirror(p, frame, 'A', 'v');
      assert.deepEqual(ops, want);
    }
  }
});

test('without soft trees the mirror keeps its single combined pass', () => {
  for (const ink of [0, .02]) {
    const { s, p, ops } = fixture({ soft: false, ink });
    s._prepareMirror(p, frame, 'A', 'v');
    assert.deepEqual(ops, ['depth:57', ...BANDS3(57)]);
  }
});

test('the mirror shades all reflected lakes even when the main view separates water', () => {
  const { s, p, ops } = fixture();
  p.uniforms.uSeparateWater.value = 1;
  const render = s.renderer.render;
  s.renderer.render = (...args) => {
    assert.equal(p.uniforms.uSeparateWater.value, 0, 'the mirror has no later separate-water overlay');
    render(...args);
  };
  s._prepareMirror(p, frame, 'A', 'v');
  assert.equal(p.uniforms.uSeparateWater.value, 1, 'the main view retains its admitted water separation');
  const draws = ops.length;
  s._prepareMirror(p, frame, 'A', 'v');
  assert.equal(ops.length, draws, 'same-frame mirror caching still avoids redraw');
  assert.equal(p.uniforms.uSeparateWater.value, 1);
});

test('a failed mirror draw restores the main view water separation before propagating', () => {
  const { s, p } = fixture({ scissor: { x: 0, y: 0, width: 10, height: 10 } });
  p.uniforms.uSeparateWater.value = 1;
  s.renderer.render = () => {
    assert.equal(p.uniforms.uSeparateWater.value, 0);
    throw new Error('mirror draw interrupted');
  };
  assert.throws(() => s._prepareMirror(p, frame, 'A', 'v'), /mirror draw interrupted/);
  assert.equal(p.uniforms.uSeparateWater.value, 1);
  assert.equal(s.mirrors.A.target.scissorTest, false);
  assert.equal(s.mirrors.A.frame, -1, 'a failed mirror is not published into the frame cache');
});

// What the skip relies on in the forest. Layer 2 holds only depth: no colour
// to lose. Layers 3 to 5 hold nothing of the forest's. And every layer-2
// mesh in the shared depth scene shares its geometry with a tree the mirror
// draws first (the depth scene's layer 0, or a band's layer 0 or 1), with the
// same visibility: three computes a geometry's boundingSphere (the z it sorts
// every listed mesh by, and its frustum bound) the first time any render
// lists it, so skipping a render must never be what defers that first listing.
const placedTrees = () => ({
  // The third mesh tree shares the first's band, family and variant, so the
  // rail's first tree and a tour tree share one batch.
  mesh: new Float32Array([0, 0, -400, 20, 10, 0, .5, 2, 30, 0, -420, 18, 9, 3, .2, 1, 40, 0, -430, 20, 10, 0, .5, 2]),
  meshDetail: new Float32Array([5, 0, -60, 20, 10, 1, .3, 2, 9, 0, -80, 14, 7, 6, .8, 2]),
  billboard: new Float32Array([2000, 0, 0, 20, 10, 1, .6, 1, 2400, 0, 300, 20, 10, 2, .1, 0]),
  stride: 8, count: 7,
  // A view on its rail: each kind's first tree is the rail's, the rest only
  // the tour draws, and the rail-only trees only the rail draws.
  railCount: { meshDetail: 1, mesh: 1, billboard: 1 },
  railOnly: {
    meshDetail: new Float32Array([7, 0, -70, 20, 10, 1, .3, 2]),
    mesh: new Float32Array([10, 0, -410, 20, 10, 0, .5, 1]),
    billboard: new Float32Array([2200, 0, 100, 20, 10, 1, .6, 0]),
  },
});
const onLayer = (m, k) => (m.layers.mask & (1 << k)) !== 0;

test('the forest puts only depth-only meshes on layer 2 and nothing on layers 3 to 5', () => {
  const forest = createForest(THREE, placedTrees(), sceneUniforms(THREE, {}));
  try {
    const all = [...forest.depth, ...Object.values(forest.depthByBand).flat(), ...Object.values(forest.byBand).flat()];
    for (const m of all) {
      for (const k of [3, 4, 5]) assert.ok(!onLayer(m, k), `layer ${k}`);
      if (onLayer(m, 2)) assert.equal(m.material.colorWrite, false);
    }
    for (const m of Object.values(forest.byBand).flat()) assert.ok(m.layers.mask === 1 || m.layers.mask === 2);
    assert.ok(forest.depth.some(m => onLayer(m, 2)));
  } finally { forest.dispose(); }
});

test('every layer-2 tree depth mesh shares its geometry and visibility with a tree the mirror draws first', () => {
  const forest = createForest(THREE, placedTrees(), sceneUniforms(THREE, {}));
  try {
    const earlier = [...forest.depth.filter(m => onLayer(m, 0)),
      ...Object.values(forest.byBand).flat().filter(m => onLayer(m, 0) || onLayer(m, 1))];
    const cut = forest.depth.filter(m => onLayer(m, 2));
    assert.ok(cut.length >= 6, 'every kind and band draws a cut');
    for (const d of cut) assert.ok(earlier.some(m => m.geometry === d.geometry), `${d.geometry.userData.asset ?? 'board'}`);
    // The rail's own batches (rail-only, and a rail prefix shared with the
    // tour) draw a cut too, on a geometry drawn first.
    const modes = forest.modeGeometries.map(g => g.userData.instanceCounts);
    assert.ok(modes.some(c => c.tour === 0), 'a rail-only batch');
    assert.ok(modes.some(c => c.rail > 0 && c.rail < c.tour), 'a batch the rail and the tour share');
    for (const g of forest.modeGeometries) assert.ok(cut.some(d => d.geometry === g), `${g.userData.asset ?? 'board'} cut`);
    // Visibility is one rule per geometry, whatever the weights, the
    // narrative and the detail ring do.
    const camera = new THREE.PerspectiveCamera(50, 2, 1, 20000);
    camera.position.set(0, 30, 0); camera.lookAt(0, 0, -100); camera.updateMatrixWorld();
    const states = [
      () => forest.updateDetailView({ camera, width: 640, height: 320, pixelated: true }),
      () => forest.updateDetailView({ camera, width: 64, height: 32, pixelated: true }),
      () => {
        forest.updateDetailView({ camera, width: 128, height: 64, pixelated: true });
        assert.ok(forest.detailView.blendedBatches > 0, 'a footprint that blends detail and lite');
      },
      () => forest.updateDetailView({ camera, width: 640, height: 320, pixelated: false, nearDetail: false }),
      () => forest.applyVisibility({ shown: false }),
      () => forest.applyVisibility({ shown: true, nearDetail: true }),
    ];
    let differing = 0;
    for (const set of states) {
      set();
      for (const d of cut) {
        const twins = earlier.filter(m => m.geometry === d.geometry);
        assert.ok(twins.every(m => m.visible === d.visible));
      }
      differing += new Set(cut.map(d => d.visible)).size > 1;
    }
    assert.ok(differing > 0, 'some state shows part of the forest and hides the rest');
  } finally { forest.dispose(); }
});

// The tour forest layer (TourForest.js) adds its twins and demote boards to
// the same scenes (RangeScene puts tour.depth in the depth scene and
// tour.byBand in the bands), so they must keep the same property, on the
// rail (hidden) and on the tour, before and after a refill.
test('the tour layer\'s cuts share their geometry and visibility with a tree the mirror draws first', () => {
  const forest = createForest(THREE, syntheticPlaced({ extent: 1200, spacing: 60 }), sceneUniforms(THREE, {}), { tour: { seed: 7 } });
  try {
    const tour = forest.tour;
    assert.ok(tour && tour.twins.length > 0 && tour.boards.length > 0);
    const depthScene = [...forest.depth, ...tour.depth];
    const bands = [...Object.values(forest.byBand).flat(), ...Object.values(tour.byBand).flat()];
    const earlier = [...depthScene.filter(m => onLayer(m, 0)), ...bands.filter(m => onLayer(m, 0) || onLayer(m, 1))];
    const cut = depthScene.filter(m => onLayer(m, 2));
    const tourCut = tour.depth.filter(m => onLayer(m, 2));
    assert.ok(tourCut.length >= tour.twins.length + tour.boards.length, 'every twin and board draws a cut');
    for (const m of [...depthScene, ...bands, ...Object.values(tour.depthByBand).flat()]) {
      for (const k of [3, 4, 5]) assert.ok(!onLayer(m, k), `layer ${k}`);
      if (onLayer(m, 2)) assert.equal(m.material.colorWrite, false);
    }
    for (const d of cut) assert.ok(earlier.some(m => m.geometry === d.geometry));
    const camera = new THREE.PerspectiveCamera(50, 2, 1, 20000);
    camera.position.set(0, 1100, 0); camera.lookAt(0, 1000, -600); camera.updateMatrixWorld();
    const mode = (name) => { for (const g of forest.modeGeometries) setTerrainDrawMode(g, name); tour.setMode(name); };
    const all = { bits: tour.index.all.bits };
    const half = { bits: tour.index.all.bits.map((w, i) => i % 2 ? w : 0) };
    const states = [
      () => { mode('rail'); forest.applyVisibility({}); },
      () => { mode('tour'); forest.applyVisibility({}); },
      () => { tour.apply({ a: all, b: all, f: 1 }); forest.updateDetailView({ camera, width: 640, height: 320, pixelated: true }); },
      () => { tour.apply({ a: half, b: all, f: .4 }); forest.updateDetailView({ camera, width: 64, height: 32, pixelated: true }); },
      () => forest.updateDetailView({ camera, width: 640, height: 320, pixelated: false, nearDetail: false }),
      () => forest.applyVisibility({ shown: false }),
      () => { mode('rail'); forest.applyVisibility({ shown: true, nearDetail: true }); },
    ];
    let mixed = 0;
    for (const set of states) {
      set();
      for (const d of cut) assert.ok(earlier.filter(m => m.geometry === d.geometry).every(m => m.visible === d.visible));
      mixed += new Set(tourCut.map(d => d.visible)).size > 1 || new Set(cut.map(d => d.visible)).size > 1;
    }
    assert.ok(mixed > 0, 'some state shows part of the forest and hides the rest');
  } finally { forest.dispose(); }
});
