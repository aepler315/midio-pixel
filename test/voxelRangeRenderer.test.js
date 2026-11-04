import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeVoxelRangePack, VoxelRange, voxelRangeRequested } from '../src/render/VoxelRange.js';

const triangle = new Float32Array([
  0, 100, 0, 0.5, 0.25, 0.5, 0.125, 2,
  0, 100, 500, 0.5, 0.25, 0.5, 0.125, 2,
  500, 100, 0, 0.5, 0.25, 0.5, 0.125, 2,
]);

test('the voxel renderer requires an explicit URL opt-in', () => {
  assert.equal(voxelRangeRequested(''), false);
  assert.equal(voxelRangeRequested('?voxelRange=off'), false);
  assert.equal(voxelRangeRequested('?voxelRange=1'), true);
});

test('a voxel pack needs complete triangles with valid reveal lifetimes', () => {
  assert.deepEqual(decodeVoxelRangePack(triangle.buffer), triangle);
  assert.throws(() => decodeVoxelRangePack(triangle.buffer.slice(4)), /length/);
  const broken = triangle.slice();
  broken[7] = 0;
  assert.throws(() => decodeVoxelRangePack(broken.buffer), /vertex/);
  const partial = triangle.slice();
  partial[14] = 0.25;
  assert.throws(() => decodeVoxelRangePack(partial.buffer), /lifetime/);
});

test('full analysis preserves the heard build and retimes only the future', () => {
  const range = new VoxelRange({ ownerDocument: null, residency: null });
  const sim = {
    analysisOpening: { analyzedMs: 2000 },
    conductor: { durationMs: 8000 },
    biomes: { sections: [{ startMs: 0, endMs: 8000 }] },
  };
  range.setSong(1, sim);
  const opening = range.score;
  sim.analysisOpening = null;
  sim.biomes.sections = [{ startMs: 0, endMs: 2000 }, { startMs: 2000, endMs: 8000 }];
  range.setSong(1, sim, 1000);
  assert.equal(range.score.progressAt(500), opening.progressAt(500));
  assert.equal(range.score.progressAt(1000), opening.progressAt(1000));
  assert.ok(Math.abs(range.score.progressAt(2000) - .43666666666666665) < 1e-9);
  assert.equal(range.score.progressAt(8000), 1);
  const atTwoSeconds = range.score.progressAt(2000);
  range.setSong(1, sim, 3000);
  assert.equal(range.score.progressAt(2000), atTwoSeconds);
});
