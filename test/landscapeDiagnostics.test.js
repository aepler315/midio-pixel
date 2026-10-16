import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEmptyPass, diagnosticAllows, LANDSCAPE_PASSES } from '../src/world/alpine/LandscapeDiagnostics.js';
import { convertLightBetween } from '../src/world/alpine/LightSpace.js';

test('a diagnostic pass suppresses unrelated paint and names an empty result', () => {
  assert.equal(diagnosticAllows(null, 'ridge-faces', 'L3'), true);
  assert.equal(diagnosticAllows({ pass: 'ridge-faces' }, 'ridge-faces', 'L3'), true);
  assert.equal(diagnosticAllows({ pass: 'ridge-faces' }, 'space-ridge'), false);
  assert.equal(diagnosticAllows({ pass: 'L2' }, 'cover', 'L2'), true);
  assert.equal(diagnosticAllows({ pass: 'L2' }, 'cover', 'L4'), false);
  const terrain = new Set(['ridge-base', 'ridge-faces', 'ground-base']);
  assert.equal(diagnosticAllows({ passes: terrain }, 'space-ridge'), false);
  assert.equal(diagnosticAllows({ passes: terrain }, 'ridge-faces', 'L3'), true);
  assert.equal(classifyEmptyPass({ painted: false, disabled: true, geometry: true }), 'disabled');
  assert.equal(classifyEmptyPass({ painted: false, offscreen: true, geometry: true }), 'offscreen');
  assert.equal(classifyEmptyPass({ painted: false, geometry: false }), 'empty-geometry');
  assert.equal(classifyEmptyPass({ painted: false, geometry: true }), 'unexpected-zero');
  assert.ok(LANDSCAPE_PASSES.includes('valley-fog'));
});

test('scenic and ground light share a direction through a known scale', () => {
  const matrix = (scale, tx, ty) => ({
    transformPoint({ x, y }) { return { x: x * scale + tx, y: y * scale + ty }; },
    inverse() {
      return { transformPoint({ x, y }) { return { x: (x - tx) / scale, y: (y - ty) / scale }; } };
    },
  });
  const scenic = matrix(0.5, 100, 40);
  const ground = matrix(1, 8, 12);
  const light = { x: 200, y: 80, dirX: 0.6, dirY: 0.8, intensity: 0.7, colorHex: '#fff6e0' };
  const out = convertLightBetween(light, scenic, ground);
  assert.ok(Math.abs(out.x - 192) < 1e-9);
  assert.ok(Math.abs(out.y - 68) < 1e-9);
  assert.ok(Math.abs(out.dirX - 0.6) < 1e-9);
  assert.ok(Math.abs(out.dirY - 0.8) < 1e-9);
  assert.equal(out.intensity, 0.7);
  assert.equal(out.colorHex, '#fff6e0');
  assert.equal(convertLightBetween(light, null, ground), light);
});
