import { buildCloudTexture } from './RangeCloudTexture.js';

const owner = 'range-cloud-pixels';
const limit = 48;
const caches = new WeakMap();

/** Retain deterministic density pixels across scene rebuilds, within the
 * page's graphics budget. Callers copy these bytes into their own canvas.
 * Only the ledger owns pixels; this LRU holds reservation metadata so its
 * eviction cannot leave an unaccounted buffer alive in a second cache. */
export function cachedCloudTexture(residency, seed, width = 192, height = 128) {
  let cache = caches.get(residency);
  if (!cache) { cache = new Map(); caches.set(residency, cache); }
  const key = `${owner}:${typeof seed}:${seed}:${width}:${height}`;
  const pixels = residency.get(key);
  if (pixels) {
    const reservation = cache.get(key);
    cache.delete(key);
    cache.set(key, reservation);
    return pixels;
  }
  cache.delete(key);
  if (cache.size >= limit) residency.releaseReservation(cache.values().next().value);
  // Retaining recomputable pixels must not evict terrain or other graphics.
  const protect = [...residency.entries.values()].filter(entry => entry.owner !== owner).map(entry => entry.key);
  const reservation = residency.reserve({ key, bytes: width * height * 4, owner, generation: 0, evictable: true, protect });
  // Admission is optional. A refusal keeps the original transient build/copy
  // path, without retaining another buffer after the destination is painted.
  if (!reservation) return buildCloudTexture(seed, width, height);
  try {
    const built = buildCloudTexture(seed, width, height);
    cache.set(key, reservation);
    residency.commit(reservation, built, () => {
      if (cache.get(key) === reservation) cache.delete(key);
    });
    return built;
  } catch (error) {
    residency.releaseReservation(reservation);
    throw error;
  }
}
