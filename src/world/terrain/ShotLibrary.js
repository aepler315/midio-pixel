// Scenic shot tours: the per-view shot library (schema midio.shots v1).
//
// Authored offline by tools/build-scenic-tours.mjs, one library per approved
// scenic view, validated there against the view's actual terrain package.
// A library holds:
//   subjects  what shots are about (named landmarks and DEM features)
//   shots     complete camera moves around one subject -- approach, payoff,
//             sustained view, departure -- each a sampled path (ShotPath)
//   links     connecting moves from one shot's exit to another's entry,
//             several alternatives per pair (shorter, more scenic)
// The runtime planner (ShotPlanner.js) strings shots and links together
// against the music; nothing here depends on a song.
//
// Binary payload: every path is `count` samples of PATH_LANES little-endian
// Int16 values:
//   ds, dEyeX, dEyeY, dEyeZ, dAimX, dAimY, dAimZ, fov, flow
// Progress and positions are quantized to one global lattice (POSITION_STEP_M
// metres) and stored as differences from the previous sample; the record's
// `samples.first` holds sample 0's lattice integers. Paths that meet (a
// link's ends and its shots' ends) therefore decode to identical values.
// fov is in FOV_STEP_DEG; flow, the 95th-percentile angular image speed of
// visible terrain per unit progress speed (radians per progress metre: at
// progress speed v the picture moves ~v*flow rad/s), is stored as
// round(sqrt(flow) * FLOW_SCALE).
import { RangeAssetError, gunzip, sha256Hex } from '../alpine/RangeAssets.js';
import { pathErrors } from './ShotPath.js';

export const SHOT_SCHEMA = 'midio.shots';
export const SHOT_VERSION = 1;
export const PATH_LANES = 9;
export const POSITION_STEP_M = 0.1;
export const FOV_STEP_DEG = 0.01;
export const FLOW_SCALE = 60000;
export const SHOT_MOVES = Object.freeze(['rail', 'traverse', 'approach', 'reveal', 'orbit', 'pullback', 'valley', 'crest']);
export const LINK_KINDS = Object.freeze(['direct', 'arc', 'high', 'low']);
export const SUBJECT_KINDS = Object.freeze(['landmark', 'peak', 'butte', 'ridge', 'lake', 'valley', 'shore', 'rail-target']);

const vec = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Problems with a manifest, checked before any binary offset is read. */
export function shotLibraryErrors(m, { viewId = null, decodedByteLength = null } = {}) {
  const errors = [];
  const fail = (s) => { if (errors.length < 20) errors.push(s); };
  if (!m || m.schema !== SHOT_SCHEMA || m.version !== SHOT_VERSION) return ['shot library schema/version'];
  if (typeof m.viewId !== 'string' || !m.viewId || (viewId && m.viewId !== viewId)) fail('view identity');
  if (!/^[a-f0-9]{64}$/.test(m.terrainManifestSha256 || '')) fail('terrain identity');
  if (m.axes?.x !== 'east' || m.axes?.y !== 'up' || m.axes?.z !== 'south' || m.axes?.units !== 'metres') fail('metric frame');
  const length = m.payload?.decodedByteLength;
  if (!Number.isInteger(length) || length <= 0 || (decodedByteLength !== null && length !== decodedByteLength)) fail('decoded length');
  for (const key of ['sha256', 'decodedSha256']) if (!/^[a-f0-9]{64}$/.test(m.payload?.[key] || '')) fail(`payload ${key}`);
  if (!(m.payload?.byteLength > 0) || typeof m.payload?.url !== 'string') fail('payload metadata');
  if (!Array.isArray(m.subjects) || !Array.isArray(m.shots) || !Array.isArray(m.links)) return [...errors, 'library arrays'];
  if (!m.shots.length) fail('no shots');
  const subjects = new Set(), ids = new Set(), ranges = [];
  for (const s of m.subjects) {
    if (subjects.has(s?.id) || typeof s?.id !== 'string' || !SUBJECT_KINDS.includes(s.kind) || !vec(s.posM, 3) || !(s.radiusM > 0)) fail(`subject ${s?.id}`);
    subjects.add(s?.id);
  }
  const lane = (l, label) => {
    if (!l || !Number.isInteger(l.offset) || l.offset < 0 || l.offset % 2 || !Number.isInteger(l.count) || l.count < 2
      || l.offset + l.count * PATH_LANES * 2 > length || !Array.isArray(l.first) || l.first.length !== 7 || !l.first.every(Number.isInteger)) { fail(`${label} samples`); return; }
    ranges.push([l.offset, l.offset + l.count * PATH_LANES * 2, label]);
  };
  const durations = (d, label) => {
    if (!d || !finite(d.min) || !finite(d.max) || !(d.min > 0) || !(d.max >= d.min)) fail(`${label} duration`);
  };
  for (const s of m.shots) {
    const label = `shot ${s?.id}`;
    if (typeof s?.id !== 'string' || ids.has(s.id)) fail(`${label} id`);
    ids.add(s?.id);
    if (!subjects.has(s.subjectId)) fail(`${label} subject`);
    if (!SHOT_MOVES.includes(s.move)) fail(`${label} move`);
    if (!(s.lengthM > 0) || !finite(s.payoffS) || s.payoffS < 0 || s.payoffS > s.lengthM + 1e-3) fail(`${label} payoff`);
    if (!Array.isArray(s.holdS) || s.holdS.length !== 2 || !(s.holdS[0] <= s.payoffS && s.payoffS <= s.holdS[1])) fail(`${label} hold`);
    if (!s.traits || !finite(s.traits.headingDeg) || !finite(s.traits.aglM) || !['wide', 'normal', 'tele'].includes(s.traits.lens)) fail(`${label} traits`);
    if (!s.score || !finite(s.score.total)) fail(`${label} score`);
    durations(s.durationMs, label);
    lane(s.samples, label);
  }
  const shots = new Set(m.shots.map((s) => s?.id));
  for (const l of m.links) {
    const label = `link ${l?.id}`;
    if (typeof l?.id !== 'string' || ids.has(l.id)) fail(`${label} id`);
    ids.add(l?.id);
    if (!shots.has(l.from) || !shots.has(l.to) || l.from === l.to) fail(`${label} ends`);
    if (!LINK_KINDS.includes(l.kind) || !(l.lengthM > 0)) fail(`${label} kind`);
    if (!l.score || !finite(l.score.total)) fail(`${label} score`);
    durations(l.durationMs, label);
    lane(l.samples, label);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) { fail(`overlapping samples ${ranges[i][2]}`); break; }
  const pending = [m];
  while (pending.length) {
    const v = pending.pop();
    if (typeof v === 'number' && !Number.isFinite(v)) { fail('nonfinite metadata'); break; }
    if (v && typeof v === 'object') pending.push(...Object.values(v));
  }
  return errors;
}

/** Path lanes for one record from decoded payload bytes. */
function readPath(view, l) {
  const n = l.count, s = new Float32Array(n), eye = new Float32Array(n * 3), aim = new Float32Array(n * 3);
  const fov = new Float32Array(n), flow = new Float32Array(n);
  const acc = l.first.slice();
  for (let i = 0; i < n; i++) {
    const at = l.offset + i * PATH_LANES * 2, q = (k) => view.getInt16(at + k * 2, true);
    if (i) for (let k = 0; k < 7; k++) acc[k] += q(k);
    s[i] = acc[0] * POSITION_STEP_M;
    for (let k = 0; k < 3; k++) { eye[i * 3 + k] = acc[1 + k] * POSITION_STEP_M; aim[i * 3 + k] = acc[4 + k] * POSITION_STEP_M; }
    fov[i] = view.getUint16(at + 14, true) * FOV_STEP_DEG;
    flow[i] = (view.getUint16(at + 16, true) / FLOW_SCALE) ** 2;
  }
  return { s, eye, aim, fov, flow };
}

/** Decode a validated manifest + decoded payload into a runtime library:
 *  { ...manifest, subjects, shots, links, shotById, linkById, linksFrom }. */
export function decodeShotLibrary(manifest, bytes) {
  const errors = shotLibraryErrors(manifest, { decodedByteLength: bytes.byteLength });
  if (errors.length) throw new RangeAssetError('manifest', errors.slice(0, 3).join('; '));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const withPath = (record) => {
    const path = readPath(view, record.samples);
    const problems = pathErrors(path);
    if (problems.length) throw new RangeAssetError('decode', `${record.id}: ${problems[0]}`);
    if (!path.flow.every((v) => Number.isFinite(v) && v >= 0)) throw new RangeAssetError('decode', `${record.id}: flow lane`);
    return { ...record, path };
  };
  const shots = manifest.shots.map(withPath), links = manifest.links.map(withPath);
  const shotById = new Map(shots.map((s) => [s.id, s])), linkById = new Map(links.map((l) => [l.id, l]));
  const linksFrom = new Map(shots.map((s) => [s.id, []]));
  for (const l of links) linksFrom.get(l.from).push(l);
  for (const list of linksFrom.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  return { ...manifest, shots, links, shotById, linkById, linksFrom, subjectById: new Map(manifest.subjects.map((s) => [s.id, s])) };
}

/** Pack records with in-memory paths into a payload (authoring side). Each
 *  record gets `samples: {offset, count, first}`; returns the decoded
 *  bytes. Progress is re-anchored so every path starts at 0. Throws when a
 *  step does not fit an Int16 difference. */
export function packShotPaths(records) {
  const total = records.reduce((n, r) => n + r.path.s.length * PATH_LANES * 2, 0);
  const bytes = new Uint8Array(total), view = new DataView(bytes.buffer);
  const q = (v) => Math.round(v / POSITION_STEP_M);
  let at = 0;
  for (const r of records) {
    const { s, eye, aim, fov, flow } = r.path, n = s.length;
    const lat = (i) => [q(s[i] - s[0]), q(eye[i * 3]), q(eye[i * 3 + 1]), q(eye[i * 3 + 2]), q(aim[i * 3]), q(aim[i * 3 + 1]), q(aim[i * 3 + 2])];
    let prev = lat(0);
    r.samples = { offset: at, count: n, first: prev.slice() };
    for (let i = 0; i < n; i++, at += PATH_LANES * 2) {
      const cur = lat(i);
      for (let k = 0; k < 7; k++) {
        const d = i ? cur[k] - prev[k] : 0;
        if (d < -32768 || d > 32767) throw new Error(`${r.id}: sample ${i} steps too far for the Int16 lattice`);
        view.setInt16(at + k * 2, d, true);
      }
      // A progress step that rounds to zero would stall decoding: keep >= 1.
      if (i && cur[0] <= prev[0]) { cur[0] = prev[0] + 1; view.setInt16(at, 1, true); }
      view.setUint16(at + 14, Math.max(0, Math.min(65535, Math.round(fov[i] / FOV_STEP_DEG))), true);
      view.setUint16(at + 16, Math.max(0, Math.min(65535, Math.round(Math.sqrt(Math.max(0, flow?.[i] ?? 0)) * FLOW_SCALE))), true);
      prev = cur;
    }
  }
  return bytes;
}

/** Fetch, verify (manifest and payload SHA-256) and decode one library. */
export async function loadShotLibrary(url, { signal = null, fetchImpl = globalThis.fetch, expectManifestSha256 = null, viewId = null } = {}) {
  const fetchBytes = async (u) => {
    try {
      const r = await fetchImpl(u, { signal });
      if (!r.ok) throw new RangeAssetError('http', `HTTP ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (signal?.aborted) throw new RangeAssetError('aborted', 'shot library load aborted');
      return bytes;
    } catch (e) { if (e instanceof RangeAssetError) throw e; throw new RangeAssetError(signal?.aborted ? 'aborted' : 'http', e.message); }
  };
  const raw = await fetchBytes(url);
  if (expectManifestSha256 && await sha256Hex(raw) !== expectManifestSha256) throw new RangeAssetError('hash', 'shot library manifest hash mismatch');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new RangeAssetError('manifest', 'invalid shot library JSON'); }
  const errors = shotLibraryErrors(manifest, { viewId });
  if (errors.length) throw new RangeAssetError('manifest', errors.slice(0, 3).join('; '));
  const compressed = await fetchBytes(new URL(manifest.payload.url, new URL(url, globalThis.location?.href || 'http://localhost/')).href);
  const gzip = compressed[0] === 0x1f && compressed[1] === 0x8b;
  if (gzip && (compressed.length !== manifest.payload.byteLength || await sha256Hex(compressed) !== manifest.payload.sha256)) {
    throw new RangeAssetError('hash', 'shot library payload hash mismatch');
  }
  let decoded;
  try { decoded = await gunzip(compressed); } catch (e) { throw new RangeAssetError('decode', e.message); }
  if (decoded.length !== manifest.payload.decodedByteLength || await sha256Hex(decoded) !== manifest.payload.decodedSha256) {
    throw new RangeAssetError('hash', 'shot library decoded hash mismatch');
  }
  return { manifest, library: decodeShotLibrary(manifest, decoded), bytes: { compressed: compressed.length, decoded: decoded.length } };
}

/** Bytes a decoded library holds resident (paths plus a metadata allowance). */
export function shotLibraryBytes(library) {
  let n = 64 * 1024;
  for (const r of [...library.shots, ...library.links]) n += r.path.s.length * 36 + 512;
  return n;
}

/** Eye polylines of every shot and link, thinned: the song-independent
 *  footprint prepare-time resources (forest placement) are built for. */
export function cameraFootprint(library, everyM = 120) {
  const lines = [];
  for (const r of [...library.shots, ...library.links]) {
    const { eye, s } = r.path, n = s.length, out = [];
    let last = -Infinity;
    for (let i = 0; i < n; i++) {
      if (i === n - 1 || s[i] - last >= everyM) { out.push([eye[i * 3], eye[i * 3 + 1], eye[i * 3 + 2]]); last = s[i]; }
    }
    if (out.length >= 2) lines.push(out);
  }
  return lines;
}

