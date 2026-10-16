import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FireDirector } from '../src/sim/FireDirector.js';
import { FIRE_DURATION_MS } from '../src/world/Wildfire.js';

test('dormant until struck -- idle costs nothing', () => {
  const f = new FireDirector();
  f.update(1000, 0.016);
  assert.equal(f.active, false);
  assert.equal(f.intensity01, 0);
  assert.equal(f.isBurned(0), false);
});

test('a strike goes active and eventually settles, recording a final burn scar', () => {
  const f = new FireDirector();
  f.strike(0, 500, 0); // wind blowing due +x
  let t = 0;
  for (let i = 0; i < 2000; i++) { t += 16; f.update(t, 0.016); }
  assert.equal(f.active, false);
  assert.equal(f.intensity01, 0);
  assert.ok(f.burnedIntervals.length >= 1, 'should have recorded at least one scar');
  // The origin itself should read as burned even after the fire dies.
  assert.equal(f.isBurned(500), true);
});

test('the burn scar reflects the wind-asymmetric extent, not a symmetric one', () => {
  const f = new FireDirector();
  f.strike(0, 0, 0); // full +x lean
  let t = 0;
  for (let i = 0; i < 2000; i++) { t += 16; f.update(t, 0.016); }
  const iv = f.burnedIntervals[0];
  assert.ok(iv.x1 > -iv.x0 * 2, `expected the scar to lean downwind (+x), got x0=${iv.x0} x1=${iv.x1}`);
});

test('smokeLevel01 rises while burning and settles afterward, lingering past the fire itself', () => {
  const f = new FireDirector();
  f.strike(0, 0, 0);
  let t = 0;
  let peak = 0;
  for (let i = 0; i < 1000; i++) { t += 16; f.update(t, 0.016); peak = Math.max(peak, f.smokeLevel01); }
  assert.ok(peak > 0.2, `expected measurable smoke buildup, got ${peak}`);
  // Well past the fire's own end, smoke should still be settling, not gone.
  const atFireEnd = f.smokeLevel01;
  f.update(FIRE_DURATION_MS + 1000, 0.016);
  assert.ok(f.smokeLevel01 <= atFireEnd, 'smoke should be receding, never re-rising, after the fire ends');
  assert.ok(f.smokeLevel01 > 0, 'smoke should still linger shortly after the fire itself has died');
});

test('isBurned is false outside every recorded interval', () => {
  const f = new FireDirector();
  f.strike(0, 0, 0);
  let t = 0;
  for (let i = 0; i < 2000; i++) { t += 16; f.update(t, 0.016); }
  assert.equal(f.isBurned(100000), false);
  assert.equal(f.isBurned(-100000), false);
});

test('re-striking while dormant starts a fresh, independent life', () => {
  const f = new FireDirector();
  f.strike(0, 0, 0);
  let t = 0;
  for (let i = 0; i < 2000; i++) { t += 16; f.update(t, 0.016); }
  assert.equal(f.active, false);
  f.strike(t, 5000, Math.PI);
  f.update(t + 16, 0.016);
  assert.equal(f.active, true);
  assert.equal(f.originWorldX, 5000);
});
