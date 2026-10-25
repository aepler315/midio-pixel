// Every Range shader stage declares each uniform once: GLSL rejects a
// redefinition, and the whole view then falls back to the legacy painters
// (node never compiles GLSL, so only a browser would notice).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { createForest } from '../src/world/alpine/ForestGL.js';
import * as terrain from '../src/world/alpine/TerrainMaterial.js';
import { ActorsGL, actorUniforms } from '../src/world/alpine/ActorsGL.js';

function duplicates(source) {
  const seen = new Map();
  // Comments may mention a uniform; only declarations count.
  for (const m of source.replace(/\/\/[^\n]*/g, '').matchAll(/^\s*uniform\s+\w+\s+(\w+)/gm)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([name]) => name);
}

test('terrain, forest and cast shaders declare every uniform once per stage', () => {
  const stages = [];
  for (const [name, source] of Object.entries(terrain)) if (/_(FRAG|VERT)$/.test(name) && typeof source === 'string') stages.push([`terrain ${name}`, source]);
  const placed = { mesh: new Float32Array([0, 0, 0, 20, 10, 0, .5, 2]), billboard: new Float32Array([0, 0, 0, 20, 10, 0, .5, 2]), stride: 8, count: 1 };
  const forest = createForest(THREE, placed, {});
  for (const [band, list] of Object.entries(forest.byBand)) for (const m of list) {
    stages.push([`forest ${band} fragment`, m.material.fragmentShader], [`forest ${band} vertex`, m.material.vertexShader]);
  }
  const actors = new ActorsGL(THREE, actorUniforms(THREE));
  const materials = [actors.sites.material, ...Object.values(actors.threads.meshes).map(m => m.material)];
  for (const group of Object.values(actors.groups)) group.traverse(o => o.material && materials.push(o.material));
  for (const m of materials) stages.push(['cast fragment', m.fragmentShader], ['cast vertex', m.vertexShader]);
  assert.ok(stages.length > 12, 'the shaders were found');
  for (const [name, source] of stages) assert.deepEqual(duplicates(source), [], name);
  for (const m of [...Object.values(forest.byBand).flat(), ...forest.depth]) m.geometry.dispose();
  actors.dispose();
});
