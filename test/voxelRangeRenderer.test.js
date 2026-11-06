import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import voxelAsset from '../src/assets/range/v2/voxel/white-mountains-owens.v2.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { decodeVoxelRangePack, VoxelRange, voxelRangeRequested, voxelRangeFrameState, voxelRangeLayersAt, voxelRangeGrowthProgress } from '../src/render/VoxelRange.js';

const triangle = new Float32Array([
  0, 100, 0, 0.5, 0.25, 0.5, 0.125, 2,
  0, 100, 500, 0.5, 0.25, 0.5, 0.125, 2,
  500, 100, 0, 0.5, 0.25, 0.5, 0.125, 2,
]);

function assetFor(compressed, decoded = triangle) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  return { ...voxelAsset, payload: { ...voxelAsset.payload, byteLength: compressed.byteLength, sha256: hash(compressed),
    decodedByteLength: decoded.byteLength, decodedSha256: hash(decoded) } };
}

test('a changed voxel payload is rejected by its pin before inflation or GPU allocation', async t => {
  const zipped = gzipSync(triangle), asset = assetFor(zipped), altered = Buffer.from(zipped);
  altered[altered.length - 8] ^= 1;
  t.mock.method(globalThis, 'fetch', async () => new Response(altered));
  let inflations = 0;
  t.mock.method(globalThis, 'DecompressionStream', function() { inflations++; throw Error('unexpected inflate'); });
  const residency = new GraphicsResidency();
  const range = new VoxelRange({ asset, residency, ownerDocument: { createElement() { assert.fail('unexpected GPU allocation'); } } });
  assert.equal(await range.prepare(), false);
  assert.match(range.reason, /hash/i);
  assert.equal(inflations, 0);
  assert.equal(residency.usedBytes, 0);
});

test('a valid compressed voxel pack must also match its decoded hash', async t => {
  const zipped = gzipSync(triangle), asset = assetFor(zipped);
  asset.payload.decodedSha256 = '0'.repeat(64);
  t.mock.method(globalThis, 'fetch', async () => new Response(zipped));
  const residency = new GraphicsResidency();
  const range = new VoxelRange({ asset, residency, ownerDocument: { createElement() { assert.fail('unexpected GPU allocation'); } } });
  assert.equal(await range.prepare(), false);
  assert.match(range.reason, /decoded.*hash/i);
  assert.equal(residency.usedBytes, 0);
});

test('the voxel renderer requires an explicit URL opt-in', () => {
  assert.equal(voxelRangeRequested(''), false);
  assert.equal(voxelRangeRequested('?voxelRange=off'), false);
  assert.equal(voxelRangeRequested('?voxelRange=1'), true);
});

test('a voxel pack needs complete triangles with valid reveal lifetimes', () => {
  const decoded = decodeVoxelRangePack(triangle.buffer);
  assert.deepEqual(decoded.vertices, triangle);
  assert.equal(decoded.version, 1);
  assert.equal(decoded.levels[0].vertexCount, 3);
  assert.throws(() => decodeVoxelRangePack(triangle.buffer.slice(4)), /length/);
  const broken = triangle.slice();
  broken[7] = 0;
  assert.throws(() => decodeVoxelRangePack(broken.buffer), /vertex/);
  const partial = triangle.slice();
  partial[14] = 0.25;
  assert.throws(() => decodeVoxelRangePack(partial.buffer), /lifetime/);
});

test('a refused voxel load never starts inflation and releases its pending reservations', async t => {
  const zipped = gzipSync(triangle);
  const decompressor = globalThis.DecompressionStream;
  let inflations = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(zipped));
  t.mock.method(globalThis, 'DecompressionStream', function(format) {
    inflations++;
    return new decompressor(format);
  });
  for (const budgetBytes of [100, 128 * 1024]) {
    const residency = new GraphicsResidency({ budgetBytes });
    const range = new VoxelRange({ asset: assetFor(zipped), residency, ownerDocument: { createElement() { throw Error('unexpected GPU allocation'); } } });
    assert.equal(await range.prepare(), false);
    assert.match(range.reason, /budget/i);
    assert.equal(inflations, 0);
    assert.equal(residency.usedBytes, 0);
  }
});

test('an oversized gzip declaration is refused before inflation', async t => {
  const zipped = gzipSync(triangle);
  zipped.writeUInt32LE(256 * 1024 * 1024 + 4, zipped.length - 4);
  const residency = new GraphicsResidency();
  const asset = assetFor(zipped);
  asset.payload.decodedByteLength = 256 * 1024 * 1024 + 4;
  const range = new VoxelRange({ asset, residency, ownerDocument: null });
  t.mock.method(globalThis, 'fetch', async () => new Response(zipped));
  let inflations = 0;
  t.mock.method(globalThis, 'DecompressionStream', function() { inflations++; throw Error('unexpected inflate'); });
  assert.equal(await range.prepare(), false);
  assert.match(range.reason, /length|size/i);
  assert.equal(inflations, 0);
  assert.equal(residency.usedBytes, 0);
});

test('an oversized compressed response is cancelled before allocating a decoded buffer', async t => {
  const chunk = new Uint8Array(1024 * 1024);
  chunk[0] = 0x1f; chunk[1] = 0x8b;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(stream));
  const residency = new GraphicsResidency();
  const range = new VoxelRange({ asset: assetFor(gzipSync(triangle)), residency, ownerDocument: null });
  assert.equal(await range.prepare(), false);
  assert.match(range.reason, /response.*size/i);
  assert.equal(cancelled, true);
  assert.equal(residency.usedBytes, 0);
});

test('a gzip that expands past its declaration fails and releases CPU and GPU admission', async t => {
  const zipped = gzipSync(new Uint8Array(2 * 1024 * 1024));
  zipped.writeUInt32LE(96, zipped.length - 4);
  const residency = new GraphicsResidency();
  const range = new VoxelRange({ asset: assetFor(zipped, new Uint8Array(96)), residency, ownerDocument: null });
  t.mock.method(globalThis, 'fetch', async () => new Response(zipped));
  assert.equal(await range.prepare(), false);
  assert.match(range.reason, /length|size|gzip|incorrect|exceed/i);
  assert.equal(residency.usedBytes, 0);
});

test('corrupt gzip and a later GPU refusal both release decode staging', async t => {
  const zipped = gzipSync(triangle);
  const residency = new GraphicsResidency();
  const corrupted = Buffer.from(zipped);
  corrupted[corrupted.length - 8] ^= 1;
  let next = corrupted;
  t.mock.method(globalThis, 'fetch', async () => new Response(next));
  const corruptRange = new VoxelRange({ asset: assetFor(corrupted), residency, ownerDocument: null });
  assert.equal(await corruptRange.prepare(), false);
  assert.match(corruptRange.reason, /gzip/i);
  assert.equal(residency.usedBytes, 0);
  next = zipped;
  const gpuRefusal = new VoxelRange({ asset: assetFor(zipped), residency, ownerDocument: { createElement: () => ({ getContext: () => null }) } });
  assert.equal(await gpuRefusal.prepare(), false);
  assert.match(gpuRefusal.reason, /WebGL2/);
  assert.equal(residency.usedBytes, 0);
});

test('transfer-decoded voxel responses are checked against the decoded pin', async t => {
  const zipped = gzipSync(triangle), asset = assetFor(zipped);
  let next = new Uint8Array(triangle.buffer);
  t.mock.method(globalThis, 'fetch', async () => new Response(next));
  const residency = new GraphicsResidency();
  const ownerDocument = { createElement: () => ({ getContext: () => null }) };
  const valid = new VoxelRange({ asset, residency, ownerDocument });
  assert.equal(await valid.prepare(), false);
  assert.match(valid.reason, /WebGL2/);
  next = next.slice(); next[0] ^= 1;
  const changed = new VoxelRange({ asset, residency, ownerDocument });
  assert.equal(await changed.prepare(), false);
  assert.match(changed.reason, /hash/);
  assert.equal(residency.usedBytes, 0);
});

test('the default payload pins reject a substituted tiny fixture', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(gzipSync(triangle)));
  const residency = new GraphicsResidency();
  const range = new VoxelRange({ residency, ownerDocument: null });
  assert.equal(await range.prepare(), false);
  assert.match(range.reason, /length.*pin/);
  assert.equal(residency.usedBytes, 0);
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

test('the progressive camera and raster return to the same state after a seek', () => {
  const opening = voxelRangeFrameState(.025, 1920, 1080);
  const middle = voxelRangeFrameState(.5, 1920, 1080);
  const ending = voxelRangeFrameState(1, 1920, 1080);
  assert.equal(opening.width, 320);
  assert.equal(opening.height, 180);
  assert.ok(opening.camera.fovYDeg < middle.camera.fovYDeg);
  assert.ok(middle.camera.fovYDeg < ending.camera.fovYDeg);
  assert.ok(middle.width > opening.width && middle.width < ending.width);
  assert.equal(ending.width, 1280);
  assert.equal(ending.height, 720);
  assert.equal(ending.camera.fovYDeg, 24);
  assert.ok(ending.camera.eyeM[1] > 2000);
  voxelRangeFrameState(.9, 1920, 1080);
  assert.deepEqual(voxelRangeFrameState(.5, 1920, 1080), middle);
  const portrait = voxelRangeFrameState(1, 540, 960);
  assert.ok(portrait.width <= 540 && portrait.height <= 720);
});

test('only adjacent terrain levels dissolve and the final smooth mesh replaces the columns', () => {
  const levels = [
    { startProgress: 0, endProgress: 0 },
    { startProgress: .2, endProgress: .3 },
    { startProgress: .8, endProgress: .95 },
  ];
  assert.deepEqual(voxelRangeLayersAt(.1, levels), [{ index: 0, weight: 1 }]);
  const transition = voxelRangeLayersAt(.25, levels);
  assert.equal(transition.length, 2);
  assert.deepEqual(transition.map(layer => layer.index), [0, 1]);
  assert.ok(Math.abs(transition[0].weight - .5) < 1e-8);
  assert.ok(Math.abs(transition[1].weight - .5) < 1e-8);
  assert.deepEqual(voxelRangeLayersAt(1, levels), [{ index: 2, weight: 1 }]);
});

test('all terrain is built before the smooth surface replaces its temporary voxel walls', () => {
  assert.equal(voxelRangeGrowthProgress(.025), .025);
  assert.ok(voxelRangeGrowthProgress(.5) > .5);
  assert.equal(voxelRangeGrowthProgress(.84), 1);
  assert.equal(voxelRangeGrowthProgress(.96), 1);
  assert.equal(voxelRangeGrowthProgress(1), 1);
  assert.equal(voxelRangeGrowthProgress(.96, 1), .96);
});

test('intermediate 16 by 9 rasters retain their aspect even when the height is odd', () => {
  const frame = voxelRangeFrameState(.33, 960, 540);
  assert.equal(frame.width, 464);
  assert.equal(frame.height, 261);
  assert.equal(frame.width / frame.height, 16 / 9);
});

test('rendering refines the resident terrain without rebuilding or uploading geometry', () => {
  const calls = [];
  const range = new VoxelRange({ ownerDocument: null, residency: null });
  range.state = 'ready'; range.program = 'terrain'; range.skyProgram = 'sky';
  range.canvas = { width: 320, height: 180 };
  range.score = { progressAt: timeMs => timeMs / 1000 };
  range.levels = [
    { firstVertex: 0, vertexCount: 30, startProgress: 0, endProgress: 0, kind: 'columns', cellSizeM: 500 },
    { firstVertex: 30, vertexCount: 60, startProgress: .2, endProgress: .3, kind: 'smooth', cellSizeM: 44 },
  ];
  range.cameraUniforms = { eye: 'eye', forward: 'forward', right: 'right', up: 'up' };
  range.gl = {
    isContextLost: () => false, viewport() {}, clear() {}, disable() {}, enable() {},
    useProgram(program) { this.program = program; },
    uniform3fv(name, value) { assert.ok(value.every(Number.isFinite)); }, uniform2f() {}, uniform1f() {},
    drawArrays(mode, first, count) { calls.push({ program: this.program, first, count }); },
    bufferData() { throw new Error('per-frame upload'); },
  };
  range.render(250, 1920, 1080);
  assert.deepEqual(calls.map(call => call.program), ['sky', 'terrain', 'terrain']);
  calls.length = 0;
  range.render(1000, 1920, 1080);
  assert.deepEqual(calls, [{ program: 'sky', first: 0, count: 3 }, { program: 'terrain', first: 30, count: 60 }]);
  assert.equal(range.canvas.width, 1280);
  assert.equal(range.canvas.height, 720);
  assert.equal(range.activeLevels[0].kind, 'smooth');
});
