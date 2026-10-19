import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeTour } from '../src/world/terrain/TourPackage.js';
import { planTour } from '../src/world/terrain/TourPlanner.js';
import { buildTourTimeline } from '../src/world/terrain/TourTimeline.js';
import { decodeTerrain, terrainHeightAt } from '../src/world/alpine/TerrainMesh.js';

test('a short four-phrase song slows its itinerary when the fast altitude corridor loses view quality', () => {
  const root = new URL('../src/assets/range/v2/tour/', import.meta.url);
  const data = decodeTour(JSON.parse(readFileSync(new URL('teton-range-tour.tour.json', root))),
    gunzipSync(readFileSync(new URL('teton-range-tour.tour.bin.gz', root))));
  const boundaries = [0, 17983.487617, 37987.864772, 57988.374977, 95979.68254];
  const roles = ['chorus', 'chorus', 'breakdown', 'outro'];
  const peaks = [7596.697523, 22484.363048, 45487.966813, 75586.636489];
  const sections = roles.map((role, i) => ({ startMs: boundaries[i], endMs: boundaries[i + 1], role,
    relEnergy01: i < 2 ? 1 : 0, finalChorus: i === 1 }));
  const energyAt = t => (t < boundaries[2] ? .8 : .2) + .15 * Math.exp(-Math.min(...peaks.map(p => (t - p) ** 2)) / 160000);
  const plan = planTour(data, { sections, durationMs: boundaries.at(-1), energyAt });
  const tour = buildTourTimeline(data, plan);
  assert.ok(tour.meanQualityRatio >= .8, `short-song view quality ${tour.meanQualityRatio}`);
  const terrainRoot = new URL('../src/assets/range/v2/terrain/', import.meta.url);
  const terrain = decodeTerrain(JSON.parse(readFileSync(new URL('teton-range-tour.terrain.json', terrainRoot))),
    gunzipSync(readFileSync(new URL('teton-range-tour.terrain.bin.gz', terrainRoot))));
  let good = 0, count = 0, previous = tour.poseAt(0);
  for (let t = 100; t <= tour.durationMs; t += 100) {
    const pose = tour.poseAt(t), speed = Math.hypot(pose.eyeM[0] - previous.eyeM[0], pose.eyeM[2] - previous.eyeM[2]) * 10;
    const agl = pose.eyeM[1] - terrainHeightAt(terrain, pose.eyeM[0], pose.eyeM[2]);
    const omega = speed / Math.max(1, agl);
    if (speed < 15 || omega >= .03 && omega <= .3) good++;
    count++; previous = pose;
  }
  assert.ok(good / count >= .98, `optical fraction ${good / count}`);
});
