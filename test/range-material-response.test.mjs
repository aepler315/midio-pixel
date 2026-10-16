// Natural-rendering Task 4: roughness changes the terrain's light response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terrainSpecular, terrainRoughness, SPEC_MAX, F0_DIELECTRIC, F0_ICE, TERRAIN_LIGHTING_GLSL } from '../src/world/alpine/TerrainLighting.js';
import { SCENE_FRAG, sceneUniforms, WATER_REFLECT_FLOOR, SHADOW_RESIDUAL } from '../src/world/alpine/TerrainMaterial.js';
import * as THREE from 'three';

const norm = (v) => { const l = Math.hypot(...v); return v.map(x => x / l); };
const up = [0, 1, 0];
// A low sun ahead of a camera looking along the ground: the glancing light
// where wet rock and snow should separate from dry soil.
const sun = norm([0, 0.25, -1]), eye = norm([0, 0.3, 1]);

test('with everything else fixed, roughness alone changes the reflected light', () => {
  const values = [0.25, 0.45, 0.65, 0.85, 0.95].map(r => terrainSpecular(up, eye, sun, r).spec);
  for (let i = 1; i < values.length; i++) assert.ok(values[i] < values[i - 1], `rougher is dimmer at the mirror angle (${values})`);
  assert.ok(values[0] > values[values.length - 1] * 4, 'wet versus dry is a visible difference, not a rounding error');
  // Off the mirror direction a rough surface keeps more than a smooth one.
  const side = norm([1, 0.6, 0.2]);
  assert.ok(terrainSpecular(up, side, sun, 0.9).spec > terrainSpecular(up, side, sun, 0.2).spec);
});

test('the response is bounded, finite and zero facing away from the light', () => {
  for (const r of [0.04, 0.1, 0.3, 0.6, 1]) for (const v of [eye, up, norm([1, 0.01, 0])]) for (const l of [sun, up, norm([0.3, 0.05, 0.9])]) {
    const { spec, fresnel } = terrainSpecular(up, v, l, r);
    assert.ok(Number.isFinite(spec) && spec >= 0 && spec <= SPEC_MAX);
    assert.ok(fresnel >= F0_DIELECTRIC - 1e-9 && fresnel <= 1);
  }
  assert.deepEqual(terrainSpecular(up, eye, norm([0, -0.2, 1]), 0.5), { spec: 0, fresnel: 0 });
  // Ice and snow reflect less at normal incidence than rock.
  const v = norm([0, 1, 0.02]), l = norm([0, 1, -0.02]);
  assert.ok(terrainSpecular(up, v, l, 0.5, F0_ICE).spec < terrainSpecular(up, v, l, 0.5, F0_DIELECTRIC).spec);
});

test('specular anti-aliasing only ever widens the lobe, within a clamp', () => {
  assert.equal(terrainRoughness(0.5, 0), 0.5);
  assert.ok(terrainRoughness(0.3, 0.2) > 0.3);
  assert.ok(terrainRoughness(0.3, 100) <= Math.sqrt(0.09 + 0.5) + 1e-12);
  assert.equal(terrainRoughness(0, 0), 0.04);
});

test('the terrain shader uses roughness, the baked horizon and a roughness debug view', () => {
  assert.match(SCENE_FRAG, /terrainSpecular\(nShade, Vs, uLightDir, rough,/);
  assert.match(SCENE_FRAG, /sunHorizonVisibility\(vUv, uLightDir\)/);
  assert.ok(SHADOW_RESIDUAL > 0 && SHADOW_RESIDUAL <= 0.5, 'shadow keeps some bounce, not full light');
  assert.ok(SCENE_FRAG.includes(`mix(${SHADOW_RESIDUAL.toFixed(2)}, 1.0, sunVis)`));
  assert.match(SCENE_FRAG, /specLight = spec\.x \* sunVis/, 'no specular in shadow');
  assert.match(SCENE_FRAG, /uDebugMask == 6\) \{ outColor = vec4\(vec3\(rough\)/);
  assert.doesNotMatch(SCENE_FRAG, /pow\(max\(dot\(nShade, sheenH\), 0\.0\), 48\.0\)/, 'no fixed-exponent wet layer');
  assert.ok(SCENE_FRAG.includes(TERRAIN_LIGHTING_GLSL.trim().slice(0, 40)));
  // Water: world-anchored swells, no screen-row shiver, explicit floor.
  assert.doesNotMatch(SCENE_FRAG, /gl_FragCoord\.y \/ max\(uViewportPx\.y, 1\.0\) \* 260\.0/);
  assert.match(SCENE_FRAG, /waterSlope\(vWorld\.xz, uTime\)/);
  const u = sceneUniforms(THREE, {});
  assert.ok(SCENE_FRAG.includes(`clamp(${WATER_REFLECT_FLOOR.toFixed(3)} +`), 'the floor is a named constant in the shader');
  assert.ok(WATER_REFLECT_FLOOR < 0.3, 'Natural keeps a more restrained floor than the old fixed 0.3');
  assert.equal(u.uHorizonSize.value.x, 0, 'no horizon until a bake lands');
});
