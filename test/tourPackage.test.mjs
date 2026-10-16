import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packTour } from '../tools/lib/tour-pack.mjs';
import { decodeTour, tourPackageErrors, loadTourPackage } from '../src/world/terrain/TourPackage.js';
import { gunzipSync } from 'node:zlib';
const fixture = () => ({
  view: { id: 'test', tour: { tunables: {} } },
  source: { horizontalCrs: '+proj=tmerc', provenance: { demSha256: 'a'.repeat(64), namesSha256: 'b'.repeat(64) } },
  highway: { points: [{ id: 'p', localM: [0, 100, 0], role: 'drop', tier: 'primary', station: { nodeId: 'n', posM: [0, 0], yM: 200, bestAim: { headingDeg: 270, pitchDeg: 0, hfovDeg: 55, score: 1 } } }],
    nodes: [{ id: 'n', posM: [0, 0], pointId: 'p' }],
    edges: [{ id: 'e', a: 'n', b: 'n', kind: 'orbit', spine: false, lengthM: 100, samples: [[0, 0, 150, 1000], [100, 0, 150, 1000]] }] },
  field: { spacingM: 100, normalization: 1, edges: [{ edgeId: 'e', sampleIds: [0], distancesM: [0] }], stations: [{ pointId: 'p', sampleId: 0 }], samples: [{ posM: [0, 0], floorY: 150, ceilY: 1000, tiers: [{ yM: 200, score: new Uint8Array(72).fill(255), pitch: new Int8Array(36), fovIdx: new Uint8Array(18), subjectId: new Uint16Array(72) }] }] },
  clearance: { cellM: 60, width: 2, height: 2, originM: [0, 0], offsetY: 0, floor: new Uint16Array(4).fill(1500), ceil: new Uint16Array(4).fill(10000) },
});
test('portable tour round trips all lanes and geometry without a V8 dependency', () => {
  const { manifest, payload } = packTour(fixture());
  assert.deepEqual(tourPackageErrors(manifest), []);
  const data = decodeTour(manifest, gunzipSync(payload));
  assert.deepEqual(data.edges[0].samples, [[0, 0, 150, 1000], [100, 0, 150, 1000]]);
  assert.equal(data.field.samples[0].tiers[0].score[71], 255);
  assert.equal(data.clearance.floor[0], 1500);
});
test('tour manifest refuses mismatches, invalid references, nonfinite values and overlapping lanes', () => {
  const { manifest } = packTour(fixture());
  for (const mutate of [m => m.version++, m => m.nodes[0].posM[0] = NaN, m => m.edges[0].a = 'missing', m => m.edges[0].samples.offset = 1e9,
    m => m.field.offsets.score.offset = m.clearance.floor.offset]) {
    const bad = structuredClone(manifest); mutate(bad);
    assert.ok(tourPackageErrors(bad).length);
  }
  assert.ok(tourPackageErrors(manifest, { terrainViewId: 'wrong' }).length);
});
test('loader verifies both compressed and transfer-decoded identities', async () => {
  const { manifest, payload } = packTour(fixture());
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const fetchImpl = async url => new Response(url.endsWith('.json') ? manifestBytes : payload);
  const loaded = await loadTourPackage('http://localhost/test.json', { fetchImpl, terrainViewId: 'test' });
  assert.equal(loaded.data.nodes.length, 1);
  const corrupt = Uint8Array.from(payload); corrupt[15] ^= 1;
  await assert.rejects(loadTourPackage('http://localhost/test.json', { fetchImpl: async url => new Response(url.endsWith('.json') ? manifestBytes : corrupt) }), /hash/);
  const decoded = gunzipSync(payload);
  assert.equal((await loadTourPackage('http://localhost/test.json', { fetchImpl: async url => new Response(url.endsWith('.json') ? manifestBytes : decoded) })).data.nodes.length, 1);
});

test('portable metadata keeps runtime point identity and omits authoring-only score inputs',()=>{
 const input=fixture();input.highway.points[0].suit={drop:.9};input.highway.points[0].propertiesTruncated=false;
 const {manifest}=packTour(input);
 assert.equal(manifest.points[0].suit,undefined);assert.equal(manifest.points[0].id,'p');
 assert.ok(manifest.junctions&&typeof manifest.junctions==='object');
});
