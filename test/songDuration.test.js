import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDurationMs } from '../src/core/SongDuration.js';

test('a positive declared duration always wins', () => {
  assert.equal(resolveDurationMs([{ tMs: 0, durMs: 90 }], 5000), 5000);
  assert.equal(resolveDurationMs([], 1234), 1234);
});

test('falls back to the last event end + 3000ms grace when declared is missing', () => {
  const timeline = [
    { tMs: 1000, durMs: 200 },
    { tMs: 5000, durMs: 500 }, // ends at 5500, the latest
    { tMs: 3000, durMs: 100 },
  ];
  assert.equal(resolveDurationMs(timeline, 0), 5500 + 3000);
  assert.equal(resolveDurationMs(timeline, -1), 5500 + 3000);
  assert.equal(resolveDurationMs(timeline, undefined), 5500 + 3000);
});

test('empty timeline with no declared duration resolves to 0', () => {
  assert.equal(resolveDurationMs([], 0), 0);
  assert.equal(resolveDurationMs(null, 0), 0);
});

test('events with no durMs still contribute via tMs alone', () => {
  const timeline = [{ tMs: 2000 }, { tMs: 500 }];
  assert.equal(resolveDurationMs(timeline, 0), 2000 + 3000);
});
