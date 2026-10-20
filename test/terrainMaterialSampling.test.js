import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSceneMaterial, SCENE_FRAG } from '../src/world/alpine/TerrainMaterial.js';

function functionBody(source, name) {
  const declaration = source.match(new RegExp(`\\bTri ${name}\\([^)]*\\) \\{`));
  assert.ok(declaration, `${name} must reach the terrain draw shader`);
  const start = declaration.index + declaration[0].length;
  let depth = 1;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i);
  }
  assert.fail(`unterminated ${name}`);
}

function contributionGate(sampler) {
  const call = SCENE_FRAG.match(new RegExp(`triplanarWhen\\(${sampler},[^\\n]*, ([^,()]+)\\);`));
  assert.ok(call, `${sampler} must use the conditional sampler`);
  // Execute the production call's scalar condition. Vector sampling and
  // mip/filter equivalence require the matching browser render comparison.
  return new Function('water', 'snow', 'nearFade', `return ${call[1]};`);
}

test('conditional material sampling is compiled only for an explicit Pixel material', () => {
  const baseline = createSceneMaterial(THREE, {});
  const natural = createSceneMaterial(THREE, {}, { pixelated: false });
  const pixel = createSceneMaterial(THREE, {}, { pixelated: true });
  try {
    assert.equal(baseline.defines.PIXEL_MATERIAL_SKIP, undefined);
    assert.equal(natural.defines.PIXEL_MATERIAL_SKIP, undefined);
    assert.equal(pixel.defines.PIXEL_MATERIAL_SKIP, 1);
    assert.equal(pixel.vertexShader, natural.vertexShader, 'sampling cannot change terrain geometry');
    assert.equal(pixel.fragmentShader, natural.fragmentShader, 'only the compile-time define selects sampling');
  } finally { baseline.dispose(); natural.dispose(); pixel.dispose(); }
});

test('snow and near-rock fetch gates exclude water and zero contributions', () => {
  const snow = contributionGate('tSnow');
  const near = contributionGate('tRockNear');
  for (const weight of [0, 1e-7, .5, 1]) {
    assert.equal(snow(true, weight, weight), false, 'water replaces the snow albedo and detail normal');
    assert.equal(near(true, weight, weight), false, 'water replaces the near-rock detail normal');
    assert.equal(snow(false, weight, weight), weight > 0);
    assert.equal(near(false, weight, weight), weight > 0);
  }
  const snowCalls = [...SCENE_FRAG.matchAll(/triplanarWhen\(tSnow,[^\n]*, ([^,()]+)\);/g)];
  assert.equal(snowCalls.length, 2, 'both snow scales must share the gate');
  assert.equal(snowCalls[0][1], snowCalls[1][1]);
});

test('conditional triplanar samples keep UV gradients outside the divergent branch', () => {
  const body = functionBody(SCENE_FRAG, 'triplanarWhen');
  const guard = body.indexOf('if (!visible) return');
  assert.ok(guard >= 0, 'invisible detail must return before any texture fetch');
  const before = body.slice(0, guard), after = body.slice(guard);
  for (const axis of ['X', 'Y', 'Z']) {
    assert.match(before, new RegExp(`dx${axis} = dFdx\\(uv${axis}\\)`));
    assert.match(before, new RegExp(`dy${axis} = dFdy\\(uv${axis}\\)`));
    assert.match(after, new RegExp(`textureGrad\\(t, uv${axis}, dx${axis}, dy${axis}\\)`));
  }
  assert.doesNotMatch(before, /\btexture(?:Grad)?\s*\(/);
  assert.doesNotMatch(after, /\b(?:texture|dFdx|dFdy)\s*\(/);
  assert.equal([...after.matchAll(/\btextureGrad\s*\(/g)].length, 3);
  assert.match(before, /uvX = R \* \(vec2\(p\.z, p\.y\) \/ scale\)/);
  assert.match(before, /uvY = R \* \(p\.xz \/ scale\)/);
  assert.match(before, /uvZ = R \* \(vec2\(p\.x, p\.y\) \/ scale\)/);
});

test('water retains macro rock heights and snow coverage for its specular material', () => {
  assert.match(SCENE_FRAG, /Tri macro = triplanarRib\(tRock, detailPosition, n, sRock, 0\.0, 0\.35\);/);
  assert.match(SCENE_FRAG, /Tri macro2 = triplanarRib\(tRock, detailPosition, n, sRock \* 0\.37, 1\.1, 0\.5\);/);
  assert.match(SCENE_FRAG, /float rh = mix\(macro\.h, macro2\.h, 0\.35\);/);
  assert.match(SCENE_FRAG, /snow01 = snow;\s*if \(water\)/);
  assert.match(SCENE_FRAG, /materialF0\(snow01, ice\.y\)/);
});
