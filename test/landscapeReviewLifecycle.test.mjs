import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReviewRunOwner } from '../tools/lib/landscape-review-lifecycle.mjs';
import { parseReviewArgs, runLandscapeReview } from '../tools/landscape-review.mjs';

test('interruption closes current and late resources exactly once and retains cleanup failures', async () => {
  const signals = new EventEmitter(), owner = new ReviewRunOwner(signals), closed = [];
  owner.own(() => { closed.push('server'); });
  owner.own(() => { closed.push('browser'); throw Error('browser close failed'); });
  signals.emit('SIGINT');
  owner.own(() => { closed.push('late launch'); });
  signals.emit('SIGTERM');
  assert.throws(() => owner.check(), error => error.signal === 'SIGINT' && error.exitCode === 130);
  assert.deepEqual(await owner.close(), ['browser close failed']);
  assert.deepEqual(closed.sort(), ['browser', 'late launch', 'server']);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('SIGTERM aborts an owned helper process and cleanup waits for its exit', async () => {
  const signals = new EventEmitter(), owner = new ReviewRunOwner(signals);
  const child = owner.execFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const rejected = assert.rejects(child, error => error.code === 'REVIEW_CANCELLED' && error.exitCode === 143);
  signals.emit('SIGTERM');
  await rejected;
  assert.deepEqual(await owner.close(), []);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} during launch saves a cancelled report even if browser cleanup fails`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'landscape-cancel-'));
    const signals = new EventEmitter();
    let closes = 0, launchOptions;
    try {
      await fs.mkdir(path.join(dir, 'src'));
      await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html>');
      await fs.writeFile(path.join(dir, 'src/main.js'), '// fixture');
      const args = parseReviewArgs(['--out', path.join(dir, 'review'), '--source', dir, '--no-mp4']);
      await assert.rejects(runLandscapeReview(args, { signals, launch: async options => {
        launchOptions = options;
        signals.emit(signal);
        return { close: async () => { closes++; throw Error('fixture close rejection'); } };
      } }), error => error.code === 'REVIEW_CANCELLED' && error.signal === signal);
      const report = JSON.parse(await fs.readFile(path.join(args.out, 'report.json')));
      assert.equal(report.status, 'cancelled');
      assert.equal(report.failure.signal, signal);
      assert.equal(report.failure.exitCode, signal === 'SIGINT' ? 130 : 143);
      assert.deepEqual(report.cleanupErrors, ['fixture close rejection']);
      assert.ok(report.finishedAt);
      assert.match(await fs.readFile(path.join(args.out, 'index.html'), 'utf8'), /Technical status: cancelled/);
      assert.equal(closes, 1);
      assert.equal(launchOptions.headless, true);
      assert.equal(launchOptions.handleSIGINT, false);
      assert.equal(launchOptions.handleSIGTERM, false);
      assert.equal(launchOptions.ignoreDefaultArgs, undefined, 'Chromium default mute-audio remains enabled');
      assert.equal(launchOptions.userDataDir, undefined, 'review never selects a user profile');
      assert.equal(signals.listenerCount(signal), 0);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
}
