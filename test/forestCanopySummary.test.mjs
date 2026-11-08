import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canopySummaryEnabled, canopySummaryWeight, CANOPY_SUMMARY_GLSL } from '../src/world/alpine/ForestCanopySummary.js';

test('canopy summary is live by default and preserves explicit reference URLs', () => {
  assert.equal(canopySummaryEnabled(), true);
  assert.equal(canopySummaryEnabled('?other=1'), true);
  for (const value of ['1', 'on']) assert.equal(canopySummaryEnabled(`?canopySummary=${value}`), true);
  for (const value of ['0', 'off', 'reference', '', 'unknown']) {
    assert.equal(canopySummaryEnabled(`?canopySummary=${value}`), false);
  }
});

test('unresolved crowns return to the mean canopy while resolved crowns retain all detail', () => {
  for (const [radius, footprint, expected] of [[0, 1, 0], [.375, 1, 0], [.5625, 1, .5], [.75, 1, 1], [3, 1, 1]]) {
    assert.equal(canopySummaryWeight({ radius, footprint }), expected);
  }
  assert.equal(canopySummaryWeight({ radius: -1, footprint: 1 }), 0);
  assert.equal(canopySummaryWeight({ radius: 1, footprint: 0 }), 1);
  assert.equal(canopySummaryWeight({ radius: .00001, footprint: 0 }), 1);
  assert.equal(canopySummaryWeight({ radius: 0, footprint: 0 }), 0);
});

test('projected crown handoff is monotonic and continuous at both endpoints', () => {
  let previous = 0;
  for (let i = 0; i <= 300; i++) {
    const weight = canopySummaryWeight({ radius: i / 200, footprint: 1 });
    assert.ok(weight >= previous && weight >= 0 && weight <= 1);
    previous = weight;
  }
  assert.ok(canopySummaryWeight({ radius: .375 + 1e-6, footprint: 1 }) < 1e-9);
  assert.ok(canopySummaryWeight({ radius: .75 - 1e-6, footprint: 1 }) > 1 - 1e-9);
});

test('shrinking a low-vigor stand hands off sooner without changing resolved crowns', () => {
  // Low-vigor mean radius is 1.7m at scale 1 and .51m at scale .3.
  assert.equal(canopySummaryWeight({ radius: .51, footprint: 2 }), 0);
  assert.equal(canopySummaryWeight({ radius: 1.7, footprint: 2 }), 1);
  assert.equal(canopySummaryWeight({ radius: .51, footprint: .5 }), 1);
  assert.equal(canopySummaryWeight({ radius: 1.7, footprint: .5 }), 1);
  assert.equal(canopySummaryWeight({ radius: .5625, footprint: 1 }), canopySummaryWeight({ radius: 1.125, footprint: 2 }));
});

test('invalid inputs cannot leak a nonfinite detail weight into the shader controls', () => {
  for (const invalid of [NaN, Infinity, -Infinity, undefined, null]) {
    assert.equal(canopySummaryWeight({ radius: invalid, footprint: 1 }), 0);
    assert.equal(canopySummaryWeight({ radius: 1, footprint: invalid }), 0);
  }
});

test('the actual GLSL scalar blend matches the CPU handoff across its transition', () => {
  const body = CANOPY_SUMMARY_GLSL.match(/float canopySummaryBlend\(float pixels\)\s*\{([^}]+)\}/)?.[1];
  assert.ok(body, 'execute the production GLSL scalar body');
  const blend = new Function('pixels', 'smoothstep', body);
  const smoothstep = (lo, hi, x) => { const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t); };
  for (const pixels of [0, .75, .9, 1.125, 1.4, 1.5, 8]) {
    assert.equal(blend(pixels, smoothstep), canopySummaryWeight({ radius: pixels / 2, footprint: 1 }));
  }
  assert.equal(blend(1.125, smoothstep), .5);
});
