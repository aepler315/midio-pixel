// Cheap geographic scouting. Existing examples guide comparison; no scenic
// score is an admission rule. This module never changes the runtime catalog.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { TERRARIUM_URL, decodePng, resampleGrid, tilesForBbox } from './terrarium.mjs';
import { biomeOfRange } from '../../src/world/RealBiomes.js';

const DEG = Math.PI / 180;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const biomeMap = { ice: 'ICEFIELD', 'pine-oak': 'PINE_OAK' };
const biome = value => biomeMap[value] || String(value || 'UNKNOWN').toUpperCase();
const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const rounded = value => Math.round(value * 1e6) / 1e6;
const distanceM = (a, b) => Math.hypot((a.lon - b.lon) * 111320 * Math.cos((a.lat + b.lat) / 2 * DEG), (a.lat - b.lat) * 110540);
const bearing = (a, b) => (Math.atan2((b.lon - a.lon) * Math.cos((a.lat + b.lat) / 2 * DEG), b.lat - a.lat) / DEG + 360) % 360;
const midAnchor = (a, b = a) => {
  const out = { lon: rounded((a.lonLat[0] + b.lonLat[0]) / 2), lat: rounded((a.lonLat[1] + b.lonLat[1]) / 2) };
  if (Number.isFinite(a.heightM) && Number.isFinite(b.heightM)) out.heightM = (a.heightM + b.heightM) / 2;
  else out.aboveGroundM = ((a.aboveGroundM || 0) + (b.aboveGroundM || 0)) / 2;
  return out;
};

/** All authored examples, every saved camera, and four intentionally loose
 * orbit positions for every range. Stable interleaving avoids a long run of
 * near-identical views. Historical rejected records remain discoverable. */
export function enumerateDiscoveryCandidates(authored, viewpoints) {
  const references = authored.views.map(view => {
    const cameraSource = view.rail ? view : authored.views.find(v => v.id === view.terrainSourceId);
    if (!cameraSource?.rail) return {
      id: `reference-${slug(view.id)}`, kind: view.status === 'approved' || view.experimental === true ? 'reference' : 'explore', name: view.title || view.id,
      region: view.place || view.regionId || '', landmark: (view.landmarks || []).map(point => point.name).filter(Boolean).join(', '), biome: biome(view.biome), sourceViewId: view.id, camera: null,
      provenance: { source: 'data/terrain/scenic-views.json', sourceStatus: view.status, sourceExperimental: view.experimental === true,
        warning: 'This authored tour has no single reference camera. Review its related authored rail separately.' },
    };
    const r = cameraSource.rail, eye = midAnchor(r.eyeStart, r.eyeEnd), target = midAnchor(r.targetStart, r.targetEnd);
    return {
      id: `reference-${slug(view.id)}`, kind: view.status === 'approved' || view.experimental === true ? 'reference' : 'explore', name: view.title || view.id,
      region: view.place || view.regionId || '', landmark: (view.landmarks || []).map(point => point.name).filter(Boolean).join(', '), biome: biome(view.biome), sourceViewId: view.id,
      camera: { eye, target, headingDeg: rounded(bearing(eye, target)), pitchDeg: 0,
        hfovDeg: rounded(2 * Math.atan(Math.tan((r.fovYDeg || 35) * DEG / 2) * 16 / 9) / DEG) },
      provenance: { source: 'data/terrain/scenic-views.json', sourceStatus: view.status, sourceExperimental: view.experimental === true,
        cameraSourceViewId: cameraSource.id, cameraPosition: 'authored rail midpoint',
        ...(cameraSource !== view ? { warning: 'This tour has no single camera; its related Jackson Lake rail is shown as a comparison proxy.' } : {}) },
    };
  });
  const groups = [...viewpoints.ranges].sort((a, b) => a.id.localeCompare(b.id)).map(range => {
    const common = { region: range.region || '', landmark: range.landmark || range.summit?.name || '', biome: biome(range.biome), sourceRangeId: range.id };
    const existing = range.views.map((v, i) => ({
      ...common, id: `computed-${slug(range.id)}-${i + 1}`, kind: 'computed', name: `${range.name} · saved view ${i + 1}`,
      camera: { eye: { lon: v.eye.lon, lat: v.eye.lat, aboveGroundM: v.eye.agl }, headingDeg: v.heading, pitchDeg: v.pitch, hfovDeg: v.hfov },
      provenance: { source: 'ridgeview/data/viewpoints.json', originalDemZoom: range.demZoom ?? null,
        originalScore: v.score, originalEyeHeightM: v.eye.h, originalCamera: { eye: v.eye, heading: v.heading, pitch: v.pitch, hfov: v.hfov }, altitudePolicy: 'saved above-ground height on coarse terrain', warning: 'Saved above-ground height is reapplied to the coarse terrain; original camera height is retained in provenance.', status: 'unreviewed candidate',
        ...(range.rejected ? { historicalRejection: range.rejected } : {}) },
    }));
    const center = { lon: range.crest?.lon ?? range.summit.lon, lat: range.crest?.lat ?? range.summit.lat };
    const headings = [45, 135, 225, 315], radii = [8000, 12000, 16000, 20000], agls = [120, 220, 320, 400];
    const compass = ['northeast', 'southeast', 'southwest', 'northwest'];
    const loose = headings.map((az, i) => {
      const eye = { lon: rounded(center.lon + Math.sin(az * DEG) * radii[i] / (111320 * Math.cos(center.lat * DEG))),
        lat: rounded(center.lat + Math.cos(az * DEG) * radii[i] / 110540), aboveGroundM: agls[i] };
      return { ...common, id: `explore-${slug(range.id)}-${compass[i]}`, kind: 'explore', name: `${range.name} · from ${compass[i]}`,
        camera: { eye, headingDeg: rounded(bearing(eye, center)), pitchDeg: 3, hfovDeg: 68 },
        provenance: { source: 'ridgeview/data/viewpoints.json', method: 'four fixed orbit positions around the saved geographic crest',
          radiusM: radii[i], status: 'unreviewed candidate', scenicRejection: false },
      };
    });
    for (const candidate of [...existing, ...loose]) {
      const availableReferences = references.filter(r => r.camera && r.kind === 'reference');
      const comparisonBiome = biomeOfRange(candidate.sourceRangeId) || candidate.biome;
      const same = availableReferences.filter(r => r.biome === comparisonBiome);
      const pool = same.length ? same : availableReferences;
      const nearest = [...pool].sort((a, b) => distanceM(a.camera.eye, candidate.camera.eye) - distanceM(b.camera.eye, candidate.camera.eye))[0];
      if (nearest) candidate.referenceId = nearest.id;
    }
    return [...existing, ...loose];
  });
  const interleaved = [];
  for (let i = 0; i < Math.max(0, ...groups.map(g => g.length)); i++) for (const group of groups) if (group[i]) interleaved.push(group[i]);
  return [...references, ...interleaved];
}

export function candidateBounds(candidates, paddingM = 36000) {
  if (!candidates.length || !(paddingM > 0)) throw new Error('candidate bounds require candidates and positive padding');
  if (candidates.some(c => !c.camera)) throw new Error(candidates.find(c => !c.camera).provenance?.warning || 'No single reference camera');
  const eyes = candidates.map(c => c.camera.eye);
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const eye of eyes) {
    if (![eye.lon, eye.lat].every(Number.isFinite) || Math.abs(eye.lat) > 84) throw new Error('candidate outside supported latitude');
    const dx = paddingM / (111320 * Math.cos(eye.lat * DEG)), dy = paddingM / 110540;
    west = Math.min(west, eye.lon - dx); east = Math.max(east, eye.lon + dx);
    south = Math.min(south, eye.lat - dy); north = Math.max(north, eye.lat + dy);
  }
  if (west < -180 || east > 180) throw new Error('candidate bounds cross the antimeridian');
  return { west, south: Math.max(-85, south), east, north: Math.min(85, north) };
}

function groundAt(grid, point) {
  const x = (point.lon - grid.west) / (grid.east - grid.west) * grid.width - .5;
  const y = (grid.north - point.lat) / (grid.north - grid.south) * grid.height - .5;
  if (x < -.5 || y < -.5 || x > grid.width - .5 || y > grid.height - .5) return NaN;
  const cx = Math.max(0, Math.min(grid.width - 1, x)), cy = Math.max(0, Math.min(grid.height - 1, y));
  const ix = Math.min(grid.width - 2, Math.floor(cx)), iy = Math.min(grid.height - 2, Math.floor(cy));
  const fx = cx - ix, fy = cy - iy, i = iy * grid.width + ix, h = grid.heightsM;
  return (h[i] * (1 - fx) + h[i + 1] * fx) * (1 - fy) + (h[i + grid.width] * (1 - fx) + h[i + grid.width + 1] * fx) * fy;
}

export function resolveReferenceCamera(camera, grid) {
  if (!camera.target) return camera;
  const elevation = point => Number.isFinite(point.heightM) ? point.heightM : groundAt(grid, point) + (point.aboveGroundM || 0);
  const eyeHeight = elevation(camera.eye), targetHeight = elevation(camera.target);
  if (![eyeHeight, targetHeight].every(Number.isFinite)) throw new Error('Reference camera or target has no terrain coverage');
  return { ...camera, eye: { ...camera.eye, heightM: eyeHeight }, pitchDeg: rounded(Math.atan2(targetHeight - eyeHeight, distanceM(camera.eye, camera.target)) / DEG) };
}

export function candidateSignature(candidate, previewBytes, sourceIdentity) {
  return sha(JSON.stringify({ version: 1, camera: candidate.camera, provenance: candidate.provenance, sourceIdentity, previewSha256: sha(previewBytes) }));
}

export function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096 || rgba.length !== width * height * 4) throw new Error('Invalid PNG size');
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]), out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length); body.copy(out, 4);
    let crc = 0xffffffff; for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = width * 4 + 1, raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * stride + 1);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** One global request semaphore plus shared in-flight tiles. Each cache hit is
 * decoded/validated before reuse. Errors never become invented elevations. */
const MAX_TILE_BYTES = 2 * 1024 * 1024;

function validateTile(bytes) {
  if (bytes.length > MAX_TILE_BYTES || bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13
    || bytes.readUInt32BE(16) !== 256 || bytes.readUInt32BE(20) !== 256
    || bytes[24] !== 8 || ![2,6].includes(bytes[25]) || bytes[28] !== 0) throw new Error('Terrain tile must be a bounded 256 × 256 RGB PNG');
  const compressed = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('Truncated terrain PNG');
    const length = bytes.readUInt32BE(offset);
    if (offset + length + 12 > bytes.length) throw new Error('Truncated terrain PNG');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR' && offset !== 8) throw new Error('Duplicate terrain PNG header');
    if (type === 'IDAT') compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
    if (type === 'IEND') break;
  }
  // Check decompressed size before the shared decoder allocates its buffer.
  const expected = 256 * (256 * (bytes[25] === 6 ? 4 : 3) + 1);
  const raw = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  if (raw.length !== expected) throw new Error('Invalid terrain PNG decoded length');
  return { image: decodePng(bytes), hash: sha(bytes) };
}

async function responseBytes(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (declared > MAX_TILE_BYTES) throw new Error('Terrain tile download exceeds 2 MiB');
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_TILE_BYTES) throw new Error('Terrain tile download exceeds 2 MiB');
    return bytes;
  }
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > MAX_TILE_BYTES) throw new Error('Terrain tile download exceeds 2 MiB');
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

export function createTileLoader({ cacheDir, concurrency = 12, fetchImpl = fetch } = {}) {
  if (!cacheDir || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Invalid tile loader configuration');
  const pending = new Map(), waiting = [], decoded = new Map();
  let active = 0;
  const stats = { requests: 0, downloadedBytes: 0, diskHits: 0, memoryHits: 0, sharedRequests: 0 };
  const acquire = async () => { if (active >= concurrency) await new Promise(resolve => waiting.push(resolve)); else active++; };
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };

  const tile = async function tile(zoom, x, y) {
    if (![zoom, x, y].every(Number.isInteger) || zoom < 0 || zoom > 15 || x < 0 || y < 0 || x >= 2 ** zoom || y >= 2 ** zoom) throw new Error('Invalid tile coordinate');
    const key = `${zoom}/${x}/${y}`, file = path.join(cacheDir, `${zoom}-${x}-${y}.png`);
    if (decoded.has(key)) { stats.memoryHits++; return decoded.get(key); }
    if (pending.has(key)) { stats.sharedRequests++; return pending.get(key); }
    const job = (async () => {
      let result;
      try { if ((await fs.stat(file)).size > MAX_TILE_BYTES) throw new Error('oversized cache'); result = validateTile(await fs.readFile(file)); stats.diskHits++; } catch { /* missing or corrupt cache: fetch again */ }
      if (!result) {
        await acquire();
        try {
          stats.requests++;
          const response = await fetchImpl(`${TERRARIUM_URL}/${key}.png`, { signal: AbortSignal.timeout(30000) });
          if (!response.ok) throw new Error(`Terrain tile ${key}: HTTP ${response.status}`);
          const bytes = await responseBytes(response); stats.downloadedBytes += bytes.length; result = validateTile(bytes);
          await fs.mkdir(cacheDir, { recursive: true });
          const temp = `${file}.tmp-${process.pid}`;
          await fs.writeFile(temp, bytes); await fs.rename(temp, file);
        } finally { release(); }
      }
      decoded.set(key, result); if (decoded.size > 128) decoded.delete(decoded.keys().next().value);
      return result;
    })();
    pending.set(key, job);
    try { return await job; } finally { pending.delete(key); }
  };
  tile.stats = stats;
  return tile;
}

export async function loadDiscoveryGrid(candidates, { tileLoader, zoom = 9, cellM = 250, maxTiles = 64, paddingM = 36000 } = {}) {
  if (!tileLoader || !Number.isInteger(maxTiles) || maxTiles < 1) throw new Error('Invalid discovery grid configuration');
  const bbox = candidateBounds(candidates, paddingM);
  let t = tilesForBbox(bbox, zoom), count = (t.x1 - t.x0 + 1) * (t.y1 - t.y0 + 1), warning;
  if (count > maxTiles && zoom > 8) {
    zoom = 8; t = tilesForBbox(bbox, zoom); count = (t.x1 - t.x0 + 1) * (t.y1 - t.y0 + 1);
    warning = 'This high-latitude region uses z8 terrain to keep its preview within the fixed tile budget.';
  }
  if (count > maxTiles) throw new Error(`Preview requires ${count} tiles; region cap is ${maxTiles}`);
  const keys = [];
  for (let y = t.y0; y <= t.y1; y++) for (let x = t.x0; x <= t.x1; x++) keys.push([x, y]);
  const settled = await Promise.allSettled(keys.map(([x, y]) => tileLoader(zoom, x, y)));
  const failed = settled.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  const loaded = settled.map(result => result.value);
  const tiles = new Map(keys.map(([x, y], i) => [`${x}/${y}`, loaded[i].image]));
  const grid = resampleGrid(bbox, zoom, tiles, cellM);
  return { ...bbox, width: grid.width, height: grid.height, heightsM: grid.elev, cellM, zoom, ...(warning ? { warning } : {}),
    source: `Mapzen / AWS Terrain Tiles, Terrarium z${zoom}; mixed USGS 3DEP/SRTM/GMTED/ETOPO sources`,
    tileHashes: keys.map(([x, y], i) => ({ tile: `${zoom}/${x}/${y}`, sha256: loaded[i].hash })),
  };
}

// Match the production pack assignment without loading material textures or a
// renderer. Glacial routes share the icefield appearance; unknown new biomes
// get an explicitly recorded conifer fallback until given their own pack.
export const SCOUT_MATERIAL_PACKS = Object.freeze({
  RAINFOREST: 'wet-conifer', CONIFER: 'dry-conifer', TAIGA: 'taiga', ICEFIELD: 'icefield', TUNDRA: 'tundra',
  PINE_OAK: 'pine-oak', BROADLEAF: 'broadleaf', CHAPARRAL: 'chaparral', STEPPE: 'steppe', CANYON: 'canyon', DESERT: 'desert',
  GLACIAL_FLOW: 'icefield',
});

export async function loadScoutMaterials({ root } = {}) {
  if (!root) throw new Error('Material library requires a source root');
  const entries = await Promise.all([...new Set(Object.values(SCOUT_MATERIAL_PACKS))].map(async id => {
    const source = `src/assets/range/v2/materials/${id}.json`, bytes = await fs.readFile(path.join(root, source));
    const material = JSON.parse(bytes);
    if (material.schema !== 'midio.material' || material.version !== 1 || material.id !== id || !material.palette || !material.rules)
      throw new Error(`Invalid production material manifest ${id}`);
    return [id, { material, sha256: sha(bytes), source }];
  }));
  return new Map(entries);
}

export function resolveScoutMaterial(candidate, { materials, authored = { views: [] } } = {}) {
  const view = authored.views.find(v => v.id === candidate.sourceViewId);
  const productionBiome = candidate.sourceRangeId ? biomeOfRange(candidate.sourceRangeId) : null;
  const selectedBiome = view?.biome ? biome(view.biome) : productionBiome || candidate.biome;
  const knownBiome = Object.hasOwn(SCOUT_MATERIAL_PACKS, selectedBiome);
  const styleBiome = selectedBiome === 'GLACIAL_FLOW' ? 'ICEFIELD' : knownBiome ? selectedBiome : 'CONIFER';
  const id = view?.materialPack || SCOUT_MATERIAL_PACKS[selectedBiome] || 'dry-conifer';
  const entry = materials?.get(id);
  if (!entry) throw new Error(`Production material ${id} is unavailable`);
  const materialRules = { ...(view?.materialRules || {}) };
  return {
    material: entry.material, materialRules,
    styleBiome,
    provenance: { materialId: id, materialSha256: entry.sha256, source: entry.source, preset: 'daylight',
      sourceBiome: candidate.biome, styleBiome,
      biomeSource: view?.biome ? 'data/terrain/scenic-views.json' : productionBiome ? 'src/world/RealBiomes.js biomeOfRange' : 'candidate biome',
      method: 'Current production palette and elevation/slope habitat rules on coarse real terrain; simplified preview exposure, lighting and atmosphere.',
      rules: materialRules,
      ...(knownBiome ? {} : { warning: `Unknown biome ${selectedBiome}; dry-conifer appearance fallback is used.` }),
    },
  };
}
