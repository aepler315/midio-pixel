import assert from 'node:assert/strict';
import test from 'node:test';
import { bakeVoxelRange } from '../tools/build-voxel-range.mjs';

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
