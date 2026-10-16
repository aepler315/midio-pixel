import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as accessibility from '../src/ui/Accessibility.js';

test('reduced motion is persisted independently of reduced flash and defaults to OS preference', () => {
  const values = new Map();
  const oldStorage = globalThis.localStorage, oldWindow = globalThis.window;
  globalThis.localStorage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  try {
    assert.equal(accessibility.getReducedMotion(), true);
    accessibility.setReducedMotion(false);
    accessibility.setReducedFlash(true);
    assert.equal(accessibility.getReducedMotion(), false);
    assert.equal(accessibility.getReducedFlash(), true);
  } finally {
    if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});

test('reduced flashing lengthens a same-biome returning-section cut (M1)', async () => {
  const { blendSections } = await import('../src/world/BiomeSchedule.js');
  const sections = [{ startMs: 0, profile: 'TAIGA', heightMul: 1 }, { startMs: 5000, profile: 'TAIGA', heightMul: 2, transition: 'cut', barMs: 2000 }];
  assert.equal(blendSections(sections, 5800).t, 1);
  assert.ok(blendSections(sections, 5800, { reducedFlash: true }).t < .5);
});

test('reduced motion holds legacy scanned terrain and suppresses ridge dance (M2)', async () => {
  const { BiomeManager } = await import('../src/world/BiomeManager.js');
  const m = Object.create(BiomeManager.prototype);
  Object.assign(m, { world: { kind: 'alpine' }, energyCurves: { globalEnergyNorm: () => .5 }, durationMs: 60000,
    w: 1280, reducedMotion: false, reducedFlash: false, _scannedLayer: () => true,
    _terrainStripWidth: () => 10000, _scannedMaxDepth: () => 1, tSec: 10 });
  const before = m._terrainScroll('L2', 2000); m.tSec = 20;
  assert.notEqual(m._terrainScroll('L2', 4000), before);
  m.reducedMotion = true; m.tSec = 10;
  const held = m._terrainScroll('L2', 2000), env = m._ridgeEnvelope(); m.tSec = 20;
  assert.equal(m._terrainScroll('L2', 4000), held);
  assert.ok(m._ridgeEnvelope().groove < env.groove + .001);
  m.reducedMotion = false;
  const moving = m._ridgeEnvelope(); m.reducedMotion = true;
  assert.ok(m._ridgeEnvelope().groove < moving.groove, 'same-time cache reflects the new motion preference');
});
