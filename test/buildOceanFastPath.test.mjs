import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_FRAG } from '../src/world/alpine/TerrainMaterial.js';
import { openingOceanColor } from '../src/world/alpine/BuildOcean.js';

const main = SCENE_FRAG.slice(SCENE_FRAG.indexOf('  void main() {'));
const fast = main.match(/if \(uWaterOnly < \.5[\s\S]*?uLandRise\.x >= 1\.0\) \{[\s\S]*?\n {4}\}/)?.[0];
assert.ok(fast, 'the production terrain shader supplies the exact-flat opening shortcut');
const execute = new Function('uWaterOnly', 'uDebugMask', 'uDiag', 'uLandRise', 'vRenderedWorld', 'cameraPosition',
  'pWater', 'uSkyHorizon', 'uAirColor', 'uAirDensity', 'openingOceanDisplay', 'vec4',
  `let outColor; ${fast.replaceAll('uLandRise.x', 'uLandRise[0]').replace('return;', 'return outColor;')}`);
const colors = { water: [.035, .08, .09], sky: [.21, .31, .42], air: [.32, .40, .48] };
const display = (p, eye, water, sky, air, airDensity) => openingOceanColor({ water, sky, air, airDensity,
  distanceM: Math.hypot(...p.map((v, i) => v - eye[i])) });

function shade({ rise = 0, waterOnly = 0, debugMask = 0, diag = 0, point = [100, 20, 300], eye = [0, 50, 0], density = .00002 } = {}) {
  return execute(waterOnly, debugMask, diag, [1 - rise], point, eye,
    colors.water, colors.sky, colors.air, density, display, (color, alpha) => [...color, alpha]);
}

test('the exact-flat shortcut returns the same shared display color as the full final material override', () => {
  for (const point of [[0, 20, 0], [1000, 20, 3000], [60000, 20, 4000]]) for (const density of [0, .00002, .001]) {
    const eye = [50, 80, 0], shared = display(point, eye, colors.water, colors.sky, colors.air, density);
    for (const shadedMaterial of [[0, 0, 0], [.2, .7, .3], [1, 1, 1]]) {
      const fullyReplaced = shadedMaterial.map((v, i) => v * 0 + shared[i]);
      assert.deepEqual(shade({ point, eye, density }), [...fullyReplaced, 1]);
    }
  }
  assert.ok(main.indexOf(fast) < main.indexOf('texture(uSurface'), 'the shortcut precedes surface/material texture work');
  assert.ok(main.indexOf('discard;') < main.indexOf(fast), 'the clip boundary remains authoritative');
});

test('growing, water-only and diagnostic renders retain their original shader branches', () => {
  for (const settings of [{ rise: .0001 }, { rise: .25 }, { rise: 1 }, { waterOnly: 1 }, { debugMask: 1 }, { diag: 1 }]) {
    assert.equal(shade(settings), undefined);
  }
});
