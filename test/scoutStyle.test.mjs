import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createScoutStyle, shadeScoutSurface, scoutSkyColor } from '../tools/lib/scout-style.mjs';
import { renderScoutPreview } from '../tools/lib/scout-preview.mjs';
import { cinematicLightingProfile } from '../src/world/alpine/CinematicLighting.js';

const material = JSON.parse(await fs.readFile(new URL('../src/assets/range/v2/materials/dry-conifer.json', import.meta.url), 'utf8'));
const canyon = JSON.parse(await fs.readFile(new URL('../src/assets/range/v2/materials/canyon.json', import.meta.url), 'utf8'));
const surface = { heightM: 1700, distanceM: 5000, eyeHeightM: 1900, normal: [0, 1, 0], lon: -110.8, lat: 43.75 };

test('appearance copies current production palette/rules and shared daylight response', () => {
  const style = createScoutStyle(material, { biome: 'CONIFER', cameraHeadingDeg: 30 });
  assert.equal(style.materialId, material.id);
  assert.deepEqual(style.cinematic, cinematicLightingProfile({ enabled: true, night01: 0, storm01: 0 }));
  assert.equal(style.rules.snowlineM, material.rules.snowlineM);
  const expectedRockR = Math.pow(parseInt(material.palette.rockLit.slice(1, 3), 16) / 255, 2.2);
  assert.equal(style.palette.rockLit[0], expectedRockR);
  assert.ok(style.sky.top[2] > style.sky.top[0]);
  assert.notDeepEqual(scoutSkyColor(style, 0), scoutSkyColor(style, 1));
  assert.ok(Math.abs(Math.hypot(...style.lightDirection) - 1) < 1e-12);
});

test('authored snowline overrides change the treatment without changing source packs', () => {
  const lowSnow = createScoutStyle(material, { materialRules: { snowlineM: 1000, snowFullM: 1300 } });
  const ordinary = createScoutStyle(material);
  const snowy = shadeScoutSurface(lowSnow, surface), ground = shadeScoutSurface(ordinary, surface);
  assert.ok(snowy.reduce((a, x) => a + x) > ground.reduce((a, x) => a + x) + 100);
  assert.equal(material.rules.snowlineM, 3000);
  assert.equal(ordinary.rules.snowlineM, 3000);
});

test('production desert colors differ from conifer habitat and all shades stay bounded', () => {
  const forest = shadeScoutSurface(createScoutStyle(material), surface);
  const desert = shadeScoutSurface(createScoutStyle(canyon, { biome: 'CANYON' }), surface);
  assert.ok(forest[1] > forest[0], 'conifer surface retains green habitat color');
  assert.ok(desert[0] > desert[2], 'dry soil uses the warm canyon pack');
  assert.notDeepEqual(forest, desert);
  const style = createScoutStyle(material);
  for (const heightM of [0, 1700, 3500, 6000]) for (const distanceM of [0, 5000, 60000]) {
    const color = shadeScoutSurface(style, { ...surface, heightM, distanceM });
    assert.ok(color.every(value => Number.isFinite(value) && value >= 0 && value <= 255));
    assert.deepEqual(color, shadeScoutSurface(style, { ...surface, heightM, distanceM }));
  }
});

test('appearance and shape previews share every projected skyline column and coverage value', () => {
  const n = 80;
  const grid = { west: -0.2, south: -0.2, east: 0.2, north: 0.2, width: n, height: n,
    heightsM: Float32Array.from({ length: n * n }, (_, i) => 1500 + 1500 * Math.exp(-Math.pow((Math.floor(i / n) - 30) / 7, 2))) };
  const camera = { eye: { lon: 0, lat: -0.12, aboveGroundM: 200 }, headingDeg: 0, pitchDeg: 3, hfovDeg: 68 };
  const options = { width: 160, height: 90, maxDistanceM: 18000 };
  const shape = renderScoutPreview(grid, camera, options);
  const appearance = renderScoutPreview(grid, camera, { ...options, style: createScoutStyle(material) });
  assert.notDeepEqual(appearance.rgba, shape.rgba);
  assert.deepEqual(appearance.skylineY, shape.skylineY);
  assert.equal(appearance.coverage, shape.coverage);
  assert.equal(appearance.warning, shape.warning);
  assert.ok(appearance.skylineY.some(y => y < 45), 'fixture contains a visible ridge');
});

test('style inputs reject malformed palettes and nonfinite placement rules', () => {
  assert.throws(() => createScoutStyle({ ...material, palette: { ...material.palette, snow: 'red' } }), /palette/i);
  assert.throws(() => createScoutStyle(material, { materialRules: { snowlineM: Infinity } }), /rules/i);
  assert.throws(() => createScoutStyle(material, { cameraHeadingDeg: NaN }), /heading/i);
});
