import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGroundPatches, buildGroundPatchMesh, sampleGroundAtX } from '../src/world/alpine/GroundMaterial.js';

test('ground attachment interpolates actual x rather than a nominal 10px index', () => {
  const curve = [
    { x: 0, y: 100, tx: 1, ty: 1 },
    { x: 17, y: 117, tx: 1, ty: -1 },
    { x: 45, y: 89, tx: 1, ty: -1 },
  ];
  const p = sampleGroundAtX(curve, 31);
  assert.equal(p.x, 31);
  assert.equal(p.y, 103);
  assert.ok(Number.isFinite(p.tx) && Number.isFinite(p.ty));
  assert.equal(sampleGroundAtX(curve, -10).x, 0);
  assert.equal(sampleGroundAtX(curve, 90).x, 45);
  assert.equal(sampleGroundAtX([], 4), null);
});

test('a patch mesh follows the current curve and rejects a missed projection', () => {
  const curve = [
    { x: 0, y: 100, tx: 1, ty: 0 }, { x: 40, y: 120, tx: 1, ty: 0 }, { x: 80, y: 110, tx: 1, ty: 0 },
  ];
  const patch = { id: 'p', wx: 500, widthPx: 30, depthPx: 10, kind: 'ledge', shapeSeed: 0.2 };
  const mesh = buildGroundPatchMesh({ patch, curve, worldX: 500, originX: 40 });
  assert.equal(mesh.vertices[0].x, 40);
  assert.ok(Math.abs(mesh.vertices[0].y - 121) < 1.5);
  assert.equal(buildGroundPatchMesh({ patch, curve, worldX: 0, originX: 0 }), null);
});

test('patch identities depend on world sectors, not viewport width or draw order', () => {
  const a = buildGroundPatches({ seed: 315, biomeKey: 'RAINFOREST', worldX: 1000, viewWidth: 600, moisture: .85 });
  const b = buildGroundPatches({ seed: 315, biomeKey: 'RAINFOREST', worldX: 1000, viewWidth: 1200, moisture: .85 });
  assert.ok(a.length <= 24 && b.length <= 24);
  assert.deepEqual(a.filter(p => p.wx >= 1000 && p.wx < 1550), b.filter(p => p.wx >= 1000 && p.wx < 1550));
});

test('cold and dry materials cannot produce water receivers', () => {
  for (const biomeKey of ['DESERT', 'ICEFIELD']) {
    for (const worldX of [0, 10_000, 100_000, 1_000_000]) {
      const patches = buildGroundPatches({ seed: 315, biomeKey, worldX, viewWidth: 1280, moisture: 0 });
      assert.ok(patches.every(p => p.kind !== 'pool'));
      assert.ok(patches.every(p => p.widthPx >= 16 && p.widthPx <= 90));
    }
  }
});
