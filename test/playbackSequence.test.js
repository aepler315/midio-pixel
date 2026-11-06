import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PlaybackSequence } from '../src/library/PlaybackSequence.js';
const tracks = () => ['a', 'b', 'c'].map(key => ({ key, title: key.toUpperCase(), path: `${key}.mp3` }));
const pick = (sequence, rows, options = {}) => sequence.next(rows, options)?.key ?? null;

test('shuffle consumes the current track and exhausts its bag before starting another cycle', () => {
  const sequence = new PlaybackSequence({ random: () => 0 }), rows = tracks();
  assert.equal(pick(sequence, rows, { previousId: 'a' }), 'b');
  assert.equal(pick(sequence, rows, { previousId: 'b' }), 'c');
  const cycle = [], previous = 'c';
  let current = previous;
  for (let i = 0; i < rows.length; i++) {
    const next = pick(sequence, rows, { previousId: current });
    assert.notEqual(next, current);
    cycle.push(next); current = next;
  }
  assert.deepEqual([...cycle].sort(), ['a', 'b', 'c']);
});

test('shuffle still exhausts its bag when callers do not supply the previous track', () => {
  const sequence = new PlaybackSequence({ random: () => .9999 });
  const cycle = Array.from({ length: 3 }, () => pick(sequence, tracks()));
  assert.deepEqual([...cycle].sort(), ['a', 'b', 'c']);
});

test('a manually chosen current track is consumed from the remaining shuffle bag', () => {
  const sequence = new PlaybackSequence({ random: () => 0 }), rows = tracks();
  assert.equal(pick(sequence, rows), 'a');
  assert.equal(pick(sequence, rows, { previousId: 'b' }), 'c');
});

test('new scan tracks join the current bag and removed tracks cannot be selected', () => {
  const sequence = new PlaybackSequence({ random: () => 0 });
  assert.equal(pick(sequence, tracks().slice(0, 2), { previousId: 'a' }), 'b');
  assert.equal(pick(sequence, tracks(), { previousId: 'b' }), 'c', 'new track joins before a cycle repeats');
  const reduced = tracks().filter(track => track.key !== 'a');
  assert.equal(pick(sequence, reduced, { previousId: 'c' }), 'b');
  assert.equal(pick(sequence, reduced, { previousId: 'b' }), 'c');
});

test('excluded attempts are skipped and an exhausted candidate pool returns null', () => {
  const sequence = new PlaybackSequence({ random: () => 0 }), rows = tracks();
  assert.equal(pick(sequence, rows, { previousId: 'a', excludedIds: new Set(['b']) }), 'c');
  assert.equal(sequence.next(rows, { excludedIds: new Set(['a', 'b', 'c']) }), null);
  assert.equal(pick(sequence, rows, { previousId: 'c', excludedIds: new Set(['a', 'c']) }), 'b');
});

test('empty libraries stop and a single distinct track loops', () => {
  const sequence = new PlaybackSequence({ random: () => 0 }), row = tracks()[0];
  assert.equal(sequence.next([]), null);
  assert.equal(sequence.next(null), null);
  assert.equal(sequence.next([row], { previousId: row.key }), row);
  assert.equal(sequence.next([row, { ...row }], { previousId: row.key }), row);
  assert.equal(sequence.next([row], { excludedIds: new Set([row.key]) }), null);
});

test('sequential playback uses stable numeric title order, wraps and skips excluded keys', () => {
  const sequence = new PlaybackSequence(), rows = [
    { key: 'ten', title: 'Track 10', path: '10.mp3' },
    { key: 'two', title: 'Track 2', path: '2.mp3' },
    { key: 'one', title: 'Track 1', path: '1.mp3' },
  ];
  assert.equal(pick(sequence, rows, { shuffle: false }), 'one');
  assert.equal(pick(sequence, rows, { shuffle: false, previousId: 'one' }), 'two');
  assert.equal(pick(sequence, rows, { shuffle: false, previousId: 'ten' }), 'one');
  assert.equal(pick(sequence, rows, { shuffle: false, previousId: 'one', excludedIds: new Set(['two']) }), 'ten');
  assert.equal(pick(sequence, rows, { shuffle: false, previousId: 'missing' }), 'one');
  assert.equal(sequence.next(rows, { shuffle: false, excludedIds: new Set(['one', 'two', 'ten']) }), null);
  assert.deepEqual(rows.map(track => track.key), ['ten', 'two', 'one']);
});

test('changing shuffle mode or resetting starts a fresh bag', () => {
  const sequence = new PlaybackSequence({ random: () => 0 }), rows = tracks();
  assert.equal(pick(sequence, rows, { previousId: 'a' }), 'b');
  assert.equal(pick(sequence, rows, { shuffle: false, previousId: 'b' }), 'c');
  assert.equal(pick(sequence, rows, { shuffle: true, previousId: 'b' }), 'a');
  sequence.reset();
  assert.equal(pick(sequence, rows, { previousId: 'b' }), 'a');
});

test('random boundaries stay within the bag and returned rows come from the current listing', () => {
  for (const draw of [0, 1, -.5, NaN, Infinity]) {
    const sequence = new PlaybackSequence({ random: () => draw }), rows = tracks();
    const first = sequence.next(rows);
    assert.ok(rows.includes(first));
    const fresh = rows.map(track => ({ ...track, title: `Updated ${track.title}` }));
    const second = sequence.next(fresh, { previousId: first.key });
    assert.ok(fresh.includes(second));
    assert.notEqual(first.key, second.key);
  }
});
