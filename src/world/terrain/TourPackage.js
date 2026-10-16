import { RangeAssetError, gunzip, sha256Hex } from '../alpine/RangeAssets.js';
const TYPES = { f32: [4, Float32Array, 'getFloat32'], u16: [2, Uint16Array, 'getUint16'], u8: [1, Uint8Array, 'getUint8'], i8: [1, Int8Array, 'getInt8'] };
const vec = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
/** Validate before interpreting any binary offset. */
export function tourPackageErrors(m, { terrainViewId = null, decodedByteLength = null } = {}) {
  const errors = [], ranges = [], fail = s => errors.push(s);
  if (!m || m.schema !== 'midio.tour' || m.version !== 1) return ['tour schema/version'];
  if (!m.id || !m.terrainViewId || terrainViewId && m.terrainViewId !== terrainViewId) fail('terrain identity mismatch');
  if (typeof m.horizontalCrs !== 'string' || !m.horizontalCrs || m.axes?.x !== 'east' || m.axes?.y !== 'up' || m.axes?.z !== 'south' || m.axes?.units !== 'metres') fail('metric frame');
  if (!Array.isArray(m.roles) || !m.roles.length || new Set(m.roles).size !== m.roles.length) fail('roles');
  const pending = [m];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'number' && !Number.isFinite(value)) fail('nonfinite metadata');
    else if (value && typeof value === 'object') pending.push(...Object.values(value));
  }
  const length = m.payload?.decodedByteLength;
  if (!Number.isInteger(length) || length <= 0 || decodedByteLength !== null && length !== decodedByteLength) fail('decoded length');
  for (const key of ['sha256', 'decodedSha256']) if (!/^[a-f0-9]{64}$/.test(m.payload?.[key])) fail(`payload ${key}`);
  if (!(m.payload?.byteLength > 0) || !m.payload?.url) fail('payload metadata');
  const lane = (l, type, count) => {
    const size = TYPES[type][0];
    if (!l || l.type !== type || !Number.isInteger(l.offset) || l.offset < 0 || l.offset % size
      || !Number.isInteger(l.count) || l.count !== count || l.offset + l.count * size > length) { fail('binary lane range/type/count'); return; }
    ranges.push([l.offset, l.offset + l.count * size]);
  };
  const nodes = new Set(), points = new Set(), edges = new Set();
  if (!Array.isArray(m.nodes) || !Array.isArray(m.points) || !Array.isArray(m.edges)) return [...errors, 'graph arrays'];
  for (const n of m.nodes) { if (nodes.has(n.id) || !vec(n.posM, 2)) fail('node'); nodes.add(n.id); }
  for (const p of m.points) {
    if (points.has(p.id) || !vec(p.localM, 3)) fail('point'); points.add(p.id);
    if (p.station && (!nodes.has(p.station.nodeId) || !vec(p.station.posM, 2) || !Number.isFinite(p.station.yM))) fail('station');
    if (p.station && (!p.station.bestAim || !['headingDeg', 'pitchDeg', 'hfovDeg', 'score'].every(k => Number.isFinite(p.station.bestAim[k])) || !(p.station.bestAim.hfovDeg > 0 && p.station.bestAim.hfovDeg < 180))) fail('station aim');
  }
  if (points.size >= 65535) fail('subject capacity');
  for (const n of m.nodes) if (n.pointId != null && !points.has(n.pointId)) fail('node point reference');
  for (const e of m.edges) {
    if (edges.has(e.id) || !nodes.has(e.a) || !nodes.has(e.b) || !['road', 'orbit'].includes(e.kind) || !(e.lengthM > 0) || !Number.isFinite(e.lengthM)) fail('edge');
    edges.add(e.id);
    if (!e.samples || e.samples.count < 8 || e.samples.count % 4) fail('road sample count');
    lane(e.samples, 'f32', e.samples?.count);
  }
  if(m.junctions){
    if(typeof m.junctions!=='object'||Array.isArray(m.junctions))fail('junction cache');
    else for(const [key,join]of Object.entries(m.junctions)){
      const parts=key.split(':');
      if(parts.length!==4||!edges.has(parts[0])||!edges.has(parts[2])||![parts[1],parts[3]].every(v=>v==='true'||v==='false'))fail('junction reference');
      if(join!==null&&(!(join.trimM>=0)||!(join.lengthM>=0)||!(join.radiusM>=(m.tunables?.turnRadiusM||400))||!Array.isArray(join.samples)||join.samples.some(s=>!vec(s,4)||s[2]>s[3])))fail('junction geometry');
    }
  }
  const f = m.field, c = m.clearance;
  if (!f || f.headingStepDeg !== 5 || ![5, 10].includes(f.subjectStepDeg) || !Number.isInteger(f.sampleCount) || f.sampleCount < 1
    || !Number.isInteger(f.tierCount) || f.tierCount < f.sampleCount || f.tierCount > 5 * f.sampleCount || !Array.isArray(f.edges) || !Array.isArray(f.stations)) return [...errors, 'field'];
  for (const [key, type, count] of [['samples', 'f32', f.sampleCount * 6], ['yM', 'f32', f.tierCount],
    ['score', 'u8', f.tierCount * 72], ['pitch', 'i8', f.tierCount * 36], ['fovIdx', 'u8', f.tierCount * 18],
    ['subjectId', 'u16', f.tierCount * 360 / f.subjectStepDeg]]) lane(f.offsets?.[key], type, count);
  for (const e of f.edges) if (!edges.has(e.edgeId) || !Array.isArray(e.sampleIds) || !Array.isArray(e.distancesM)
    || e.sampleIds.length !== e.distancesM.length || e.sampleIds.some(i => !Number.isInteger(i) || i < 0 || i >= f.sampleCount)
    || e.distancesM.some((d, i) => !Number.isFinite(d) || d < 0 || i && d < e.distancesM[i - 1])) fail('field edge mapping');
  for (const s of f.stations) if (!points.has(s.pointId) || !Number.isInteger(s.sampleId) || s.sampleId < 0 || s.sampleId >= f.sampleCount) fail('field station mapping');
  if (!c || !(c.cellM > 0) || !Number.isInteger(c.width) || c.width < 2 || !Number.isInteger(c.height) || c.height < 2 || !vec(c.originM, 2) || !Number.isFinite(c.offsetY)) fail('clearance');
  else { lane(c.floor, 'u16', c.width * c.height); lane(c.ceil, 'u16', c.width * c.height); }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) fail('overlapping binary lanes');
  return errors;
}
export function decodeTour(manifest, bytes) {
  const errors = tourPackageErrors(manifest, { decodedByteLength: bytes.byteLength });
  if (errors.length) throw new RangeAssetError('manifest', errors.slice(0, 3).join('; '));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lane = l => {
    const [size, Constructor, method] = TYPES[l.type], out = new Constructor(l.count);
    for (let i = 0; i < out.length; i++) {
      out[i] = view[method](l.offset + i * size, true);
      if (!Number.isFinite(out[i])) throw new RangeAssetError('decode', 'nonfinite lane');
    }
    return out;
  };
  const f = manifest.field, lanes = Object.fromEntries(Object.entries(f.offsets).map(([k, l]) => [k, lane(l)]));
  const samples = []; let nextTier = 0;
  for (let i = 0; i < f.sampleCount; i++) {
    const [x, z, floorY, ceilY, start, count] = lanes.samples.slice(i * 6, i * 6 + 6);
    if (floorY > ceilY || start !== nextTier || !Number.isInteger(count) || count < 1 || count > 5 || start + count > f.tierCount) throw new RangeAssetError('decode', 'field tier range');
    nextTier += count;
    const tiers = [];
    for (let j = start; j < start + count; j++) {
      const yM = lanes.yM[j], subjects = 360 / f.subjectStepDeg;
      if (yM < floorY - .001 || yM > ceilY + .001) throw new RangeAssetError('decode', 'field tier height');
      const subjectId = lanes.subjectId.subarray(j * subjects, (j + 1) * subjects);
      if (subjectId.some(id => id !== 65535 && id >= manifest.points.length)) throw new RangeAssetError('decode', 'subject reference');
      tiers.push({ yM, score: lanes.score.subarray(j * 72, j * 72 + 72), pitch: lanes.pitch.subarray(j * 36, j * 36 + 36),
        fovIdx: lanes.fovIdx.subarray(j * 18, j * 18 + 18), subjectId });
    }
    samples.push({ posM: [x, z], floorY, ceilY, tiers });
  }
  if (nextTier !== f.tierCount) throw new RangeAssetError('decode', 'unused field tiers');
  const data = { ...manifest, edges: manifest.edges.map(e => {
    const raw = lane(e.samples), samples = [];
    for (let i = 0; i < raw.length; i += 4) {
      if (raw[i + 2] > raw[i + 3]) throw new RangeAssetError('decode', 'inverted road band');
      samples.push([...raw.slice(i, i + 4)]);
    }
    return { ...e, samples };
  }), field: { ...f, samples }, clearance: { ...manifest.clearance, floor: lane(manifest.clearance.floor), ceil: lane(manifest.clearance.ceil) } };
  for (let i = 0; i < data.clearance.floor.length; i++) if (data.clearance.floor[i] > data.clearance.ceil[i]) throw new RangeAssetError('decode', 'inverted clearance');
  return data;
}
export async function loadTourPackage(url, { signal = null, fetchImpl = globalThis.fetch, expectManifestSha256 = null, terrainViewId = null } = {}) {
  const fetchBytes = async u => {
    try {
      const r = await fetchImpl(u, { signal });
      if (!r.ok) throw new RangeAssetError('http', `HTTP ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (signal?.aborted) throw new RangeAssetError('aborted', 'tour load aborted');
      return bytes;
    } catch (e) { if (e instanceof RangeAssetError) throw e; throw new RangeAssetError(signal?.aborted ? 'aborted' : 'http', e.message); }
  };
  const raw = await fetchBytes(url);
  if (expectManifestSha256 && await sha256Hex(raw) !== expectManifestSha256) throw new RangeAssetError('hash', 'tour manifest hash mismatch');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new RangeAssetError('manifest', 'invalid tour JSON'); }
  const errors = tourPackageErrors(manifest, { terrainViewId });
  if (errors.length) throw new RangeAssetError('manifest', errors.slice(0, 3).join('; '));
  const compressed = await fetchBytes(new URL(manifest.payload.url, new URL(url, globalThis.location?.href || 'http://localhost/')).href);
  const gzip = compressed[0] === 31 && compressed[1] === 139;
  if (gzip && (compressed.length !== manifest.payload.byteLength || await sha256Hex(compressed) !== manifest.payload.sha256)) throw new RangeAssetError('hash', 'tour payload hash mismatch');
  let decoded;
  try { decoded = await gunzip(compressed); } catch (e) { throw new RangeAssetError('decode', e.message); }
  if (decoded.length !== manifest.payload.decodedByteLength || await sha256Hex(decoded) !== manifest.payload.decodedSha256) throw new RangeAssetError('hash', 'tour decoded hash mismatch');
  return { manifest, data: decodeTour(manifest, decoded), bytes: { compressed: compressed.length, decoded: decoded.length } };
}

/** Conservative reconstruction matches the authoring floor/ceiling query. */
export function tourClearanceAt(c, x, z) {
  const col = (x - c.originM[0]) / c.cellM, row = (z - c.originM[1]) / c.cellM;
  if (!(col >= 0 && row >= 0 && col <= c.width - 1 && row <= c.height - 1)) return { floorY: NaN, ceilY: NaN };
  const i = Math.min(Math.floor(row), c.height - 2) * c.width + Math.min(Math.floor(col), c.width - 2);
  let floorY = -Infinity, ceilY = Infinity;
  for (const d of [0, 1, c.width, c.width + 1]) {
    floorY = Math.max(floorY, c.offsetY + c.floor[i + d] / 10);
    ceilY = Math.min(ceilY, c.offsetY + c.ceil[i + d] / 10);
  }
  return { floorY, ceilY };
}

/** Every clearance cell traversed by a line, including corner crossings. */
export function tourClearanceAlong(c,a,b) {
  const times=[0,1];
  for(let axis=0;axis<2;axis++){
    const da=b[axis]-a[axis];if(!da)continue;
    const low=Math.min(a[axis],b[axis]),high=Math.max(a[axis],b[axis]);
    for(let k=Math.floor((low-c.originM[axis])/c.cellM)+1;k*c.cellM+c.originM[axis]<high;k++)times.push((k*c.cellM+c.originM[axis]-a[axis])/da);
  }
  times.sort((x,y)=>x-y);let floorY=-Infinity,ceilY=Infinity;
  const query=t=>{const band=tourClearanceAt(c,a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t);floorY=Math.max(floorY,band.floorY);ceilY=Math.min(ceilY,band.ceilY);};
  for(let i=0;i<times.length;i++){query(times[i]);if(i)query((times[i-1]+times[i])/2);}
  return{floorY,ceilY};
}
