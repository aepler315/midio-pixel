import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';

// currentFxAlpha reads only this.currentBlend + this._profile -- exercised
// against a fake `this` the same way ridgeShoulders.test.js does for
// _ridgePeaks, so this stays a fast unit test with no real BiomeManager
// construction (conductor/energyCurves/etc.) involved.
function fakeThis(blend, profiles) {
  return {
    currentBlend: blend,
    _profile: (name) => profiles[name],
  };
}

test('currentFxAlpha is 0 with no active blend', () => {
  const alpha = BiomeManager.prototype.currentFxAlpha.call(fakeThis(null, {}), 'emberGlow');
  assert.equal(alpha, 0);
});

test('currentFxAlpha is 0 when neither side of the blend carries the fx', () => {
  const profiles = { A: { fx: 'aurora' }, B: { fx: 'mirage' } };
  const alpha = BiomeManager.prototype.currentFxAlpha.call(
    fakeThis({ from: 'A', to: 'B', t: 0.5 }, profiles), 'emberGlow',
  );
  assert.equal(alpha, 0);
});

test('currentFxAlpha is 1 when fully settled on a biome carrying the fx', () => {
  const profiles = { A: { fx: 'emberGlow' } };
  const alpha = BiomeManager.prototype.currentFxAlpha.call(
    fakeThis({ from: 'A', to: 'A', t: 1 }, profiles), 'emberGlow',
  );
  assert.equal(alpha, 1);
});

test('currentFxAlpha crossfades: fades out leaving the fx, fades in entering it', () => {
  const profiles = { EMBER: { fx: 'emberGlow' }, ARCTIC: { fx: 'starTwinkle' } };
  // Leaving EMBER for ARCTIC: alpha should fall from 1 to 0 as t rises.
  const leaving = fakeThis({ from: 'EMBER', to: 'ARCTIC', t: 0.3 }, profiles);
  assert.ok(Math.abs(BiomeManager.prototype.currentFxAlpha.call(leaving, 'emberGlow') - 0.7) < 1e-9);

  // Entering EMBER from ARCTIC: alpha should rise from 0 to 1 as t rises.
  const entering = fakeThis({ from: 'ARCTIC', to: 'EMBER', t: 0.3 }, profiles);
  assert.ok(Math.abs(BiomeManager.prototype.currentFxAlpha.call(entering, 'emberGlow') - 0.3) < 1e-9);
});
