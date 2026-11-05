import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { verifyVoxelRangePack } from '../tools/stage-site.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'midio-voxel-stage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'terrain'));
  await fs.mkdir(path.join(root, 'voxel'));
  const terrain = Buffer.from(JSON.stringify({ source: { demSha256: 'a'.repeat(64) }, payload: { sha256: 'b'.repeat(64) } }));
  await fs.writeFile(path.join(root, 'terrain/white-mountains-owens.terrain.json'), terrain);
  const decoded = Buffer.from('mountain mesh fixture'), compressed = gzipSync(decoded);
  const view = { id: 'white-mountains-owens', terrainManifestUrl: 'terrain/white-mountains-owens.terrain.json', terrainManifestSha256: sha(terrain) };
  const metadata = {
    schema: 'midio.voxel-range', version: 2, viewId: view.id,
    source: { mode: 'rail', terrainManifestUrl: view.terrainManifestUrl, terrainManifestSha256: sha(terrain), terrainPayloadSha256: 'b'.repeat(64), demSha256: 'a'.repeat(64) },
    payload: { url: 'white-mountains-owens.v2.bin.gz', encoding: 'gzip', byteLength: compressed.length, sha256: sha(compressed), decodedByteLength: decoded.length, decodedSha256: sha(decoded) },
  };
  await fs.writeFile(path.join(root, 'voxel', metadata.payload.url), compressed);
  const writeMetadata = () => fs.writeFile(path.join(root, 'voxel/white-mountains-owens.v2.js'), 'export default ' + JSON.stringify(metadata) + ';\n');
  await writeMetadata();
  return { root, metadata, writeMetadata, catalog: { views: [view] } };
}

test('staging requires the voxel pack and its declared compressed and decoded identities', async t => {
  const f = await fixture(t);
  await verifyVoxelRangePack(f.root, f.catalog);
  f.metadata.payload.decodedSha256 = 'c'.repeat(64);
  await f.writeMetadata();
  await assert.rejects(verifyVoxelRangePack(f.root, f.catalog), /decoded bytes do not match/);
  f.metadata.payload.sha256 = 'd'.repeat(64);
  await f.writeMetadata();
  await assert.rejects(verifyVoxelRangePack(f.root, f.catalog), /does not match/);
  await fs.rm(path.join(f.root, 'voxel', f.metadata.payload.url));
  await assert.rejects(verifyVoxelRangePack(f.root, f.catalog), /ENOENT/);
});

test('staging rejects a voxel bake with stale terrain provenance or the full tour footprint', async t => {
  const f = await fixture(t);
  for (const key of ['terrainManifestSha256', 'terrainPayloadSha256', 'demSha256', 'mode']) {
    const original = f.metadata.source[key];
    f.metadata.source[key] = key === 'mode' ? 'tour' : 'f'.repeat(64);
    await f.writeMetadata();
    await assert.rejects(verifyVoxelRangePack(f.root, f.catalog), /Voxel.*source/i);
    f.metadata.source[key] = original;
  }
});

test('staging cannot silently omit voxel metadata', async t => {
  const f = await fixture(t);
  await fs.rm(path.join(f.root, 'voxel/white-mountains-owens.v2.js'));
  await assert.rejects(verifyVoxelRangePack(f.root, f.catalog), /Voxel.*metadata/i);
});
