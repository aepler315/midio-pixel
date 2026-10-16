// Streaming elevation source: AWS Terrain Tiles (terrarium PNG, z0-15),
// fetched and decoded in a worker pool, kept in an LRU cache, and sampled
// with graceful fallback to coarser levels while finer tiles are loading.
//
// Sampling uses global pixel coordinates at a level: pixel (X, Y) of level L
// is pixel (X & 255, Y & 255) of tile (X >> 8, Y >> 8). Integer coordinates
// hit pixel values exactly; fractions interpolate.

export const DEM_MAX_LEVEL = 15;
const HOSTS = [
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png',
];

export class DemSource {
  constructor({ proxy = false, maxTiles = 600, workers = 4, maxInFlight = 16 } = {}) {
    this.templates = proxy ? ['/tiles/terrarium/{z}/{x}/{y}.png'] : HOSTS;
    this.maxTiles = maxTiles;
    this.maxInFlight = maxInFlight;
    this.tiles = new Map(); // key -> { z, x, y, state, heights, min, max, used }
    this.queue = new Map(); // key -> { z, x, y, priority, frame }
    this.inFlight = 0;
    this.frame = 0;
    this.listeners = new Set();
    this.stats = { loaded: 0, failed: 0, bytes: 0 };
    this.workers = [];
    this.pending = new Map();
    this.nextId = 1;
    for (let i = 0; i < workers; i++) {
      const w = new Worker(new URL('./demWorker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => this._onResult(e.data);
      this.workers.push(w);
    }
    this.rr = 0;
  }

  static key(z, x, y) { return `${z}/${x}/${y}`; }

  /** Ready tile data or null. Touches LRU. */
  get(z, x, y) {
    const t = this.tiles.get(DemSource.key(z, x, y));
    if (!t) return null;
    t.used = this.frame;
    return t.state === 'ready' ? t : null;
  }

  /** 'ready' | 'failed' | 'loading' | undefined */
  state(z, x, y) { return this.tiles.get(DemSource.key(z, x, y))?.state; }

  /** Ask for a tile; lower priority numbers load first. Re-request every
   *  frame while needed; requests not renewed for a few frames are dropped. */
  request(z, x, y, priority = 0) {
    const k = DemSource.key(z, x, y);
    const t = this.tiles.get(k);
    if (t) { t.used = this.frame; return t.state; }
    const q = this.queue.get(k);
    if (q) { q.priority = Math.min(q.priority, priority); q.frame = this.frame; return 'queued'; }
    this.queue.set(k, { z, x, y, priority, frame: this.frame });
    return 'queued';
  }

  onLoad(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Call once per frame: drop stale requests, start the best ones, evict. */
  update() {
    this.frame++;
    for (const [k, q] of this.queue) if (this.frame - q.frame > 3) this.queue.delete(k);
    if (this.inFlight < this.maxInFlight && this.queue.size) {
      const list = [...this.queue.values()].sort((a, b) => a.priority - b.priority);
      for (const q of list) {
        if (this.inFlight >= this.maxInFlight) break;
        this._start(q);
      }
    }
    if (this.tiles.size > this.maxTiles) this._evict();
  }

  _start({ z, x, y }) {
    const k = DemSource.key(z, x, y);
    this.queue.delete(k);
    const tpl = this.templates[(x + y) % this.templates.length];
    const url = new URL(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y), location.href).href;
    const entry = { z, x, y, state: 'loading', heights: null, min: 0, max: 0, used: this.frame, retries: 0 };
    this.tiles.set(k, entry);
    this._dispatch(entry, url);
  }

  _dispatch(entry, url) {
    const id = this.nextId++;
    this.pending.set(id, { entry, url });
    this.inFlight++;
    this.workers[this.rr++ % this.workers.length].postMessage({ id, url });
  }

  _onResult({ id, heights, min, max, error }) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.inFlight--;
    const { entry } = p;
    if (error) {
      // Retry transient failures a couple of times; 404s (no data) fail fast.
      if (!/HTTP 404/.test(error) && entry.retries < 2) {
        entry.retries++;
        setTimeout(() => this._dispatch(entry, p.url), 400 * 2 ** entry.retries);
        return;
      }
      entry.state = 'failed';
      this.stats.failed++;
    } else {
      entry.state = 'ready';
      entry.heights = heights; entry.min = min; entry.max = max;
      this.stats.loaded++;
    }
    for (const fn of this.listeners) fn(entry);
  }

  _evict() {
    const list = [...this.tiles.values()].filter((t) => t.state !== 'loading' && t.z > 3).sort((a, b) => a.used - b.used);
    let n = this.tiles.size - this.maxTiles;
    for (const t of list) {
      if (n <= 0 || this.frame - t.used < 4) break;
      this.tiles.delete(DemSource.key(t.z, t.x, t.y));
      n--;
    }
  }

  /** Best loaded data for tile (level, tx, ty): the tile itself or its
   *  nearest loaded ancestor. Returns { heights, level, ox, oy, scale }
   *  where a pixel index X at `level` maps to ancestor index
   *  (X + 0.5) / scale - 0.5 - ox (pixel-centre convention), or null. */
  resolve(level, tx, ty) {
    const n = 1 << level;
    tx = ((tx % n) + n) % n;
    if (ty < 0) ty = 0; else if (ty >= n) ty = n - 1;
    for (let L = level; L >= 0; L--) {
      const s = level - L;
      const ax = tx >> s, ay = ty >> s;
      const t = this.tiles.get(`${L}/${ax}/${ay}`);
      if (t && t.state === 'ready') {
        t.used = this.frame;
        return { heights: t.heights, level: L, ox: ax * 256, oy: ay * 256, scale: 1 << s, tile: t };
      }
    }
    return null;
  }
}

export function bilinearInTile(h, fx, fy) {
  if (fx < 0) fx = 0; else if (fx > 255) fx = 255;
  if (fy < 0) fy = 0; else if (fy > 255) fy = 255;
  const x0 = Math.min(254, fx | 0), y0 = Math.min(254, fy | 0), ax = fx - x0, ay = fy - y0;
  const i = (y0 << 8) | x0;
  const a = h[i] + (h[i + 1] - h[i]) * ax, b = h[i + 256] + (h[i + 257] - h[i + 256]) * ax;
  return a + (b - a) * ay;
}
