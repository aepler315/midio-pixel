import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { demFromLatLon, crestGuideFromDem } from '../src/world/terrain/LatLonDem.js';
import { profilesFromJSON, profileUnits } from '../src/world/terrain/TerrainProfile.js';
import { alpineTerrainProfiles } from '../src/world/terrain/loadTerrain.js';
import { stripOriginX } from '../src/world/SilhouetteGenerator.js';

test('a north-up raster keeps north to the north, and the crest guide follows the high column', () => {
  // Two rows, row 0 is north. The northern row is high on the west.
  const elev = Float64Array.from([
    3000, 1000,
    1000, 1000,
  ]);
  const dem = demFromLatLon({
    elev, width: 2, height: 2,
    west: -111, south: 43.5, east: -110.98, north: 43.52,
  }, 200);
  assert.ok(dem.width >= 2 && dem.height >= 2);
  const north = dem.elev[(dem.height - 1) * dem.width];
  const south = dem.elev[0];
  assert.ok(north > south, `north ${north} should be the high side, south ${south}`);
  const guide = crestGuideFromDem(dem, 200);
  assert.ok(guide.length >= 2);
  assert.ok(guide[guide.length - 1].y > guide[0].y);
});

test('a terrain strip scrolls to its end and holds instead of tiling', () => {
  const strip = { width: 1000, ridge: { source: 'terrain' } };
  const loop = { width: 1000, ridge: { source: 'procedural' } };
  assert.equal(stripOriginX(strip, 0, 400), 0);
  assert.equal(stripOriginX(strip, 100, 400), -100);
  assert.equal(stripOriginX(strip, 5000, 400), -600);
  assert.equal(stripOriginX(loop, 1500, 400), -500);
});

test('The Range loads the Teton crest and the eastern range, not a made-up middle', () => {
  const profiles = alpineTerrainProfiles();
  assert.deepEqual(Object.keys(profiles).sort(), ['L2', 'L4']);
  assert.equal(alpineTerrainProfiles(), profiles);
});

test('the authored Teton ridges keep their own heights on one scale', () => {
  const raw = JSON.parse(readFileSync(new URL('../data/terrain/tetons-front.json', import.meta.url), 'utf8'));
  const profiles = profilesFromJSON(raw);
  assert.deepEqual(Object.keys(profiles).sort(), ['L2', 'L4']);
  const maxOf = (layer) => {
    let max = -Infinity;
    for (const v of layer.skylineElevM) if (Number.isFinite(v) && v > max) max = v;
    return max;
  };
  const far = maxOf(profiles.L2);
  const near = maxOf(profiles.L4);
  assert.ok(far > 3800, `Teton skyline ${far}`);
  assert.ok(near > 2500 && near < far, `eastern skyline ${near}`);
  assert.ok(profiles.L2.angleMax > profiles.L4.angleMax);
  assert.equal(Math.max(...profileUnits(profiles.L2)), 1);
  assert.equal(Math.max(...profileUnits(profiles.L4)), 1);
});
