// C01: a minimized schedule with the real published terrain and planner.
// Keep the desired 90-second result visible as TODO until WP03 repairs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { decodeTour } from '../src/world/terrain/TourPackage.js';
import { planTour } from '../src/world/terrain/TourPlanner.js';
import { buildTourTimeline } from '../src/world/terrain/TourTimeline.js';

const assets = new URL('../src/assets/range/v2/tour/', import.meta.url);
const data = decodeTour(JSON.parse(await fs.readFile(new URL('teton-range-tour.tour.json', assets))),
  gunzipSync(await fs.readFile(new URL('teton-range-tour.tour.bin.gz', assets))));

for (const durationMs of [60000, 90000, 120000]) {
  test(`C01 real Tetons planner completes the ${durationMs / 1000}-second role schedule`,
    durationMs === 90000 ? { todo: 'C01: no feasible aim state; repair in WP03, then remove TODO' } : {}, () => {
      const sections = [
        { startMs: 0, endMs: 10000, role: 'intro', relEnergy01: .5 },
        { startMs: 10000, endMs: 20000, role: 'verse', relEnergy01: .5 },
        { startMs: 20000, endMs: durationMs, role: 'outro', relEnergy01: .5 },
      ];
      assert.doesNotThrow(() => buildTourTimeline(data, planTour(data, { sections, durationMs })));
    });
}
