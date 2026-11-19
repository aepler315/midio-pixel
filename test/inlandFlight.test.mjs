import test from 'node:test';
import assert from 'node:assert/strict';
import { aimTurn, pathPoseAt } from '../src/world/terrain/ShotPath.js';
import { scenePoseAt } from '../src/world/terrain/SceneTravel.js';
import { compileInlandFlight, inlandFlightPose } from '../src/world/alpine/InlandFlight.js';
import { DEFORM_PAD_M } from '../src/world/alpine/RangeCamera.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';

const BASE_M = 1800;
const positions = [[-6300, -3300, 1670], [200, -8100, 1430], [-13500, -13700, 1500],
  [9300, -6500, 1250], [9800, 5700, 940], [-14400, 6400, 900]];
const slotIds = ['B1', 'H2', 'H1', 'B2', 'F2', 'F3'];
const groundAt = (x, z) => Math.max(Math.abs(x), Math.abs(z)) > 44800 ? NaN
  : BASE_M + 370 * Math.sin(x / 4900 + z / 11000) + 340 * Math.cos(z / 4200) + positions
    .reduce((sum, [px, pz, h]) => sum + h * Math.exp(-((x - px) ** 2 + (z - pz) ** 2) / 9600000), 0);
const [principal, companion] = positions.slice(0, 2).map(([x, z], i) => ({ slotId: slotIds[i], pointM: [x, groundAt(x, z), z] }));
const data = { groundAt, manifest: {
  kind: 'song-range-stage', boundsM: { min: [-44800, 1000, -44800], max: [44800, 4500, 44800] },
  source: { provenance: { composition: { pieces: slotIds.map(slotId => ({ slotId })) } } },
  landmarks: positions.map(([x, z], i) => ({ name: 'Crest ' + slotIds[i], localM: [x, z] })),
} };
const view = {
  id: 'test-inland', songRange: { plan: { inland: { version: 1, seed: 37 } } },
  songprintComposition: { principal, companion },
  camera: { eyeStartM: [-6100, 2710, 16800], eyeEndM: [-5100, 2710, 15000],
    targetStartM: [-3200, 2700, -4300], targetEndM: [-3100, 2740, -3900], fovYDeg: 36 },
};
const timing = { guides: [{ progress01: .24 }, { progress01: .51 }, { progress01: .76 }], travelMs: 170000 };
const options = { baseM: BASE_M, rise01: 1, heightAt: groundAt };

test('inland flight schedules three geographic views at the song’s transition progress', () => {
  const route = compileInlandFlight(data, view, timing);
  assert.ok(route);
  assert.deepEqual(route.landmarks.map(landmark => landmark.progress01), [0, .24, .51, .76, 1]);
  assert.equal(route.landmarks[0].id, principal.slotId);
  assert.match(route.landmarks[1].id, /^pass-/);
  assert.match(route.landmarks[3].id, /^basin-/);
  assert.ok(new Set(route.landmarks.map(landmark => landmark.id)).size >= 4);
  const rail = scenePoseAt(view);
  const at = p => inlandFlightPose(rail, route, { gain: 1, progress01: p }, options);
  for (const [i, mark] of route.landmarks.entries()) {
    const sample = at(mark.progress01), planned = pathPoseAt(route.path, route.marks[i]);
    assert.ok(Math.hypot(...sample.eyeM.map((coord, k) => coord - planned.eyeM[k])) < 1e-6);
  }
});

test('inland flight keeps advancing, smooths clearance and preserves the fixed lens on arbitrary seeks', () => {
  const route = compileInlandFlight(data, view, timing);
  const crop = { fx: .15, rx: .011, uy: 0 };
  const rail = { ...scenePoseAt(view), viewOffset: crop };
  const at = (p, gain = 1) => inlandFlightPose(rail, route, { gain, progress01: p }, options);
  const frames = Array.from({ length: 201 }, (_, i) => at(i / 200));
  assert.strictEqual(at(.4, 0), rail);
  assert.deepEqual(at(.81), frames[162]);
  assert.deepEqual(at(.12), frames[24]);
  assert.ok(route.path.lengthM >= 20000);
  assert.ok(frames.every(pose => pose.fovYDeg === 36 && pose.viewOffset === crop));
  for (const [i, pose] of frames.entries()) {
    const [x, y, z] = pose.eyeM;
    assert.ok(groundAt(x, z) + DEFORM_PAD_M + 210 <= y);
    assert.ok(Math.max(Math.abs(x), Math.abs(z)) < 43599);
    if (i === 0) continue;
    const previous = frames[i - 1];
    assert.ok(pose.songprintOrbit.travelM > previous.songprintOrbit.travelM);
    assert.ok(aimTurn(previous.eyeM, previous.targetM, pose.eyeM, pose.targetM) < .12);
  }
  assert.ok(frames.some(pose => aimTurn(frames[0].eyeM, frames[0].targetM, pose.eyeM, pose.targetM) > .40));
});

test('ordinary music-timed drawing uses the inland route and authored rails opt out', () => {
  const scene = Object.assign(Object.create(RangeScene.prototype), { _movedPoses: new WeakMap() });
  const prepared = { data, view, waterLevelM: null };
  const read = (progress01, songprintOrbitEnabled, choreography = timing) => scene.movedPose(view, {
    progress01, timeMs: 170000 * progress01, rise01: .8, songprintOrbitEnabled,
    scenicViewport: { logicalWidth: 1280, logicalHeight: 720, nominalHeight: 720 },
    cameraEffects: { halfAngleScale: .82 },
    performance: { songprintOrbit: { gain: 1, progress01, ...choreography } },
  }, prepared);
  const flight = read(.54, true);
  assert.equal(flight.pose.songprintOrbit.routeStyle, 'inland');
  assert.equal(flight.pose.fovYDeg, 36);
  assert.equal(read(.54, false).pose.songprintOrbit, undefined);
  const revised = { ...timing, guides: [{ progress01: .2 }, { progress01: .47 }, { progress01: .74 }] };
  const later = read(.54, true, revised).pose.songprintOrbit;
  assert.deepEqual(later.landmarks.map(landmark => landmark.progress01), [0, .2, .47, .74, 1]);
  assert.deepEqual(read(.54, true), flight);
  assert.equal(compileInlandFlight(data, { ...view, songRange: null }, timing), null);
});
