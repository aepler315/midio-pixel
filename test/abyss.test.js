import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BIOMES, biomeByName } from '../src/world/BiomeProfiles.js';
import { BIOME_TEMPERATURE, castBiomes } from '../src/world/Dramaturgy.js';
import { LANDMARKS } from '../src/world/Landmarks.js';
import { PERSONALITY } from '../src/world/BiomePersonality.js';
import { ParticleField } from '../src/world/ParticleField.js';

test('ABYSS is a real biome with the same profile shape as every other biome', () => {
  const abyss = biomeByName('ABYSS');
  assert.equal(abyss.name, 'ABYSS');
  assert.equal(abyss.sky.length, 3);
  for (const hex of abyss.sky) assert.match(hex, /^#[0-9a-f]{6}$/i);
  assert.match(abyss.silhouette, /^#[0-9a-f]{6}$/i);
  assert.match(abyss.edgeLight, /^#[0-9a-f]{6}$/i);
  assert.ok(['sun', 'moon'].includes(abyss.celestial.kind));
  assert.match(abyss.celestial.color, /^#[0-9a-f]{6}$/i);
  assert.ok(abyss.celestial.radius > 0);
  assert.match(abyss.celestial.haloColor, /^#[0-9a-f]{6}$/i);
  assert.ok(abyss.celestial.ring);
  assert.ok(abyss.particles.kind && abyss.particles.count > 0);
  assert.equal(abyss.fx, 'bioluminescence');
  assert.ok(BIOMES.some((b) => b.name === 'ABYSS'));
});

test('ABYSS is fully registered: temperature, landmarks, personality', () => {
  assert.ok('ABYSS' in BIOME_TEMPERATURE);
  assert.ok(Array.isArray(LANDMARKS.ABYSS) && LANDMARKS.ABYSS.length > 0);
  assert.ok(PERSONALITY.ABYSS);
  assert.ok(PERSONALITY.ABYSS.swarmBand[0] < PERSONALITY.ABYSS.swarmBand[1]);
});

test('ABYSS sits between TWILIGHT and VOID on the cold-to-hot axis', () => {
  assert.ok(BIOME_TEMPERATURE.ABYSS > BIOME_TEMPERATURE.TWILIGHT);
  assert.ok(BIOME_TEMPERATURE.ABYSS < BIOME_TEMPERATURE.VOID);
});

test('ABYSS can win a mid-low energy section across a spread of seeds', () => {
  let wins = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const cast = castBiomes([0.05, 0.35, 0.7, 0.95], seed);
    if (cast.includes('ABYSS')) wins++;
  }
  assert.ok(wins > 0, 'ABYSS never got cast across 50 seeds — casting condition is unreachable');
});

test('ABYSS antigrav particles spawn and stay finite under update', () => {
  const field = new ParticleField(
    { kind: 'antigrav', color: '#5cffd9', count: 12, speed: 16 },
    1280,
    720,
    11,
  );
  assert.equal(field.particles.length, 12);
  for (let i = 0; i < 120; i++) {
    field.update(1 / 60, i / 60, null, i * 16.7);
  }
  for (const p of field.particles) {
    assert.ok(Number.isFinite(p.x + p.y));
  }
});
