// Range v2 terrain package contract (schema midio.terrain v1), shared by the
// offline baker (tools/lib/terrain-bake.mjs) and the runtime loader. Pure:
// no DOM, no GPU. Everything a manifest declares is checked here before any
// buffer is read or any GPU object is constructed.
export const TERRAIN_SCHEMA = 'midio.terrain';
export const TERRAIN_VERSION = 1;
export const STRIDES = Object.freeze([1, 2, 4, 8, 16, 32, 64]);
export const WATER_FLOW = 255;

/** Inverse of the baker's planar-predictor residual encoding (mod 2^16). */
export function decodeResiduals(r, n) {
  const q = new Uint16Array(r.length);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const left = x ? q[i - 1] : (y ? q[i - n] : 0);
      const up = y ? q[i - n] : left;
      const ul = x && y ? q[i - n - 1] : (y ? q[i - n] : left);
      const pred = x && y ? Math.min(65535, Math.max(0, left + up - ul)) : (x ? left : up);
      q[i] = (r[i] + pred) & 0xffff;
    }
  }
  return q;
}

// ---------------------------------------------------------------------------
// Validation.

const TILE_KEYS = ['id', 'ix', 'iz', 'stride', 'samples', 'heights', 'flow', 'validity', 'minY', 'maxY'];

/** Validate a terrain manifest against the decoded payload length. Checks
 *  schema, required fields, finite numbers, strides, sample counts and that
 *  every declared byte range lies inside the payload. */
export function validateTerrainManifest(manifest, byteLengths = {}) {
  const errors = [];
  const fail = (m) => { errors.push(m); };
  if (!manifest || typeof manifest !== 'object') return { ok: false, errors: ['manifest missing'] };
  if (manifest.schema !== TERRAIN_SCHEMA) fail(`schema ${manifest.schema}`);
  if (manifest.version !== TERRAIN_VERSION) fail(`unsupported version ${manifest.version}`);
  const g = manifest.grid;
  if (!g || !Number.isInteger(g.width) || !Number.isInteger(g.height) || g.width < 2 || g.height < 2 || !(g.cellSizeM > 0)
    || !Array.isArray(g.originM) || g.originM.length !== 2 || !g.originM.every(Number.isFinite)) fail('grid');
  const cells = manifest.tileCells;
  if (!Number.isInteger(cells) || cells < 2 || (cells & (cells - 1))) fail('tileCells must be a power of two');
  const qz = manifest.quantization;
  if (!qz || !Number.isFinite(qz.offsetM) || !(qz.stepM > 0)) fail('quantization');
  const decodedLength = byteLengths.decoded ?? manifest.payload?.decodedByteLength;
  if (!Number.isInteger(decodedLength)) fail('payload length unknown');
  if (byteLengths.compressed !== undefined && byteLengths.compressed !== manifest.payload?.byteLength) fail('compressed length mismatch');
  if (byteLengths.decoded !== undefined && byteLengths.decoded !== manifest.payload?.decodedByteLength) fail('decoded length mismatch');
  if (!Array.isArray(manifest.tiles) || !manifest.tiles.length) fail('no tiles');
  if (errors.length) return { ok: false, errors };
  const seen = new Set();
  const inRange = (o, len) => Number.isInteger(o) && Number.isInteger(len) && o >= 0 && len >= 0 && o + len <= decodedLength;
  for (const t of manifest.tiles) {
    for (const k of TILE_KEYS) if (!(k in t)) { fail(`tile missing ${k}`); break; }
    if (errors.length) break;
    if (seen.has(t.id)) fail(`duplicate tile ${t.id}`);
    seen.add(t.id);
    if (!(Number.isInteger(t.ix) && Number.isInteger(t.iz) && t.ix >= 0 && t.iz >= 0 && t.ix < manifest.tilesX && t.iz < manifest.tilesZ)) fail(`tile ${t.id} index`);
    if (!STRIDES.includes(t.stride) || t.stride > cells) fail(`tile ${t.id} stride ${t.stride}`);
    if (t.samples !== cells / t.stride + 1) fail(`tile ${t.id} samples ${t.samples}`);
    const count = t.samples * t.samples;
    if (t.heights?.type !== 'uint16' || t.heights.count !== count || t.heights.byteLength !== count * 2
      || !inRange(t.heights.byteOffset, t.heights.byteLength)) fail(`tile ${t.id} heights range`);
    if (t.flow?.type !== 'uint8' || t.flow.count !== count || t.flow.byteLength !== count
      || !inRange(t.flow.byteOffset, t.flow.byteLength)) fail(`tile ${t.id} flow range`);
    if (t.validity?.mode === 'bits') {
      if (t.validity.byteLength !== Math.ceil(count / 8) || !inRange(t.validity.byteOffset, t.validity.byteLength)) fail(`tile ${t.id} validity range`);
    } else if (t.validity?.mode !== 'all') fail(`tile ${t.id} validity mode`);
    if (!Number.isFinite(t.minY) || !Number.isFinite(t.maxY) || t.minY > t.maxY) fail(`tile ${t.id} bounds`);
    if (!t.lod && !t.errorsM) fail(`tile ${t.id} needs lod or errorsM`);
    if (!t.lod && t.errorsM) {
      for (const s of STRIDES.filter(s => s >= t.stride && s <= cells)) {
        if (!Number.isFinite(t.errorsM[s]) || t.errorsM[s] < 0) fail(`tile ${t.id} error for stride ${s}`);
      }
      for (const s of Object.keys(t.errorsM)) {
        if (!STRIDES.includes(Number(s)) || Number(s) < t.stride || Number(s) > cells) fail(`tile ${t.id} error stride ${s}`);
      }
    }
    for (const s of Object.values(t.lod || {})) if (!STRIDES.includes(s) || s < t.stride || s > cells) fail(`tile ${t.id} lod ${s}`);
    if (errors.length > 20) break;
  }
  return { ok: !errors.length, errors };
}
