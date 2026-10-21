import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORLDS } from '../src/world/Worlds.js';
import {
  WORLD_IDENTITIES, identityFor, identityAllows, stockPaletteMixFor,
} from '../src/world/WorldIdentity.js';

test('every registered world kind declares a complete, immutable identity', () => {
  for (const { id, kind } of WORLDS) {
    const identity = identityFor(kind);
    assert.ok(identity, `${id} is missing an identity policy`);
    assert.equal(identity.kind, kind);
    assert.ok(identity.landmark.length > 0, `${id} needs a persistent landmark`);
    assert.ok(identity.signatureMotion.length > 0, `${id} needs signature motion`);
    assert.ok(identity.lightSource.length > 0, `${id} needs a light source`);
    assert.ok(identity.castPlacement.length > 0, `${id} needs a cast placement rule`);
    assert.ok(identity.paletteFloor >= 0.2 && identity.paletteFloor <= 1, `${id} needs a usable palette floor`);
    assert.ok(Object.isFrozen(identity), `${id} identity must not drift at runtime`);
  }
  assert.equal(Object.keys(WORLD_IDENTITIES).length, new Set(WORLDS.map((w) => w.kind)).size);
});

test('only the alpine range owns an ocean hazard', () => {
  for (const [kind, identity] of Object.entries(WORLD_IDENTITIES)) {
    assert.equal(identityAllows(identity, 'ocean'), kind === 'alpine', `${kind} ocean hazard`);
  }
});

test('unknown kinds fall back to the alpine identity instead of bypassing the contract', () => {
  assert.equal(identityFor('unknown'), WORLD_IDENTITIES.alpine);
  assert.equal(identityAllows('unknown', 'deepSky'), true);
});

test('identity palette floors cannot be weakened by adaptation capability defaults', () => {
  for (const identity of Object.values(WORLD_IDENTITIES)) {
    assert.ok(stockPaletteMixFor(identity, identity.paletteFloor - 0.1) >= identity.paletteFloor);
  }
});
