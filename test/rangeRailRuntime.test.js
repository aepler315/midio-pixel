import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RangePresentation } from '../src/world/alpine/RangePresentation.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { sceneUniforms } from '../src/world/alpine/TerrainMaterial.js';
import { calibrateRangeMusic } from '../src/world/alpine/RangeFrame.js';
import { sceneProgressAt } from '../src/world/terrain/SceneTravel.js';
import { compileSceneRailPlan } from '../src/world/terrain/SceneRailPlan.js';

const camera = { eyeStartM: [0, 1500, 0], eyeEndM: [1000, 1600, 0],
  targetStartM: [0, 700, -9000], targetEndM: [2000, 700, -8000], fovYDeg: 35 };
const views = ['a', 'b', 'c'].map((id, i) => ({ id, biome: ['RAINFOREST', 'TAIGA', 'ALPINE'][i],
  status: 'approved', camera, terrainManifestUrl: `${id}.json` }));
const catalog = { catalogVersion: 1, views };
const terrain = { sceneByBiome: new Map(views.map(view => [view.biome, { view }])) };
const sections = [{ startMs: 0, profile: 'RAINFOREST', barMs: 750 },
  { startMs: 20000, profile: 'TAIGA', barMs: 750 }, { startMs: 40000, profile: 'ALPINE', barMs: 750 }];
function inputs(timeMs, custom = {}) {
  return { sim: { heardTimeMs: timeMs, songSeed: 7, perf: { level: 0 }, biomes: {
    currentBlend: { from: 'ALPINE', to: 'ALPINE', t: 1 }, sections, tSec: timeMs / 1000,
    durationMs: 180000, songSeed: 7, worldId: 'range', world: {}, _profile: () => null,
    ...custom,
  } }, pose: { worldX: 0, midioX: 0, midioDrawX: 0, midioY: 0 },
  scenicViewport: { logicalWidth: 1280, logicalHeight: 720, backingWidth: 1280, backingHeight: 720 },
  groundViewport: { logicalWidth: 1280, logicalHeight: 720 } };
}
function canvas(width, height) {
  return { width, height, getContext: () => ({ clearRect() {}, save() {}, restore() {},
    beginPath() {}, rect() {}, clip() {}, drawImage() {}, setTransform() {} }) };
}
async function setup(options = {}) {
  const ready = new Set(), calls = [];
  const scene = { prepared: new Map(), _movedPoses: new WeakMap(), _ensureTourWindow() {},
    isReady: id => ready.has(id), prepare: async view => { ready.add(view.id); }, resize() {}, release() {},
    ensureSide: () => true, releaseSide() {}, pinView(ids) { this.pinned = [].concat(ids); },
    renderPartition(frame, pass, id, { side = 'A' } = {}) { calls.push({ frame, pass, id, side }); return canvas(1280, 720); },
    movedPose: RangeScene.prototype.movedPose, snapshot: () => ({}),
  };
  const p = new RangePresentation({ mode: 'v2', catalog, shots: false, sceneFactory: async () => scene, makeCanvas: canvas });
  p.setSong({ terrain, mgr: inputs(0).sim.biomes, ...options });
  await p.whenReady();
  return { p, scene, ready, calls };
}
function draw(p, timeMs, custom) {
  p.setFrameInputs(inputs(timeMs, custom));
  assert.equal(p.beginScenic(), true);
}

// Catches continued selection from currentBlend and shared whole-song side progress.
test('scheduled ordinary rails choose actual views and render independent frozen transition sides at 3x', async () => {
  const { p, calls } = await setup();
  draw(p, 10000);
  assert.equal(p.viewId, 'a');
  const start = p.status().cameraRails.from;
  draw(p, 11000);
  const delta = p.status().cameraRails.from.progress01 - start.progress01;
  const baseDelta = sceneProgressAt({ timeMs: 11000, durationMs: 180000 }) - sceneProgressAt({ timeMs: 10000, durationMs: 180000 });
  assert.ok(Math.abs(delta / baseDelta - 3) < 1e-9);
  draw(p, 21000);
  assert.equal(p.viewId, 'a'); assert.equal(p.incomingViewId, 'b');
  assert.equal(p.seamP, 1 / 3, 'entering transition is 3s, not the 8.2s fit reservation');
  p.drawPartition(canvas(1280, 720).getContext(), 'far', { width: 1280, height: 720 });
  assert.equal(calls.length, 2);
  const [a, b] = calls.map(call => call.frame);
  assert.notEqual(a.occurrenceId, b.occurrenceId);
  assert.notEqual(a.progress01, b.progress01);
  assert.equal(a.progress01, p.status().cameraRails.from.progress01);
  assert.equal(b.progress01, p.status().cameraRails.to.progress01);
  assert.equal(p.frame.progress01, sceneProgressAt({ timeMs: 21000, durationMs: 180000 }));
  for (const object of [a, b, p.frame.railSides, a.railState, b.railState]) assert.ok(Object.isFrozen(object));
  assert.throws(() => { a.railState.progress01 = 0; }, TypeError);
  assert.equal(p.status().cameraRails.scheduleId, p.cameraSchedule.id);
  assert.equal('bases' in p.status().cameraRails, false);
});

// Catches restoring through the new biome choice map or silently recompiling a supplied snapshot.
test('JSON restored selection retains catalog views when current analysis and assignments differ', async () => {
  const { p } = await setup();
  const saved = JSON.parse(JSON.stringify(p.cameraSchedule));
  const changed = { sceneByBiome: new Map([['RAINFOREST', { view: views[2] }], ['ALPINE', { view: views[2] }]]) };
  p.setSong({ terrain: changed, mgr: inputs(0, { sections: [{ startMs: 0, profile: 'ALPINE' }] }).sim.biomes,
    cameraSchedule: saved, requestedMultiplier: 1 });
  await p.whenReady();
  assert.deepEqual(p.cameraSchedule, saved);
  draw(p, 21000);
  assert.equal(p.viewId, 'a'); assert.equal(p.incomingViewId, 'b');
  assert.equal(p.status().cameraRails.requestedMultiplier, 3);
});

test('owner repacing keeps readiness and fades while protecting begun occurrences', async () => {
  const { p } = await setup();
  draw(p, 21000);
  const previous = p.railPlan, owner = p._readinessOwner, frame = p.frame;
  const handoff = p._handoff, join = p._incomingJoin;
  p.setRailPace(4, 21000);
  assert.equal(p._readinessOwner, owner); assert.equal(p.frame, frame);
  assert.equal(p._handoff, handoff); assert.equal(p._incomingJoin, join);
  assert.deepEqual(p.railPlan.occurrences.slice(0, 2), previous.occurrences.slice(0, 2));
  assert.equal(p.railPlan.occurrences[2].requestedMultiplier, 4);
});

test('late incoming handoff preserves outgoing occurrence and progress after musical and scheduled blend collapse', async () => {
  const { p, ready } = await setup();
  ready.delete('b'); p._prepare = () => {};
  draw(p, 22500);
  const outgoing = p.status().cameraRails.from.occurrenceId;
  ready.add('b');
  draw(p, 22800);
  assert.equal(p.incomingFade, 0);
  draw(p, 23200);
  assert.equal(p.viewId, 'a'); assert.equal(p.incomingViewId, 'b'); assert.equal(p.seamP, 1);
  assert.equal(p.status().cameraRails.from.occurrenceId, outgoing);
  assert.equal(p.status().cameraRails.from.progress01, p.railPlan.railStateAt(outgoing, 23200).progress01);
  assert.ok(p.incomingFade > 0 && p.incomingFade < 1);
  draw(p, 24001); assert.equal(p.viewId, 'b'); assert.equal(p.incomingViewId, null);
});

test('consecutive same-view sections retain one trajectory without reset', async () => {
  const same = [sections[0], { ...sections[1], profile: 'RAINFOREST' }, sections[2]];
  const { p } = await setup({ mgr: inputs(0, { sections: same }).sim.biomes });
  draw(p, 19999); const a = p.status().cameraRails.from;
  draw(p, 20001); const b = p.status().cameraRails.from;
  assert.equal(a.occurrenceId, b.occurrenceId);
  assert.ok(b.progress01 > a.progress01 && b.progress01 - a.progress01 < .001);
  assert.equal(p.incomingViewId, null);
});

test('preview glacier tour and candidate policies bypass requested 3x and ordinary 1x stays compatible', async () => {
  for (const [policy, extra] of [['preview', { terrainPreview: true }], ['rail', {}]]) {
    const { p } = await setup({ requestedMultiplier: 1 });
    draw(p, 10000, extra);
    assert.equal(p.status().cameraRails.from.policy, policy);
    assert.equal(p.status().cameraRails.from.effectiveMultiplier, 1);
    assert.equal(p.status().cameraRails.from.progress01, policy === 'preview' ? .5 : p.frame.progress01);
  }
  for (const [policy, extra] of [['glacier', { glacier: {} }], ['tour', { tour: { poseAt: timeMs => ({ eyeM: [timeMs, 2000, 0], targetM: [0, 700, -9000], fovYDeg: 35 }) } }], ['candidate', { status: 'candidate' }]]) {
    const { p } = await setup();
    p.catalog = { ...catalog, views: [{ ...views[0], ...extra }, ...views.slice(1)] };
    draw(p, 10000);
    const state = p.status().cameraRails.from;
    assert.equal(state.policy, policy); assert.equal(state.effectiveMultiplier, 1); assert.equal(state.capped, false);
    if (policy === 'glacier') assert.equal(state.progress01, p.frame.glacier.journey01);
    if (policy === 'candidate') assert.equal(state.progress01, p.frame.progress01);
  }
});

// Catches same-view occurrence collisions and re-sampling projection/rail after sky light reprojection.
test('camera cache shares the complete pose through immutable light clones and separates repeated view occurrences', () => {
  const scene = Object.assign(Object.create(RangeScene.prototype), { prepared: new Map(), _movedPoses: new WeakMap(),
    _ensureTourWindow() {}, camera: new THREE.PerspectiveCamera() });
  const key = {}, frame = { cameraFrameKey: key, occurrenceId: 'first-a', timeMs: 10000, progress01: .2,
    scenicViewport: inputs(0).scenicViewport };
  const first = scene.movedPose(views[0], frame);
  assert.equal(scene.movedPose(views[0], { ...frame, light: {} }), first);
  const other = scene.movedPose(views[0], { ...frame, occurrenceId: 'later-a', progress01: .8 });
  assert.notDeepEqual(other.pose.eyeM, first.pose.eyeM);
  assert.equal(first.rail.eyeM[0], 200); assert.equal(other.rail.eyeM[0], 800);
});

test('explicit refinement preserves begun camera and takes new analysis only in the future', async () => {
  const { p } = await setup();
  const old = p.cameraSchedule;
  const mgr = inputs(0, { sections: [{ startMs: 0, profile: 'ALPINE' }, { startMs: 20000, profile: 'RAINFOREST' },
    { startMs: 50000, profile: 'ALPINE' }, { startMs: 70000, profile: 'TAIGA' }] }).sim.biomes;
  p.setSong({ terrain, mgr, cameraSchedule: old, cameraRefineThroughMs: 10000, requestedMultiplier: 4 });
  assert.deepEqual(p.railPlan.occurrences[0], old.occurrences[0]);
  assert.equal(p.railPlan.occurrences[1].viewId, 'b');
  assert.equal(p.railPlan.occurrences[1].startMs, 20000);
  assert.equal(p.cameraSchedule.requestedMultiplier, 4);
  assert.equal(p.railPlan.occurrences.at(-1).viewId, 'b');
  assert.notEqual(p.cameraSchedule.id, old.id);
  // Detached schedules remain usable without any analysis closure.
  assert.ok(compileSceneRailPlan({ sections: [], durationMs: 100 }).snapshot);
});

test('sky and shared terrain calibration consume the exact moved camera for each side', async () => {
  const { p, scene } = await setup();
  draw(p, 21000);
  const renderer = Object.assign(Object.create(RangeScene.prototype), { THREE, camera: new THREE.PerspectiveCamera(),
    prepared: new Map(), _movedPoses: scene._movedPoses, _ensureTourWindow() {} });
  for (const [side, view] of [['A', views[0]], ['B', views[1]]]) {
    const drawn = p._sideFrame(side);
    const frame = { ...drawn, music: { ...drawn.music, amplitudeM: 1, structuralM: 1, totalBoundM: 2 } };
    const resolved = renderer.movedPose(view, frame);
    assert.deepEqual(p.skyPan.skyCamera[side === 'A' ? 'from' : 'to'].referencePose.eyeM, resolved.rail.eyeM);
    const uniforms = sceneUniforms(THREE, { uHeightRange: { value: new THREE.Vector2(0, 100000) } });
    const prepared = { view, uniforms };
    renderer._setCamera(view, frame, prepared);
    renderer._setUniforms(prepared, frame);
    const depthM = Math.hypot(...resolved.pose.eyeM.map((value, i) => value - resolved.pose.targetM[i]));
    const expected = calibrateRangeMusic(frame.music, { depthM, fovYDeg: resolved.pose.fovYDeg,
      nominalHeight: 720, heightRange: [0, 100000] });
    assert.equal(uniforms.uDeformAmp.value, expected.amplitudeM);
    assert.equal(uniforms.uDeformStructural.value, expected.structuralM);
    assert.ok(uniforms.uDeformAmp.value > 0);
    assert.equal(renderer.camera.userData.rangeCameraPose, resolved.pose);
    assert.equal(renderer.movedPose(view, { ...frame, light: {} }), resolved);
  }
});

test('fallback sky uses the scheduled side progress independently of the music blend', async () => {
  const { p, scene } = await setup();
  delete scene.movedPose;
  draw(p, 21000);
  assert.equal(p.skyPan.skyCamera.from.referencePose.eyeM[0], p.status().cameraRails.from.progress01 * 1000);
  assert.equal(p.skyPan.skyCamera.to.referencePose.eyeM[0], p.status().cameraRails.to.progress01 * 1000);
});

// Catches evidence pairing A's view/global frame with the last-drawn B camera.
test('motion evidence captures a selected side frame and its camera even after the other side drew last', async () => {
  const { captureRangeMotionSnapshot } = await import('../tools/lib/range-motion-metrics.mjs');
  assert.equal(typeof captureRangeMotionSnapshot, 'function');
  const { p, scene } = await setup();
  Object.assign(scene, { camera: new THREE.PerspectiveCamera(), _setCamera: RangeScene.prototype._setCamera });
  for (const view of views) scene.prepared.set(view.id, { view });
  draw(p, 21000);
  scene._setCamera(views[1], p._sideFrame('B'));
  const previous = scene.camera.position.toArray();
  const snapshot = captureRangeMotionSnapshot(p, 'A');
  assert.equal(snapshot.view.id, 'a'); assert.equal(snapshot.frame, p._sideFrame('A'));
  assert.equal(snapshot.camera.pose, scene.movedPose(views[0], snapshot.frame).pose);
  assert.notDeepEqual(snapshot.camera.world.slice(12, 15), previous);
  assert.deepEqual(snapshot.camera.world.slice(12, 15), snapshot.camera.pose.eyeM);
  assert.equal(JSON.parse(JSON.stringify(snapshot)).frame.occurrenceId, p.status().cameraRails.from.occurrenceId);
});

test('a separated return to the same view owns a new occurrence and its own incoming fade', async () => {
  const repeated = [sections[0], sections[1], { ...sections[2], profile: 'RAINFOREST' }];
  const { p, ready } = await setup({ mgr: inputs(0, { sections: repeated }).sim.biomes });
  draw(p, 10000); const first = p.status().cameraRails.from.occurrenceId;
  draw(p, 24000);
  ready.delete('a'); p._prepare = () => {};
  draw(p, 42500); assert.equal(p.viewId, 'b');
  ready.add('a'); draw(p, 42800); assert.equal(p.incomingFade, 0);
  draw(p, 43200); assert.equal(p.viewId, 'b'); assert.equal(p.incomingViewId, 'a');
  const returned = p.status().cameraRails.to;
  assert.notEqual(returned.occurrenceId, first);
  assert.ok(p.incomingFade > 0 && p.incomingFade < 1);
  assert.equal(returned.progress01, p.railPlan.railStateAt(returned.occurrenceId, 43200).progress01);
});
