import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemGrid } from '../src/core/demgrid.js';
import { analyzeCrest, findViewpoints, evaluateEye, crestBoxPixels } from '../src/core/viewpoints.js';
import { bearing, tileAt } from '../src/core/geo.js';

// A synthetic range near 44N: a jagged north-south crest (peaks to ~3400 m)
// over a 1000 m valley. East of it lies a flat lake; west of it a broad
// 2600 m plateau rises close to the crest and hides its lower face.
function syntheticGrid() {
  const z = 10, c = tileAt(-110.8, 43.8, z);
  const grid = new DemGrid({ z, tx0: c.x - 3, ty0: c.y - 3, tilesX: 7, tilesY: 7 });
  const [cx, cy] = grid.toPixel(-110.8, 43.8);
  const mpp = grid.mpp(43.8);
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const ex = (x - cx) * mpp, ny = (cy - y) * mpp; // metres east / north of centre
      let h = 1000;
      const along = Math.exp(-((ny / 18000) ** 2));
      h += 1900 * Math.exp(-((ex / 2500) ** 2)) * along;
      for (const [py, amp] of [[-9000, 600], [-2500, 450], [4000, 520], [10000, 380]]) {
        h += amp * Math.exp(-(((ex) / 1300) ** 2) - (((ny - py) / 1500) ** 2));
      }
      if (ex < -6000) h = Math.max(h, 2600 - Math.max(0, -ex - 14000) * 0.1);
      if (ex > 7000 && ex < 13000 && Math.abs(ny) < 6000) h = 1000; // flat lake
      grid.data[y * grid.width + x] = h;
    }
  }
  return grid;
}

const range = { id: 'synthetic', bbox: [-110.9, 43.6, -110.7, 44.0] };

test('crest analysis finds the north-south axis and the summit', () => {
  const grid = syntheticGrid();
  const crest = analyzeCrest(grid, range);
  const axis = crest.axisBearing;
  assert.ok(axis < 15 || axis > 165, `axis ${axis}`);
  assert.ok(Math.abs(crest.summit.lon + 110.8) < 0.03, `summit lon ${crest.summit.lon}`);
  assert.ok(crest.summit.h > 3300);
});

test('the best view looks at the crest across the lake, not over the plateau', () => {
  const grid = syntheticGrid();
  const { views } = findViewpoints(grid, range, { count: 3 });
  assert.ok(views.length >= 1);
  const best = views[0];
  assert.ok(best.eye.lon > -110.8, `best eye should be east of the crest, got ${best.eye.lon}`);
  // looking roughly west
  assert.ok(best.heading > 220 && best.heading < 320, `heading ${best.heading}`);
  assert.ok(best.features.water > 0, 'lake should be in view');
  assert.ok(best.features.summitVisible === 1);
  assert.ok(best.hfov >= 30 && best.hfov <= 80);
});

test('an eye hidden behind the plateau scores lower than one across the lake', () => {
  const grid = syntheticGrid();
  const crest = analyzeCrest(grid, range);
  const crestBox = crestBoxPixels(grid, range);
  const west = evaluateEye(grid, crest, [-110.98, 43.8], 2, { crestBox });
  const east = evaluateEye(grid, crest, [-110.68, 43.8], 2, { crestBox });
  assert.ok(east.score > (west?.score ?? 0), `east ${east.score} vs west ${west?.score}`);
  assert.ok(Math.abs(bearing(-110.68, 43.8, -110.8, 43.8) - east.heading) < 35);
});
