import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { buildSongProfile } from '../src/audio/SongProfile.js';
import { getWorld, listWorlds } from '../src/world/Worlds.js';
import {
  adaptWorld, capabilitiesFor, filterTerrainMods, responseConfigFor,
  instanceIdFor, ADAPT_VERSION,
} from '../src/world/WorldAdaptation.js';
import { RIDGE_TERRAIN_KEYS, ROLLING_TERRAIN_KEYS } from '../src/world/dna/ShapeGrammar.js';
import { sampleWorldMusic } from '../src/world/WorldMusic.js';
import { buildWorldVariant } from '../src/world/WorldScore.js';

function curves({ durationMs = 120000, energyAt, bandsAt } = {}) {
  const ec = new EnergyCurves(durationMs, 50);
  for (let i = 0; i < ec.n; i++) {
    const t01 = ec.n > 1 ? i / (ec.n - 1) : 0;
    const e = energyAt ? energyAt(t01) : 0.4;
    const shares = bandsAt ? bandsAt(t01) : [1, 1, 1, 1, 1, 1, 1];
    let sum = 0;
    for (const s of shares) sum += s;
    ec.setFrame(i, shares.map((s) => Math.max(0, e * s / (sum || 1))));
  }
  return ec;
}

function song(overrides = {}) {
  const durationMs = overrides.durationMs ?? 120000;
  const energyCurves = overrides.energyCurves || curves({
    durationMs,
    energyAt: overrides.energyAt,
    bandsAt: overrides.bandsAt,
  });
  const data = {
    durationMs,
    bpm: overrides.bpm ?? 100,
    energyCurves,
    analysis: overrides.analysis || {
      rhythm: { eventDensity: 0.4, pulseRegularity: 0.6, confidence: 0.8 },
    },
    structure: overrides.structure || {
      boundariesMs: [0, 40000, 80000, 120000],
      labels: ['A', 'B', 'A'],
      confidence: 0.6,
    },
  };
  return { data, profile: buildSongProfile(data) };
}

test('every registered kind has an explicit capability description', () => {
  for (const w of listWorlds()) {
    const caps = capabilitiesFor(w.kind);
    assert.equal(caps.palette, 'painterly', w.id);
    assert.ok(Array.isArray(caps.geometry) && caps.geometry.length > 0, w.id);
    assert.ok(caps.response.smoothingMs > 0 && caps.response.maxAccents >= 1, w.id);
  }
  assert.equal(ADAPT_VERSION, 1);
});

test('adaptWorld is deterministic and keeps registered identity separate from the instance', () => {
  const { data, profile } = song({ bpm: 112 });
  const a = adaptWorld(getWorld('trio'), profile, data);
  const b = adaptWorld(getWorld('trio'), profile, data);
  assert.equal(a.world.instanceId, b.world.instanceId);
  assert.equal(a.world.name, 'Trio');
  assert.equal(a.world.kind, 'alpine');
  assert.equal(a.world.registeredId, 'trio');
  assert.equal(a.world.baseId, 'trio');
  assert.equal(a.world.id, 'custom');
  assert.notEqual(a.world.instanceId, 'trio');
  assert.equal(a.world.instanceId, instanceIdFor('trio', profile));
  assert.deepEqual(a.world.channels, getWorld('trio').channels);
});

test('only the terrain controls the alpine kind reads are sent', () => {
  const { data, profile } = song();
  const readable = new Set([...RIDGE_TERRAIN_KEYS, ...ROLLING_TERRAIN_KEYS]);
  for (const id of ['alpine', 'trio']) {
    const world = adaptWorld(getWorld(id), profile, data).world;
    const keys = Object.keys(world.terrainMods || {});
    assert.ok(keys.length > 0, `${id} received no terrain controls`);
    assert.ok(keys.every((k) => readable.has(k)), `${id} leaked ${keys}`);
    assert.ok(world.terrainMods.shoulderMul, `${id} lost its ridge controls`);
    assert.ok(world.terrainMods.rollingAmpMul, `${id} lost its rolling controls`);
    assert.ok(world.characterScheme, `${id} lost its character scheme`);
  }
  const filtered = filterTerrainMods('alpine', { shoulderMul: 1.2, rollingAmpMul: 1.1, unreadKey: 0.8 });
  assert.deepEqual(filtered, { shoulderMul: 1.2, rollingAmpMul: 1.1 });
  // A kind nobody registered reads the alpine capabilities.
  assert.equal(capabilitiesFor('unregistered-kind'), capabilitiesFor('alpine'));
  assert.deepEqual(filterTerrainMods('unregistered-kind', { shoulderMul: 1.2, unreadKey: 0.8 }), { shoulderMul: 1.2 });
});


test('response bounds: sparse is restrained, dense filters accents, quiet stays still', () => {
  const sparse = responseConfigFor('alpine', { watch: { onset: 0.08, energyMean: 0.3, dyn: 0.3 } });
  const dense = responseConfigFor('alpine', { watch: { onset: 0.8, energyMean: 0.6, dyn: 0.5 } });
  const quiet = responseConfigFor('alpine', { watch: { onset: 0.05, energyMean: 0.05, dyn: 0.08 } });
  assert.equal(sparse.band, 'sparse');
  assert.equal(dense.band, 'dense');
  assert.ok(sparse.accentGain > dense.accentGain);
  assert.ok(dense.smoothingMs > sparse.smoothingMs);
  assert.ok(dense.macroMs > sparse.macroMs);
  assert.equal(quiet.quiet, true);
  assert.ok(quiet.ambientScale <= 0.35, 'quiet input is not given a lifted ambient');
  assert.ok(quiet.accentGain <= sparse.accentGain);
  for (const r of [sparse, dense, quiet]) {
    assert.ok(r.smoothingMs >= 60 && r.smoothingMs <= 4000);
    assert.ok(r.maxAccents >= 1 && r.maxAccents <= 8);
    assert.ok(r.accentGain >= 0 && r.accentGain <= 1);
  }
});

test('a palette-only failure leaves geometry; a geometry-only failure leaves palettes', () => {
  const poison = {
    [Symbol.toPrimitive]() { throw new Error('poisoned label'); },
    toString() { throw new Error('poisoned label'); },
  };
  const { data, profile } = song({
    structure: { labels: [poison, 'B', poison, 'B'], boundariesMs: [0, 30000, 60000, 90000], confidence: 0.5 },
  });
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(args);
  let result;
  try {
    // Trio: Landscape's real biomes are never synthesized (see below), so
    // the palette path is exercised on the world that still is.
    result = adaptWorld(getWorld('trio'), profile, data);
  } finally {
    console.warn = original;
  }
  assert.equal(result.degraded.palette, true);
  assert.ok(result.proof.dna?.error);
  assert.ok(result.world.terrainMods, 'ridge geometry must survive a palette-only failure');
  assert.ok(result.world.characterScheme);
  assert.ok(warns.some((args) => String(args[0]).includes('palette')));
  assert.equal(result.world.palettes, getWorld('trio').palettes);
});

test('The Range keeps its real biomes: no palette is synthesized into them', () => {
  const { data, profile } = song({
    structure: { labels: ['A', 'B', 'A', 'B'], boundariesMs: [0, 30000, 60000, 90000], confidence: 0.5 },
  });
  const result = adaptWorld(getWorld('alpine'), profile, data);
  assert.equal(result.world.palettes, getWorld('alpine').palettes);
  assert.equal(result.world.realBiomes, true);
  assert.ok(result.world.palettes.every((p) => p.real));
  assert.ok(result.world.terrainMods, 'the song still shapes the invented terrain');
});

test('buildWorldVariant no longer constructs a 100 score', () => {
  const feat = {
    centroid: 0.5, bass: 0.4, air: 0.3, spread: 0.5, dyn: 0.5, energyMean: 0.5,
    phrase: 0.4, landmarks: 5, onset: 0.4, contrast: 0.4, groove: 0.5, warmth: 0.5,
    texture: 0.4, form: 0.5, arc: 0.5, drive: 0.5, bpm: 120, tempoHeat: 0.5, trend: 0,
  };
  const { world, proof } = buildWorldVariant('trio', feat);
  assert.equal(world.kind, 'alpine');
  assert.equal(world.registeredId, 'trio');
  assert.notEqual(proof.score, 100);
  assert.ok(proof.score >= 1 && proof.score <= 99);
  assert.equal(world.comfort, getWorld('trio').comfort);
});

test('sampleWorldMusic: a quiet response does not lift silence; a dense response damps accents', () => {
  const quiet = sampleWorldMusic({
    nowMs: 1000,
    rhythm: { tMs: 1000, vel: 1 },
    response: {
      ambientScale: 0.35,
      accentGain: 0, smoothingMs: 1200, accentWindowMs: 800, accentDecayMs: 150, macroMs: 8000,
    },
  });
  assert.equal(quiet.accent, 0);
  const dense = sampleWorldMusic({
    nowMs: 1000,
    rhythm: { tMs: 1000, vel: 1 },
    response: { accentGain: 0.4, accentWindowMs: 800, accentDecayMs: 150, smoothingMs: 1200, macroMs: 8000, ambientScale: 1 },
  });
  const full = sampleWorldMusic({ nowMs: 1000, rhythm: { tMs: 1000, vel: 1 } });
  assert.ok(dense.accent < full.accent);
  assert.ok(Math.abs(full.accent - 1) < 1e-9);
});

test('WorldAdaptation does not import WorldScore — construction stays downstream of scoring', () => {
  const src = readFileSync(new URL('../src/world/WorldAdaptation.js', import.meta.url), 'utf8');
  assert.equal(/from ['"].*WorldScore/.test(src), false);
});

// Eleven sections reach Trio's neon stock palettes (CYBER, ABYSS), whose
// edgeLight ridge wire palette synthesis does not generate.
const ELEVEN_SECTIONS = {
  boundariesMs: Array.from({ length: 12 }, (_, i) => Math.round(i * 120000 / 11)),
  labels: 'ABCDEFGHIJK'.split(''),
  confidence: 0.6,
};

for (const id of ['alpine', 'trio']) {
  test(`${id}: adaptation preserves material lighting without mutating stock palettes`, () => {
    const base = getWorld(id);
    const before = structuredClone(base.palettes);
    const { data, profile } = song({ structure: ELEVEN_SECTIONS });
    const { world, degraded } = adaptWorld(base, profile, data);
    assert.equal(degraded.palette, false);
    assert.ok(world.palettes.length > 0);
    world.palettes.forEach((palette, i) => {
      assert.equal(palette.edgeLight, base.palettes[i % base.palettes.length].edgeLight);
      if (palette.edgeLight) assert.match(palette.edgeLight, /^#[0-9a-f]{6}$/i);
    });
    if (id === 'trio') assert.ok(world.palettes.some((p) => p.edgeLight), 'no neon stock palette was reached');
    assert.deepEqual(base.palettes, before);
  });
}

for (const fixture of [
  { bpm: 64, energyAt: () => 0.05 },
  { bpm: 84, energyAt: () => 0.65, bandsAt: () => [8, 5, 1, 1, 1, 1, 1] },
  { bpm: 180, energyAt: t => (Math.floor(t * 120) % 2 ? 0.95 : 0.2) },
  { bpm: 120, energyAt: t => t < 0.33 || t > 0.67 ? 0.12 : 0.9 },
]) {
  test(`adapted physical vocabulary stays within selected world at bpm=${fixture.bpm}`, () => {
    const { data, profile } = song(fixture);
    let synthesized = 0;
    for (const base of listWorlds()) {
      // Real biomes are never synthesized (above), so only an invented
      // palette set can drift out of its world's vocabulary.
      if (base.realBiomes) continue;
      synthesized++;
      const { world } = adaptWorld(base, profile, data);
      assert.equal(world.kind, base.kind);
      const particles = new Set(base.palettes.map(p => p.particles.kind));
      const effects = new Set(base.palettes.map(p => p.fx));
      for (const palette of world.palettes) {
        assert.ok(particles.has(palette.particles.kind), `${base.id}: inappropriate ${palette.particles.kind}`);
        assert.ok(effects.has(palette.fx), `${base.id}: inappropriate ${palette.fx}`);
      }
    }
    assert.ok(synthesized > 0, 'no registered world synthesizes palettes');
  });
}
