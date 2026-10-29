// Compiled terrain experiment (docs/compiled-terrain-experiment.md): the pack
// contract shared by the offline compiler (tools/lib/compiled-terrain.mjs)
// and the runtime, the opt-in URL request, the displayed-ground samplers and
// the TerrainData view the rest of a prepared scene reads (camera clearance,
// forest roots, the cast). Pure: no DOM, no GPU.
//
// A pack is one representation of one view's terrain:
//   'columns'  height columns: top faces and exposed side spans only
//   'mesh'     the triangulated control at the same spacing and colours
// Both carry per-chunk indexed meshes (Int16 positions, Int8 normals, Uint16
// material-atlas coordinates), one atlas of baked albedo + ambient occlusion
// (sRGB8 + AO8: a texel per column, or per control lattice vertex), and the
// ground the mesh displays.
import { BANDS } from './TerrainMesh.js';

export const COMPILED_SCHEMA = 'midio.compiled-terrain';
export const COMPILED_VERSION = 1;
export const COMPILED_REPRESENTATIONS = Object.freeze(['columns', 'mesh']);
/** Under the Range v2 asset base (assets/range/v2/). */
export const COMPILED_ASSET_DIR = 'compiled/';
/** Vertex Y is stored in decimetres above the chunk's base height. */
export const COMPILED_Y_UNIT_M = 0.1;
/** Atlas coordinates are stored in fixed point: texels times this. */
export const COMPILED_ATLAS_SCALE = 4;
/** Int16 sentinel for a column with no valid source sample under it. */
export const COMPILED_NO_DATA = -32768;

// The one scene this milestone compiles, and the declared extra camera of
// its multi-angle test: from the mesa 7.7 km south-west of the Mittens,
// looking back north-east at the buttes' far faces, which the shipped
// static-view package culled. Shared by the compiler (coverage) and the
// runtime (?compiledTerrainCamera=reverse), so both use the same rail.
export const COMPILED_PILOT = Object.freeze({
  viewId: 'monument-valley-163',
  cameras: Object.freeze({
    reverse: Object.freeze({
      eyeStartM: Object.freeze([-9000, 2054, 11500]), eyeEndM: Object.freeze([-9600, 2030, 11050]),
      targetStartM: Object.freeze([-4000, 1700, 5600]), targetEndM: Object.freeze([-4300, 1700, 5400]),
      fovYDeg: 16,
    }),
  }),
});

/** The developer request from the page URL:
 *  ?compiledTerrain=columns|mesh (absent/off/original: the existing renderer)
 *  ?compiledTerrainCamera=reverse (the pilot's declared test rail, any mode)
 *  ?compiledTerrainGroup=1|2|4|8 (draw batching, tiles per block side)
 *  ?compiledTerrainProfile=NAME (packs built with --profile NAME).
 *  An unknown value is reported, never guessed. */
export function compiledTerrainRequest(search = '') {
  const q = new URLSearchParams(search);
  const raw = q.get('compiledTerrain');
  const off = raw == null || raw === '' || raw === 'off' || raw === 'original';
  const mode = off ? 'original' : COMPILED_REPRESENTATIONS.includes(raw) ? raw : 'original';
  const camRaw = q.get('compiledTerrainCamera');
  const camera = camRaw && Object.hasOwn(COMPILED_PILOT.cameras, camRaw) ? camRaw : null;
  // Draw batching (tiles per side of a merged block); a measuring aid.
  const groupRaw = Number(q.get('compiledTerrainGroup'));
  const groupTiles = [1, 2, 4, 8].includes(groupRaw) ? groupRaw : null;
  const profileRaw = q.get('compiledTerrainProfile');
  const profile = profileRaw && PROFILE_NAME.test(profileRaw) ? profileRaw : null;
  return {
    mode, camera, groupTiles, profile,
    invalid: !off && mode === 'original' ? raw : null,
    invalidCamera: camRaw && !camera ? camRaw : null,
  };
}

/** Pack manifest path for a view, relative to the Range v2 asset base; a
 *  named profile (other compiler settings) lives in its own folder. */
export function compiledManifestPath(viewId, representation, profile = null) {
  return `${COMPILED_ASSET_DIR}${profile ? `${profile}/` : ''}${viewId}.${representation}.json`;
}
const PROFILE_NAME = /^[a-z0-9-]{1,32}$/;

/** Why a view cannot use a compiled pack (null when it can). Only the pilot
 *  is compiled; tours, glaciers and composition variants keep production. */
export function compiledViewUnsupported(view) {
  if (!view) return 'no view';
  if (view.id !== COMPILED_PILOT.viewId) return `view ${view.id} has no compiled pack`;
  if (view.tour || view.tourManifestUrl) return 'tour views stream terrain windows';
  if (view.glacier) return 'glacier views move their ice surface';
  if (view.terrainSourceId) return 'composition variants share another view';
  return null;
}

/** The pilot's camera with the declared test rail substituted (the view
 *  itself when no override applies). */
export function compiledCameraView(view, camera) {
  const rail = camera && view?.id === COMPILED_PILOT.viewId ? COMPILED_PILOT.cameras[camera] : null;
  return rail ? { ...view, camera: { ...rail } } : view;
}

// ---------------------------------------------------------------------------
// Validation.

const SECTIONS = Object.freeze({
  positions: { type: 'int16', per: 'vertex', items: 3 },
  normals: { type: 'int8', per: 'vertex', items: 4 },
  atlas: { type: 'uint16', per: 'vertex', items: 2 },
  samples: { type: 'int16', per: 'sample', items: 1 },
});
const BYTES = { int8: 1, uint8: 1, int16: 2, uint16: 2, uint32: 4 };

/** Validate a pack manifest against its decoded payload length: schema,
 *  version, identity fields, settings and every byte range. */
export function validateCompiledManifest(manifest, byteLengths = {}) {
  const errors = [];
  const fail = (m) => { errors.push(m); };
  if (!manifest || typeof manifest !== 'object') return { ok: false, errors: ['manifest missing'] };
  if (manifest.schema !== COMPILED_SCHEMA) fail(`schema ${manifest.schema}`);
  if (manifest.version !== COMPILED_VERSION) fail(`unsupported version ${manifest.version}`);
  if (!COMPILED_REPRESENTATIONS.includes(manifest.representation)) fail(`representation ${manifest.representation}`);
  if (typeof manifest.viewId !== 'string') fail('viewId');
  if (typeof manifest.compilerVersion !== 'string') fail('compilerVersion');
  const src = manifest.source;
  if (!src || typeof src.demSha256 !== 'string' || !src.grid || typeof src.verticalReference !== 'string'
    || typeof src.horizontalCrs !== 'string' || src.heightUnits !== 'metre') fail('source identity');
  const g = src?.grid;
  if (!g || !Number.isInteger(g.width) || !Number.isInteger(g.height) || !(g.cellSizeM > 0)
    || !Array.isArray(g.originM) || g.originM.length !== 2 || !g.originM.every(Number.isFinite)) fail('grid');
  const s = manifest.settings;
  if (!s || !Number.isInteger(s.chunkCells) || s.chunkCells < 2 || !Array.isArray(s.levels) || !s.levels.length) fail('settings');
  for (const l of s?.levels || []) {
    if (!Number.isInteger(l.cellSamples) || l.cellSamples < 1 || s.chunkCells % l.cellSamples || !(l.quantumM >= 0)) fail(`level ${l.level}`);
  }
  if (!Array.isArray(manifest.deform?.heightRangeM) || manifest.deform.heightRangeM.length !== 2) fail('deform height range');
  if (!manifest.material?.palette || !manifest.material?.rules) fail('material');
  const decoded = byteLengths.decoded ?? manifest.payload?.decodedByteLength;
  if (!Number.isInteger(decoded)) fail('payload length unknown');
  if (byteLengths.decoded !== undefined && byteLengths.decoded !== manifest.payload?.decodedByteLength) fail('decoded length mismatch');
  if (byteLengths.compressed !== undefined && byteLengths.compressed !== manifest.payload?.byteLength) fail('compressed length mismatch');
  if (!Array.isArray(manifest.chunks) || !manifest.chunks.length) fail('no chunks');
  if (errors.length) return { ok: false, errors };
  const inRange = (r, len) => r && Number.isInteger(r.byteOffset) && r.byteOffset >= 0 && r.byteOffset % 4 === 0
    && r.byteLength === len && r.byteOffset + len <= decoded;
  const seen = new Set();
  for (const c of manifest.chunks) {
    if (seen.has(c.id)) fail(`duplicate chunk ${c.id}`);
    seen.add(c.id);
    const level = s.levels.find(l => l.level === c.level);
    if (!level) { fail(`chunk ${c.id} level ${c.level}`); continue; }
    if (!BANDS.includes(c.band)) fail(`chunk ${c.id} band`);
    const n = s.chunkCells / level.cellSamples;
    const V = c.vertexCount, I = c.indexCount;
    if (!(Number.isInteger(V) && V >= 0 && Number.isInteger(I) && I >= 0 && I % 3 === 0)) { fail(`chunk ${c.id} counts`); continue; }
    if (c.indexType !== (V > 65535 ? 'uint32' : 'uint16')) fail(`chunk ${c.id} index type`);
    const counts = { vertex: V, sample: (n + 1) * (n + 1) };
    for (const [k, d] of Object.entries(SECTIONS)) {
      if (!inRange(c.sections?.[k], counts[d.per] * d.items * BYTES[d.type])) fail(`chunk ${c.id} ${k} range`);
    }
    if (!inRange(c.sections?.indices, I * BYTES[c.indexType])) fail(`chunk ${c.id} indices range`);
    if (manifest.representation === 'columns' && !inRange(c.sections?.columns, n * n * 2)) fail(`chunk ${c.id} columns range`);
    if (!Array.isArray(c.originM) || c.originM.length !== 2 || !Number.isFinite(c.yBaseM)) fail(`chunk ${c.id} origin`);
    if (!c.boundsM || !c.boundsM.min?.every(Number.isFinite) || !c.boundsM.max?.every(Number.isFinite)) fail(`chunk ${c.id} bounds`);
    if (errors.length > 20) break;
  }
  const a = manifest.atlas;
  if (!a || !Number.isInteger(a.width) || !Number.isInteger(a.height) || a.width < 1 || a.height < 1
    || !inRange(a.texels, a.width * a.height * 4)) fail('atlas');
  const r = manifest.receiver;
  if (!r || !Number.isInteger(r.count) || r.count < 0 || !inRange(r.indices, r.count * 4) || !inRange(r.values, Math.ceil(r.count / 4) * 4)) fail('receiver');
  return { ok: !errors.length, errors };
}

// ---------------------------------------------------------------------------
// Decoding.

const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function view(bytes, range, Type, count) {
  return new Type(bytes.buffer, bytes.byteOffset + range.byteOffset, count);
}

/** Typed views of every chunk of a validated pack (no copies: the decoded
 *  payload stays the backing store). Rejects malformed indices. */
export function decodeCompiledPack(manifest, bytes) {
  const check = validateCompiledManifest(manifest, { decoded: bytes.byteLength });
  if (!check.ok) throw new Error(`compiled manifest rejected: ${check.errors.slice(0, 4).join('; ')}`);
  if (!littleEndian) throw new Error('compiled packs are little-endian');
  if (bytes.byteOffset % 4) bytes = bytes.slice();
  const levels = new Map(manifest.settings.levels.map(l => [l.level, l]));
  const chunks = manifest.chunks.map((c) => {
    const level = levels.get(c.level);
    const n = manifest.settings.chunkCells / level.cellSamples;
    const V = c.vertexCount;
    const sec = c.sections;
    const indices = view(bytes, sec.indices, c.indexType === 'uint32' ? Uint32Array : Uint16Array, c.indexCount);
    for (let i = 0; i < indices.length; i++) if (indices[i] >= V) throw new Error(`chunk ${c.id} index ${indices[i]} >= ${V}`);
    return {
      ...c, n, cellM: level.cellSamples * manifest.source.grid.cellSizeM, levelInfo: level,
      positions: view(bytes, sec.positions, Int16Array, V * 3),
      normals: view(bytes, sec.normals, Int8Array, V * 4),
      atlasTile: c.atlas,
      atlas: view(bytes, sec.atlas, Uint16Array, V * 2),
      indices,
      samples: view(bytes, sec.samples, Int16Array, (n + 1) * (n + 1)),
      columns: sec.columns ? view(bytes, sec.columns, Int16Array, n * n) : null,
    };
  });
  const r = manifest.receiver, a = manifest.atlas;
  return {
    manifest, chunks, bytes,
    atlas: { width: a.width, height: a.height, texels: view(bytes, a.texels, Uint8Array, a.width * a.height * 4) },
    receiver: { width: manifest.source.grid.width, height: manifest.source.grid.height,
      indices: view(bytes, r.indices, Uint32Array, r.count), values: view(bytes, r.values, Uint8Array, r.count) },
  };
}

/** Full-grid R8 receiver mask (255 dry, smaller toward pinned water), as
 *  TerrainMesh.buildReceiverMask produces it for the production surface. */
export function compiledReceiverMask(pack) {
  const { width, height, indices, values } = pack.receiver;
  const data = new Uint8Array(width * height).fill(255);
  for (let k = 0; k < indices.length; k++) if (indices[k] < data.length) data[indices[k]] = values[k];
  return { width, height, data };
}

// ---------------------------------------------------------------------------
// Ground.

const metres = (chunk, dm) => chunk.yBaseM + dm * COMPILED_Y_UNIT_M;

/** Displayed column top at local (x, z): the column the point falls in, or
 *  NaN off the pack and over no-data. Column edges belong to the column on
 *  their positive side, except the pack's far edge. */
export function columnGroundAt(data, x, z) {
  const { grid, cells } = data;
  const gx = (x - grid.originM[0]) / grid.cellSizeM, gz = (z - grid.originM[1]) / grid.cellSizeM;
  if (!(gx >= 0 && gz >= 0)) return NaN;
  let ix = Math.floor(gx / cells), iz = Math.floor(gz / cells);
  let tile = data.byIndex.get(`${ix},${iz}`);
  if (!tile && gx === ix * cells) tile = data.byIndex.get(`${--ix},${iz}`);
  if (!tile && gz === iz * cells) tile = data.byIndex.get(`${ix},${--iz}`);
  const chunk = tile?.compiled;
  if (!chunk?.columns) return NaN;
  const n = chunk.n;
  const cu = Math.min(n - 1, Math.floor((gx - ix * cells) / tile.stride));
  const cv = Math.min(n - 1, Math.floor((gz - iz * cells) / tile.stride));
  const dm = chunk.columns[cv * n + cu];
  return dm === COMPILED_NO_DATA ? NaN : metres(chunk, dm);
}

/** A TerrainData (TerrainMesh.decodeTerrain shape) over the pack's chunks.
 *  Tile samples are the pack's own lattice heights (the control mesh's
 *  vertices, seam-snapped), so terrainHeightAt follows the drawn control
 *  exactly; for columns `groundAt` makes terrainHeightAt return the column
 *  tops instead. The packs carry no terrain water (flow 0). */
export function compiledTerrainData(pack) {
  const m = pack.manifest;
  const grid = m.source.grid, cells = m.settings.chunkCells;
  const tiles = new Map(), byIndex = new Map();
  let minY = Infinity, maxY = -Infinity;
  for (const c of pack.chunks) {
    const samples = c.n + 1, count = samples * samples;
    const heightsM = new Float32Array(count);
    for (let i = 0; i < count; i++) heightsM[i] = c.samples[i] === COMPILED_NO_DATA ? NaN : metres(c, c.samples[i]);
    let validMask = null;
    if (heightsM.some(Number.isNaN)) validMask = Uint8Array.from(heightsM, h => (Number.isNaN(h) ? 0 : 1));
    const tile = {
      id: c.id, ix: c.ix, iz: c.iz, stride: c.levelInfo.cellSamples, samples,
      heightsM, flowBytes: new Uint8Array(count), validMask,
      minY: c.boundsM.min[1], maxY: c.boundsM.max[1], visible: true, framing: 'compiled', band: c.band,
      lod: { desktop: c.levelInfo.cellSamples, mobile: c.levelInfo.cellSamples },
      // Copied out, so the decoded payload is not retained by the ground.
      compiled: { id: c.id, n: c.n, yBaseM: c.yBaseM, columns: c.columns ? c.columns.slice() : null },
    };
    minY = Math.min(minY, tile.minY); maxY = Math.max(maxY, tile.maxY);
    tiles.set(c.id, tile);
    byIndex.set(`${c.ix},${c.iz}`, tile);
  }
  const data = {
    manifest: {
      schema: m.schema, viewId: m.viewId, grid, tileCells: cells,
      tilesX: Math.ceil((grid.width - 1) / cells), tilesZ: Math.ceil((grid.height - 1) / cells),
      bands: m.bands, boundsM: { min: [m.coverage.boundsM.min[0], minY, m.coverage.boundsM.min[2]], max: [m.coverage.boundsM.max[0], maxY, m.coverage.boundsM.max[2]] },
      compiled: true,
    },
    tiles, byIndex, cells, grid, groundAt: null,
  };
  if (m.representation === 'columns') data.groundAt = (x, z) => columnGroundAt(data, x, z);
  return data;
}

/** Re-seat forest roots (placeForest's stride-8 records) on the displayed
 *  ground; roots with no ground under them are dropped. */
export function regroundForest(placed, groundAt) {
  if (!groundAt) return placed;
  const out = { ...placed };
  let count = 0;
  for (const key of ['meshDetail', 'mesh', 'billboard']) {
    const src = placed[key];
    const kept = [];
    for (let i = 0; i < src.length; i += placed.stride) {
      const y = groundAt(src[i], src[i + 2]);
      if (!Number.isFinite(y)) continue;
      for (let k = 0; k < placed.stride; k++) kept.push(k === 1 ? y : src[i + k]);
    }
    out[key] = Float32Array.from(kept);
    count += kept.length / placed.stride;
  }
  out.count = count;
  return out;
}

/** The chunks each band pass draws: its own, plus (seam fill, as
 *  TerrainMesh.planBands) nearer chunks touching a farther band. */
export function compiledBandPlan(pack) {
  const byIndex = new Map(pack.chunks.map(c => [`${c.ix},${c.iz}`, c]));
  const own = Object.fromEntries(BANDS.map(b => [b, []]));
  const fringe = Object.fromEntries(BANDS.map(b => [b, []]));
  for (const c of pack.chunks) {
    own[c.band].push(c);
    const at = BANDS.indexOf(c.band);
    let touches = false;
    for (let dz = -1; dz <= 1 && !touches; dz++) for (let dx = -1; dx <= 1; dx++) {
      const nb = (dx || dz) && byIndex.get(`${c.ix + dx},${c.iz + dz}`);
      if (nb && BANDS.indexOf(nb.band) < at) { touches = true; break; }
    }
    if (touches) fringe[c.band].push(c);
  }
  return { own, fringe };
}
