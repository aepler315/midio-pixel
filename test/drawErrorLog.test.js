// Draw failures should be countable and visible, not a console line nobody
// reads. This is the guard that would have surfaced the hype-echo throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DrawErrorLog } from '../src/render/DrawErrorLog.js';

test('a healthy frame loop reports nothing at all', () => {
  const log = new DrawErrorLog();
  assert.equal(log.summary, null);
  assert.equal(log.worst, null);
  assert.equal(log.total, 0);
});

test('every failure is counted even though only some are logged', () => {
  const log = new DrawErrorLog();
  let logged = 0;
  for (let i = 0; i < 1000; i++) if (log.record(new Error('boom'), i)) logged++;
  assert.equal(log.total, 1000, 'the tally is complete');
  // 1,2,4,...,512 -> 10 lines for a thousand failures.
  assert.equal(logged, 10, `expected log2-ish logging, got ${logged}`);
  assert.match(log.summary, /1000 draw errors/);
  assert.match(log.summary, /boom/);
});

test('the first failure always logs -- a one-off is never silent', () => {
  const log = new DrawErrorLog();
  assert.equal(log.record(new Error('once'), 0), true);
  assert.match(log.summary, /1 draw error\b/, 'and it reads as singular');
});

test('distinct failures are tracked separately, worst first', () => {
  const log = new DrawErrorLog();
  for (let i = 0; i < 5; i++) log.record(new Error('rare'), i);
  for (let i = 0; i < 50; i++) log.record(new Error('common'), i);
  assert.equal(log.byMessage.size, 2);
  assert.equal(log.worst.message, 'common');
  assert.equal(log.worst.count, 50);
  assert.match(log.summary, /2 kinds/);
});

test('it survives whatever the catch actually hands it', () => {
  const log = new DrawErrorLog();
  for (const junk of [null, undefined, 'a string', 42, { nope: 1 }]) {
    assert.doesNotThrow(() => log.record(junk, 0));
  }
  assert.equal(log.total, 5);
  assert.ok(log.summary);
});

test('a long message is truncated so the readout stays one line', () => {
  const log = new DrawErrorLog();
  log.record(new Error('x'.repeat(400)), 0);
  assert.ok(log.summary.length < 160, `summary too long: ${log.summary.length}`);
});

test('first and last timestamps bracket the failure', () => {
  const log = new DrawErrorLog();
  log.record(new Error('e'), 1000);
  log.record(new Error('e'), 9000);
  assert.equal(log.worst.firstMs, 1000);
  assert.equal(log.worst.lastMs, 9000);
});

test('reset clears it for a fresh song', () => {
  const log = new DrawErrorLog();
  log.record(new Error('e'), 0);
  log.reset();
  assert.equal(log.total, 0);
  assert.equal(log.summary, null);
});
