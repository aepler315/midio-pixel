import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Murmuration } from '../src/world/Murmuration.js';
import { GnatGag } from '../src/sim/GnatGag.js';

function fakeEnergy(value) {
  return { globalEnergy: () => value, sample: () => value };
}

const STEP = 1 / 60;

test('boid alignment: heading order rises well above random from a scattered start', () => {
  const flock = new Murmuration(1280, 720, 5, { noiseGain: 0 }); // no wander term: isolate the three rules
  const before = flock.headingOrder();
  let t = 0;
  for (let i = 0; i < 900; i++) { flock.update(t, STEP, fakeEnergy(0.4), 0); t += 16.7; }
  const after = flock.headingOrder();
  assert.ok(after > 0.8, `expected strong alignment, got ${after.toFixed(2)} (started at ${before.toFixed(2)})`);
});

test('a startle blows the flock apart; cohesion then pulls it back together', () => {
  const flock = new Murmuration(1280, 720, 9);
  let t = 0;
  for (let i = 0; i < 600; i++) { flock.update(t, STEP, fakeEnergy(0.4), 0); t += 16.7; }
  const settled = flock.spread();

  flock.startle(1);
  for (let i = 0; i < 30; i++) { flock.update(t, STEP, fakeEnergy(0.4), 0); t += 16.7; }
  const scattered = flock.spread();
  assert.ok(scattered > settled * 1.15, `startle should scatter (${settled.toFixed(0)} -> ${scattered.toFixed(0)})`);

  for (let i = 0; i < 1200; i++) { flock.update(t, STEP, fakeEnergy(0.4), 0); t += 16.7; }
  assert.ok(flock.spread() < scattered, 'the flock must re-form after the fright');
});

test('boids respect the speed clamp and the vertical flight band', () => {
  const flock = new Murmuration(1280, 720, 3);
  let t = 0;
  for (let i = 0; i < 600; i++) {
    flock.update(t, STEP, fakeEnergy(1), 0);
    t += 16.7;
    for (const b of flock.boids) {
      const sp = Math.hypot(b.vx, b.vy);
      assert.ok(sp <= 158, `speed ${sp} exceeds full-energy max`);
      assert.ok(b.y >= 0.03 * 720 - 1 && b.y <= 0.58 * 720 + 1, `boid left the flight band at y=${b.y}`);
    }
  }
});

test('the gnat only dares enter after sustained calm, and respects its cooldown', () => {
  const gnat = new GnatGag(7);
  let t = 0;
  // Energetic passage: no fly.
  for (let i = 0; i < 600; i++) { gnat.update(t, STEP, 0.1); t += 16.7; }
  assert.equal(gnat.state, 'idle');
  // Brief calm, below the arming time: still no fly.
  for (let i = 0; i < 100; i++) { gnat.update(t, STEP, 0.9); t += 16.7; }
  assert.equal(gnat.state, 'idle');
  // Sustained calm: the fly appears.
  for (let i = 0; i < 150; i++) { gnat.update(t, STEP, 0.9); t += 16.7; }
  assert.equal(gnat.state, 'buzz');
});

test('the swat fires only on a kick, only after enough buzzing, then falls and cools down', () => {
  const gnat = new GnatGag(3);
  let t = 0;
  for (let i = 0; i < 260; i++) { gnat.update(t, STEP, 1); t += 16.7; } // arm + spawn
  assert.equal(gnat.state, 'buzz');

  gnat.onKick({ tMs: t }); // too early: fly has not buzzed long enough
  assert.equal(gnat.state, 'buzz');

  for (let i = 0; i < 160; i++) { gnat.update(t, STEP, 1); t += 16.7; } // buzz past the minimum
  gnat.onKick({ tMs: t });
  assert.equal(gnat.state, 'swat');

  for (let i = 0; i < 10; i++) { gnat.update(t, STEP, 1); t += 16.7; }
  assert.equal(gnat.state, 'fall');

  for (let i = 0; i < 70; i++) { gnat.update(t, STEP, 1); t += 16.7; }
  assert.equal(gnat.state, 'idle');

  // Cooldown: sustained calm alone cannot summon another fly yet.
  for (let i = 0; i < 400; i++) { gnat.update(t, STEP, 1); t += 16.7; }
  assert.equal(gnat.state, 'idle');
});
