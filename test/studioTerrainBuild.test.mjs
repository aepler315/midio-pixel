import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { packStudioGrid, studioGridOptions, buildStudioTerrain } from '../tools/build-studio-terrain.mjs';
import { candidateBounds } from '../tools/lib/view-discovery.mjs';
import { tilesForBbox } from '../tools/lib/terrarium.mjs';

const grid = () => ({ width: 2, height: 2, west: -1, south: -1, east: 1, north: 1,
  heightsM: new Float32Array([100.3, -55.8, NaN, 2200.5]), cellM: 500,
  zoom: 8, source: 'Mapzen / AWS Terrain Tiles; fixture', tileHashes: [{ tile: '8/1/2', sha256: 'a'.repeat(64) }] });
const candidate = (id, sourceRangeId, lon = 0, lat = 0) => ({ id, sourceRangeId, camera: { eye: { lon, lat, aboveGroundM: 200 } } });

// Catches altered elevation scale, wrong endian order, erased no-data and omitted source provenance.
test('bundled terrain stores metre-quantized north-up elevations with a distinct no-data sentinel', () => {
  const record = packStudioGrid(grid());
  assert.equal(record.schema, 'midio.studio-terrain');
  assert.equal(record.encoding, 'gzip-int16-le');
  assert.equal(record.noDataValue, -32768);
  const bytes = gunzipSync(Buffer.from(record.data, 'base64'));
  assert.equal(bytes.length, 8);
  assert.deepEqual([0, 2, 4, 6].map(offset => bytes.readInt16LE(offset)), [100, -56, -32768, 2201]);
  assert.equal(record.source, 'Mapzen / AWS Terrain Tiles; fixture');
  assert.deepEqual(record.tileHashes, [{ tile: '8/1/2', sha256: 'a'.repeat(64) }]);
});

// Catches invented terrain from silent overflow, all-missing grids or structurally invalid samples.
test('terrain packing rejects unsafe or empty source grids instead of inventing heights', () => {
  assert.throws(() => packStudioGrid({ ...grid(), heightsM: [100, 40000, 200, 300] }), /height|range|elevation/i);
  assert.throws(() => packStudioGrid({ ...grid(), heightsM: [NaN, NaN, NaN, NaN] }), /missing|coverage|empty/i);
  assert.throws(() => packStudioGrid({ ...grid(), width: 3 }), /grid|dimension|length/i);
});

// Catches oversized grids or unsupported polar tile counts breaking the broad discovery collection.
test('adaptive terrain sampling covers grouped camera eyes at a bounded tile and sample budget', () => {
  const groups = [[candidate('equator', 'equator')],
    [candidate('north-1', 'arctic', -75, 81.7), candidate('north-2', 'arctic', -76, 81.5)]];
  for (const group of groups) {
    const options = studioGridOptions(group);
    const bbox = candidateBounds(group, options.paddingM), tiles = tilesForBbox(bbox, options.zoom);
    assert.ok((tiles.x1 - tiles.x0 + 1) * (tiles.y1 - tiles.y0 + 1) <= 16);
    const width = Math.round((bbox.east - bbox.west) * 111320 * Math.cos((bbox.north + bbox.south) / 2 * Math.PI / 180) / options.cellM);
    const height = Math.round((bbox.north - bbox.south) * 110540 / options.cellM);
    assert.ok(width <= 193 && height <= 193);
    assert.ok(Math.max(width, height) >= 190);
    assert.equal(options.paddingM, 36000);
  }
});

// Catches per-candidate duplication, mismatched integrity hashes and silently fabricating unsupported camera records.
test('terrain builds share source groups and map every supported candidate to verified same-origin JSON', async t => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-terrain-build-'));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  const candidates = [candidate('view-a', 'mountain'), candidate('view-b', 'mountain'),
    { ...candidate('view-c', undefined), sourceViewId: 'reference-valley' }, { id: 'tour-without-camera', camera: null }];
  const index = await buildStudioTerrain({ candidates, out, loadGrid: async () => grid(), log: () => {} });
  assert.equal(Object.keys(index.candidates).length, 3);
  assert.equal(index.candidates['view-a'].url, index.candidates['view-b'].url);
  assert.notEqual(index.candidates['view-a'].url, index.candidates['view-c'].url);
  assert.deepEqual(index.unsupported, ['tour-without-camera']);
  for (const item of Object.values(index.candidates)) {
    assert.match(item.url, /^[a-z0-9-]+\.json$/);
    const bytes = await fs.readFile(path.join(out, item.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
    assert.equal(JSON.parse(bytes).schema, 'midio.studio-terrain');
  }
  const saved = JSON.parse(await fs.readFile(path.join(out, 'index.json'), 'utf8'));
  assert.deepEqual(saved.candidates, index.candidates);
});

// Catches publishing an index that points at failed or nonexistent terrain bundles.
test('a failed terrain group aborts publication and leaves a previous index intact', async t => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-terrain-failure-'));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  await fs.writeFile(path.join(out, 'index.json'), '{"previous":true}\n');
  await assert.rejects(buildStudioTerrain({ candidates: [candidate('bad', 'bad')], out,
    loadGrid: async () => { throw new Error('real source unavailable'); }, log: () => {} }), /unavailable/);
  assert.equal(await fs.readFile(path.join(out, 'index.json'), 'utf8'), '{"previous":true}\n');
});
