import { cameraAt, defaultCamera } from './CameraEditor.js';
import { createScoutStyle, renderScoutPreview, sampleScoutHeight } from './ScoutRender.js';

// AWS Terrain Tiles, Terrarium encoding. Source and encoding match
// tools/lib/terrarium.mjs; browser image decoding replaces its Node PNG reader.
export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TILE = 256, LAT_M = 110540, LON_M = 111320, DEG = Math.PI / 180;
const GRID_SIZE = 193, RADIUS_M = 40000, MAX_DISTANCE_M = 36000;
const INDEX_URL = new URL('../assets/studio-terrain/index.json', import.meta.url);
let terrainIndex = null;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const abortError = () => new DOMException('Terrain request superseded', 'AbortError');
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }

function globalPixel(lon, lat, zoom) {
  const size = TILE * 2 ** zoom, sin = Math.sin(clamp(lat, -85.051128, 85.051128) * DEG);
  return { x: (lon + 180) / 360 * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size };
}

/** Real geographic coverage around an editable eye. Polar views use lower
 * source zoom to hold the same 40 km radius within the 16-tile budget. */
export function terrainPlan(candidate) {
  const eye = candidate?.camera?.eye;
  if (!eye || !Number.isFinite(eye.lon) || !Number.isFinite(eye.lat) || Math.abs(eye.lon) > 180 || Math.abs(eye.lat) > 84) {
    throw new Error('This view has no usable reference camera for real terrain');
  }
  const lonRadius = RADIUS_M / (LON_M * Math.cos(eye.lat * DEG)), latRadius = RADIUS_M / LAT_M;
  const bounds = {
    west: Math.max(-180, eye.lon - lonRadius), east: Math.min(180, eye.lon + lonRadius),
    south: Math.max(-85, eye.lat - latRadius), north: Math.min(85, eye.lat + latRadius),
  };
  for (let zoom = 9; zoom >= 1; zoom--) {
    const nw = globalPixel(bounds.west, bounds.north, zoom), se = globalPixel(bounds.east, bounds.south, zoom);
    const limit = 2 ** zoom - 1;
    // Include neighbour pixels needed by bilinear sampling on source edges.
    const x0 = clamp(Math.floor((nw.x - 1) / TILE), 0, limit), x1 = clamp(Math.floor((se.x + 1) / TILE), 0, limit);
    const y0 = clamp(Math.floor((nw.y - 1) / TILE), 0, limit), y1 = clamp(Math.floor((se.y + 1) / TILE), 0, limit);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 16) continue;
    const tiles = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ x, y, key: `${x}/${y}` });
    return { ...bounds, zoom, tiles, width: GRID_SIZE, height: GRID_SIZE, centerLon: eye.lon, centerLat: eye.lat, cellM: 2 * RADIUS_M / GRID_SIZE };
  }
  throw new Error('This camera exceeds the bounded terrain coverage');
}

/** Decode untouched image bytes, including negative and fractional heights. */
export function decodeTerrariumRgba({ width, height, data }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > TILE || height > TILE || data?.length !== width * height * 4) throw new Error('Invalid Terrarium image dimensions');
  const heightsM = new Float32Array(width * height);
  for (let i = 0; i < heightsM.length; i++) {
    const p = i * 4;
    heightsM[i] = data[p + 3] === 0 ? NaN : data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
  }
  return { width, height, heightsM };
}

/** Cell-centred, north-up resampling; no filling or extrapolating missing DEM. */
export function resampleTerrain(plan, tiles) {
  const heightsM = new Float32Array(plan.width * plan.height);
  function pixel(x, y) {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE), tile = tiles.get(`${tx}/${ty}`);
    if (!tile) return NaN;
    return tile.heightsM[(y - ty * TILE) * tile.width + x - tx * TILE];
  }
  for (let row = 0; row < plan.height; row++) {
    const lat = plan.north - (row + 0.5) / plan.height * (plan.north - plan.south);
    for (let col = 0; col < plan.width; col++) {
      const lon = plan.west + (col + 0.5) / plan.width * (plan.east - plan.west);
      const { x, y } = globalPixel(lon, lat, plan.zoom);
      const x0 = Math.floor(x - 0.5), y0 = Math.floor(y - 0.5), ax = x - 0.5 - x0, ay = y - 0.5 - y0;
      let value = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const weight = (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay);
        if (weight) value += pixel(x0 + dx, y0 + dy) * weight;
      }
      heightsM[row * plan.width + col] = value;
    }
  }
  const { tiles: requestedTiles, ...bounds } = plan;
  return { ...bounds, heightsM, tileCount: requestedTiles?.length || tiles.size, source: 'AWS Terrain Tiles / Terrarium; coarse real elevation' };
}

/** Decode a bounded bundled real DEM. Integer metres are a storage precision
 * choice; no-data remains NaN throughout camera sampling and rendering. */
export async function decodeTerrainRecord(record) {
  const { width, height, west, south, east, north } = record || {};
  if (record?.schema !== 'midio.studio-terrain' || record.version !== 1 || record.encoding !== 'gzip-int16-le'
    || !Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 256 || height > 256
    || ![west, south, east, north].every(Number.isFinite) || !(west < east && south < north)
    || west < -180 || east > 180 || south < -85 || north > 85
    || typeof record.data !== 'string' || record.data.length > 512 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.data)) {
    throw new Error('Invalid bundled terrain grid');
  }
  if (typeof DecompressionStream !== 'function') throw new Error('This browser needs gzip decompression support for live terrain');
  const binary = atob(record.data), compressed = Uint8Array.from(binary, char => char.charCodeAt(0));
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const bytes = new Uint8Array(width * height * 2);
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > bytes.byteLength) throw new Error('Bundled terrain exceeds its declared grid size');
      bytes.set(value, offset); offset += value.byteLength;
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  if (offset !== bytes.byteLength) throw new Error('Bundled terrain is truncated');
  const heightsM = new Float32Array(width * height), view = new DataView(bytes.buffer);
  for (let i = 0; i < heightsM.length; i++) {
    const value = view.getInt16(i * 2, true);
    heightsM[i] = value === (record.noDataValue ?? -32768) ? NaN : value;
  }
  const metadata = { ...record };
  delete metadata.data; delete metadata.encoding;
  return { ...metadata, heightsM, centerLon: (west + east) / 2, centerLat: (south + north) / 2,
    tileCount: record.tileHashes?.length || 0, bundled: true };
}

async function bundledRecord(candidate, signal) {
  if (!terrainIndex) {
    const response = await fetch(INDEX_URL, { signal });
    if (!response.ok) throw new Error(`Bundled real terrain is unavailable (HTTP ${response.status})`);
    const raw = await response.text();
    if (raw.length > 2 * 1024 * 1024) throw new Error('Bundled terrain index exceeds its size budget');
    const index = JSON.parse(raw);
    if (index.schema !== 'midio.studio-terrain-index' || index.version !== 1 || !index.candidates
      || typeof index.candidates !== 'object' || Array.isArray(index.candidates) || Object.keys(index.candidates).length > 10000) throw new Error('Invalid bundled terrain index');
    checkAbort(signal);
    terrainIndex = index;
  }
  const record = terrainIndex.candidates[candidate?.id];
  if (!record) throw new Error('This view has no bundled terrain camera; choose a related authored view');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(record.url || '') || !/^[a-f0-9]{64}$/.test(record.sha256 || '')) {
    throw new Error('Invalid bundled terrain asset reference');
  }
  return record;
}

async function fetchBundledGrid(record, signal) {
  const response = await fetch(new URL(record.url, INDEX_URL), { signal });
  if (!response.ok) throw new Error(`Bundled real terrain grid is unavailable (HTTP ${response.status})`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 768 * 1024) throw new Error('Bundled terrain grid exceeds its download budget');
  if (!globalThis.crypto?.subtle) throw new Error('Live terrain needs a secure browser context to verify its elevation source');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  const hex = [...hash].map(value => value.toString(16).padStart(2, '0')).join('');
  if (hex !== record.sha256) throw new Error('Bundled terrain integrity check failed');
  checkAbort(signal);
  return decodeTerrainRecord(JSON.parse(new TextDecoder().decode(buffer)));
}

async function decodeTile(blob, signal) {
  if (typeof createImageBitmap !== 'function') throw new Error('Live terrain needs browser image decoding support');
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
  try {
    checkAbort(signal);
    if (bitmap.width !== TILE || bitmap.height !== TILE) throw new Error('Terrain server returned an unexpected tile size');
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(TILE, TILE) : document.createElement('canvas');
    canvas.width = TILE; canvas.height = TILE;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Live terrain needs a 2D canvas');
    context.drawImage(bitmap, 0, 0);
    return decodeTerrariumRgba(context.getImageData(0, 0, TILE, TILE));
  } finally { bitmap.close(); }
}

async function fetchGrid(plan, signal) {
  const tiles = new Map();
  let index = 0;
  // Four in flight, sixteen source images at most; decoded tiles are released
  // after the bounded grid is assembled. Only two completed grids are cached.
  async function next() {
    while (index < plan.tiles.length) {
      checkAbort(signal);
      const tile = plan.tiles[index++];
      let response;
      try { response = await fetch(`${TERRARIUM_URL}/${plan.zoom}/${tile.x}/${tile.y}.png`, { signal, mode: 'cors', credentials: 'omit' }); }
      catch (error) {
        checkAbort(signal);
        throw new Error(`Real terrain could not load. Check the connection and access to AWS Terrain Tiles. ${error.message}`, { cause: error });
      }
      if (!response.ok) throw new Error(`Real terrain tile unavailable (HTTP ${response.status})`);
      if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new Error('Terrain tile exceeds the download budget');
      const blob = await response.blob();
      if (blob.size > 2 * 1024 * 1024) throw new Error('Terrain tile exceeds the download budget');
      tiles.set(tile.key, await decodeTile(blob, signal));
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, plan.tiles.length) }, next));
  checkAbort(signal);
  return resampleTerrain(plan, tiles);
}

const MATERIAL_IDS = new Set(['wet-conifer', 'dry-conifer', 'icefield', 'tundra', 'taiga', 'pine-oak', 'broadleaf', 'chaparral', 'steppe', 'canyon', 'desert']);
const materialCache = new Map();
async function candidateStyle(candidate, settings, signal) {
  const id = candidate.provenance?.style?.materialId || 'dry-conifer';
  if (!MATERIAL_IDS.has(id)) throw new Error('Unknown Landscape material for this view');
  let material = materialCache.get(id);
  if (!material) {
    const response = await fetch(new URL(`../assets/range/v2/materials/${id}.json`, import.meta.url), { signal });
    if (!response.ok) throw new Error(`Landscape material unavailable (HTTP ${response.status})`);
    material = await response.json();
    checkAbort(signal);
    materialCache.set(id, material);
  }
  return createScoutStyle(material, { biome: candidate.provenance?.style?.styleBiome || candidate.biome || 'CONIFER', cameraHeadingDeg: settings.headingDeg, materialRules: candidate.provenance?.style?.rules || {} });
}

/** One live canvas, one render in flight, two retained terrain grids. Loading
 * begins only in select/useGrid. A failed request never substitutes terrain. */
export class TerrainPreview {
  constructor({ canvas, onStatus = () => {}, onAnalysis = () => {} }) {
    this.canvas = canvas;
    this.context = canvas?.getContext('2d', { alpha: false });
    if (!this.context) throw new Error('Live terrain preview requires a 2D canvas');
    canvas.width = 320; canvas.height = 180;
    this.onStatus = onStatus; this.onAnalysis = onAnalysis;
    this.ready = false; this._grid = null; this._style = null; this._settings = null;
    this._mode = 'landscape'; this._progress = 0; this._epoch = 0; this._request = 0; this._minimumRequest = 0;
    this._cache = new Map(); this._waiters = []; this._dirty = false; this._busy = false;
    this._disposed = false; this._frame = null; this._worker = null; this._controller = null;
    this._candidate = null; this._recenterTimer = null;
    if (typeof Worker === 'function') {
      try {
        this._worker = new Worker(new URL('./preview-worker.js', import.meta.url), { type: 'module', name: 'terrain-preview' });
        this._worker.onmessage = event => this._result(event.data);
        this._worker.onerror = () => { this._worker?.terminate(); this._worker = null; this._busy = false; this._schedule(); };
      } catch { this._worker = null; }
    }
  }

  get grid() { return this._grid; }

  async select(candidate) { return this._load(candidate, defaultCamera(candidate)); }
  async useGrid(candidate, grid) { return this._load(candidate, defaultCamera(candidate), grid); }

  async _load(candidate, settings, suppliedGrid = null, external = false) {
    if (this._disposed) throw new Error('Terrain preview is closed');
    clearTimeout(this._recenterTimer);
    this._recenterTimer = null;
    const epoch = ++this._epoch;
    this._controller?.abort();
    this._rejectWaiters(abortError());
    const controller = new AbortController();
    this._controller = controller;
    const { signal } = controller;
    this._candidate = candidate; this._settings = settings; this._grid = null; this.ready = false;
    this.onStatus(suppliedGrid ? 'Preparing live terrain…' : 'Loading real terrain…');
    try {
      let grid = suppliedGrid;
      const stylePromise = candidateStyle(candidate, settings, signal);
      // Attach a rejection handler immediately while the real tiles load.
      const styleResult = stylePromise.then(value => ({ value }), error => ({ error }));
      if (!grid) {
        const record = external ? null : await bundledRecord(candidate, signal);
        const plan = external ? terrainPlan({ camera: { eye: { lon: settings.lon, lat: settings.lat } } }) : null;
        const key = record ? `bundled:${record.sha256}` : `${plan.centerLon.toFixed(5)}/${plan.centerLat.toFixed(5)}/${plan.zoom}`;
        grid = this._cache.get(key);
        if (grid) this._cache.delete(key);
        else grid = record ? await fetchBundledGrid(record, signal) : await fetchGrid(plan, signal);
        checkAbort(signal);
        this._cache.set(key, grid);
        while (this._cache.size > 2) this._cache.delete(this._cache.keys().next().value);
      }
      const styled = await styleResult;
      if (styled.error) throw styled.error;
      checkAbort(signal);
      if (epoch !== this._epoch) throw abortError();
      this._grid = grid; this._style = styled.value;
      this._worker?.postMessage({ type: 'grid', grid, epoch });
      const painted = new Promise((resolve, reject) => this._waiters.push({ epoch, resolve, reject }));
      this._schedule();
      await painted;
      return grid;
    } catch (error) {
      controller.abort();
      if (epoch === this._epoch && !this._disposed && error.name !== 'AbortError') {
        this.ready = false;
        this.onStatus(error.message || 'Real terrain could not load');
      }
      throw error;
    }
  }

  setCamera(settings) {
    if (this._disposed) return;
    this._settings = { ...settings };
    clearTimeout(this._recenterTimer);
    if (this._grid && this._candidate) {
      if (settings.lon < this._grid.west || settings.lon > this._grid.east || settings.lat < this._grid.south || settings.lat > this._grid.north) {
        this._recenterTimer = setTimeout(() => {
          this._load(this._candidate, this._settings, null, true).catch(() => {});
        }, 200);
      }
    }
    this._schedule();
  }

  setMode(mode = 'landscape') { this._mode = mode === 'shape' ? 'shape' : 'landscape'; this._schedule(); }
  setProgress(progress01) { this._progress = Number.isFinite(progress01) ? clamp(progress01, 0, 1) : 0; this._schedule(); }

  /** Paint the exact current camera before deterministic capture reads pixels.
   * Any older in-flight worker result is discarded; interactive work resumes. */
  renderExact(progress01 = this._progress) {
    if (this._disposed || !this._grid || !this._settings) return false;
    this._progress = Number.isFinite(progress01) ? clamp(progress01, 0, 1) : 0;
    if (this._frame !== null) { cancelAnimationFrame(this._frame); this._frame = null; }
    this._dirty = false;
    const id = ++this._request, epoch = this._epoch;
    this._minimumRequest = id;
    try {
      const start = performance.now(), camera = cameraAt(this._settings, this._progress, this._grid);
      const result = renderScoutPreview(this._grid, camera, { width: this.canvas.width, height: this.canvas.height,
        maxDistanceM: MAX_DISTANCE_M, style: this._mode === 'landscape' ? this._style : null });
      this._paint({ epoch, id, result, renderMs: performance.now() - start });
      return this.ready;
    } catch (error) { this.ready = false; this.onStatus(error.message); return false; }
  }

  _schedule() {
    this._dirty = true;
    if (this._disposed || !this._grid || this._busy || this._frame !== null) return;
    this._frame = requestAnimationFrame(() => { this._frame = null; this._render(); });
  }

  _render() {
    if (!this._grid || this._disposed || this._busy) return;
    this._dirty = false; this._busy = true;
    const epoch = this._epoch, id = ++this._request;
    try {
      const camera = cameraAt(this._settings, this._progress, this._grid);
      const style = this._mode === 'landscape' ? this._style : null;
      const options = { width: this.canvas.width, height: this.canvas.height, maxDistanceM: MAX_DISTANCE_M, style };
      if (this._worker) this._worker.postMessage({ type: 'render', epoch, id, camera, options });
      else {
        const start = performance.now();
        const result = renderScoutPreview(this._grid, camera, options);
        this._result({ epoch, id, result, renderMs: performance.now() - start });
      }
    } catch (error) { this._result({ epoch, id, error: error.message }); }
  }

  _result(message) {
    if (this._disposed) return;
    this._busy = false;
    if (message.epoch === this._epoch && message.id >= this._minimumRequest) this._paint(message);
    if (this._dirty) this._schedule();
  }

  _paint(message) {
    if (message.epoch === this._epoch) {
      if (message.error) {
        this.ready = false; this.onStatus(message.error);
        this._rejectWaiters(new Error(message.error));
      } else {
        try {
          const { result } = message;
          this.context.putImageData(new ImageData(new Uint8ClampedArray(result.rgba), result.width, result.height), 0, 0);
          this.ready = true;
          const ground = sampleScoutHeight(this._grid, this._settings.lon, this._settings.lat);
          this.onAnalysis({ ...result, rgba: undefined, skylineY: undefined, renderMs: message.renderMs, zoom: this._grid.zoom,
            tileCount: this._grid.tileCount, cellM: this._grid.cellM, groundM: ground, source: this._grid.source });
          this.onStatus('Live terrain ready');
          for (const waiter of this._waiters.splice(0)) waiter.resolve(this._grid);
        } catch (error) { this.ready = false; this.onStatus(error.message); this._rejectWaiters(error); }
      }
    }
  }

  _rejectWaiters(error) { for (const waiter of this._waiters.splice(0)) waiter.reject(error); }

  dispose() {
    if (this._disposed) return;
    this._disposed = true; this.ready = false; ++this._epoch;
    this._controller?.abort(); this._worker?.terminate(); this._worker = null;
    if (this._frame !== null) cancelAnimationFrame(this._frame);
    clearTimeout(this._recenterTimer);
    this._rejectWaiters(abortError()); this._cache.clear(); this._grid = null;
  }
}
