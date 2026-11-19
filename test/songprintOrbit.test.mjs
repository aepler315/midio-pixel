import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPoint, scenePoseAt } from '../src/world/terrain/SceneTravel.js';
import { compileSongprintOrbit, songprintOrbitPose } from '../src/world/alpine/SongprintOrbit.js';
import { DEFORM_PAD_M } from '../src/world/alpine/RangeCamera.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';

const BASE_M = 2000;
const { view, data } = stage();

function stage() {
  const boundsM = { min: [-22400, BASE_M, -22400], max: [22400, 4800, 22400] };
  const groundAt = (x, z) => Math.abs(x) <= 22400 && Math.abs(z) <= 22400
    ? BASE_M + 400 * Math.exp(-((x - 3200) ** 2 + (z - 11700) ** 2) / 2500000) : NaN;
  return {
    view: {
      camera: { eyeStartM: [-6200, 2400, 20200], eyeEndM: [-5100, 2400, 19700],
        targetStartM: [-1800, 2900, -4100], targetEndM: [-1300, 2850, -4200], fovYDeg: 36 },
      songprintComposition: {
        principal: { slotId: 'B1', pointM: [-3800, 4800, -3900] },
        companion: { slotId: 'H2', pointM: [2800, 4300, -8200] },
      },
    },
    data: { groundAt, manifest: { kind: 'song-range-stage', boundsM,
      source: { provenance: { composition: { pieces: [{ slotId: 'H1' }, { slotId: 'B2' }, { slotId: 'F2' }] } } },
      landmarks: [{ name: 'West Ridge', localM: [-11000, -9200] },
        { name: 'Eastern Summit', localM: [9100, -7200] }, { name: 'Island', localM: [700, 2100] }],
    } },
  };
}

test('composed cameras circulate across a measurable arc and expose parallax with a fixed lens', () => {
  const rail = scenePoseAt(view);
  const route = compileSongprintOrbit(data, view, BASE_M);
  assert.ok(route?.support, 'a measured supporting landform participates');
  const sample = progress01 => songprintOrbitPose(rail, route, { progress01, gain: 1 },
    { heightAt: data.groundAt, waterLevelM: BASE_M, baseM: BASE_M, rise01: 1 });
  const frames = Array.from({ length: 81 }, (_, i) => sample(i / 80));
  const first = frames[0], last = frames.at(-1);
  const radius = pose => Math.hypot(pose.eyeM[0] - route.pivotM[0], pose.eyeM[2] - route.pivotM[2]);
  assert.ok(radius(first) < radius(last), 'the opening stands closer in the actual world');
  assert.ok(Math.abs(last.songprintOrbit.sweepRad) >= .44);
  assert.ok(Math.hypot(last.eyeM[0] - first.eyeM[0], last.eyeM[2] - first.eyeM[2]) > 6000);
  assert.ok(frames.every(pose => pose.fovYDeg === 36 && !pose.viewOffset));
  for (const pose of frames) {
    const [x, y, z] = pose.eyeM;
    assert.ok(Math.max(Math.abs(x), Math.abs(z)) < 22400);
    assert.ok(y >= data.groundAt(x, z) + DEFORM_PAD_M + 100);
  }
  const separation = pose => {
    const coast = projectPoint(pose, 16 / 9, [700, BASE_M, 2100]);
    const peak = projectPoint(pose, 16 / 9, view.songprintComposition.companion.pointM);
    return coast.x - peak.x;
  };
  assert.ok(Math.abs(separation(first) - separation(last)) > .16);
  assert.deepEqual(sample(.25), frames[20]);
});

test('composed camera fades to a late orbit and keeps listener framing', () => {
  const crop = { fx: .22, rx: .01, uy: -.015 };
  const rail = { ...scenePoseAt(view), viewOffset: crop };
  const route = compileSongprintOrbit(data, view, BASE_M);
  const options = { heightAt: data.groundAt, waterLevelM: BASE_M, baseM: BASE_M, rise01: 1, slotRise01: { B1: .5, H2: .6 } };
  const sample = (gain, progress01 = .41) => songprintOrbitPose(rail, route, { gain, progress01 }, options);
  assert.strictEqual(sample(0), rail);
  const early = sample(.0001), elected = sample(1);
  assert.ok(Math.hypot(...early.eyeM.map((x, i) => x - rail.eyeM[i])) < 3);
  assert.strictEqual(elected.viewOffset, crop);
  assert.deepEqual(sample(.6, .2), sample(.6, .2));
});

test('only fully composed terrain admits an orbit', () => {
  const catalog = { ...data, manifest: { ...data.manifest, kind: 'view' } };
  assert.equal(compileSongprintOrbit(catalog, view, BASE_M), null);
  assert.equal(compileSongprintOrbit(data, { ...view, songprintComposition: null }, BASE_M), null);
});

test('the drawn camera starts a late orbit without dropping the current lens or move', () => {
  const prepared = { data, view, waterLevelM: BASE_M, songprintLandmarks: [view.songprintComposition.principal] };
  const scene = Object.assign(Object.create(RangeScene.prototype), { _movedPoses: new WeakMap() });
  const read = (gain, songprintOrbitEnabled = true) => scene.movedPose(view, {
    progress01: .6, timeMs: 11000, rise01: .7, songprintOrbitEnabled,
    scenicViewport: { logicalWidth: 1280, logicalHeight: 720, nominalHeight: 720 },
    cameraEffects: { halfAngleScale: .85 }, cameraMove: { dolly: .08, yaw: .035, crane: .02, truck: .012 },
    performance: { ...(gain == null ? {} : { songprintOrbit: { progress01: .32, gain } }),
      songprintCue: { targets: [{ landmark01: .4, weight: .8 }] } },
  }, prepared);
  const legacy = read(null), zero = read(0), first = read(.0001), middle = read(.5), full = read(1);
  assert.deepEqual(zero, legacy);
  assert.deepEqual(read(1, false), legacy);
  assert.ok(Math.abs(first.proj.fovYDeg - legacy.proj.fovYDeg) < .002);
  assert.ok(Math.hypot(...first.pose.eyeM.map((coord, i) => coord - legacy.pose.eyeM[i])) < 2);
  assert.ok(middle.proj.fovYDeg > legacy.proj.fovYDeg && middle.proj.fovYDeg < full.proj.fovYDeg);
  assert.ok(Math.abs(full.proj.fovYDeg - 36) < 1e-9);
  assert.ok(!full.pose.viewOffset);
  assert.ok(full.pose.songprintOrbit);
  assert.deepEqual(read(.5), middle);
});
