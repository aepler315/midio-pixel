import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FloodDirector, RAIN_FLOOD_ARM, RAIN_FLOOD_RELEASE, TSUNAMI_FLOOD_DURATION_MS,
} from '../src/sim/FloodDirector.js';

test('dormant until either source triggers -- idle costs nothing', () => {
  const f = new FloodDirector();
  f.update(0, 0.016, { rainAccum01: 0 });
  assert.equal(f.active, false);
  assert.equal(f.level01, 0);
  assert.equal(f.source, null);
});

test('a tsunami arm rises, holds, and recedes within TSUNAMI_FLOOD_DURATION_MS', () => {
  const f = new FloodDirector();
  f.armFromTsunami(0, 'wall-1');
  let t = 0;
  let peak = 0;
  for (let i = 0; i < 400; i++) {
    t += 16;
    f.update(t, 0.016, { rainAccum01: 0 });
    peak = Math.max(peak, f.level01);
  }
  assert.ok(peak >= 0.99, `expected a full hold near 1, got peak ${peak}`);
  // Well past the duration, it must be fully receded.
  f.update(TSUNAMI_FLOOD_DURATION_MS + 2000, 0.016, { rainAccum01: 0 });
  assert.equal(f.active, false);
  assert.equal(f.level01, 0);
});

test('re-arming the same tsunami event key is a no-op (guards per-event, not per-frame)', () => {
  const f = new FloodDirector();
  f.armFromTsunami(1000, 'wall-1');
  const startedAt = f._tsunamiStartMs;
  f.armFromTsunami(1500, 'wall-1'); // same key, later call -- must not reset the clock
  assert.equal(f._tsunamiStartMs, startedAt);
});

test('a different tsunami event key re-arms a fresh envelope', () => {
  const f = new FloodDirector();
  f.armFromTsunami(1000, 'wall-1');
  f.armFromTsunami(1000, 'wall-2');
  assert.equal(f._tsunamiStartMs, 1000);
  assert.equal(f._tsunamiArmedForKey, 'wall-2');
});

test('rainAccum01 crossing RAIN_FLOOD_ARM eases the flood up, well below a tsunami\'s full level', () => {
  const f = new FloodDirector();
  let t = 0;
  for (let i = 0; i < 3000; i++) {
    t += 16;
    f.update(t, 0.016, { rainAccum01: RAIN_FLOOD_ARM + 0.05 });
  }
  assert.ok(f.level01 > 0.1, `expected a measurable rain flood, got ${f.level01}`);
  assert.ok(f.level01 < 0.6, `rain flood should stay shallower than a tsunami's full overtop, got ${f.level01}`);
  assert.equal(f.source, 'rain');
});

test('rain flood has hysteresis -- dropping just under RAIN_FLOOD_ARM does not immediately disarm', () => {
  const f = new FloodDirector();
  let t = 0;
  for (let i = 0; i < 1000; i++) { t += 16; f.update(t, 0.016, { rainAccum01: RAIN_FLOOD_ARM + 0.05 }); }
  assert.ok(f._rainArmed);
  // Drop to a value between RELEASE and ARM -- should remain armed.
  const mid = (RAIN_FLOOD_ARM + RAIN_FLOOD_RELEASE) / 2;
  f.update(t + 16, 0.016, { rainAccum01: mid });
  assert.ok(f._rainArmed, 'should not disarm until below RAIN_FLOOD_RELEASE');
});

test('rain flood recedes once rainAccum01 drops below RAIN_FLOOD_RELEASE', () => {
  const f = new FloodDirector();
  let t = 0;
  for (let i = 0; i < 2000; i++) { t += 16; f.update(t, 0.016, { rainAccum01: RAIN_FLOOD_ARM + 0.05 }); }
  const wet = f.level01;
  assert.ok(wet > 0.1);
  for (let i = 0; i < 3000; i++) { t += 16; f.update(t, 0.016, { rainAccum01: 0 }); }
  assert.ok(f.level01 < wet, 'flood should recede once rain drains');
  assert.ok(f.level01 < 0.02);
});

test('the two sources never stack -- combined level01 is the max, not the sum', () => {
  const f = new FloodDirector();
  f.armFromTsunami(0, 'wall-1');
  let t = 0;
  for (let i = 0; i < 3000; i++) {
    t += 16;
    // Simultaneously feed a fully-armed rain flood -- tsunami should dominate while active.
    f.update(t, 0.016, { rainAccum01: 1 });
  }
  assert.ok(f.level01 <= 1.0001, `level01 must never exceed 1 even with both sources active, got ${f.level01}`);
});

test('active is exactly the level01 > 0.02 threshold', () => {
  const f = new FloodDirector();
  f.armFromTsunami(0, 'w');
  f.update(1, 0.016, { rainAccum01: 0 });
  assert.equal(f.active, f.level01 > 0.02);
});
