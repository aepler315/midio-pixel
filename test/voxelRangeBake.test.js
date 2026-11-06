import assert from 'node:assert/strict';
import test from 'node:test';
import { bakeVoxelRange, bakeProgressiveVoxelRange, createVoxelRangeAsset } from '../tools/build-voxel-range.mjs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { decodeVoxelRangePack } from '../src/render/VoxelRange.js';

test('voxel asset metadata pins both byte representations and the source terrain deterministically', () => {
  const decoded = Buffer.from('terrain'), compressed = gzipSync(decoded);
  const view = { id: 'white-mountains-owens', terrainManifestUrl: 'terrain/owens.json', terrainManifestSha256: 'a'.repeat(64) };
  const terrain = { source: { demSha256: 'b'.repeat(64) }, payload: { sha256: 'c'.repeat(64) } };
  const asset = createVoxelRangeAsset(view, terrain, compressed, decoded);
  assert.deepEqual(createVoxelRangeAsset(view, terrain, compressed, decoded), asset);
  assert.equal(asset.payload.byteLength, compressed.length);
  assert.equal(asset.payload.sha256, createHash('sha256').update(compressed).digest('hex'));
  assert.equal(asset.payload.decodedByteLength, decoded.length);
  assert.equal(asset.payload.decodedSha256, createHash('sha256').update(decoded).digest('hex'));
  assert.equal(asset.source.demSha256, terrain.source.demSha256);
  assert.equal(asset.source.terrainManifestSha256, view.terrainManifestSha256);
  assert.equal(asset.source.terrainPayloadSha256, terrain.payload.sha256);
  assert.equal(asset.source.mode, 'rail');
});

test('the progressive bake excludes terrain that only a shot tour can see', () => {
  const tiles = new Map([
    ['rail', { ix: 0, iz: 0, samples: 2, stride: 1, heightsM: new Float32Array(4).fill(100) }],
    ['tour', { ix: 1, iz: 0, rail: false, samples: 2, stride: 1, heightsM: new Float32Array(4).fill(200) }],
  ]);
  const data = { grid: { originM: [0, 0], width: 3, height: 2, cellSizeM: 500 }, cells: 1,
    manifest: { tilesX: 2, tilesZ: 1 }, tiles, byIndex: new Map([...tiles.values()].map(tile => [`${tile.ix},${tile.iz}`, tile])) };
  const camera = { eyeM: [250, 1000, 2000], targetM: [500, 100, 0], fovYDeg: 24 };
  const bytes = bakeProgressiveVoxelRange(data, camera, { smoothCellM: 125 });
  const decoded = decodeVoxelRangePack(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  for (let vertex = 0; vertex < decoded.vertices.length; vertex += 8) assert.ok(decoded.vertices[vertex] <= 500);
  assert.equal(data.tiles.size, 2, 'the source package keeps its tour ground');
});

function faces(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = [];
  for (let start = 0; start < bytes.length; start += 6 * 8 * 4) {
    const vertices = Array.from({ length: 6 }, (_, vertex) => Array.from({ length: 8 }, (_, field) =>
      view.getFloat32(start + (vertex * 8 + field) * 4, true)));
    result.push({ vertices, show: vertices[0][6], hide: vertices[0][7] });
  }
  return result;
}

test('voxel range emits timed exterior faces without an overlapping wall after adjacent columns arrive', () => {
  const heights = new Map([[250, 149], [750, 264]]);
  const data = {
    grid: { originM: [0, 0], width: 3, height: 2, cellSizeM: 500 },
    groundAt: x => heights.get(x),
  };
  const camera = { eyeM: [0, 0, 0], targetM: [0, 0, -1000], fovYDeg: 24 };
  const bytes = bakeVoxelRange(data, camera);
  assert.deepEqual(bakeVoxelRange(data, camera), bytes);
  const quads = faces(bytes);
  const shared = quads.filter(({ vertices }) => vertices.every(v => v[0] === 500));
  assert.deepEqual(shared.map(({ vertices, show, hide }) => [
    Math.min(...vertices.map(v => v[1])), Math.max(...vertices.map(v => v[1])), show, hide,
  ]), [[0, 100, 0, 1], [100, 300, 1, 2]]);
  assert.equal(quads.length, 10);
  assert.equal(quads.filter(({ vertices, hide }) => hide === 2 && vertices.every(v => v[1] === vertices[0][1])).length, 2);
  for (const { vertices, show, hide } of quads) {
    assert.ok(vertices.every(v => v[6] === show && v[7] === hide));
    assert.ok(vertices.every(v => v.slice(3, 6).every(c => c > 0 && c <= 1)));
  }
});

test('the opening promotes a framed foothill ahead of lower terrain behind the camera', () => {
  const heights = new Map([[-2250, 2000], [-1250, 300], [1250, 100]]);
  const data = {
    grid: { originM: [500, -2500], width: 2, height: 9, cellSizeM: 500 },
    groundAt: (_, z) => heights.get(z),
  };
  const eyeM = [750, 650, 1000];
  const tops = faces(bakeVoxelRange(data, { eyeM, targetM: [750, 650, -3000], fovYDeg: 24 }))
    .filter(({ vertices }) => vertices.every(v => v[1] === vertices[0][1]));
  assert.deepEqual(tops.map(({ vertices, show }) => [vertices[0][1], show]), [[300, 0], [100, .5], [2000, 1]]);
});

test('progressive packs finish on the unquantized DEM and validate their level ranges', () => {
  const data = {
    grid: { originM: [0, 0], width: 3, height: 3, cellSizeM: 500 },
    groundAt: (x, z) => 100 + x * .123 + z * .057,
  };
  const camera = { eyeM: [250, 1000, 2000], targetM: [500, 100, 0], fovYDeg: 24 };
  const bytes = bakeProgressiveVoxelRange(data, camera, { smoothCellM: 125 });
  const packed = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const decoded = decodeVoxelRangePack(packed);
  assert.equal(decoded.version, 2);
  assert.deepEqual(decoded.levels.map(level => level.cellSizeM), [500, 250, 125, 62.5, 125]);
  assert.equal(decoded.levels.at(-1).kind, 'smooth');
  assert.deepEqual(bakeProgressiveVoxelRange(data, camera, { smoothCellM: 125 }), bytes);
  const last = decoded.levels.at(-1);
  for (let vertex = last.firstVertex; vertex < last.firstVertex + last.vertexCount; vertex++) {
    const at = vertex * 8;
    const [x, y, z] = decoded.vertices.subarray(at, at + 3);
    assert.ok(Math.abs(y - data.groundAt(x, z)) < .0001);
  }
  const broken = packed.slice(0);
  new DataView(broken).setUint32(32, 3, true);
  assert.throws(() => decodeVoxelRangePack(broken), /level/);
  assert.throws(() => decodeVoxelRangePack(packed.slice(0, -4)), /length/);
});
