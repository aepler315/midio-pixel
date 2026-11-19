import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { PerspectiveCamera, Vector3 } from 'three';
import { songprintLandmarks } from '../src/world/alpine/BuildFocus.js';
import { seenFrom } from '../src/world/alpine/LineOfSight.js';
import { buildRangeFrame, rangeSideFrame } from '../src/world/alpine/RangeFrame.js';
import { RangePresentation } from '../src/world/alpine/RangePresentation.js';
import { RangeShotTours } from '../src/world/alpine/RangeShotTours.js';
import { loadTerrainPackage } from '../src/world/alpine/RangeAssets.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { songprintRailStations } from '../src/world/alpine/SongprintViewpoints.js';
import { loadShotLibrary } from '../src/world/terrain/ShotLibrary.js';
import { shotPlanRequest } from '../src/world/terrain/ShotRuntime.js';
import { restoreShotTimeline } from '../src/world/terrain/ShotTimeline.js';
import { handleShotMessage } from '../src/world/terrain/shot-worker.js';
import { projectPoint } from '../src/world/terrain/SceneTravel.js';
import catalog from '../src/world/terrain/sceneCatalogData.js';
import { anthemSong } from './fixtures/shot-library-fixture.mjs';
import { cone, LEVEL, summitWorld } from './fixtures/summit-world.mjs';

const durationMs = 120000;
const returnMs = 52000;
const viewport = { logicalWidth: 1280, logicalHeight: 720, nominalHeight: 720 };

function sceneFixture() {
  const { view, data } = summitWorld((x, z) => Math.max(cone(x, z), cone(x + 2800, z), cone(x - 3400, z)));
  Object.assign(view, { status: 'approved', biome: 'ALPINE' });
  Object.assign(view.camera, {
    eyeStartM: [6400, 1900, -1600], eyeEndM: [6600, 1900, -1300],
    targetStartM: [10400, 1100, 6400], targetEndM: [1000, 1100, 6400], fovYDeg: 34,
  });
  view.songprintLandmarks = songprintLandmarks(data, view);
  view.songprintRailStations = songprintRailStations(data, view, view.songprintLandmarks);
  const landmark = view.songprintLandmarks.at(-1);
  const neighbor = view.songprintLandmarks.at(-2);
  assert.deepEqual(landmark.pointM, [3600, 2505, 8000]);
  const ordinary = { sceneByBiome: new Map([[view.biome, { view }]]) };
  const songprint = { version: 1, passages: [
    { timeMs: 22000, landmark01: .95, strength: .4 },
    { timeMs: returnMs, landmark01: .95, strength: .94 },
  ] };
  return { view, data, landmark, neighbor, ordinary, directed: { ...ordinary, songprint } };
}

function playback({ view, data }, terrain, cameraSchedule = null, { songprintAdmittedMs = 0 } = {}) {
  const prepared = { data, view, waterLevelM: LEVEL, songprintLandmarks: view.songprintLandmarks };
  const scene = Object.assign(Object.create(RangeScene.prototype), {
    camera: new PerspectiveCamera(), prepared: new Map([[view.id, prepared]]),
    _movedPoses: new WeakMap(), _ensureTourWindow() {},
  });
  const manager = {
    durationMs, songTerrain: terrain, songprintAdmittedMs, world: { kind: 'alpine' }, worldId: 'range',
    sections: [{ profile: view.biome, startMs: 0, endMs: durationMs }],
    _profile: () => null,
  };
  const presentation = new RangePresentation({ mode: 'v2', catalog: { views: [view] } });
  presentation.scene = scene;
  const sim = { biomes: manager };
  presentation.setSong({ terrain, mgr: manager, cameraSchedule, requestedMultiplier: 4 });
  presentation.frameInputs = { sim };
  return {
    schedule: presentation.cameraSchedule,
    read(timeMs, landmark) {
      sim.heardTimeMs = timeMs;
      const frame = buildRangeFrame({
        frameId: timeMs, sim, pose: { worldX: 0, midioX: 0 }, scenicViewport: viewport,
        groundViewport: viewport, sceneAssignments: terrain.sceneByBiome,
      });
      const occurrence = presentation.railPlan.selectionAt(timeMs).to;
      const railState = presentation._railState({ view, occurrence }, frame);
      const pose = scene._setCamera(view, rangeSideFrame(frame, railState), prepared);
      const height = LEVEL + frame.rise01 * (landmark.pointM[1] - LEVEL);
      const clip = new Vector3(landmark.pointM[0], height, landmark.pointM[2]).project(scene.camera);
      return { pose, clip: Math.max(Math.abs(clip.x), Math.abs(clip.y)), railState };
    },
  };
}

test('a recurring cue takes the production rail camera to a measured summit by the heard beat and survives seeking', () => {
  const fixture = sceneFixture();
  const { landmark, neighbor, ordinary, directed } = fixture;
  const baseline = playback(fixture, ordinary);
  // Sample the same Songprint and terrain growth with the old rail schedule.
  // Its projection-only crop cannot uncover an offscreen summit.
  const cropOnly = playback(fixture, directed, baseline.schedule);
  const camera = playback(fixture, directed);
  const before = camera.read(15000, landmark);
  const missed = cropOnly.read(returnMs, landmark);
  const arrival = camera.read(returnMs, landmark);
  assert.ok(before.clip > 1, 'the summit starts outside the view');
  assert.ok(missed.clip > 1, 'the original rail still misses it at the cue with the same song analysis');
  assert.ok(arrival.clip < .88, 'the directed camera brings that summit inside the frame at the cue');
  assert.ok(camera.read(returnMs, neighbor).clip < .88, 'the adjacent ridge remains visible in the same shot');
  assert.ok(seenFrom(fixture.data, arrival.pose.eyeM, landmark.pointM), 'the summit is clear of foreground relief');
  assert.notDeepEqual(arrival.pose.eyeM, missed.pose.eyeM, 'the eye travels to a different point on the rail');
  let previous = before;
  for (let timeMs = 15100; timeMs <= 80000; timeMs += 100) {
    const next = camera.read(timeMs, landmark);
    const travelled = Math.hypot(...next.pose.eyeM.map((x, axis) => x - previous.pose.eyeM[axis]));
    const aimMoved = Math.hypot(...next.pose.targetM.map((x, axis) => x - previous.pose.targetM[axis]));
    assert.ok(travelled < 3 && aimMoved < 12, `no jump between camera samples at ${timeMs} ms`);
    assert.ok(next.railState.progress01 >= previous.railState.progress01, 'never travels backward');
    previous = next;
  }
  const seek = playback(fixture, directed, JSON.parse(JSON.stringify(camera.schedule)));
  for (const timeMs of [returnMs, 15100, 80000, returnMs + 1]) {
    assert.deepEqual(seek.read(timeMs, landmark), camera.read(timeMs, landmark));
  }
  const late = playback(fixture, directed, null, { songprintAdmittedMs: returnMs - 1000 });
  assert.equal(late.read(returnMs, landmark).railState.progress01, missed.railState.progress01);
});


test('a pinned catalog shot tour uses prepared terrain to reveal a summit its ordinary timeline misses', async () => {
  const view = catalog.views.find(candidate => candidate.id === 'nc-ross-lake-north');
  const assetBase = new URL('../src/assets/range/v2/', import.meta.url);
  const fetchImpl = async url => new Response(await readFile(new URL(url)));
  const { data } = await loadTerrainPackage(new URL(view.terrainManifestUrl, assetBase).href,
    { expectManifestSha256: view.terrainManifestSha256, fetchImpl });
  const landmarks = songprintLandmarks(data, view);
  const targetIndex = landmarks.findIndex(mark => mark.name === 'Jack Mountain');
  assert.ok(targetIndex >= 0);
  const target = landmarks[targetIndex].pointM;
  const song = anthemSong();
  const cueMs = 58000;
  const landmark01 = (targetIndex + .5) / landmarks.length;
  const terrain = {
    sceneByBiome: new Map([[view.biome, { view }]]),
    songprint: { version: 1, passages: [{ timeMs: 8000, landmark01, strength: .4 },
      { timeMs: cueMs, landmark01, strength: .96 }] },
  };
  const manager = {
    songTerrain: terrain, durationMs: song.durationMs, songSeed: 37,
    sections: song.sections.map(section => ({ ...section, profile: view.biome })),
    energyCurves: { globalEnergy: timeMs => song.energy[Math.min(song.energy.length - 1, Math.floor(timeMs / song.energyStepMs))] },
  };
  function plan(library, mgr, options) {
    const { message } = handleShotMessage(structuredClone(shotPlanRequest(library, mgr, options)));
    assert.equal(message.error, undefined);
    return restoreShotTimeline(message.timeline);
  }
  let ordinary;
  const shots = new RangeShotTours({
    assetBase, load: (url, options) => loadShotLibrary(url, { ...options, fetchImpl }),
    plan: async (library, mgr, options) => {
      ordinary = plan(library, mgr, { ...options, summitCues: [] });
      return plan(library, mgr, options);
    },
  });
  const presentation = new RangePresentation({ mode: 'v2', catalog, assetBase, shotTours: shots });
  const prepared = new Map();
  // Stop before GL resource allocation. The normal preparation callback
  // still receives the pinned DEM and the real approved shot footprint.
  presentation.scene = { prepared, isReady: id => prepared.has(id), async prepare(plannedView) {
    assert.ok(plannedView.cameraPaths.length > 0);
    const result = { data, view: plannedView, songprintLandmarks: landmarks };
    prepared.set(plannedView.id, result);
    return result;
  } };
  presentation.setSong({ terrain, mgr: manager });
  const deadline = Date.now() + 4000;
  while (!shots.settled(view.id) && Date.now() < deadline) {
    presentation._prepare(view);
    await setImmediate();
  }
  const { state, reason } = shots.stateAt(view.id, cueMs);
  assert.equal(state, 'ready', reason);
  const directed = shots.timeline(view.id);
  const arrival = directed.summitReturns.find(cue => cue.timeMs === cueMs);
  assert.ok(arrival && Math.abs(arrival.actualMs - cueMs) < 1, 'the checked shot arrives on the recurring passage');
  const clipBefore = projectPoint(ordinary.poseAt(cueMs), 16 / 9, target);
  const pose = directed.poseAt(cueMs);
  const clipAfter = projectPoint(pose, 16 / 9, target);
  assert.ok(!clipBefore || Math.max(Math.abs(clipBefore.x), Math.abs(clipBefore.y)) > 1);
  assert.ok(clipAfter && Math.max(Math.abs(clipAfter.x), Math.abs(clipAfter.y)) < .8);
  assert.ok(seenFrom(data, pose.eyeM, [target[0], target[1] + 2, target[2]]));
  assert.deepEqual(directed.diagnostics.limitBreaches, []);

  shots.dispose();
});
