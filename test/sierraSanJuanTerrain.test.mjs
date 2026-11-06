import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import catalog from '../src/world/terrain/sceneCatalogData.js';
import { validateTerrainManifest } from '../src/world/alpine/TerrainPackage.js';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const terrain = path.join(root, 'src/assets/range/v2/terrain');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const additions = [
  { id: 'sierra-whitney-east', regionId: 'sierra-nevada', biome: 'STEPPE' },
  { id: 'san-juan-sneffels-north', regionId: 'san-juan-mountains', biome: 'CONIFER' },
  { id: 'crater-lake-watchman-east', regionId: 'crater-lake', biome: 'CONIFER' },
  { id: 'badlands-pinnacles-south', regionId: 'badlands', biome: 'STEPPE' },
];

for (const { id, regionId, biome } of additions) {
  test(`${id} ships source-backed 20 m terrain with consistent provenance and payload identities`, () => {
    const prefix = path.join(terrain, id);
    for (const suffix of ['.terrain.json', '.terrain.bin.gz', '.build.json']) {
      assert.ok(fs.existsSync(prefix + suffix), `${id}: missing published package ${suffix}`);
    }
    const authored = json(path.join(root, 'data/terrain/scenic-views.json')).views.find(view => view.id === id);
    assert.ok(authored, `${id}: missing authoring`);
    assert.equal(authored.regionId, regionId);
    assert.equal(authored.biome, biome);
    assert.equal(authored.dem.source, '3dep13');
    assert.equal(authored.dem.cellM, 20);
    assert.equal(authored.dem.windowCache, 'tile');
    const pins = typeof authored.dem.pin === 'string' ? json(path.resolve(root, authored.dem.pin)) : authored.dem.pin;
    assert.ok(pins && typeof pins === 'object' && !Array.isArray(pins), `${id}: explicit source pins required`);
    assert.ok(Object.keys(pins).length > 0, `${id}: source pins must not be empty`);
    for (const [tile, value] of Object.entries(pins)) {
      assert.match(tile, /^n\d{2}w\d{3}$/);
      const url = new URL(value);
      assert.equal(url.protocol, 'https:');
      assert.equal(url.hostname, 'prd-tnm.s3.amazonaws.com');
      assert.match(url.pathname, new RegExp(`/historical/${tile}/USGS_13_${tile}_\\d{8}\\.tif$`), 'pin the dated historical source');
    }

    const manifestBytes = fs.readFileSync(prefix + '.terrain.json');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const payload = fs.readFileSync(prefix + '.terrain.bin.gz');
    const build = json(prefix + '.build.json');
    const view = catalog.views.find(entry => entry.id === id);
    assert.ok(view, `${id}: generated catalog entry missing`);
    assert.equal(manifest.viewId, id);
    assert.equal(manifest.regionId, regionId);
    assert.equal(build.view.id, id);
    assert.equal(build.view.regionId, regionId);
    assert.equal(build.view.biome, biome);
    assert.deepEqual(build.view.dem, authored.dem, 'build records the current source configuration');
    assert.equal(view.terrainManifestUrl, `terrain/${id}.terrain.json`);
    assert.equal(sha256(manifestBytes), build.manifestSha256);
    assert.equal(view.terrainManifestSha256, build.manifestSha256);
    assert.equal(manifest.payload.url, `${id}.terrain.bin.gz`);
    assert.equal(manifest.payload.encoding, 'gzip');
    assert.equal(payload.byteLength, manifest.payload.byteLength);
    assert.equal(payload.byteLength, build.payloadBytes);
    assert.equal(sha256(payload), manifest.payload.sha256);
    assert.equal(build.payloadSha256, manifest.payload.sha256);

    const source = manifest.source, provenance = source.provenance;
    assert.equal(manifest.grid.cellSizeM, 20);
    assert.equal(source.outputSpacingM, 20);
    assert.ok(source.sourceResolutionM > 0 && source.sourceResolutionM <= 20, '20 m output must not claim finer source detail');
    assert.deepEqual(source.centerLonLat, authored.dem.centerLonLat);
    assert.match(source.demSha256, hashPattern);
    assert.match(source.horizontalCrs, /\+proj=tmerc/);
    assert.match(source.verticalReference, /NAVD88/);
    assert.equal(source.fill, null, 'both corridors use their pinned 3DEP source throughout');
    assert.match(provenance.provider, /U\.S\. Geological Survey/);
    assert.match(provenance.product, /3DEP 1\/3 arc-second/);
    assert.match(provenance.license, /Public domain/);
    assert.match(provenance.retrievedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(provenance.files?.length > 0, 'retain source acquisition records');
    assert.deepEqual(provenance.tileIds, provenance.files.map(file => file.tile));
    assert.deepEqual(provenance.urls, provenance.files.map(file => file.url));
    assert.deepEqual(provenance.sha256, provenance.files.map(file => file.windowSha256));
    assert.equal(new Set(provenance.tileIds).size, provenance.tileIds.length);
    assert.deepEqual(build.sourceSha256, provenance.sha256);
    for (const file of provenance.files) {
      assert.equal(file.url, pins[file.tile], `${file.tile}: every delivered source tile must be pinned`);
      assert.match(file.windowSha256, hashPattern);
      assert.ok(Array.isArray(file.windowPixels) && file.windowPixels.length === 4
        && file.windowPixels.every(value => Number.isInteger(value) && value >= 0)
        && file.windowPixels[2] > 0 && file.windowPixels[3] > 0, `${file.tile}: native source window`);
    }
    for (const hash of [...build.sourceSha256, build.payloadSha256]) {
      assert.ok(view.evidence.sourceHashes.includes(hash), `${id}: catalog retains source and payload evidence`);
    }

    const decoded = gunzipSync(payload);
    assert.equal(decoded.byteLength, manifest.payload.decodedByteLength);
    assert.equal(sha256(decoded), manifest.payload.decodedSha256);
    const validation = validateTerrainManifest(manifest, { compressed: payload.byteLength, decoded: decoded.byteLength });
    assert.equal(validation.ok, true, validation.errors.join('; '));
    assert.ok(manifest.boundsM.min.every(Number.isFinite) && manifest.boundsM.max.every(Number.isFinite));
    const data = decodeTerrain(manifest, decoded), tolerance = manifest.quantization.stepM + .001;
    let validSamples = 0, minimum = Infinity, maximum = -Infinity;
    for (const tile of data.tiles.values()) {
      const count = tile.samples ** 2;
      assert.equal(tile.heightsM.length, count);
      assert.equal(tile.flowBytes.length, count);
      if (tile.validMask) assert.equal(tile.validMask.length, count);
      for (let i = 0; i < count; i++) {
        const height = tile.heightsM[i];
        if (tile.validMask && !tile.validMask[i]) {
          assert.ok(Number.isNaN(height), `${tile.id}: no-data must remain invalid`);
          continue;
        }
        assert.ok(Number.isFinite(height), `${tile.id}: valid elevation`);
        assert.ok(height >= tile.minY - tolerance && height <= tile.maxY + tolerance, `${tile.id}: decoded elevation stays within source bounds`);
        assert.ok(height >= manifest.boundsM.min[1] - tolerance && height <= manifest.boundsM.max[1] + tolerance, `${tile.id}: decoded elevation stays within package bounds`);
        validSamples++;
        minimum = Math.min(minimum, height); maximum = Math.max(maximum, height);
      }
    }
    assert.ok(validSamples > 0 && maximum > minimum, `${id}: usable terrain with real relief`);
  });
}
