import test from 'node:test';
import assert from 'node:assert/strict';
import { songprintLandmarks } from '../src/world/alpine/BuildFocus.js';
import { landscapeScoreFor } from '../src/world/alpine/LandscapeScore.js';
import { frameSongprintLandmark } from '../src/world/alpine/SongprintReveal.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { terrainHeightAt } from '../src/world/alpine/TerrainMesh.js';
import { scenePoseAt } from '../src/world/terrain/SceneTravel.js';
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
