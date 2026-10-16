import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ObstacleSpawner, emergenceEnvelope, dissolveEnvelope, SHADOW_ARCHETYPES,
} from '../src/sim/ObstacleSpawner.js';
import { contactShadow } from '../src/world/ContactShadow.js';

function spawnerWith(active) {
  const s = new ObstacleSpawner({ live: { obstacleDensity: 1 } }, { seed: 1 });
  s.active = active;
  return s;
}

function solid(over = {}) {
  return {
    wx: 400, tMs: 1000, height: 46, width: 28, archetype: 'thorn', phase: 0, ...over,
  };
}

test('SHADOW_ARCHETYPES is the solid set: thorn, geo, pipe — not veil or echo', () => {
  assert.deepEqual([...SHADOW_ARCHETYPES], ['thorn', 'geo', 'pipe']);
  assert.ok(!SHADOW_ARCHETYPES.includes('veil'));
  assert.ok(!SHADOW_ARCHETYPES.includes('echo'));
});

test('groundedShadows excludes veil and echo', () => {
  const s = spawnerWith([
    solid({ wx: 400, archetype: 'thorn' }),
    solid({ wx: 410, archetype: 'geo' }),
    solid({ wx: 420, archetype: 'pipe' }),
    solid({ wx: 430, archetype: 'veil' }),
    solid({ wx: 440, archetype: 'echo' }),
  ]);
  // worldX sits on the cluster so every solid is fully emerged (presence=1)
  // rather than still condensing in from far ahead.
  const out = s.groundedShadows(400, 220, () => 480);
  assert.deepEqual(out.map((o) => o.x), [220, 230, 240]);
  assert.equal(out.length, 3);
});

test('groundedShadows excludes off-screen obstacles', () => {
  // Presence is a world-space envelope; screen-cull is a screen-space
  // window. Park every obstacle inside the envelope, then slide originX
  // so one of them lands past the right cull edge.
  const s = spawnerWith([
    solid({ wx: 300, archetype: 'pipe' }), // x = 300-400+2200 = 2100, on
    solid({ wx: 400, archetype: 'pipe' }), // x = 2200, on
    solid({ wx: 560, archetype: 'pipe' }), // x = 2360, past 2280
  ]);
  const out = s.groundedShadows(400, 2200, () => 480);
  assert.equal(out.length, 2);
  assert.ok(out.every((o) => o.x >= -80 && o.x <= 2280));
});

test('groundedShadows reports presence matching emergenceEnvelope * dissolveEnvelope', () => {
  const o = solid({ wx: 800, archetype: 'thorn' });
  const s = spawnerWith([o]);
  // Still approaching: worldX well behind wx.
  const worldX = 800 - 80;
  const originX = 220;
  const [got] = s.groundedShadows(worldX, originX, () => 500);
  const expected = emergenceEnvelope(o.wx - worldX) * 1;
  assert.ok(got, 'on-screen approaching solid should be listed');
  assert.ok(Math.abs(got.presence - expected) < 1e-9, `presence ${got.presence} != ${expected}`);

  // Past: dissolving.
  const worldX2 = 800 + 60;
  const [got2] = s.groundedShadows(worldX2, originX, () => 500);
  const expected2 = 1 * dissolveEnvelope(worldX2 - o.wx);
  assert.ok(Math.abs(got2.presence - expected2) < 1e-9, `dissolve presence ${got2.presence} != ${expected2}`);
});

test('a grounded obstacle\'s shadow cx tracks a mocked light across the sky', () => {
  const s = spawnerWith([solid({ wx: 400, width: 32, archetype: 'pipe' })]);
  const [o] = s.groundedShadows(400, 200, () => 480);
  assert.ok(o, 'fully-emerged pipe must produce a shadow');
  const left = contactShadow(o.x, o.groundY, 0, o.width, { x: 0, y: 80 });
  const right = contactShadow(o.x, o.groundY, 0, o.width, { x: 800, y: 80 });
  const overhead = contactShadow(o.x, o.groundY, 0, o.width, { x: o.x, y: 0 });
  // Grounded (heightAbove = 0): the ellipse stays under the feet — it
  // only *slides* once something leaves the ground. Tracking here means
  // the same contactShadow the characters use, fed this obstacle's x.
  assert.equal(left.cx, o.x);
  assert.equal(right.cx, o.x);
  assert.equal(overhead.cx, o.x);
  // And a mid-air stand-in (if an archetype ever left the ground) would
  // throw away from the light — the same function, same contract.
  const thrownL = contactShadow(o.x, o.groundY, 40, o.width, { x: 0, y: 80 });
  const thrownR = contactShadow(o.x, o.groundY, 40, o.width, { x: 800, y: 80 });
  assert.ok(thrownL.cx > o.x, 'light on the left throws the shadow right');
  assert.ok(thrownR.cx < o.x, 'light on the right throws the shadow left');
});

test('shadow alpha scales linearly with presence', () => {
  const s = spawnerWith([solid({ wx: 400, width: 28, archetype: 'geo' })]);
  const [o] = s.groundedShadows(400, 200, () => 480);
  assert.ok(o, 'fully-emerged geo must produce a shadow');
  const base = contactShadow(o.x, o.groundY, 0, o.width, { x: 100, y: 80 });
  for (const p of [0, 0.25, 0.5, 1]) {
    const scaled = base.alpha * p;
    assert.ok(Math.abs(scaled - base.alpha * p) < 1e-12);
    if (p === 0) assert.equal(scaled, 0);
    if (p === 1) assert.equal(scaled, base.alpha);
  }
  assert.ok(o.presence > 0 && o.presence <= 1);
});

test('groundY comes from the mocked heightAt, not a flat reference', () => {
  const s = spawnerWith([solid({ wx: 400, archetype: 'thorn' })]);
  const [o] = s.groundedShadows(400, 200, (sx) => 300 + sx * 0.1);
  assert.ok(o);
  assert.ok(Math.abs(o.groundY - (300 + o.x * 0.1)) < 1e-9);
  assert.notEqual(o.groundY, 480);
});
