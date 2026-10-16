import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chladni, thomasDeriv, rk4Step3 } from '../src/render/oscillators.js';
import { valueNoise3, curl2 } from '../src/utils/fields.js';
import { CymaticField } from '../src/world/CymaticField.js';
import { KuramotoSwarm, calmWanderParams } from '../src/world/KuramotoSwarm.js';
import { ChaosRibbon } from '../src/world/ChaosRibbon.js';

function fakeEnergy(value) {
  return { globalEnergy: () => value, sample: () => value };
}

// --- Chladni plate math ---

test('chladni figure is antisymmetric under u<->v swap, so the diagonal is always nodal', () => {
  for (const [m, n] of [[1, 2], [2, 3], [3, 5]]) {
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      assert.ok(Math.abs(chladni(t, t, m, n)) < 1e-12, 'diagonal must be a nodal line');
    }
    assert.ok(Math.abs(chladni(0.3, 0.7, m, n) + chladni(0.7, 0.3, m, n)) < 1e-12);
  }
});

test('cymatic dust settles onto the nodal figure: mean |z| falls well below its random-scatter start', () => {
  const field = new CymaticField(42);
  const before = field.meanAmplitude();
  let t = 0;
  for (let i = 0; i < 1200; i++) { field.update(t, 1 / 120, fakeEnergy(0.2), 0.5); t += 8.33; }
  const after = field.meanAmplitude();
  assert.ok(after < before * 0.45, `expected settling (before=${before.toFixed(3)}, after=${after.toFixed(3)})`);
});

test('cymatic dust stays on the plate (u,v within [0,1]) under sustained high agitation', () => {
  const field = new CymaticField(7);
  let t = 0;
  for (let i = 0; i < 600; i++) { field.update(t, 1 / 120, fakeEnergy(1), 0); t += 8.33; }
  for (const p of field.particles) {
    assert.ok(p.u >= 0 && p.u <= 1 && p.v >= 0 && p.v <= 1, `particle escaped: (${p.u}, ${p.v})`);
  }
});

test('cymatic mode re-rolls every 8 bars and never lands on m == n', () => {
  const field = new CymaticField(3);
  const seen = new Set([field.modeIdx]);
  for (let bar = 0; bar < 64; bar++) field.onBar();
  seen.add(field.modeIdx);
  assert.ok(seen.size > 1, 'expected the mode to change at least once across 64 bars');
});

// --- Kuramoto synchronization ---

test('Kuramoto swarm stays incoherent at zero coupling (zero energy)', () => {
  const swarm = new KuramotoSwarm(11);
  let t = 0;
  let rSum = 0, samples = 0;
  for (let i = 0; i < 1200; i++) {
    swarm.update(t, 1 / 120, fakeEnergy(0), 500, 0);
    t += 8.33;
    if (i > 600) { rSum += swarm.r; samples++; }
  }
  assert.ok(rSum / samples < 0.55, `expected weak order at K=0, got mean r=${(rSum / samples).toFixed(3)}`);
});

test('Kuramoto swarm phase-locks under sustained high energy', () => {
  const swarm = new KuramotoSwarm(11);
  let t = 0;
  for (let i = 0; i < 1800; i++) { swarm.update(t, 1 / 120, fakeEnergy(1), 500, 0); t += 8.33; }
  assert.ok(swarm.r > 0.85, `expected phase-locked unison at full energy, got r=${swarm.r.toFixed(3)}`);
});

test('calmWanderParams: identity at calm=0, widens/slows monotonically toward calm=1', () => {
  const c0 = calmWanderParams(0);
  assert.equal(c0.ampMul, 1);
  assert.equal(c0.rateMul, 1);

  let prevAmp = -Infinity, prevRate = Infinity;
  for (const c of [0, 0.25, 0.5, 0.75, 1]) {
    const p = calmWanderParams(c);
    assert.ok(p.ampMul >= prevAmp - 1e-9, 'orbit must not narrow as calm rises');
    assert.ok(p.rateMul <= prevRate + 1e-9, 'orbit must not speed up as calm rises');
    prevAmp = p.ampMul; prevRate = p.rateMul;
  }
  assert.ok(calmWanderParams(1).ampMul > 1, 'full calm must genuinely widen the orbit');
  assert.ok(calmWanderParams(1).rateMul < 1, 'full calm must genuinely slow the sweep');
});

test('calmWanderParams clamps out-of-range input the same as clamp01', () => {
  assert.deepEqual(calmWanderParams(-1), calmWanderParams(0));
  assert.deepEqual(calmWanderParams(2), calmWanderParams(1));
});

test('kicks entrain the locked swarm toward phase zero', () => {
  const swarm = new KuramotoSwarm(11);
  let t = 0;
  // Lock the swarm first, kicking every 500ms like a steady four-on-the-floor.
  for (let i = 0; i < 2400; i++) {
    if (i % 60 === 0) swarm.kick(0.9); // 60 steps at 120Hz = 500ms
    swarm.update(t, 1 / 120, fakeEnergy(1), 500, 0);
    t += 8.33;
  }
  // Sample the mean phase exactly on the kick grid: it should sit near 0 (mod 2pi).
  swarm.kick(0.9);
  swarm.update(t, 1 / 120, fakeEnergy(1), 500, 0);
  let sumCos = 0, sumSin = 0;
  for (const o of swarm.oscillators) { sumCos += Math.cos(o.theta); sumSin += Math.sin(o.theta); }
  const meanPhase = Math.atan2(sumSin, sumCos);
  assert.ok(Math.abs(meanPhase) < Math.PI / 2, `expected mean phase near 0 on the beat, got ${meanPhase.toFixed(2)}`);
});

// --- Thomas attractor / RK4 ---

test('RK4 integrates exponential decay to 4th-order accuracy', () => {
  const decay = (s) => ({ x: -s.x, y: -s.y, z: -s.z });
  let s = { x: 1, y: 2, z: -3 };
  const dt = 0.05;
  for (let i = 0; i < 20; i++) s = rk4Step3(decay, s, dt);
  const exact = Math.exp(-1); // t = 1.0
  assert.ok(Math.abs(s.x - exact) < 1e-6);
  assert.ok(Math.abs(s.y - 2 * exact) < 1e-6);
  assert.ok(Math.abs(s.z + 3 * exact) < 1e-6);
});

test('Thomas attractor stays bounded across the full music-driven b range', () => {
  for (const b of [0.19, 0.25, 0.32]) {
    let s = { x: 1.1, y: 0.3, z: -0.6 };
    for (let i = 0; i < 20000; i++) {
      s = rk4Step3(thomasDeriv, s, 0.05, b);
      assert.ok(Number.isFinite(s.x + s.y + s.z), `NaN at b=${b}, step ${i}`);
    }
    assert.ok(Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z) < 20, `escaped at b=${b}`);
  }
});

test('ChaosRibbon runs indefinitely without NaN and caps its trail', () => {
  const ribbon = new ChaosRibbon(5);
  let t = 0;
  for (let i = 0; i < 3000; i++) {
    if (i % 55 === 0) ribbon.kick();
    ribbon.update(t, 1 / 120, fakeEnergy(0.5 + 0.5 * Math.sin(i / 100)), 0.2);
    t += 8.33;
  }
  assert.ok(ribbon.trail.length <= 420);
  for (const p of ribbon.trail) assert.ok(Number.isFinite(p.x + p.y));
});

// --- curl noise ---

test('valueNoise3 is deterministic and in [0,1]', () => {
  for (let i = 0; i < 200; i++) {
    const x = i * 0.37, y = i * 0.91, z = i * 0.13;
    const a = valueNoise3(x, y, z);
    assert.equal(a, valueNoise3(x, y, z));
    assert.ok(a >= 0 && a <= 1);
  }
});

test('curl2 field is numerically divergence-free', () => {
  const eps = 0.02;
  for (let i = 0; i < 50; i++) {
    const x = 0.7 + i * 0.63, y = 1.3 + i * 0.41, t = i * 0.11;
    const vxPlus = curl2(x + eps, y, t), vxMinus = curl2(x - eps, y, t);
    const vyPlus = curl2(x, y + eps, t), vyMinus = curl2(x, y - eps, t);
    const div = (vxPlus.x - vxMinus.x) / (2 * eps) + (vyPlus.y - vyMinus.y) / (2 * eps);
    assert.ok(Math.abs(div) < 0.75, `divergence too large at (${x},${y},${t}): ${div}`);
  }
});
