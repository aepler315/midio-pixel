import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParamBus } from '../src/core/ParamBus.js';

test('ParamBus KEYS smoothing steps toward a proposal and reset restores the defaults', () => {
  const bus = new ParamBus();
  bus.propose({ jumpHeight: 1.2 }, 1);
  bus.step();
  assert.ok(bus.live.jumpHeight > 1);
  bus.reset();
  assert.equal(bus.live.jumpHeight, 1);
});
