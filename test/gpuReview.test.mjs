import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuReviewArgs } from '../tools/gpu-review.mjs';
import { parseReviewArgs } from '../tools/landscape-review.mjs';

test('GPU test always requires the RTX 3060 and keeps a unique local output', () => {
  const args = parseReviewArgs(gpuReviewArgs(['--grid', 'classic', '--live-seconds', '30'], 123));
  assert.equal(args.hardware, true);
  assert.equal(args.gpuMatch, 'RTX 3060');
  assert.equal(args.liveSeconds, 30);
  assert.match(args.out, /gpu-123$/);
  assert.equal(args.mp4, false);
  assert.notEqual(gpuReviewArgs([], 123).at(-1), gpuReviewArgs([], 124).at(-1));
});

test('GPU test preserves explicit paths and rejects foreground or different-GPU requests', () => {
  const args = parseReviewArgs(gpuReviewArgs(['--out', 'my results', '--audio', 'my song.wav']));
  assert.equal(args.out, 'my results'); assert.equal(args.audio, 'my song.wav');
  for (const input of [['--headful'], ['--open'], ['--gpu-match', 'SwiftShader']]) assert.throws(() => gpuReviewArgs(input));
  assert.equal(gpuReviewArgs(['--help']), null);
});

test('GPU review preserves the Cinematic look through its strict review parser', () => {
  const args = parseReviewArgs(gpuReviewArgs(['--out', 'cinematic-gpu', '--look', 'cinematic', '--grid', 'classicPlus']));
  assert.equal(args.look, 'cinematic');
  assert.deepEqual(args.grids, ['classicPlus']);
  assert.equal(args.hardware, true);
  assert.throws(() => gpuReviewArgs(['--look', 'unknown']));
});
