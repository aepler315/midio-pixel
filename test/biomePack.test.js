import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BIOMES, biomeByName } from '../src/world/BiomeProfiles.js';
import { BIOME_TEMPERATURE, castBiomes } from '../src/world/Dramaturgy.js';
import { LANDMARKS } from '../src/world/Landmarks.js';
import { PERSONALITY } from '../src/world/BiomePersonality.js';
import { ParticleField } from '../src/world/ParticleField.js';

const PACK = ['CORAL', 'LUMEN', 'AURUM', 'NEBULA', 'ABYSS', 'GEODE'];

const EXPECTED = {
  CORAL: { fx: 'godRays', kind: 'bubbles' },
  LUMEN: { fx: 'sporeGlow', kind: 'spores' },
  AURUM: { fx: 'sunMotes', kind: 'petals' },
  NEBULA: { fx: 'nebulaBloom', kind: 'fireflies' },
  ABYSS: { fx: 'bioluminescence', kind: 'antigrav' },
  GEODE: { fx: 'crystalGlint', kind: 'spores' },
};

test('every pack biome has a valid profile shape', () => {
  for (const name of PACK) {
    const b = biomeByName(name);
    assert.equal(b.name, name);
    assert.equal(b.sky.length, 3);
    for (const hex of b.sky) assert.match(hex, /^#[0-9a-f]{6}$/i);
    assert.match(b.silhouette, /^#[0-9a-f]{6}$/i);
    assert.ok(['sun', 'moon'].includes(b.celestial.kind));
    assert.ok(b.celestial.radius > 0);
    assert.equal(b.fx, EXPECTED[name].fx);
    assert.equal(b.particles.kind, EXPECTED[name].kind);
    assert.ok(b.particles.count > 0);
  }
});

test('every pack biome is registered for casting, landmarks, and personality', () => {
  for (const name of PACK) {
    assert.ok(name in BIOME_TEMPERATURE, `missing temperature for ${name}`);
    assert.ok(Array.isArray(LANDMARKS[name]) && LANDMARKS[name].length > 0, `missing landmarks for ${name}`);
    assert.ok(PERSONALITY[name], `missing personality for ${name}`);
  }
});

test('every stock biome has landmarks and a temperature entry', () => {
  for (const b of BIOMES) {
    assert.ok(b.name in BIOME_TEMPERATURE, `missing temperature for ${b.name}`);
    assert.ok(Array.isArray(LANDMARKS[b.name]) && LANDMARKS[b.name].length > 0, `missing landmarks for ${b.name}`);
  }
});

test('temperature table is strictly ordered cold → hot', () => {
  const entries = Object.entries(BIOME_TEMPERATURE).sort((a, b) => a[1] - b[1]);
  for (let i = 1; i < entries.length; i++) {
    assert.ok(entries[i][1] > entries[i - 1][1], `${entries[i][0]} should be warmer than ${entries[i - 1][0]}`);
  }
});

test('each pack biome can win a cast across a spread of seeds', () => {
  const energies = [0.0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.0];
  const wins = Object.fromEntries(PACK.map((n) => [n, 0]));
  for (let seed = 1; seed <= 80; seed++) {
    const cast = castBiomes(energies, seed);
    for (const name of PACK) {
      if (cast.includes(name)) wins[name]++;
    }
  }
  for (const name of PACK) {
    assert.ok(wins[name] > 0, `${name} never cast across 80 seeds (unreachable temperature)`);
  }
});

test('new particle kinds spawn, update, and stay finite', () => {
  const kinds = [
    { kind: 'sand', color: '#e8c98a', count: 20, speed: 70 },
    { kind: 'bubbles', color: '#b8f0ff', count: 20, speed: 28 },
    { kind: 'spores', color: '#9dffc8', count: 20, speed: 12 },
  ];
  for (const cfg of kinds) {
    const field = new ParticleField(cfg, 1280, 720, 17);
    assert.equal(field.particles.length, cfg.count);
    for (let i = 0; i < 90; i++) field.update(1 / 60, i / 60, null, i * 16.7);
    for (const p of field.particles) {
      assert.ok(Number.isFinite(p.x + p.y), `${cfg.kind} particle went non-finite`);
    }
  }
});

test('stock roster is the expected 16 biomes (DUNE retired -- too visually samey a brown to earn its rotation slot)', () => {
  assert.equal(BIOMES.length, 16);
  const names = new Set(BIOMES.map((b) => b.name));
  for (const name of [
    'TWILIGHT', 'EMBER', 'ARCTIC', 'JADE', 'VOID', 'SAKURA', 'SOLAR', 'STORM',
    'MIRROR', 'CYBER', 'ABYSS', 'CORAL', 'LUMEN', 'AURUM', 'NEBULA', 'GEODE',
  ]) {
    assert.ok(names.has(name), `missing ${name}`);
  }
  assert.ok(!names.has('DUNE'), 'DUNE should be fully retired from the stock rotation');
});
