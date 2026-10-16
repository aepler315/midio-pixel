import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { TerrainStripCache } from '../src/world/terrain/TerrainStripCache.js';

const canvas = () => ({ width: 0, height: 0, getContext: () => ({}) });
function manager(bytes = 200 * 1024 ** 2) {
  const m = Object.create(BiomeManager.prototype);
  m.residency = new GraphicsResidency({ budgetBytes: bytes });
  m.strips = new TerrainStripCache({ residency: m.residency });
  m._unsub = []; m._serial = 902;
  return m;
}
test('legacy scratch admits before allocation and disposal prevents late recreation', () => {
  const old = globalThis.document; let made = 0;
  globalThis.document = { createElement: () => { made++; return canvas(); } };
  try {
    const m = manager(1);
    assert.equal(m._acquireTravelSurface({ width: 1920, height: 1080 }, 'A'), null);
    assert.equal(m._reliefBand(1920), null);
    assert.equal(made, 0);
    m.dispose();
    m.residency.budgetBytes = 200 * 1024 ** 2;
    assert.equal(m._acquireTravelSurface({ width: 1280, height: 720 }, 'A'), null);
    assert.equal(m._reliefBand(1280), null);
  } finally { globalThis.document = old; }
});
test('three travel slots and relief pair reuse, resize and retire all dimensions', () => {
  const old = globalThis.document; const made = [];
  globalThis.document = { createElement: () => { const c = canvas(); made.push(c); return c; } };
  try {
    const m = manager();
    for (const [width, height] of [[1280, 720], [1920, 1080], [3840, 2160]]) {
      const previous = [...made];
      for (let i = 0; i < 100; i++) {
        for (const slot of ['A', 'B', 'mix']) m._acquireTravelSurface({ width, height }, slot);
        m._reliefBand(width);
      }
      assert.equal(made.length - previous.length, 5);
      assert.ok(previous.every(c => c.width === 0 && c.height === 0));
      const backingBytes = made.reduce((sum, c) => sum + c.width * c.height * 4, 0);
      assert.equal(m.residency.usedBytes, backingBytes);
    }
    m.dispose(); m.dispose();
    assert.ok(made.every(c => c.width === 0 && c.height === 0));
    assert.equal(m.residency.usedBytes, 0);
    assert.equal(m._travelSurfaces, null); assert.equal(m._reliefScratch, null);
  } finally { globalThis.document = old; }
});
test('unpublished bake admission precedes composition and cancel releases its exact charge', () => {
  const m = manager(100);
  m._terrainFor = () => null; m._profile = name => ({ name }); m._estimateStripBytes = () => 400;
  let composed = 0;
  m._composeStripJob = p => { composed++; return { key: p.name, strips: {}, terrain: null }; };
  m._queueBake('next');
  assert.equal(composed, 0); assert.equal(m._bakeJob, null);
  m.residency.budgetBytes = 1000; m._queueBake('next');
  assert.equal(m.residency.usedBytes, 400);
  const surface = canvas(); surface.width = surface.height = 10;
  m._bakeJob.strips.L2 = surface;
  m.dispose();
  assert.equal(surface.width, 0); assert.equal(m.residency.usedBytes, 0);
  m._queueBake('late'); assert.equal(composed, 1);
});
test('publishing an admitted bake transfers one charge without zeroing the visible result', () => {
  const m = manager(500);
  m._terrainFor = () => null; m._profile = name => ({ name }); m._estimateStripBytes = () => 400;
  const surface = canvas(); surface.width = surface.height = 10;
  m._composeStripJob = p => ({ key: p.name, strips: { L2: surface }, terrain: null, done: true });
  m._queueBake('next'); const job = m._bakeJob;
  assert.equal(m.residency.usedBytes, 400);
  assert.equal(m._publishBake(job), true);
  assert.equal(m.residency.usedBytes, 400); assert.equal(surface.width, 10);
  m._cancelBake(); assert.equal(surface.width, 10);
  m.dispose(); assert.equal(surface.width, 0); assert.equal(m.residency.usedBytes, 0);
});

test('a failed unpublished layer retires partial surfaces and the reservation', () => {
  const m = manager(1000);
  m._terrainFor = () => null; m._profile = name => ({ name }); m._estimateStripBytes = () => 400;
  const surface = canvas(); surface.width = surface.height = 10;
  m._composeStripJob = p => ({ key: p.name, strips: { L2: surface }, terrain: null });
  m._bakeOneLayer = () => { throw new Error('bake failed'); };
  m._queueBake('next');
  assert.throws(() => m._pumpBake(), /bake failed/);
  assert.equal(m._bakeJob, null); assert.equal(surface.width, 0); assert.equal(m.residency.usedBytes, 0);
});
