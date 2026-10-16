import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSeed, parseSeed, resolveSongSeed, seedFromTimeline } from '../src/utils/seed.js';

test('formatSeed pads to 8 hex digits', () => {
  assert.equal(formatSeed(0), '00000000');
  assert.equal(formatSeed(255), '000000FF');
  assert.equal(formatSeed(0xA3F0C12B), 'A3F0C12B');
});

test('parseSeed accepts hex, decimal, free text, empty', () => {
  assert.equal(parseSeed(''), null);
  assert.equal(parseSeed(null), null);
  assert.equal(parseSeed('A3F0C12B'), 0xA3F0C12B);
  assert.equal(parseSeed('0xa3f0c12b'), 0xA3F0C12B);
  assert.equal(parseSeed('42'), 42);
  assert.ok(Number.isFinite(parseSeed('hello-world')));
  assert.notEqual(parseSeed('hello'), parseSeed('world'));
});

test('resolveSongSeed prefers pinned over timeline', () => {
  const conductor = {
    durationMs: 10000,
    timeline: [{ tMs: 0 }, { tMs: 9000 }],
  };
  const auto = seedFromTimeline(conductor);
  assert.equal(resolveSongSeed(conductor, null), auto);
  assert.equal(resolveSongSeed(conductor, 0xDEADBEEF), 0xDEADBEEF);
});
