import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORLDS } from '../src/world/Worlds.js';
import {
  WORLD_IDENTITIES, identityFor, identityAllows, stockPaletteMixFor,
} from '../src/world/WorldIdentity.js';
import { stripNonCode } from './helpers/classShape.js';
import { readFileSync } from 'node:fs';

const MODULE_KINDS = {
  city: 'city', farside: 'airless', fathom: 'abyssal', redline: 'strip',
  foundry: 'foundry', understory: 'overgrowth', nave: 'nave',
};

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

test('enclosed worlds reject open-sky spectacle while airless space keeps it', () => {
  for (const kind of ['abyssal', 'overgrowth', 'nave']) {
    assert.equal(identityAllows(kind, 'deepSky'), false, `${kind} must not show deep sky`);
    assert.equal(identityAllows(kind, 'constellations'), false, `${kind} must not show constellations`);
    assert.equal(identityAllows(kind, 'meteors'), false, `${kind} must not show meteors`);
  }
  assert.equal(identityAllows('airless', 'deepSky'), true);
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

test('Understory has no executable path to open-sky spectacle', () => {
  const source = stripNonCode(readFileSync(new URL('../src/world/understory/drawUnderstory.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /\bmgr\.(?:drawDeepSky|weaver|meteors)\b/);
});

test('a world renderer cannot opt itself into a shared effect its identity forbids', () => {
  const checks = [
    ['drawDeepSky', 'deepSky'],
    ['weaver', 'constellations'],
    ['meteors', 'meteors'],
  ];
  for (const [folder, kind] of Object.entries(MODULE_KINDS)) {
    const source = stripNonCode(readFileSync(new URL(`../src/world/${folder}/draw${folder === 'city' ? 'City' : folder[0].toUpperCase() + folder.slice(1)}.js`, import.meta.url), 'utf8'));
    for (const [member, effect] of checks) {
      if (new RegExp(`\\bmgr\\.${member}\\b`).test(source)) {
        assert.equal(identityAllows(kind, effect), true,
          `${kind} may not render ${effect}; update the identity policy before adding it`);
        assert.match(source, /\bidentityAllows\(identity,/,
          `${kind} must check its runtime identity before rendering shared spectacle`);
      }
    }
  }
});
