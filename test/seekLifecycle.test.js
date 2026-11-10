import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conductor } from '../src/core/Conductor.js';
import { DisasterDirector } from '../src/sim/DisasterDirector.js';

test('fresh seek primes upcoming anticipation without dispatching past audio notes', () => {
  const c = new Conductor();
  c.load({ timeline: [{ tMs: 500, role: 'x' }, { tMs: 1100, role: 'x' }], durationMs: 10000 });
  const heard = [], ahead = [];
  c.on('*', e => heard.push(e.tMs));
  c.subscribeAhead('*', 200, e => ahead.push(e.tMs));
  c.seekTo(1000, { primeAhead: true });
  c.dispatchUpTo(1000);
  assert.deepEqual(heard, []);
  assert.deepEqual(ahead, [1100]);
  c.dispatchUpTo(1100);
  assert.deepEqual(heard, [1100]);
  assert.deepEqual(ahead, [1100]);
});

test('fresh disaster seek skips past slots and retains future slots', () => {
  const d = new DisasterDirector(1, 120000, [60000]);
  const at = d._schedule[0].tMs;
  d.seekTo(at + 1); assert.equal(d._nextIdx, 1);
  d.seekTo(1000); assert.equal(d._nextIdx, 0);
});

