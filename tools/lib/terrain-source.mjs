// Node side of the Range v2 elevation contract (plan §7.1). The GDAL work is
// done by tools/terrain/normalize-dem.py; this module runs it with
// structured arguments and decodes its metadata + binary payload into the
// in-memory DemGrid shape the baker consumes. Nothing here runs at playback.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const NORMALIZER = path.join(root, 'tools', 'terrain', 'normalize-dem.py');
export const DEM_SCHEMA = 'midio.demgrid';
export const DEM_VERSION = 1;

/** The Python that has GDAL bindings: $MIDIO_GDAL_PYTHON, else the first
 *  candidate that can import osgeo. Null when none can. */
export async function findGdalPython(candidates = [
  process.env.MIDIO_GDAL_PYTHON, 'python3', '/usr/bin/python3.12', '/usr/bin/python3',
].filter(Boolean)) {
  for (const exe of candidates) {
    try {
      await run(exe, ['-c', 'from osgeo import gdal; import numpy'], { timeout: 20000 });
      return exe;
    } catch { /* try the next */ }
  }
  return null;
}

function curlEnv() {
  const env = { ...process.env };
  // GDAL's /vsicurl/ reads 3DEP COGs; route it through the same proxy/CA
  // the rest of the toolchain uses when one is configured.
  const proxy = env.HTTPS_PROXY || env.https_proxy;
  if (proxy && !env.GDAL_HTTP_PROXY) {
    const u = new URL(proxy);
    env.GDAL_HTTP_PROXY = `${u.hostname}:${u.port}`;
    if (u.username) env.GDAL_HTTP_PROXYUSERPWD = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
  }
  if (!env.CURL_CA_BUNDLE && env.SSL_CERT_FILE) env.CURL_CA_BUNDLE = env.SSL_CERT_FILE;
  return env;
}

/**
 * Normalize elevation into `options.out` (a path prefix) and decode it.
 *   input    a raster path, or '3dep13' / 'terrarium' for a remote source
 *   options  { out, centerLonLat: [lon, lat], extentM: [w, h], cellM,
 *              offsetM?: [x, z], zoom?, resampling?, cache?, pin?, python? }
 */
export async function normalizeDem(input, options) {
  const { out, centerLonLat, extentM, cellM } = options || {};
  if (!out || !Array.isArray(centerLonLat) || !Array.isArray(extentM) || !(cellM > 0)) {
    throw new Error('normalizeDem needs out, centerLonLat, extentM and cellM');
  }
  const python = options.python || await findGdalPython();
  if (!python) throw new Error('no Python with GDAL bindings (set MIDIO_GDAL_PYTHON)');
  // `=` form: a negative longitude would otherwise parse as an option.
  const args = [NORMALIZER, '--out', out, `--center=${centerLonLat.join(',')}`,
    `--extent=${extentM.join(',')}`, '--cell', String(cellM)];
  if (options.offsetM) args.push(`--offset=${options.offsetM.join(',')}`);
  if (input === '3dep13' || input === 'terrarium') args.push('--source', input);
  else args.push('--input', ...[].concat(input));
  if (options.zoom) args.push('--zoom', String(options.zoom));
  if (options.resampling) args.push('--resampling', options.resampling);
  if (options.cache) args.push('--cache', options.cache);
  if (options.pin) args.push('--pin', options.pin);
  if (options.retrievedAt) args.push('--retrieved-at', options.retrievedAt);
  if (options.points) args.push('--points', JSON.stringify(options.points));
  if (options.fill) args.push('--fill', options.fill);
  if (options.fillZoom) args.push('--fill-zoom', String(options.fillZoom));
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await run(python, args, { env: curlEnv(), maxBuffer: 1 << 24, timeout: 30 * 60 * 1000 });
  return readDemGrid(out);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Decode a normalized grid written by normalize-dem.py, verifying its
 *  schema, byte lengths and hashes. Returns the DemGrid contract. */
export async function readDemGrid(prefix) {
  const meta = JSON.parse(await fs.readFile(`${prefix}.json`, 'utf8'));
  if (meta.schema !== DEM_SCHEMA || meta.version !== DEM_VERSION) {
    throw new Error(`unsupported DEM schema ${meta.schema}@${meta.version}`);
  }
  const n = meta.width * meta.height;
  if (!(Number.isInteger(meta.width) && Number.isInteger(meta.height) && n > 0)) throw new Error('bad DEM dimensions');
  const dir = path.dirname(prefix);
  const hBuf = await fs.readFile(path.join(dir, meta.payload.heights.file));
  const vBuf = await fs.readFile(path.join(dir, meta.payload.valid.file));
  if (hBuf.byteLength !== n * 4 || hBuf.byteLength !== meta.payload.heights.byteLength) throw new Error('height payload length mismatch');
  if (vBuf.byteLength !== n || vBuf.byteLength !== meta.payload.valid.byteLength) throw new Error('validity payload length mismatch');
  if (sha256(hBuf) !== meta.payload.heights.sha256) throw new Error('height payload hash mismatch');
  if (sha256(vBuf) !== meta.payload.valid.sha256) throw new Error('validity payload hash mismatch');
  // Copy into aligned, little-endian typed arrays regardless of host order.
  const heightsM = new Float32Array(n);
  const view = new DataView(hBuf.buffer, hBuf.byteOffset, hBuf.byteLength);
  for (let i = 0; i < n; i++) heightsM[i] = view.getFloat32(i * 4, true);
  const valid = new Uint8Array(vBuf);
  for (let i = 0; i < n; i++) {
    if (valid[i] && !Number.isFinite(heightsM[i])) throw new Error(`valid cell ${i} is not finite`);
    if (!valid[i]) heightsM[i] = NaN;
  }
  return {
    width: meta.width, height: meta.height, cellSizeM: meta.cellSizeM,
    originM: meta.originM, centerLonLat: meta.centerLonLat,
    heightsM, valid,
    sourceToLocal: meta.sourceToLocal, localToSource: meta.localToSource,
    horizontalCrs: meta.horizontalCrs, verticalReference: meta.verticalReference,
    sourceResolutionM: meta.sourceResolutionM, outputSpacingM: meta.outputSpacingM,
    upsampled: meta.upsampled,
    provenance: meta.provenance, fill: meta.fill || null, points: meta.points || {}, meta,
  };
}

/** Local metric (X east, Z south) of cell (col, row). */
export function cellToLocal(grid, col, row) {
  return [grid.originM[0] + col * grid.cellSizeM, grid.originM[1] + row * grid.cellSizeM];
}

/** Bilinear height at local (x, z); NaN outside the grid or when a cell
 *  that carries weight is no-data. */
export function sampleHeight(grid, x, z) {
  const fx = (x - grid.originM[0]) / grid.cellSizeM;
  const fz = (z - grid.originM[1]) / grid.cellSizeM;
  if (!(fx >= 0 && fz >= 0 && fx <= grid.width - 1 && fz <= grid.height - 1)) return NaN;
  const c0 = Math.min(Math.floor(fx), Math.max(0, grid.width - 2));
  const r0 = Math.min(Math.floor(fz), Math.max(0, grid.height - 2));
  const tx = fx - c0, tz = fz - r0;
  const h = grid.heightsM;
  let sum = 0;
  for (const [dc, dr, w] of [[0, 0, (1 - tx) * (1 - tz)], [1, 0, tx * (1 - tz)], [0, 1, (1 - tx) * tz], [1, 1, tx * tz]]) {
    if (w <= 0) continue;
    const c = c0 + dc, r = r0 + dr;
    if (c >= grid.width || r >= grid.height) continue;
    const v = h[r * grid.width + c];
    if (!Number.isFinite(v)) return NaN;
    sum += w * v;
  }
  return sum;
}
