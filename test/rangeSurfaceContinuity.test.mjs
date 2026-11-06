import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { SCENE_FRAG } from '../src/world/alpine/TerrainMaterial.js';
import { createForest } from '../src/world/alpine/ForestGL.js';

// Run the scalar production shader helper, as the water glint test does.
// Standard GLSL builtins have their mathematical JS meanings here.
function scalar(source, name, args) {
  const body = source.match(new RegExp(`float ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\s*\\}`));
  assert.ok(body, `${name} must reach the actual draw shader`);
  return new Function(...args, 'step', 'mix', 'smoothstep', body[1].replace(/\bfloat\b/g, 'let'));
}
const step = (edge, x) => x < edge ? 0 : 1;
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const u = Math.max(0, Math.min(1, (x - a) / (b - a))); return u * u * (3 - 2 * u); };

test('shoreline cubic preserves source posts and the midpoint of a straight bank', () => {
  const helper = scalar(SCENE_FRAG, 'waterCubic', ['a', 'b', 'c', 'd', 't']);
  const value = (...args) => helper(...args, step, mix, smoothstep);
  assert.equal(value(0, 0, 1, 1, 0), 0);
  assert.equal(value(0, 0, 1, 1, .5), .5);
  assert.equal(value(0, 0, 1, 1, 1), 1);
  assert.equal(value(1, 1, 1, 1, .37), 1);
});

test('tree coverage fades into the terrain canopy through the shared distance interval', () => {
  const trees = createForest(THREE, { mesh: new Float32Array(), billboard: new Float32Array([0, 0, 0, 20, 8, 1, .2, 0]), stride: 8, count: 1 }, {});
  try {
    for (const material of [trees.byBand.far[0].material, trees.depth[0].material]) {
      const helper = scalar(material.fragmentShader, 'forestInstanceWeight', ['distanceM', 'startM', 'endM']);
      const weight = d => helper(d, 6500, 7800, step, mix, smoothstep);
      assert.equal(weight(6000), 1); assert.equal(weight(7150), .5); assert.equal(weight(8000), 0);
      assert.ok(Math.abs(weight(7149) - weight(7151)) < .003, 'adjacent distances cannot produce an appearance cut');
    }
  } finally { trees.dispose(); }
});
