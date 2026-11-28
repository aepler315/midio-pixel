import { widenLens } from '../src/world/alpine/CameraMotion.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { aimTurn, pathPoseAt } from '../src/world/terrain/ShotPath.js';
import { scenePoseAt } from '../src/world/terrain/SceneTravel.js';
import { compileInlandFlight, inlandFlightPose } from '../src/world/alpine/InlandFlight.js';
import { DEFORM_PAD_M } from '../src/world/alpine/RangeCamera.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';

// A synthetic drained region: a meandering trunk flowing towards +z, one
// tributary joining it from the east, valley walls rising away from both.
const trunkX = z => 1500 * Math.sin(z / 6000);
const trunkBed = z => 2000 + (30000 - z) * .004;
const tribStart = [14000, -9000], tribEnd = [trunkX(0), 0];
const tribAt = t => [tribStart[0] + (tribEnd[0] - tribStart[0]) * t, tribStart[1] + (tribEnd[1] - tribStart[1]) * t];
const tribBed = t => trunkBed(0) + 180 * (1 - t);
const segmentDistance = (x, z, [ax, az], [bx, bz]) => {
  const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
  return { d: Math.hypot(x - ax - t * dx, z - az - t * dz), t };
};
const groundAt = (x, z) => {
  if (Math.max(Math.abs(x), Math.abs(z)) > 44800) return NaN;
  const trunk = trunkBed(z) + .42 * Math.abs(x - trunkX(z));
  const { d, t } = segmentDistance(x, z, tribStart, tribEnd);
  const trib = tribBed(t) + .42 * d;
  return Math.min(trunk, trib) + 120 * Math.sin(x / 2100) * Math.cos(z / 2700) ** 2 + 120;
};
const course = (points) => points.map(([x, z, bed, area]) => [Math.round(x), Math.round(z), Math.round(bed), area, 0, area > 300 ? .5 : 0]);
const trunkCourse = course(Array.from({ length: 151 }, (_, i) => { const z = -30000 + i * 400; return [trunkX(z), z, trunkBed(z), 200 + i * 10]; }));
const tribCourse = course(Array.from({ length: 41 }, (_, i) => { const [x, z] = tribAt(i / 40); return [x, z, tribBed(i / 40), 60 + i * 4]; }));
const region = {
  version: 1,
  rivers: [{ id: 0, joins: null, trunk: true, flown: true, areaKm2: 1700, course: trunkCourse },
    { id: 1, joins: 0, trunk: false, flown: true, areaKm2: 220, course: tribCourse }],
  confluences: [{ id: 'confluence-1', x: Math.round(tribEnd[0]), z: 0, bedM: Math.round(trunkBed(0)), areaKm2: 220 }],
  gorges: [], broadReaches: [],
  passes: [{ id: 'pass-0-1', x: 7000, z: -16000, heightM: Math.round(groundAt(7000, -16000)) }],
};
const summitAt = (x, z) => [x, groundAt(x, z) + 1600, z];
const principal = { slotId: 'B2', pointM: summitAt(-11000, -6000) }, companion = { slotId: 'H3', pointM: summitAt(-4000, -18000) };
const data = { groundAt, manifest: {
  kind: 'song-range-stage', boundsM: { min: [-44800, 1900, -44800], max: [44800, 5600, 44800] },
  hydrology: { riverFlow: 254, region },
} };
const view = {
  id: 'test-inland', songRange: { plan: { inland: { version: 3, seed: 37 } } },
  songprintComposition: { principal, companion },
  camera: { eyeStartM: [trunkX(12000), trunkBed(12000) + 320, 12000], eyeEndM: [trunkX(10000), trunkBed(10000) + 320, 10000],
    targetStartM: principal.pointM, targetEndM: principal.pointM, fovYDeg: 34 },
};
const timing = { guides: [{ progress01: .24, timeMs: 50000 }, { progress01: .51, timeMs: 95000 }, { progress01: .76, timeMs: 140000 }], travelMs: 175000 };
const options = { heightAt: groundAt };

test('an intervening ridge leads the timed flight to a visible shoulder and back to the valley', () => {
  const surface = (x, z) => 2000 + 900 * Math.exp(-(((x - 7500) / 850) ** 2 + (z / 1200) ** 2))
    + 1750 * Math.exp(-(((x - 3500) / 650) ** 2 + (z / 1850) ** 2));
  const cue = 60000;
  const course = Array.from({ length: 121 }, (_, i) => [0, (i - 60) * 300, 2000, i * 1000]);
  const terrain = { groundAt: surface, manifest: { ...data.manifest,
    hydrology: { region: { rivers: [], spine: { course, passes: [] } } },
    landmarks: [{ localM: [7500, 0], demGroundM: surface(7500, 0) }] } };
  const scene = { ...view, songRange: { plan: { inland: {}, slots: [{ timeMs: cue }] } } };
  const route = compileInlandFlight(terrain, scene, { travelMs: 120000 });
  const read = timeMs => inlandFlightPose({ eyeM: [0,0,0], targetM: [0,0,0] }, route,
    { gain: 1, timeMs, progress01: timeMs / 120000 }, { heightAt: surface });
  const crown = route.summits[0].point;
  for (const time of [cue - 1500, cue, cue + 1500]) {
    const { eyeM } = read(time);
    assert.ok(Math.hypot(eyeM[0], eyeM[2]) > 800, 'the lookout moves around the blocking ridge');
    for (let i = 1; i < 500; i++) {
      const t = i / 500, x = eyeM[0] + t * (crown[0] - eyeM[0]), z = eyeM[2] + t * (crown[2] - eyeM[2]);
      assert.ok(eyeM[1] + t * (crown[1] - eyeM[1]) >= surface(x, z) - .25);
    }
  }
  for (const t of [15000, 105000]) {
    const { eyeM } = read(t);
    assert.ok(Math.abs(eyeM[0]) < 1 && eyeM[1] - surface(eyeM[0], eyeM[2]) < 180);
  }
  let previous = read(30000).eyeM;
  for (let t = 30100; t <= 90000; t += 100) {
    const next = read(t).eyeM;
    assert.ok(Math.hypot(...next.map((v, i) => v - previous[i])) < 100, 'no jump while leaving or rejoining the valley');
    previous = next;
  }
});

test('the flight arrives at each stage boundary on the song’s transitions and ends facing the returning summits', () => {
  const route = compileInlandFlight(data, view, timing);
  assert.ok(route);
  assert.deepEqual(route.landmarks.map(landmark => landmark.progress01), [0, .24, .51, .76, 1]);
  assert.equal(route.kinds[0], 'low');
  assert.equal(route.kinds.at(-1), 'finale');
  assert.ok(route.kinds.includes('climb'), 'a reveal shows how the valleys connect');
  const rail = scenePoseAt(view);
  for (const [i, mark] of route.landmarks.entries()) {
    const sample = inlandFlightPose(rail, route, { gain: 1, progress01: mark.progress01 }, options);
    const planned = pathPoseAt(route.path, route.marks[i]);
    assert.ok(Math.hypot(...sample.eyeM.map((coord, k) => coord - planned.eyeM[k])) < 1e-6 || i === route.landmarks.length - 1);
  }
  const end = inlandFlightPose(rail, route, { gain: 1, progress01: 1 }, options);
  const toSummit = principal.pointM.map((v, k) => v - end.eyeM[k]), look = end.targetM.map((v, k) => v - end.eyeM[k]);
  const cos = toSummit.reduce((s, v, k) => s + v * look[k], 0) / Math.hypot(...toSummit) / Math.hypot(...look);
  assert.ok(cos > .9, 'the finale looks at the returning pair');
});

test('low stretches follow the river close to the ground; reveals climb clear; the lens never zooms', () => {
  const route = compileInlandFlight(data, view, timing);
  const rail = scenePoseAt(view);
  const frames = Array.from({ length: 401 }, (_, i) => inlandFlightPose(rail, route, { gain: 1, progress01: i / 400 }, options));
  const low = frames.filter(pose => pose.songprintOrbit.mode === 'low').map(pose => pose.songprintOrbit.aglM).sort((a, b) => a - b);
  const median = low[low.length >> 1];
  assert.ok(median >= 60 && median <= 200, `low runs fly near the valley floor (${median} m)`);
  assert.ok(frames.some(pose => pose.songprintOrbit.aglM > 280), 'a reveal climbs well above the hills');
  // The opening run stays in the trunk valley.
  for (const pose of frames.slice(0, 80)) {
    const [x, , z] = pose.eyeM;
    assert.ok(Math.abs(x - trunkX(z)) < 450, `opening eye ${Math.round(x)},${Math.round(z)} is in the trunk valley`);
  }
  for (const [i, pose] of frames.entries()) {
    const [x, y, z] = pose.eyeM, ground = groundAt(x, z);
    assert.equal(pose.fovYDeg, 34);
    assert.ok(y >= ground + 49, 'the eye stays clear of the ground');
    if (i === 0) continue;
    const previous = frames[i - 1];
    assert.ok(pose.songprintOrbit.travelM >= previous.songprintOrbit.travelM);
    assert.ok(aimTurn(previous.eyeM, previous.targetM, pose.eyeM, pose.targetM) < .2);
  }
  // Seeking: an arbitrary progress samples the same pose as playing to it.
  assert.deepEqual(inlandFlightPose(rail, route, { gain: 1, progress01: .81 }, options), frames[324]);
  assert.strictEqual(inlandFlightPose(rail, route, { gain: 0, progress01: .4 }, options), rail);
  assert.ok(DEFORM_PAD_M > 0);
});

test('ordinary music-timed drawing uses the inland route and authored rails opt out', () => {
  const scene = Object.assign(Object.create(RangeScene.prototype), { _movedPoses: new WeakMap() });
  const prepared = { data, view, waterLevelM: null };
  const read = (progress01, songprintOrbitEnabled, choreography = timing) => scene.movedPose(view, {
    progress01, timeMs: 175000 * progress01, rise01: .8, songprintOrbitEnabled,
    scenicViewport: { logicalWidth: 1280, logicalHeight: 720, nominalHeight: 720 },
    cameraEffects: { halfAngleScale: .82 },
    performance: { songprintOrbit: { gain: 1, progress01, ...choreography } },
  }, prepared);
  const flight = read(.54, true);
  assert.equal(flight.pose.songprintOrbit.routeStyle, 'inland');
  assert.equal(flight.pose.fovYDeg, widenLens(34), 'a full orbit stands on the wider standing lens');
  assert.equal(read(.54, false).pose.songprintOrbit, undefined);
  const revised = { ...timing, guides: [{ progress01: .2 }, { progress01: .47 }, { progress01: .74 }] };
  const later = read(.54, true, revised).pose.songprintOrbit;
  assert.deepEqual(later.landmarks.map(landmark => landmark.progress01), [0, .2, .47, .74, 1]);
  assert.deepEqual(read(.54, true), flight);
  assert.equal(compileInlandFlight(data, { ...view, songRange: null }, timing), null);
  assert.equal(compileInlandFlight({ ...data, manifest: { ...data.manifest, hydrology: null } }, view, timing), null);
});
