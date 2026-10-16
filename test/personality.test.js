import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSONALITY } from '../src/world/BiomePersonality.js';
import { BIOMES } from '../src/world/BiomeProfiles.js';
import { CymaticField } from '../src/world/CymaticField.js';
import { KuramotoSwarm } from '../src/world/KuramotoSwarm.js';
import { superformula } from '../src/render/oscillators.js';

function fakeEnergy(value) {
  return { globalEnergy: () => value, sample: () => value };
}

test('every personality entry names a real biome, and dials stay in sane ranges', () => {
  const names = new Set(BIOMES.map((b) => b.name));
  for (const [name, p] of Object.entries(PERSONALITY)) {
    assert.ok(names.has(name), `unknown biome ${name}`);
    if (p.swarmBand) {
      assert.ok(p.swarmBand[0] >= 0 && p.swarmBand[1] <= 0.7 && p.swarmBand[0] < p.swarmBand[1]);
    }
    if (p.cymaticModes) for (const i of p.cymaticModes) assert.ok(Number.isInteger(i) && i >= 0 && i <= 7);
    if (p.mandalaRate) assert.ok(p.mandalaRate > 0.3 && p.mandalaRate < 2);
    if (p.ribbonScale) assert.ok(p.ribbonScale > 0.5 && p.ribbonScale < 2);
    if (p.rdBias) assert.ok(Math.abs(p.rdBias) <= 0.35);
    if (p.haze) assert.ok(p.haze > 0.1 && p.haze < 2.5, `haze dial out of range for ${name}: ${p.haze}`);
  }
});

test('a cymatic mode pool restricts every future mode roll to the pool', () => {
  const field = new CymaticField(9);
  field.modePool = [2, 5];
  for (let i = 0; i < 200; i++) field.onBar(); // 25 mode re-rolls
  assert.ok([2, 5].includes(field.modeIdx), `mode ${field.modeIdx} escaped the pool`);
});

test('the Kuramoto swarm migrates into a re-assigned altitude band', () => {
  const swarm = new KuramotoSwarm(3);
  swarm.setBand(0.05, 0.15);
  let t = 0;
  for (let i = 0; i < 1200; i++) { swarm.update(t, 1 / 120, fakeEnergy(0.4), 500, 0); t += 8.33; }
  for (const o of swarm.oscillators) {
    assert.ok(o.ay >= 0.04 && o.ay <= 0.16, `oscillator stuck at ay=${o.ay}`);
  }
});

test('superformula is positive, finite, and closes after 2*pi (even m) / 4*pi (odd m)', () => {
  for (const shape of [{ m: 6, n1: 1, n2: 1.8, n3: 1.8 }, { m: 5, n1: 0.35, n2: 0.35, n3: 0.35 }, { m: 8, n1: 0.9, n2: 1.5, n3: 1.5 }]) {
    const period = (shape.m % 2 === 1 ? 4 : 2) * Math.PI;
    for (let i = 0; i < 64; i++) {
      const phi = (i / 64) * Math.PI * 2;
      const r = superformula(phi, shape.m, shape.n1, shape.n2, shape.n3);
      assert.ok(Number.isFinite(r) && r >= 0);
      const r2 = superformula(phi + period, shape.m, shape.n1, shape.n2, shape.n3);
      // Tolerance note: with fractional exponents (n < 1), |sin x|^n has
      // infinite slope at x = 0, so the ~1e-15 float error in phi+period
      // amplifies to ~1e-5 in r near the axes. Visually invisible.
      assert.ok(Math.abs(r - r2) < 1e-4, `must close after ${period}`);
    }
  }
});

test('superformula with unit exponents and m=0 degenerates to a circle', () => {
  for (let i = 0; i < 16; i++) {
    const phi = (i / 16) * Math.PI * 2;
    assert.ok(Math.abs(superformula(phi, 0, 2, 2, 2) - 1) < 1e-9); // t1=1, t2=0 -> r = 1 everywhere
  }
});
