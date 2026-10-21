// C01: a minimized schedule with the real published terrain and planner.
// Keep the published terrain and section schedule as a permanent regression.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { decodeTour, tourClearanceAt } from '../src/world/terrain/TourPackage.js';
import { planTour } from '../src/world/terrain/TourPlanner.js';
import { buildTourTimeline } from '../src/world/terrain/TourTimeline.js';

const assets = new URL('../src/assets/range/v2/tour/', import.meta.url);
const data = decodeTour(JSON.parse(await fs.readFile(new URL('teton-range-tour.tour.json', assets))),
  gunzipSync(await fs.readFile(new URL('teton-range-tour.tour.bin.gz', assets))));

const heading = pose => Math.atan2(pose.targetM[0] - pose.eyeM[0], -(pose.targetM[2] - pose.eyeM[2])) * 180 / Math.PI;
const delta = (a, b) => ((a - b + 540) % 360) - 180;
function checkTimeline(tour, reducedMotion = false) {
  let previous = tour.poseAt(0);
  for (let t = 100; t <= tour.durationMs + 99; t += 100) {
    const time = Math.min(t, tour.durationMs), pose = tour.poseAt(time), dt = (time - Math.min(t - 100, tour.durationMs)) / 1000;
    const band = tourClearanceAt(data.clearance, pose.eyeM[0], pose.eyeM[2]);
    const index = Math.min(tour.meta.length / 4 - 1, Math.ceil(time / 100)), role = data.roles[tour.meta[index * 4 + 2]];
    const yaw = reducedMotion || ['outro', 'breakdown'].includes(role) ? 12 : 25;
    assert.ok([...pose.eyeM, ...pose.targetM, pose.fovYDeg].every(Number.isFinite), `finite pose at ${time}`);
    assert.ok(pose.eyeM[1] >= band.floorY + 5 - .05 && pose.eyeM[1] <= band.ceilY + .05, `clearance at ${time}`);
    assert.ok(Math.abs(pose.eyeM[1] - previous.eyeM[1]) <= (reducedMotion ? 15 : 30) * dt + .03, `climb at ${time}`);
    assert.ok(Math.abs(delta(heading(pose), heading(previous))) <= yaw * dt + .03, `yaw at ${time}`);
    assert.deepEqual(tour.poseAt(time), pose, `deterministic access at ${time}`);
    previous = pose;
  }
}

for (const durationMs of [60000, 90000, 120000]) {
  test(`C01 real Tetons planner completes the ${durationMs / 1000}-second role schedule`,
    () => {
      const sections = [
        { startMs: 0, endMs: 10000, role: 'intro', relEnergy01: .5 },
        { startMs: 10000, endMs: 20000, role: 'verse', relEnergy01: .5 },
        { startMs: 20000, endMs: durationMs, role: 'outro', relEnergy01: .5 },
      ];
      const tour = buildTourTimeline(data, planTour(data, { sections, durationMs }));
      checkTimeline(tour);
    });
}

for (const [durationMs, roles, reducedMotion] of [
  [7951, ['intro', 'chorus', 'breakdown', 'outro'], false],
  [90000, ['intro', 'verse', 'outro'], true],
  [180000, ['intro', 'verse', 'pre-chorus', 'chorus', 'breakdown', 'solo', 'drop', 'bridge', 'outro'], false],
  [360000, ['intro', 'verse', 'chorus', 'breakdown', 'outro'], true],
]) {
  test(`C01 published mixed-role timeline remains legal for ${durationMs} ms, reduced motion ${reducedMotion}`, () => {
    const sections = roles.map((role, i) => ({ role, startMs: i * durationMs / roles.length,
      endMs: (i + 1) * durationMs / roles.length, relEnergy01: i % 2 ? .8 : .3 }));
    const tour = buildTourTimeline(data, planTour(data, { sections, durationMs, reducedMotion }), { reducedMotion });
    checkTimeline(tour, reducedMotion);
  });
}
