import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conductor } from '../src/core/Conductor.js';
import { TapJudge } from '../src/sim/TapJudge.js';
import { DisasterDirector } from '../src/sim/DisasterDirector.js';
import { RainbowBrush } from '../src/render/RainbowBrush.js';

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

test('seek skips old notes silently and makes future judgments available again', () => {
  const judge = new TapJudge({ notes: [{tMs: 500}, {tMs: 1500}, {tMs: 60000}] });
  judge._consumed.fill(true);
  judge.buttonDown = true; judge._hold = {}; judge.stepEvents.push({kind: 'hit'});
  assert.equal(judge.seekTo(1000), 1);
  assert.deepEqual(judge._consumed, [true, false, false]);
  assert.equal(judge.buttonDown, false);
  assert.equal(judge._hold, null);
  assert.deepEqual(judge.stepEvents, []);
});

test('fresh disaster seek skips past slots and retains future slots', () => {
  const d = new DisasterDirector(1, 120000, [60000]);
  const at = d._schedule[0].tMs;
  d.seekTo(at + 1); assert.equal(d._nextIdx, 1);
  d.seekTo(1000); assert.equal(d._nextIdx, 0);
});

test('a future rainbow dab never paints invalid alpha or oversized geometry', () => {
  const brush = new RainbowBrush();
  brush.update(60000, true, 100, 300);
  let paints = 0;
  const ctx = { save() {}, restore() {}, fillRect() { paints++; },
    set globalAlpha(a) { assert.ok(a >= 0 && a <= 1); } };
  brush.draw(ctx, 0, 0, 1000);
  assert.equal(paints, 0);
});
