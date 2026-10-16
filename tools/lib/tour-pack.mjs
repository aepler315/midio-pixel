// Explicit little-endian portable lanes. V8 caches are authoring inputs only.
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { TOUR_ROLES } from './tour-roles.mjs';
import { TourGraph } from '../../src/world/terrain/TourGraph.js';
import { tourPackageErrors, decodeTour } from '../../src/world/terrain/TourPackage.js';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function packTour({ view, source, highway, field, clearance, subjectStep = 1 }) {
  const chunks = []; let length = 0;
  const lane = (values, type) => {
    const size = { f32: 4, u16: 2, u8: 1, i8: 1 }[type];
    const padding = (size - length % size) % size;
    if (padding) { chunks.push(Buffer.alloc(padding)); length += padding; }
    const offset = length, bytes = Buffer.alloc(values.length * size);
    for (let i = 0; i < values.length; i++) {
      if (type === 'f32') bytes.writeFloatLE(values[i], i * size);
      else if (type === 'u16') bytes.writeUInt16LE(values[i], i * size);
      else if (type === 'i8') bytes.writeInt8(values[i], i);
      else bytes.writeUInt8(values[i], i);
    }
    chunks.push(bytes); length += bytes.length;
    return { offset, count: values.length, type };
  };
  const edges = highway.edges.map(e => ({ ...e, samples: lane(e.samples.flat(), 'f32') }));
  const rows = field.samples.flatMap(s => s.tiers);
  let tierStart = 0;
  const sampleRows = field.samples.flatMap(s => {
    const row = [...s.posM, s.floorY, s.ceilY, tierStart, s.tiers.length]; tierStart += s.tiers.length; return row;
  });
  const offsets = { samples: lane(sampleRows, 'f32'), yM: lane(rows.map(t => t.yM), 'f32'),
    score: lane(rows.flatMap(t => [...t.score]), 'u8'), pitch: lane(rows.flatMap(t => [...t.pitch]), 'i8'),
    fovIdx: lane(rows.flatMap(t => [...t.fovIdx]), 'u8'),
    subjectId: lane(rows.flatMap(t => [...t.subjectId].filter((_, i) => i % subjectStep === 0)), 'u16') };
  const clear = { ...clearance, floor: lane(clearance.floor, 'u16'), ceil: lane(clearance.ceil, 'u16') };
  const decoded = Buffer.concat(chunks), payload = gzipSync(decoded, { level: 9 });
  const manifest = { schema: 'midio.tour', version: 1, id: view.id, terrainViewId: view.id,
    horizontalCrs: source.horizontalCrs, axes: { x: 'east', y: 'up', z: 'south', units: 'metres' },
    roles: TOUR_ROLES, fallback: { intro: ['outro', 'breakdown', 'interlude'], verse: ['pre-chorus', 'interlude', 'bridge'],
      'pre-chorus': ['verse', 'post-chorus', 'chorus'], chorus: ['drop', 'post-chorus', 'pre-chorus'],
      'post-chorus': ['chorus', 'pre-chorus', 'verse'], bridge: ['solo', 'interlude', 'verse'],
      solo: ['bridge', 'chorus', 'interlude'], interlude: ['verse', 'breakdown', 'bridge'],
      breakdown: ['interlude', 'intro', 'outro'], drop: ['chorus', 'solo'], outro: ['intro', 'breakdown', 'interlude'] }, points: highway.points.map(p=>Object.fromEntries(['id','name','type','role','tier','prominenceM','elevationM','isolationM','lonLat','localM','grandeur','station'].filter(k=>p[k]!==undefined).map(k=>[k,p[k]]))), nodes: highway.nodes, edges,
    field: { spacingM: field.spacingM, tiers: [0, 120, 300, 600, 1000], headingStepDeg: 5,
      subjectStepDeg: subjectStep * 5, layout: 'score:u8[72],pitch:i8[36],fov:u2[72],subject:u16[72/step]',
      normalization: field.normalization, sampleCount: field.samples.length, tierCount: rows.length, offsets, edges: field.edges, stations: field.stations },
    clearance: clear, tunables: view.tour.tunables, provenance: { ...source.provenance, builtWith: 'build-teton-tour.mjs portable-v1' },
    payload: { url: `${view.id}.tour.bin.gz`, sha256: sha(payload), byteLength: payload.length,
      decodedSha256: sha(decoded), decodedByteLength: decoded.length } };
  // Junction fitting is authoring work, pinned by the manifest hash.
  // Runtime routes reuse these exact decoded-grid curves.
  const graph=new TourGraph(decodeTour(manifest,decoded));
  for(const [node,outgoing]of graph.adj)for(const incoming of graph.oriented.values())if(incoming.to===node)for(const next of outgoing)graph.join(incoming,next);
  manifest.junctions=Object.fromEntries(graph.joins);
  const errors = tourPackageErrors(manifest);
  if (errors.length) throw new Error(`Tour pack rejected: ${errors.slice(0, 5).join('; ')}`);
  return { manifest, payload, decoded };
}
