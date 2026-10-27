import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { createDepthMaterial, sceneUniforms } from '../src/world/alpine/TerrainMaterial.js';

test('river depth records its own terrain band during multisample ownership and restores the depth twin', () => {
  const uniforms = sceneUniforms(THREE, {});
  const depthMaterial = createDepthMaterial(THREE, uniforms);
  const riverDepthMaterial = createDepthMaterial(THREE, uniforms, { riverSurface: true });
  const river = new THREE.Mesh(new THREE.BufferGeometry(), riverDepthMaterial);
  const p = { uniforms, depthMaterial, riverDepthMaterial, depthScene: new THREE.Scene(),
    depthBandMeshes: {}, riverDepthMeshes: { near: river } };
  p.depthScene.add(river);
  const target = { texture: {} }, own = {};
  const scene = Object.create(RangeScene.prototype);
  scene.THREE = THREE;
  let recorded = false;
  scene.renderer = {
    render(actual) {
      assert.equal(actual, p.depthScene);
      assert.equal(river.material, p.riverOwnershipMaterials?.near, 'water must use its own band and interpolation shader');
      recorded = true;
    },
    setRenderTarget() {}, setClearColor() {}, clear() {},
  };
  scene._copyTexture = () => {};
  try {
    scene._renderOwnership(p, target, own);
    assert.equal(recorded, true);
    assert.equal(river.material, riverDepthMaterial);
  } finally {
    for (const m of Object.values(p.ownershipMaterials || {})) m.dispose();
    for (const m of Object.values(p.riverOwnershipMaterials || {})) m.dispose();
    depthMaterial.dispose(); riverDepthMaterial.dispose(); river.geometry.dispose();
  }
});

test('retiring a prepared canyon releases its river geometry and water material', () => {
  const scene = Object.create(RangeScene.prototype);
  const geometry = new THREE.BufferGeometry(), material = new THREE.ShaderMaterial();
  let geometries = 0, materials = 0;
  geometry.addEventListener('dispose', () => geometries++);
  material.addEventListener('dispose', () => materials++);
  scene._disposePrepared({ riverGeometries: { near: geometry }, riverMaterial: material });
  assert.equal(geometries, 1, 'water geometry must have the same lifecycle as terrain');
  assert.equal(materials, 1, 'a retired river shader must not survive view eviction');
});

test('channel seam fill reaches the farther partition and the same travel columns as its terrain', () => {
  const scene = Object.create(RangeScene.prototype);
  scene.THREE = THREE;
  scene.size = { width: 100, height: 50 };
  const scenes = Object.fromEntries(['far', 'mid', 'near'].map(b => [b, new THREE.Scene()]));
  const mid = new THREE.BufferGeometry(), near = new THREE.BufferGeometry();
  const material = new THREE.ShaderMaterial();
  const fringeMeshes = [];
  const fringeTravel = [{ band: 'mid', pass: 'far', scene: new THREE.Scene() },
    { band: 'near', pass: 'mid', scene: new THREE.Scene() }];
  try {
    assert.equal(typeof scene._attachRiverFringes, 'function');
    scene._attachRiverFringes({ mid, near }, material, scenes, fringeMeshes, fringeTravel);
    assert.equal(scenes.far.children[0].geometry, mid);
    assert.equal(scenes.mid.children[0].geometry, near);
    assert.equal(fringeMeshes.length, 2, 'ordinary fill must hide with terrain fill during travel');
    // Smooth water can target a different backing size than native terrain.
    const target = { width: 200, height: 100, scissor: new THREE.Vector4(), scissorTest: false };
    let draws = 0;
    scene.renderer = { setRenderTarget() {}, render(actual) {
      assert.equal(actual, fringeTravel[0].scene);
      assert.equal(actual.children[0].geometry, mid);
      assert.equal(actual.children[0].material, material);
      assert.deepEqual(target.scissor.toArray(), [40, 0, 120, 100]); draws++;
    } };
    scene._travelFringe({ fringeTravel }, target, 'far', { mid: [.2, .8] });
    assert.equal(draws, 1);
    assert.equal(target.scissorTest, false);
  } finally { mid.dispose(); near.dispose(); material.dispose(); }
});
