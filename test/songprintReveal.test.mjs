import test from 'node:test';
import assert from 'node:assert/strict';
import { songprintLandmarks } from '../src/world/alpine/BuildFocus.js';
import { landscapeScoreFor } from '../src/world/alpine/LandscapeScore.js';
import { frameSongprintLandmark } from '../src/world/alpine/SongprintReveal.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { terrainHeightAt } from '../src/world/alpine/TerrainMesh.js';
import { projectPoint, scenePoseAt } from '../src/world/terrain/SceneTravel.js';
import { cone, summitWorld, LEVEL } from './fixtures/summit-world.mjs';

const print = (times, positions) => ({ version: 1, passages: times.map((timeMs, i) =>
  ({ timeMs, landmark01: positions[i], strength: .8 })) });
const manager = (songprint, admitted = 0) => ({ durationMs: 92000, songTerrain: { songprint }, songprintAdmittedMs: admitted });
const subject = print([22000, 24000, 42000, 44000, 64000], [.85, .85, .83, .84, .12]);
const terrain = summitWorld((x, z) => Math.max(cone(x, z), cone(x + 2800, z), cone(x - 3400, z)));
const viewport = { logicalWidth: 1600, logicalHeight: 720, nominalHeight: 720 };
const tanY = Math.tan(terrain.view.camera.fovYDeg * Math.PI / 360);
const coneAngles = { tanX: tanY * viewport.logicalWidth / viewport.logicalHeight, tanY };
const anchors = songprintLandmarks(terrain.data, terrain.view);

test('a returning passage reaches the same visible measured crest on each recording clock', () => {
  assert.ok(anchors.length >= 3);
  for (const { pointM: [x, y, z] } of anchors) assert.equal(y, terrainHeightAt(terrain.data, x, z));
  const rail = scenePoseAt(terrain.view, { progress01: .5 });
  const sample = (record, t) => frameSongprintLandmark(rail, anchors,
    landscapeScoreFor(manager(record)).at(t).songprintCue, coneAngles);
  const first = sample(subject, 22000);
  const returnPose = sample(subject, 42000);
  const laterTake = print([31000, 53000], [.84, .86]);
  assert.ok(first.songprintReveal?.weight > .7);
  assert.deepEqual(returnPose.songprintReveal.pointM, first.songprintReveal.pointM);
  assert.deepEqual(sample(laterTake, 53000).songprintReveal.pointM, first.songprintReveal.pointM);
  assert.equal(sample(laterTake, 42000), rail);
  assert.notDeepEqual(sample(subject, 64000).songprintReveal.pointM, first.songprintReveal.pointM);
  assert.deepEqual(sample(subject, 42000), returnPose);
  assert.equal(first.eyeM, rail.eyeM);
  assert.equal(first.targetM, rail.targetM);
  assert.ok(first.viewOffset.fx > .2);
  assert.ok(Math.abs(first.viewOffset.rx) < first.viewOffset.fx * coneAngles.tanX);
  assert.ok(Math.abs(first.viewOffset.uy) < first.viewOffset.fx * coneAngles.tanY);
});

test('weak, absent and out-of-frame evidence preserves the camera; previews and the finale are neutral', () => {
  const rail = scenePoseAt(terrain.view, { progress01: .5 });
  const score = landscapeScoreFor(manager(subject));
  assert.equal(score.at(31000).songprintCue, null);
  assert.equal(score.at(42000, { preview: true }).songprintCue, null);
  assert.equal(landscapeScoreFor(manager(print([84000], [.85]))).at(84000).songprintCue, null);
  assert.equal(frameSongprintLandmark(rail, [], score.at(42000).songprintCue, coneAngles), rail);
  assert.equal(frameSongprintLandmark(rail, [{ pointM: [0, 1, -30000] }], score.at(42000).songprintCue, coneAngles), rail);
  const flat = summitWorld(() => LEVEL);
  assert.deepEqual(songprintLandmarks(flat.data, flat.view), []);
  assert.equal('songprintCue' in landscapeScoreFor(manager(null)).at(42000), false);
});

test('a late print preserves the heard prefix and fades in at the same weight after seeking', () => {
  const mgr = manager(null);
  const previous = landscapeScoreFor(mgr);
  mgr.songTerrain.songprint = subject;
  mgr.tSec = 42;
  const next = landscapeScoreFor(mgr);
  assert.deepEqual(next.at(42000), previous.at(42000));
  assert.ok(next.at(42001).songprintCue.weight < 1e-5);
  assert.ok(next.at(43000).songprintCue.weight > .35);
  assert.ok(next.at(43999).songprintCue.weight > .79);
  const seek = landscapeScoreFor(manager(subject, 42000));
  for (const t of [42001, 43000, 44000, 64000]) assert.deepEqual(seek.at(t).songprintCue, next.at(t).songprintCue);
  assert.equal(seek.at(22000).songprintCue, null);
});

test('the drawn pose tracks growing slot height, and studio and listener controls take precedence', () => {
  const { data, view } = terrain;
  const p = { data, view, songprintLandmarks: anchors.map(a => ({ ...a, slotId: 'summit' })), slotRise: {}, waterLevelM: LEVEL };
  const scene = Object.assign(Object.create(RangeScene.prototype), { _movedPoses: new WeakMap(),
    prepared: new Map([[view.id, p]]), _ensureTourWindow() {} });
  const frame = { timeMs: 42000, progress01: .5, scenicViewport: viewport, rise01: .85, slotRise01: { summit: .7 },
    performance: landscapeScoreFor(manager(subject)).at(42000) };
  const shot = scene.movedPose(view, frame).pose;
  const { drawnM, pointM } = shot.songprintReveal;
  assert.equal(drawnM[1], LEVEL + (pointM[1] - LEVEL) * .7);
  for (const override of [{ cameraStudio: { enabled: true } }, { userCamera: { fx: .2, rx: 0, uy: 0 } },
    { forcedCandidate: true }]) assert.equal(scene.movedPose(view, { ...frame, ...override }).pose.songprintReveal, undefined);
});

test('a confident return raises its measured slot to a recognizable relief and keeps it there on a seek', () => {
  const peaks = [{ slotId: 'left' }, { slotId: 'right' }];
  const stage = { slots: ['left', 'right', 'back', 'fore'].map(slotId => ({ slotId, row: 'back' })),
    principal: 'left', songprintLandmarks: peaks };
  const song = print([12000, 22000, 36000, 58000, 66000], [.89, .86, .84, .85, .2]);
  const mgr = { ...manager(song), durationMs: 200000, songTerrain: { songprint: song, songRange: { stage } } };
  const score = landscapeScoreFor(mgr), seek = landscapeScoreFor({ ...mgr });
  const natural = t => score.at(t, { songprintStage: false }).slotRise01;
  const height = t => score.at(t).slotRise01.right;
  for (const t of [0, 8000, 22000, 29999, 30000]) assert.deepEqual(score.at(t).slotRise01, natural(t));
  assert.ok(natural(36000).right < .4, 'the natural slot alone is still too low');
  assert.ok(height(33000) > .4 && height(33000) < .6);
  assert.ok(height(36000) >= .82 && height(58000) >= .82);
  let last = 0;
  for (let t = 0; t <= mgr.durationMs; t += 250) {
    const slots = score.at(t).slotRise01;
    assert.ok(slots.right >= last, `summit dropped at ${t}`);
    for (const id of ['left', 'back', 'fore']) assert.equal(slots[id], natural(t)[id]);
    last = slots.right;
  }
  assert.equal(height(mgr.durationMs), 1);
  for (const t of [57000, 33000, 0, 185000, 36000]) assert.deepEqual(seek.at(t), score.at(t));
  const late = landscapeScoreFor({ ...mgr, songprintAdmittedMs: 34000 });
  assert.deepEqual(late.at(36000).slotRise01, natural(36000));
  assert.ok(late.at(58000).slotRise01.right >= .82);
});


test('the paired crop keeps a composed crest and its companion visible on the surveyed rail', () => {
  const rail = { eyeM: [0, 700, 0], targetM: [0, 700, 9000], fovYDeg: 40 };
  const principal = { slotId: 'principal', pointM: [3900, 1800, 9000] };
  const companion = { slotId: 'companion', pointM: [-4050, 1575, 9000] };
  const aspect = 16 / 9, tanY = Math.tan(rail.fovYDeg * Math.PI / 360), tanX = tanY * aspect;
  const targets = [{ landmark01: .2, weight: .92 }];
  const cue = { targets, weight: .92 };
  const options = { tanX, tanY };
  const lens = (pose, peak) => {
    const p = projectPoint(rail, aspect, peak.pointM);
    return [(p.x - pose.viewOffset.rx / tanX) / (1 - pose.viewOffset.fx),
      (p.y - pose.viewOffset.uy / tanY) / (1 - pose.viewOffset.fx)];
  };
  const ordinary = frameSongprintLandmark(rail, [principal, companion], cue, options);
  assert.ok(Math.abs(lens(ordinary, companion)[0]) > 1);
  const paired = frameSongprintLandmark(rail, [principal, companion], cue, { ...options, composition: { principal, companion } });
  for (const peak of [principal, companion]) assert.ok(lens(paired, peak).every(value => Math.abs(value) < .99));
  assert.ok(paired.viewOffset.fx > 0);
  assert.equal(paired.eyeM, rail.eyeM);
  assert.equal(paired.targetM, rail.targetM);
  assert.equal(paired.songprintReveal.pointM, principal.pointM);
  assert.deepEqual(frameSongprintLandmark(rail, [principal, companion], cue, { ...options, composition: { principal, companion } }), paired);
});

test('a composed skyline is established after the opening and respects a late analysis or preview', () => {
  const stage = { slots: ['one', 'two'].map(slotId => ({ slotId, row: 'back' })), principal: 'one', companion: 'two' };
  const mgr = { ...manager(subject), songTerrain: { songprint: subject, songRange: { stage } } };
  const score = landscapeScoreFor(mgr);
  assert.equal(score.at(5000).songprintEstablish01, 0);
  assert.ok(score.at(9500).songprintEstablish01 > .7);
  assert.ok(score.at(21000).songprintEstablish01 < .2);
  assert.equal(score.at(22000).songprintEstablish01, 0);
  assert.equal(score.at(9500, { preview: true }).songprintEstablish01, undefined);
  assert.equal(score.at(9500, { songprintStage: false }).songprintEstablish01, undefined);
  const late = landscapeScoreFor({ ...mgr, songprintAdmittedMs: 17500 });
  assert.equal(late.at(18500).songprintEstablish01, 0);
  assert.deepEqual(score.at(9500), landscapeScoreFor({ ...mgr }).at(9500));
});
