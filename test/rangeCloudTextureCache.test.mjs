import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { RangeSkyRenderer } from '../src/world/alpine/RangeSkyRenderer.js';
import { buildCloudTexture } from '../src/world/alpine/RangeCloudTexture.js';

const owner = 'range-cloud-pixels';
const entries = residency => [...residency.entries.values()].filter(entry => entry.owner === owner);
const cache = () => import('../src/world/alpine/RangeCloudTextureCache.js');
function makeCanvas() {
  const canvas = { width: 0, height: 0 };
  canvas.getContext = () => ({
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(image) { canvas.pixels = image.data; },
  });
  return canvas;
}

test('renderer rebuild reuses density pixels while releasing its own canvas storage', () => {
  const residency = new GraphicsResidency({ budgetBytes: 2 * 1024 ** 2 });
  const opening = new RangeSkyRenderer({ residency, makeCanvas });
  opening._seed(315);
  const first = opening._cloud(103), expected = first.pixels.slice();
  const [density] = entries(residency);
  assert.ok(density, 'the deterministic density survives the opening renderer');
  assert.equal(density.generation, 0);
  assert.equal(density.evictable, true);
  assert.equal(density.bytes, 192 * 128 * 4);
  assert.notEqual(first.pixels, density.resource, 'the destination owns a copy');
  first.pixels.fill(0);
  opening.dispose();
  assert.equal(first.width, 0, 'the old canvas is still disposed');
  assert.equal(residency.usedBytes, density.bytes, 'only the evictable shared pixels survive');
  const full = new RangeSkyRenderer({ residency, makeCanvas });
  full._seed(315);
  const second = full._cloud(103);
  assert.notEqual(second, first);
  assert.deepEqual(second.pixels, expected, 'the rebuilt scene has the exact unmodified density');
  assert.equal(entries(residency)[0], density, 'the new renderer reused the original density entry');
  assert.notEqual(second.pixels, density.resource);
  full.dispose();
  residency.releaseOwner(owner);
  assert.equal(residency.usedBytes, 0);
});

test('cloud density cache keys seed and both dimensions and preserves the pure builder pixels', async () => {
  const { cachedCloudTexture } = await cache();
  const residency = new GraphicsResidency({ budgetBytes: 1024 ** 2 });
  const first = cachedCloudTexture(residency, 315, 12, 8);
  assert.equal(cachedCloudTexture(residency, 315, 12, 8), first, 'a hit returns the already built bytes');
  assert.deepEqual(first, buildCloudTexture(315, 12, 8), 'cache admission does not alter the density');
  for (const [seed, width, height] of [[316, 12, 8], [315, 13, 8], [315, 12, 9]]) {
    const pixels = cachedCloudTexture(residency, seed, width, height);
    assert.notEqual(pixels, first);
    assert.deepEqual(pixels, buildCloudTexture(seed, width, height));
  }
  const other = new GraphicsResidency({ budgetBytes: 1024 ** 2 });
  assert.notEqual(cachedCloudTexture(other, 315, 12, 8), first, 'different ledgers own different storage');
  assert.equal(entries(residency).length, 4);
  assert.equal(entries(other).length, 1);
});

test('cloud density retention is bounded and keeps recently reused shapes', async () => {
  const { cachedCloudTexture } = await cache();
  const residency = new GraphicsResidency({ budgetBytes: 1024 ** 2 });
  const first = cachedCloudTexture(residency, 0, 4, 4);
  const second = cachedCloudTexture(residency, 1, 4, 4);
  for (let seed = 2; seed < 48; seed++) cachedCloudTexture(residency, seed, 4, 4);
  assert.equal(cachedCloudTexture(residency, 0, 4, 4), first);
  cachedCloudTexture(residency, 48, 4, 4);
  assert.equal(entries(residency).length, 48);
  assert.equal(residency.usedBytes, 48 * 4 * 4 * 4);
  assert.equal(cachedCloudTexture(residency, 0, 4, 4), first, 'the refreshed oldest shape remains resident');
  const rebuilt = cachedCloudTexture(residency, 1, 4, 4);
  assert.notEqual(rebuilt, second, 'the least recently reused shape was evicted');
  assert.deepEqual(rebuilt, second);
  assert.equal(entries(residency).length, 48);
});

test('budget eviction and explicit release remove shared density ownership', async () => {
  const { cachedCloudTexture } = await cache();
  const residency = new GraphicsResidency({ budgetBytes: 256 });
  const first = cachedCloudTexture(residency, 315, 8, 8);
  residency.cancelGeneration(1);
  assert.equal(cachedCloudTexture(residency, 315, 8, 8), first, 'song generation cancellation keeps reusable pixels');
  const replacement = residency.reserve({ key: 'terrain', owner: 'terrain', bytes: 256, generation: 2, evictable: false });
  assert.ok(replacement);
  assert.equal(entries(residency).length, 0);
  residency.commit(replacement, {});
  residency.release('terrain');
  const rebuilt = cachedCloudTexture(residency, 315, 8, 8);
  assert.notEqual(rebuilt, first, 'an evicted buffer is not held outside the ledger');
  assert.deepEqual(rebuilt, first);
  residency.releaseOwner(owner);
  assert.equal(residency.usedBytes, 0);
  assert.notEqual(cachedCloudTexture(residency, 315, 8, 8), rebuilt);
});

test('cache admission refusal leaves exact uncached rendering available without retained bytes', async () => {
  const { cachedCloudTexture } = await cache();
  const residency = new GraphicsResidency({ budgetBytes: 256 });
  const pin = residency.reserve({ key: 'active', owner: 'active', bytes: 256, evictable: false });
  residency.commit(pin, {});
  const first = cachedCloudTexture(residency, 315, 8, 8);
  const second = cachedCloudTexture(residency, 315, 8, 8);
  assert.deepEqual(first, buildCloudTexture(315, 8, 8));
  assert.deepEqual(second, first);
  assert.notEqual(second, first, 'refused optional retention falls back to the existing transient build');
  assert.equal(entries(residency).length, 0);
  assert.equal(residency.usedBytes, 256);
  assert.equal(residency.overcommits || 0, 0);
});

test('optional density retention cannot evict an existing terrain resource', async () => {
  const { cachedCloudTexture } = await cache();
  const residency = new GraphicsResidency({ budgetBytes: 256 });
  const reservation = residency.reserve({ key: 'terrain', owner: 'terrain', bytes: 256, evictable: true });
  const terrain = {};
  residency.commit(reservation, terrain);
  assert.deepEqual(cachedCloudTexture(residency, 315, 8, 8), buildCloudTexture(315, 8, 8));
  assert.equal(residency.get('terrain'), terrain, 'optional retention cannot displace other useful resources');
  assert.equal(entries(residency).length, 0);
  assert.equal(residency.usedBytes, 256);
});

test('failed cloud builds release their reservation', async () => {
  const { cachedCloudTexture } = await cache();
  const residency = new GraphicsResidency({ budgetBytes: 1024 ** 2 });
  assert.throws(() => cachedCloudTexture(residency, 315, 193, 128), RangeError);
  assert.equal(residency.usedBytes, 0);
  assert.equal(entries(residency).length, 0);
});
