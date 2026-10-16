// Natural-rendering Task 1: the scenic target's edge policy, its memory
// accounting and the partition coverage correction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeRenderPolicy, supportedSamples, msaaOverride, sceneTargetBytes, sideTargetBytes,
  nearerMask, correctCoverage, MSAA_4X_PIXEL_LIMIT } from '../src/world/alpine/RangeRenderPolicy.js';

const fakeGl = ({ max = 4, colour = [4, 2], depth = [4, 2], throws = false } = {}) => ({
  MAX_SAMPLES: 1, RENDERBUFFER: 2, RGBA8: 3, DEPTH_COMPONENT24: 4, SAMPLES: 5,
  getParameter: (p) => (p === 1 ? max : 0),
  getInternalformatParameter: (_t, f) => { if (throws) throw new Error('lost'); return new Int32Array(f === 3 ? colour : depth); },
});

test('capability is the largest count both colour and depth support, capped at 4x', () => {
  assert.equal(supportedSamples(fakeGl()), 4);
  assert.equal(supportedSamples(fakeGl({ max: 8, colour: [8, 4, 2], depth: [8, 4, 2] })), 4);
  assert.equal(supportedSamples(fakeGl({ depth: [2] })), 2);
  assert.equal(supportedSamples(fakeGl({ max: 1 })), 0);
  assert.equal(supportedSamples(fakeGl({ colour: [], depth: [] })), 0);
  assert.equal(supportedSamples(fakeGl({ throws: true })), 0, 'a lost context reports no samples instead of throwing');
  assert.equal(supportedSamples(null), 0);
  assert.equal(supportedSamples({ getParameter: () => 4 }), 0, 'WebGL1 has no per-format query: no samples');
});

test('Natural at full quality multisamples; Pixel/Palette and degraded rungs never do', () => {
  const base = { widthPx: 1920, heightPx: 1080, capability: 4 };
  assert.deepEqual(rangeRenderPolicy({ ...base, quality: 0 }), { samples: 4, reason: 'natural' });
  assert.equal(rangeRenderPolicy({ ...base, quality: 1 }).samples, 4);
  assert.equal(rangeRenderPolicy({ ...base, quality: 2 }).samples, 2);
  for (const q of [3, 4, 5, 6]) assert.deepEqual(rangeRenderPolicy({ ...base, quality: q }), { samples: 0, reason: 'quality' });
  assert.deepEqual(rangeRenderPolicy({ ...base, pixelated: true }), { samples: 0, reason: 'pixel-look' });
  assert.deepEqual(rangeRenderPolicy({ ...base, pixelated: true, override: 4 }), { samples: 0, reason: 'pixel-look' },
    'an override cannot blur the deliberate pixel grid');
  assert.equal(rangeRenderPolicy({ ...base, budget: 'mobile' }).samples, 2);
  assert.deepEqual(rangeRenderPolicy({ ...base, capability: 0 }), { samples: 0, reason: 'unsupported' });
  assert.equal(rangeRenderPolicy({ ...base, capability: 2 }).samples, 2, 'capability caps the request');
});

test('very large targets fall back to 2x; overrides are honoured within capability', () => {
  const big = Math.ceil(Math.sqrt(MSAA_4X_PIXEL_LIMIT)) + 1;
  assert.equal(rangeRenderPolicy({ widthPx: big, heightPx: big, capability: 4 }).samples, 2);
  assert.deepEqual(rangeRenderPolicy({ widthPx: 640, heightPx: 360, capability: 4, quality: 5, override: 4 }), { samples: 4, reason: 'override' });
  assert.deepEqual(rangeRenderPolicy({ widthPx: 640, heightPx: 360, capability: 2, override: 4 }), { samples: 2, reason: 'override' });
  assert.deepEqual(rangeRenderPolicy({ widthPx: 640, heightPx: 360, capability: 4, override: 0 }), { samples: 0, reason: 'override' });
  assert.equal(msaaOverride('?rangeMsaa=2'), 2);
  assert.equal(msaaOverride('rangeMsaa=0'), 0);
  assert.equal(msaaOverride('?rangeMsaa=3'), null);
  assert.equal(msaaOverride('?x=1'), null);
});

test('reservations include multisample renderbuffers and the ownership image', () => {
  assert.equal(sceneTargetBytes(100, 50, 0), 100 * 50 * 12, 'unchanged single-sample accounting');
  assert.equal(sideTargetBytes(100, 50, 0), 100 * 50 * 8);
  assert.equal(sceneTargetBytes(100, 50, 4), 100 * 50 * (12 + 32 + 4));
  assert.equal(sideTargetBytes(100, 50, 2), 100 * 50 * (8 + 16 + 4));
});

test('coverage correction makes disjoint partitions composite to full coverage without halos', () => {
  const over = (dst, src) => dst.map((d, i) => src[i] + d * (1 - src[3]));
  const sky = [0.9, 0.9, 1.0, 1.0];
  for (const split of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    // A silhouette pixel: near owns `split` of it, far the rest.
    const own = [1 - split, 0, split];
    const farColour = [0.2, 0.3, 0.1], nearColour = [0.05, 0.08, 0.04];
    const far = [...farColour.map(c => c * (1 - split)), 1 - split];
    const near = [...nearColour.map(c => c * split), split];
    const naive = over(over(sky, far), near);
    const fixed = over(over(sky, correctCoverage(far, own, nearerMask('far'))), correctCoverage(near, own, nearerMask('near')));
    const expected = [0, 1, 2].map(i => farColour[i] * (1 - split) + nearColour[i] * split);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(fixed[i] - expected[i]) < 1e-9, `split ${split}: no sky in a fully covered pixel`);
    assert.ok(naive[0] > expected[0] + 0.05, 'naive source-over leaves a pale halo (the bug being prevented)');
  }
  // A ridge against open sky: nothing nearer, the edge keeps its partial alpha.
  assert.deepEqual(correctCoverage([0.1, 0.1, 0.1, 0.5], [0.5, 0, 0], nearerMask('far')), [0.1, 0.1, 0.1, 0.5]);
  // The nearest partition is never rescaled.
  assert.deepEqual(correctCoverage([0.1, 0.1, 0.1, 0.5], [0.2, 0.3, 0.5], nearerMask('near')), [0.1, 0.1, 0.1, 0.5]);
  // Never over-unity alpha, never divide by zero.
  const c = correctCoverage([0.4, 0.4, 0.4, 0.6], [0.5, 0, 0.5], nearerMask('far'));
  assert.ok(c[3] <= 1 + 1e-12);
  assert.deepEqual(correctCoverage([0, 0, 0, 0], [0, 0, 1], nearerMask('far')), [0, 0, 0, 0]);
  assert.ok(correctCoverage([0.01, 0.01, 0.01, 0.01], [0, 0, 1], nearerMask('far')).every(Number.isFinite));
});

// --- RangeScene integration, without a GL context ---------------------------
import * as THREE from 'three';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { GraphicsResidency, MiB } from '../src/render/GraphicsResidency.js';

function sizedScene({ capability = 4, budgetMiB = 512, override = null } = {}) {
  const s = Object.create(RangeScene.prototype);
  const disposed = [];
  Object.assign(s, { THREE, residency: new GraphicsResidency({ budgetBytes: budgetMiB * MiB }), budget: 'desktop',
    renderer: { setPixelRatio() {}, setSize() {} }, size: { width: 0, height: 0 }, target: null, sideTargets: { B: null },
    ownership: { A: null, B: null }, mirrors: { A: null, B: null }, depthCache: { A: { frame: -1 }, B: { frame: -1 } },
    edge: { capability, override, samples: 0, reason: 'not-sized' }, disposed });
  s.releaseShafts = () => {}; s.releaseMirror = () => {};
  return s;
}

test('resize allocates the policy\'s samples, reserves their bytes and reallocates when the rung changes', () => {
  const s = sizedScene();
  s.resize({ widthPx: 640, heightPx: 360, quality: 0 });
  assert.equal(s.target.samples, 4);
  assert.ok(s.ownership.A && s.ownership.A.samples === 0, 'ownership is a resolved single-sample image');
  assert.equal(s.residency.entries.get('range:render-target').bytes, sceneTargetBytes(640, 360, 4));
  assert.deepEqual([s.renderDiagnostics().samples, s.renderDiagnostics().edgeReason], [4, 'natural']);
  const first = s.target;
  s.resize({ widthPx: 640, heightPx: 360, quality: 1 });
  assert.equal(s.target, first, 'same size and samples keep the target');
  s.resize({ widthPx: 640, heightPx: 360, quality: 4 });
  assert.notEqual(s.target, first);
  assert.equal(s.target.samples, 0);
  assert.equal(s.ownership.A, null);
  assert.equal(s.residency.entries.get('range:render-target').bytes, sceneTargetBytes(640, 360, 0));
  s.resize({ widthPx: 640, heightPx: 360, quality: 0, pixelated: true });
  assert.equal(s.target.samples, 0, 'Pixel/Palette never multisample');
  assert.equal(s.edge.reason, 'pixel-look');
});

test('a ledger without room for samples falls back to a single-sampled target, then refuses', () => {
  const tight = sizedScene({ budgetMiB: 6 });
  tight.resize({ widthPx: 640, heightPx: 360 });
  assert.equal(tight.target.samples, 0);
  assert.equal(tight.edge.reason, 'budget');
  const none = sizedScene({ budgetMiB: 1 });
  assert.throws(() => none.resize({ widthPx: 640, heightPx: 360 }), (e) => e.reason === 'budget');
});

// G1: a budget fallback is a decision about one request, not a per-frame
// retry. Identical requests keep the single-sampled target and every
// attachment hanging off it; only a changed request re-evaluates, once.
function countingScene(opts) {
  const s = sizedScene(opts);
  const counts = { alloc: 0, shafts: 0, mirrors: 0 };
  const scenic = s._scenicTarget;
  s._scenicTarget = function (...a) { counts.alloc++; return scenic.apply(this, a); };
  s.releaseShafts = () => { counts.shafts++; s.shafts = null; };
  s.releaseMirror = (side) => { counts.mirrors++; s.mirrors[side] = null; };
  s.contextEpoch = 0;
  return { s, counts };
}

test('identical requests after a budget fallback keep the target, side B, mirror and shafts', () => {
  const { s, counts } = countingScene({ budgetMiB: 6 });
  const req = { widthPx: 640, heightPx: 360, quality: 0 };
  s.resize(req);
  assert.equal(s.target.samples, 0);
  assert.equal(s.edge.reason, 'budget');
  assert.equal(s.renderDiagnostics().requestedSamples, 4, 'diagnostics keep what the policy asked for');
  assert.equal(s.renderDiagnostics().samples, 0);
  assert.ok(s.ensureSide('B'), 'side B fits next to the single-sampled target');
  const target = s.target, side = s.sideTargets.B;
  const mirror = { sentinel: 'mirror' }, shafts = { sentinel: 'shafts' };
  s.mirrors.A = mirror; s.shafts = shafts;
  const before = { ...counts, denials: s.residency.denials, bytes: s.residency.usedBytes };
  for (let i = 0; i < 100; i++) s.resize(req);
  assert.equal(s.target, target);
  assert.equal(s.sideTargets.B, side);
  assert.equal(s.mirrors.A, mirror);
  assert.equal(s.shafts, shafts);
  assert.deepEqual({ ...counts, denials: s.residency.denials, bytes: s.residency.usedBytes }, before,
    'no allocation, release, denial or byte change on unchanged requests');
  assert.equal(s.edge.reason, 'budget');
});

test('a changed request re-evaluates a budget fallback exactly once', () => {
  const cases = {
    resize: (s) => s.resize({ widthPx: 600, heightPx: 340, quality: 0 }),
    quality: (s) => s.resize({ widthPx: 640, heightPx: 360, quality: 1 }),
    look: (s) => s.resize({ widthPx: 640, heightPx: 360, quality: 0, pixelated: true }),
    context: (s) => { s.contextEpoch++; s.resize({ widthPx: 640, heightPx: 360, quality: 0 }); },
    budget: (s) => { s.residency.budgetBytes = 64 * MiB; s.resize({ widthPx: 640, heightPx: 360, quality: 0 }); },
    released: (s) => { s.residency.release('range:render-target'); assert.equal(s.target, null, 'a released target is not kept'); s.resize({ widthPx: 640, heightPx: 360, quality: 0 }); },
  };
  for (const [name, change] of Object.entries(cases)) {
    const { s, counts } = countingScene({ budgetMiB: 6 });
    s.resize({ widthPx: 640, heightPx: 360, quality: 0 });
    const allocs = counts.alloc;
    change(s);
    // Pixel/Palette asks for no samples: the single-sampled target already
    // satisfies it, so the re-evaluation keeps it.
    const expected = allocs + (name === 'look' ? 0 : 1);
    assert.equal(counts.alloc, expected, `${name}: one re-evaluation`);
    const t = s.target;
    for (let i = 0; i < 20; i++) s.resize({ ...s._edgeRequest.args });
    assert.equal(counts.alloc, expected, `${name}: no retry loop afterwards`);
    assert.equal(s.target, t);
    assert.equal(s.residency.entries.get('range:render-target').resource, s.target, `${name}: the ledger owns the live target`);
    assert.equal(s.residency.entries.get('range:render-target').bytes, sceneTargetBytes(s.size.width, s.size.height, s.target.samples), `${name}: bytes match`);
    if (name === 'budget') assert.deepEqual([s.target.samples, s.edge.reason], [4, 'natural'], 'more room restores samples');
    if (name === 'look') assert.equal(s.edge.reason, 'pixel-look');
    if (['resize', 'quality', 'context', 'released'].includes(name)) assert.equal(s.edge.reason, 'budget');
  }
});

test('travel side B matches the main samples and its release frees the ownership image', () => {
  const s = sizedScene();
  s.resize({ widthPx: 320, heightPx: 180 });
  assert.ok(s.ensureSide('B'));
  assert.equal(s.sideTargets.B.samples, 4);
  assert.ok(s.ownership.B);
  assert.equal(s.residency.entries.get('range:render-target-B').bytes, sideTargetBytes(320, 180, 4));
  s.releaseSide('B');
  assert.equal(s.sideTargets.B, null);
  assert.equal(s.ownership.B, null);
  assert.equal(s.residency.entries.has('range:render-target-B'), false);
});

test('a multisampled pre-pass records ownership once; copies correct coverage except during travel', () => {
  const camera = new THREE.PerspectiveCamera(), log = [];
  const depthMaterial = { name: 'depth' }, owners = { far: { name: 'own-far' }, mid: { name: 'own-mid' }, near: { name: 'own-near' } };
  const meshes = { far: { material: depthMaterial }, mid: { material: depthMaterial }, near: { material: depthMaterial } };
  const p = { view: {}, uniforms: { uNarrativeInk: { value: 0 }, uBackdropAmount: { value: 0 }, uDiag: { value: 0 } },
    forest: { counts: {} }, actors: { groups: {} }, depthScene: 'depth', depthScenes: { far: 'df', mid: 'dm', near: 'dn' },
    scenes: { far: 'far', mid: 'mid', near: 'near' }, depthMaterial, ownershipMaterials: owners, depthBandMeshes: meshes, fringeMeshes: [] };
  const target = { texture: 'target-texture' }, own = { texture: 'own-texture' };
  let current = null;
  const copyUniforms = { uColor: { value: null }, uOwn: { value: null }, uNearer: { value: new THREE.Vector3() }, uUseOwn: { value: 0 } };
  const renderer = { setRenderTarget(t) { current = t; }, setClearColor() {}, clear() {},
    render(scene) {
      if (scene === 'depth') log.push(['depth', meshes.far.material.name, meshes.near.material.name]);
      else if (scene === 'copy') log.push(['copy', current === own ? 'own' : current === null ? 'screen' : 'other', copyUniforms.uUseOwn.value, copyUniforms.uNearer.value.toArray()]);
      else log.push([scene]);
    } };
  const s = Object.assign(Object.create(RangeScene.prototype), { camera, renderer, target, canvas: {}, sideTargets: { B: { texture: 'b' } },
    ownership: { A: own, B: null }, size: { width: 8, height: 8 }, prepared: new Map([['v', p]]),
    depthCache: { A: { frame: -1 }, B: { frame: -1 } }, stats: { depthPasses: 0 },
    _copy: { mesh: { material: { uniforms: copyUniforms } }, scene: 'copy', camera },
    _setCamera() {}, _setUniforms() {}, _prepareMirror() {}, _setCanvasSize() {}, _travelDepth() { log.push(['travel-depth']); }, _travelFringe() {} });
  const frame = { frameId: 7, qualityLevel: 0, light: {} };
  for (const pass of ['far', 'mid', 'near']) s.renderPartition(frame, pass, 'v');
  assert.deepEqual(log.filter(r => r[0] === 'depth'), [['depth', 'own-far', 'own-near']], 'one owning pre-pass per frame');
  assert.ok(Object.values(meshes).every(m => m.material === depthMaterial), 'depth materials restored after the pre-pass');
  assert.deepEqual(log.filter(r => r[0] === 'copy'), [
    ['copy', 'own', 0, [0, 0, 0]],
    ['copy', 'screen', 1, [0, 1, 1]], ['copy', 'screen', 1, [0, 0, 1]], ['copy', 'screen', 1, [0, 0, 0]]]);
  // Travel draws a side's nearer bands only in some columns: no correction.
  log.length = 0;
  s.renderPartition({ ...frame, frameId: 8 }, 'far', 'v', { bandColumns: { far: [0, 8] } });
  assert.deepEqual(log.filter(r => r[0] === 'copy').map(r => r.slice(0, 3)), [['copy', 'screen', 0]]);
});

// --- Task 5: the legacy sea plane behind inland Range views -----------------
import { rangeDrawsSea } from '../src/world/alpine/LandscapePolicy.js';

test('inland v2 views drop the legacy sea plane; legacy biomes and opted-in views keep it', () => {
  assert.equal(rangeDrawsSea([]), true);
  assert.equal(rangeDrawsSea([null, null]), true, 'legacy scenery keeps its ocean');
  assert.equal(rangeDrawsSea([{ id: 'teton-jackson-lake' }]), false);
  assert.equal(rangeDrawsSea([{ id: 'coast', seaHorizon: true }]), true);
  assert.equal(rangeDrawsSea([{ id: 'coast', seaHorizon: true }, { id: 'inland' }]), false, 'either side inland: no strip');
  assert.equal(rangeDrawsSea([{ id: 'ice', glacier: {}, seaHorizon: true }]), false, 'glacier views never had one');
  assert.equal(rangeDrawsSea([null, { id: 'inland' }]), false);
});
