import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrbitalDebris, GM_BASE, SOFTEN2 } from '../src/sim/OrbitalDebris.js';
import { ReactionDiffusion } from '../src/world/ReactionDiffusion.js';

function fakeEnergy(value) {
  return { globalEnergy: () => value, sample: () => value };
}

// --- Orbital debris ---

test('a circular orbit stays near-circular under symplectic Euler', () => {
  const debris = new OrbitalDebris(1, { n: 1, damping: 0, pairGravity: false, recapture: false });
  const s = debris.shards[0];
  const r0 = 80;
  s.x = r0; s.y = 0;
  // Circular speed under the SOFTENED force law: v^2/r = GM*r/(r^2+eps^2)^1.5.
  s.vx = 0; s.vy = r0 * Math.sqrt(GM_BASE) / Math.pow(r0 * r0 + SOFTEN2, 0.75);
  const attractor = { x: 0, y: 0 };
  let rMin = Infinity, rMax = 0;
  for (let i = 0; i < 1200; i++) { // 10 seconds, ~4 orbits
    debris.update(1 / 120, attractor, 1);
    const r = Math.hypot(s.x, s.y);
    rMin = Math.min(rMin, r); rMax = Math.max(rMax, r);
  }
  assert.ok(rMin > r0 * 0.8 && rMax < r0 * 1.25, `orbit drifted: [${rMin.toFixed(1)}, ${rMax.toFixed(1)}]`);
});

test('angular momentum direction is conserved for a pure central force', () => {
  const debris = new OrbitalDebris(2, { n: 1, damping: 0, pairGravity: false, recapture: false });
  const s = debris.shards[0];
  s.x = 90; s.y = 10; s.vx = -30; s.vy = 170;
  const sign0 = Math.sign(s.x * s.vy - s.y * s.vx);
  for (let i = 0; i < 2400; i++) {
    debris.update(1 / 120, { x: 0, y: 0 }, 1);
    assert.equal(Math.sign(s.x * s.vy - s.y * s.vx), sign0);
  }
});

test('Plummer softening keeps a head-on plunge finite', () => {
  const debris = new OrbitalDebris(3, { n: 1, damping: 0, pairGravity: false, recapture: false });
  const s = debris.shards[0];
  s.x = 120; s.y = 0; s.vx = 0; s.vy = 0; // dead drop straight through the center
  for (let i = 0; i < 2400; i++) {
    debris.update(1 / 120, { x: 0, y: 0 }, 1);
    assert.ok(Number.isFinite(s.x + s.y + s.vx + s.vy));
    assert.ok(Math.hypot(s.vx, s.vy) < 2000, `slingshot blew up: |v|=${Math.hypot(s.vx, s.vy)}`);
  }
});

test('escaped shards are recaptured near the attractor', () => {
  const debris = new OrbitalDebris(4, { n: 1 });
  const s = debris.shards[0];
  s.x = 5000; s.y = 5000; s.vx = 0; s.vy = 0;
  debris.update(1 / 120, { x: 0, y: 0 }, 1);
  assert.ok(Math.hypot(s.x, s.y) < 420, 'expected respawn within the capture radius');
});

// --- Gray-Scott reaction-diffusion ---

test('Gray-Scott concentrations stay clamped to [0,1] under regime sweeps', () => {
  const rd = new ReactionDiffusion(9);
  let t = 0;
  for (let i = 0; i < 600; i++) {
    rd.update(t, 1 / 120, fakeEnergy(i % 2 ? 0.9 : 0.1), 0);
    if (i % 60 === 0) rd.onKick();
    t += 8.33;
  }
  for (let i = 0; i < rd.u.length; i++) {
    assert.ok(rd.u[i] >= 0 && rd.u[i] <= 1);
    assert.ok(rd.v[i] >= 0 && rd.v[i] <= 1);
  }
});

test('Gray-Scott develops spatial structure from its seeds (variance well above zero)', () => {
  const rd = new ReactionDiffusion(5); // constructor warms up 400 iterations
  let mean = 0;
  for (let i = 0; i < rd.v.length; i++) mean += rd.v[i];
  mean /= rd.v.length;
  let variance = 0;
  for (let i = 0; i < rd.v.length; i++) variance += (rd.v[i] - mean) ** 2;
  variance /= rd.v.length;
  assert.ok(variance > 1e-4, `expected a live pattern, got variance ${variance}`);
});

test('an unseeded uniform Gray-Scott plate stays uniform (no spontaneous noise)', () => {
  const rd = new ReactionDiffusion(5);
  rd.u.fill(1); rd.v.fill(0);
  for (let i = 0; i < 100; i++) rd.step(0.0367, 0.0649);
  for (let i = 0; i < rd.v.length; i++) assert.equal(rd.v[i], 0);
});
