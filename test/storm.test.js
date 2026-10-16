import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateBolt, LightningFX } from '../src/world/Lightning.js';
import { ParticleField } from '../src/world/ParticleField.js';
import { BIOME_TEMPERATURE } from '../src/world/Dramaturgy.js';
import { LANDMARKS } from '../src/world/Landmarks.js';
import { biomeByName } from '../src/world/BiomeProfiles.js';
import { mulberry32 } from '../src/utils/math.js';

test('generateBolt preserves endpoints exactly and yields 2^detail + 1 main points', () => {
  const rand = mulberry32(7);
  const bolt = generateBolt(100, 0, 180, 480, { displace: 70, detail: 6, rand });
  assert.equal(bolt.main.length, 2 ** 6 + 1);
  assert.deepEqual(bolt.main[0], { x: 100, y: 0 });
  assert.deepEqual(bolt.main[bolt.main.length - 1], { x: 180, y: 480 });
});

test('generateBolt lateral wander stays within the geometric displacement envelope', () => {
  const rand = mulberry32(9);
  const bolt = generateBolt(200, 0, 200, 480, { displace: 60, detail: 6, rand });
  // Sum of halving displacements: 60 * (1 + 1/2 + 1/4 + ...) < 120.
  for (const p of bolt.main) assert.ok(Math.abs(p.x - 200) < 120 + 1e-9, `strayed to ${p.x}`);
});

test('generateBolt branches are finite polylines rooted on the main channel', () => {
  const rand = mulberry32(3);
  const bolt = generateBolt(150, 0, 220, 480, { displace: 70, detail: 6, branches: 3, rand });
  assert.ok(bolt.branches.length >= 1);
  for (const br of bolt.branches) {
    assert.ok(br.length >= 3);
    const onMain = bolt.main.some((p) => Math.abs(p.x - br[0].x) < 1e-9 && Math.abs(p.y - br[0].y) < 1e-9);
    assert.ok(onMain, 'branch root must lie on the main channel');
    for (const p of br) assert.ok(Number.isFinite(p.x + p.y));
  }
});

test('LightningFX respects velocity gate and cooldown', () => {
  const fx = new LightningFX(4);
  fx.maybeTrigger(1000, 0.5, 1280, 480); // too soft
  assert.equal(fx._bolt, null);
  fx.maybeTrigger(1000, 0.9, 1280, 480);
  assert.ok(fx._bolt, 'heavy kick must strike');
  const firstBolt = fx._bolt;
  fx.maybeTrigger(1500, 0.95, 1280, 480); // inside cooldown
  assert.equal(fx._bolt, firstBolt, 'cooldown must suppress the second strike');
});

test('rain particles fall, splash at the ground line, and respawn', () => {
  const field = new ParticleField({ kind: 'rain', color: '#fff', count: 20, speed: 0 }, 1280, 720, 5);
  let sawSplash = false;
  for (let i = 0; i < 600; i++) {
    field.update(1 / 60, i / 60, null, i * 16.7);
    for (const p of field.particles) {
      if (p.state === 'splash') {
        sawSplash = true;
        assert.ok(Math.abs(p.y - 720 * 0.667) < 1e-6, 'splash must sit on the ground line');
      }
    }
  }
  assert.ok(sawSplash, 'expected at least one splash over 10 seconds of rain');
});

test('STORM is fully registered: profile, temperature, landmarks', () => {
  const storm = biomeByName('STORM');
  assert.equal(storm.name, 'STORM');
  assert.equal(storm.fx, 'lightning');
  assert.ok('STORM' in BIOME_TEMPERATURE);
  assert.ok(Array.isArray(LANDMARKS.STORM) && LANDMARKS.STORM.length > 0);
});
