// A cache cannot evict what is being drawn, so the budget has to clear the
// working set a single frame demands or it does nothing but thrash. Every
// world's draw function fetches two strip sets in a row -- the biome being
// left and the one being entered -- and at bake dimensions that pair is
// ~71.6MB of alpine or ~139.4MB of city (whose layers own a second emissive
// surface each). A 64MB budget could not hold either pair, nor even one city
// biome on its own, so a transition evicted and rebuilt tens of megabytes of
// canvas per frame. This clears the largest pair with room for one more set;
// terrainStripCache.test.js pins the relationship so it cannot drift back.
export const DEFAULT_TERRAIN_STRIP_BUDGET = 176 * 1024 * 1024;

export function stripSetBytes(strips) {
  let bytes = 0;
  for (const surface of Object.values(strips || {})) {
    const width = Number(surface?.width);
    const height = Number(surface?.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      bytes += width * height * 4;
      bytes += Math.max(0, Number(surface.ridge?.surface?.byteLength) || 0);
      const nested = surface.windows;
      const nestedWidth = Number(nested?.width);
      const nestedHeight = Number(nested?.height);
      if (Number.isFinite(nestedWidth) && Number.isFinite(nestedHeight)
        && nestedWidth > 0 && nestedHeight > 0) bytes += nestedWidth * nestedHeight * 4;
    }
  }
  return bytes;
}

function release(strips) {
  for (const surface of Object.values(strips || {})) {
    if (typeof surface?.getContext === 'function') {
      surface.width = 0;
      surface.height = 0;
    }
    if (typeof surface?.windows?.getContext === 'function') {
      surface.windows.width = 0;
      surface.windows.height = 0;
    }
  }
}

export class TerrainStripCache {
  /** `residency` (GraphicsResidency) makes these strips share the page's
   *  one graphics budget with Range v2 instead of holding a second,
   *  independent allowance; `maxBytes` remains this cache's own ceiling. */
  constructor({ maxBytes = DEFAULT_TERRAIN_STRIP_BUDGET, residency = null, owner = 'legacy-strips', isFallback = () => false } = {}) {
    this.maxBytes = maxBytes;
    this.residency = residency;
    this.owner = owner;
    // A set whose biome another renderer (Range v2) draws is fallback only:
    // the shared ledger may evict it for that renderer's own reservations
    // (a legacy frame re-bakes it on demand). Anything else is not evictable
    // by other owners.
    this.isFallback = isFallback;
    this.bytes = 0;
    this.entries = new Map();
    this.pins = new Set();
    this.tick = 0;
  }

  get size() { return this.entries.size; }
  has(key) { return this.entries.has(key); }

  setPins(keys) {
    this.pins = new Set([...keys].filter(Boolean));
    this._evict();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.used = ++this.tick;
    return entry.strips;
  }

  /** Make room before canvases are allocated, so the budget bounds peak
   * owned raster memory rather than only the post-insertion steady state. */
  reserve(bytes, extraPins = new Set()) {
    const wanted = Math.max(0, Number(bytes) || 0);
    const shared = () => !this.residency || this.residency.canFit(wanted);
    while (this.bytes + wanted > this.maxBytes || !shared()) {
      let victim = null;
      for (const [key, entry] of this.entries) {
        if (this.pins.has(key) || extraPins.has(key)) continue;
        if (!victim || entry.used < victim[1].used) victim = [key, entry];
      }
      if (!victim) return false;
      this.delete(victim[0]);
    }
    // Hold real shared capacity (evicting other owners' evictable entries
    // now, not merely probing that they could be) until set() adopts it.
    if (this.residency) {
      this.residency.release(this._holdKey);
      if (!this.residency.reserve({ key: this._holdKey, bytes: wanted, owner: this.owner })) return false;
    }
    return true;
  }

  get _holdKey() { return `${this.owner}:__reserved`; }

  set(key, strips) {
    this.delete(key);
    const bytes = stripSetBytes(strips);
    this.entries.set(key, { strips, bytes, used: ++this.tick });
    this.bytes += bytes;
    // The held reservation becomes this entry's live accounting in one
    // synchronous step, so nothing can claim the room in between. Without a
    // hold (reserve() was not called, or was refused) the room is claimed
    // now, evicting what may be evicted. Only when even that fails -- the
    // strips on screen are already allocated and alone exceed the budget --
    // is the adoption recorded as an overcommit, visibly.
    if (this.residency) {
      const held = this.residency.entries.get(this._holdKey);
      this.residency.release(this._holdKey);
      if (!held || held.bytes < bytes) {
        const res = this.residency.reserve({ key: this._holdKey, bytes, owner: this.owner });
        if (res) this.residency.release(this._holdKey);
        else {
          this.overBudget = (this.overBudget || 0) + 1;
          console.warn(`[residency] ${this.owner}:${key} (${bytes} B) exceeds the shared budget`);
        }
      }
      this.residency.adopt({ key: `${this.owner}:${key}`, bytes, owner: this.owner,
        evictable: !!this.isFallback(key), dispose: () => this._evictedByLedger(key) });
    }
    this._evict(new Set([key]));
    return this;
  }

  /** Drop an entry. The canvases are NOT zeroed: `get()` hands the strip set
   *  itself to callers, which hold it for the rest of the frame, and a draw
   *  function fetches a second set (re-pinning as it goes) before drawing the
   *  first. Releasing in place therefore destroyed a surface its holder was
   *  about to paint, turning an eviction into a corrupted frame instead of a
   *  rebuild. Dropping the reference is enough -- an unreferenced canvas is
   *  collected anyway; one still being drawn stays valid until it is not. */
  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    this.residency?.release(`${this.owner}:${key}`);
    return true;
  }

  /** The ledger evicted a fallback set for another owner: forget it (the
   *  reference only, as delete() does). A delete() of our own has already
   *  removed the entry by the time its release reaches here. */
  _evictedByLedger(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }

  /** Teardown, not eviction: the caller is discarding the whole world, so
   *  nothing is mid-frame and the memory is worth reclaiming immediately
   *  rather than at the collector's convenience. */
  clear() {
    this.residency?.release(this._holdKey);
    for (const [key, entry] of [...this.entries]) {
      this.delete(key);
      release(entry.strips);
    }
  }

  _evict(extraPins = new Set()) {
    while (this.bytes > this.maxBytes) {
      let victim = null;
      for (const [key, entry] of this.entries) {
        if (this.pins.has(key) || extraPins.has(key)) continue;
        if (!victim || entry.used < victim[1].used) victim = [key, entry];
      }
      if (!victim) break;
      this.delete(victim[0]);
    }
  }
}
