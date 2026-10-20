import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RangeScene } from '../src/world/alpine/RangeScene.js';

test('pixel preparation allocates no ownership shaders; multisampling retains all three owners', () => {
  const scene = Object.assign(Object.create(RangeScene.prototype), { THREE });
  assert.equal(typeof scene._createOwnershipMaterials, 'function');
  assert.equal(scene._createOwnershipMaterials({}, true), null);
  const owners = scene._createOwnershipMaterials({}, false);
  assert.deepEqual(Object.keys(owners).sort(), ['far', 'mid', 'near']);
  for (const material of Object.values(owners)) {
    assert.ok(material instanceof THREE.ShaderMaterial);
    assert.equal(material.colorWrite, true);
    material.dispose();
  }
});
