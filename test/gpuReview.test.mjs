import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as gpuReview from '../tools/gpu-review.mjs';
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

test('WSL snapshot metadata records the frozen checkout commit and actual clean or dirty Git state', async () => {
  assert.equal(typeof gpuReview.gpuReviewSourceMetadata, 'function');
  const checkout = await fs.mkdtemp(path.join(os.tmpdir(), 'gpu-review-source-'));
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', windowsHide: true }).trim();
  try {
    git('init', '--quiet');
    await fs.writeFile(path.join(checkout, 'index.html'), '<!doctype html>');
    git('add', 'index.html');
    git('-c', 'user.name=GPU fixture', '-c', 'user.email=gpu-fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    const commit = git('rev-parse', 'HEAD');
    const clean = await gpuReview.gpuReviewSourceMetadata(checkout);
    assert.deepEqual(clean, { label: 'Local RTX 3060 test', checkout, commit, dirty: '' });
    assert.match(clean.commit, /^[a-f0-9]{40}$/);
    await fs.writeFile(path.join(checkout, 'index.html'), '<!doctype html><title>edited</title>');
    await fs.writeFile(path.join(checkout, 'untracked.txt'), 'new file');
    const dirty = await gpuReview.gpuReviewSourceMetadata(checkout);
    assert.equal(dirty.commit, commit);
    assert.match(dirty.dirty, /M index\.html/);
    assert.match(dirty.dirty, /\?\? untracked\.txt/);
    assert.equal(dirty.checkout, checkout);
  } finally { await fs.rm(checkout, { recursive: true, force: true }); }
});
