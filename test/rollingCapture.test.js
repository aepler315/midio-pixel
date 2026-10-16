// The ring's wrap-around arithmetic is the only part of the capture path with
// a real chance of being silently wrong -- and "silently" is the problem: a
// mis-ordered read still fingerprints, it just matches nothing, which looks
// like the microphone not working rather than like an off-by-one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RollingCapture } from '../src/audio/RollingCapture.js';

const ramp = (n, from = 0) => Float32Array.from({ length: n }, (_, i) => from + i);

test('a fresh buffer holds nothing', () => {
  const c = new RollingCapture(1, 100);
  assert.equal(c.filled, 0);
  assert.equal(c.seconds, 0);
  assert.equal(c.read().length, 0);
});

test('a partial fill reads back exactly what went in', () => {
  const c = new RollingCapture(1, 100);
  c.push(ramp(30));
  assert.equal(c.filled, 30);
  assert.deepEqual(Array.from(c.read()), Array.from(ramp(30)));
});

test('several pushes concatenate in order', () => {
  const c = new RollingCapture(1, 100);
  c.push(ramp(10, 0));
  c.push(ramp(10, 10));
  c.push(ramp(10, 20));
  assert.deepEqual(Array.from(c.read()), Array.from(ramp(30)));
});

test('an exactly-full buffer reads back in order', () => {
  const c = new RollingCapture(1, 100);
  c.push(ramp(100));
  assert.equal(c.filled, 100);
  assert.deepEqual(Array.from(c.read()), Array.from(ramp(100)));
});

test('once wrapped it holds the most recent window, oldest first', () => {
  // The property that matters: read() is chronological across the wrap.
  const c = new RollingCapture(1, 100);
  c.push(ramp(150));
  assert.equal(c.filled, 100);
  assert.deepEqual(Array.from(c.read()), Array.from(ramp(100, 50)));
});

test('wrapping across many small pushes stays chronological', () => {
  const c = new RollingCapture(1, 100);
  for (let i = 0; i < 37; i++) c.push(ramp(7, i * 7));
  const total = 37 * 7;
  assert.equal(c.filled, 100);
  assert.deepEqual(Array.from(c.read()), Array.from(ramp(100, total - 100)));
});

test('a push larger than the whole ring keeps only its tail', () => {
  const c = new RollingCapture(1, 100);
  c.push(ramp(250));
  assert.deepEqual(Array.from(c.read()), Array.from(ramp(100, 150)));
});

test('a huge push does not do redundant work', () => {
  // Writing every sample of a 10x-oversized chunk means overwriting the same
  // slots nine times for no reason. Only the tail can survive.
  const c = new RollingCapture(1, 1000);
  const big = ramp(1_000_000);
  const t0 = Date.now();
  c.push(big);
  assert.ok(Date.now() - t0 < 200, 'an oversized push should skip to its tail');
  assert.equal(c.read()[0], 999_000);
});

test('seconds reflects the held audio, not the capacity', () => {
  const c = new RollingCapture(2, 50); // 100 samples
  c.push(ramp(25));
  assert.equal(c.seconds, 0.5);
  c.push(ramp(200));
  assert.equal(c.seconds, 2);
});

test('empty and null pushes are no-ops', () => {
  const c = new RollingCapture(1, 100);
  c.push(null);
  c.push(new Float32Array(0));
  assert.equal(c.filled, 0);
});

test('reset forgets the history', () => {
  const c = new RollingCapture(1, 100);
  c.push(ramp(150));
  c.reset();
  assert.equal(c.filled, 0);
  assert.equal(c.read().length, 0);
  c.push(ramp(5));
  assert.deepEqual(Array.from(c.read()), [0, 1, 2, 3, 4]);
});

test('read returns a copy, not a view onto the ring', () => {
  // A view would keep mutating under the caller as new audio arrived, which
  // for a fingerprint in progress means hashing a moving target.
  const c = new RollingCapture(1, 100);
  c.push(ramp(50));
  const first = c.read();
  c.push(ramp(50, 50));
  assert.equal(first[0], 0, 'the earlier read must not have changed');
  assert.equal(first.length, 50);
});
