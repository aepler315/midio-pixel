import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_FRAG } from '../src/world/alpine/TerrainMaterial.js';

test('ocean and storm openings use distinct locals in the terrain main scope', () => {
  const main = SCENE_FRAG.slice(SCENE_FRAG.indexOf('  void main() {'));
  const storm = main.match(/float\s+(\w+)\s*=\s*stormOpening\(vRenderedWorld\)/);
  const ocean = main.match(/float\s+(\w+)\s*=\s*openingOcean01\(1\.0 - uLandRise\.x\)/);
  assert.ok(storm, 'storm opening remains in the production terrain shader');
  assert.ok(ocean, 'ocean opening remains in the production terrain shader');
  // GLSL forbids declaring the same local twice in this main() scope.
  assert.notEqual(ocean[1], storm[1], 'the ocean must not redeclare the storm local');
  const oceanTail = main.slice(ocean.index);
  assert.match(oceanTail, new RegExp(`if \\(${ocean[1]} > 0\\.0\\)`));
  assert.match(oceanTail, new RegExp(`uAirDensity\\), ${ocean[1]}\\)`));
});
