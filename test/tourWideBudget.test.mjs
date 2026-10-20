import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';
import { planTerrainWindow, terrainWindowCoverage, tourSummitTiles } from '../src/world/alpine/TerrainWindow.js';
import { decodeTour } from '../src/world/terrain/TourPackage.js';
import { planTour } from '../src/world/terrain/TourPlanner.js';
import { buildTourTimeline } from '../src/world/terrain/TourTimeline.js';

test('wide tour views stay within the triangle cap while retaining summit error budgets', () => {
  const read = (p, decode) => decode(JSON.parse(fs.readFileSync(new URL(`${p}.json`, import.meta.url))),
    gunzipSync(fs.readFileSync(new URL(`${p}.bin.gz`, import.meta.url))));
  const data = read('../src/assets/range/v2/terrain/teton-range-tour.terrain', decodeTerrain);
  const routeData = read('../src/assets/range/v2/tour/teton-range-tour.tour', decodeTour);
  const protectedTileIds = tourSummitTiles(data, routeData.points);
  assert.equal(protectedTileIds.length, 410);
  const roles = ['intro', 'verse', 'pre-chorus', 'chorus', 'verse', 'pre-chorus', 'chorus', 'bridge', 'solo', 'chorus', 'drop', 'interlude', 'outro'];
  const durationMs = 360000, sections = roles.map((role, i) => ({ role, startMs: i * durationMs / 13,
    endMs: (i + 1) * durationMs / 13, relEnergy01: role === 'drop' ? 1 : role === 'chorus' ? .8 : .5 }));
  const tour = buildTourTimeline(routeData, planTour(routeData, { sections, durationMs }));
  for (const width of [1555.2, 2560]) for (const index of [0, 18, 29]) {
    const coverage = terrainWindowCoverage({ nominalWidth: width, nominalHeight: 720,
      logicalWidth: width / .66 + 128, logicalHeight: 720 / .66 + 128, overscanPx: 64 });
    const plan = planTerrainWindow(data, tour, index, { coverage, protectedTileIds });
    assert.ok(plan.triangles <= 1500000, `${width}/${index} must fit`);
    assert.ok(plan.summitMaxErrorPx <= 8 + 1e-6, `${width}/${index} must preserve the summit budget`);
    assert.ok(plan.protectedTiles > 0);
    const coarse = planTerrainWindow(data, tour, index, { coverage, protectedTileIds, bias: 2 });
    assert.ok(coarse.triangles <= 1500000);
    assert.ok(coarse.summitMaxErrorPx <= 8 + 1e-6, 'fallback must preserve the summit budget');
  }
});
