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
import { RIDGE_TERRAIN_KEYS, CITY_TERRAIN_KEYS } from '../src/world/dna/ShapeGrammar.js';
import { sampleWorldMusic } from '../src/world/WorldMusic.js';
import { buildWorldVariant, buildCustomWorld } from '../src/world/WorldScore.js';

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
    assert.ok(caps.palette === 'painterly' || caps.palette === 'four-color', w.id);
    assert.ok(Array.isArray(caps.geometry) && caps.geometry.length > 0, w.id);
    assert.ok(caps.response.smoothingMs > 0 && caps.response.maxAccents >= 1, w.id);
  }
  assert.equal(ADAPT_VERSION, 1);
});

test('adaptWorld is deterministic and keeps registered identity separate from the instance', () => {
  const { data, profile } = song({ bpm: 112 });
  const a = adaptWorld(getWorld('nocturne'), profile, data);
  const b = adaptWorld(getWorld('nocturne'), profile, data);
  assert.equal(a.world.instanceId, b.world.instanceId);
  assert.equal(a.world.name, 'After Hours');
  assert.equal(a.world.kind, 'city');
  assert.equal(a.world.registeredId, 'nocturne');
  assert.equal(a.world.baseId, 'nocturne');
  assert.equal(a.world.id, 'custom');
  assert.notEqual(a.world.instanceId, 'nocturne');
  assert.equal(a.world.instanceId, instanceIdFor('nocturne', profile));
  assert.deepEqual(a.world.channels, getWorld('nocturne').channels);
});

test('After Hours and The Fathom treat the same song differently', () => {
  const { data, profile } = song({
    bpm: 90,
    energyAt: () => 0.35,
    bandsAt: () => [1.4, 1.2, 0.8, 0.5, 0.3, 0.2, 0.1],
  });
  const city = adaptWorld(getWorld('nocturne'), profile, data).world;
  const deep = adaptWorld(getWorld('fathom'), profile, data).world;
  assert.equal(city.kind, 'city');
  assert.equal(deep.kind, 'abyssal');
  assert.notEqual(city.instanceId, deep.instanceId);
  assert.ok(!city.characterScheme, 'city must not receive alpine character schemes');
  assert.ok(deep.characterScheme, 'fathom consumes ridge landforms');
  const cityKeys = Object.keys(city.terrainMods || {});
  const deepKeys = Object.keys(deep.terrainMods || {});
  assert.ok(cityKeys.every((k) => CITY_TERRAIN_KEYS.includes(k)), `city leaked ${cityKeys}`);
  assert.ok(!deepKeys.some((k) => CITY_TERRAIN_KEYS.includes(k)), `fathom leaked city keys ${deepKeys}`);
  assert.notEqual(city.response.smoothingMs, deep.response.smoothingMs);
  assert.notEqual(city.palettes[0].silhouette, deep.palettes[0].silhouette);
});

test('alpine terrain controls are not sent to a city; city controls are not sent to alpine', () => {
  const { data, profile } = song();
  const range = adaptWorld(getWorld('alpine'), profile, data).world;
  const city = adaptWorld(getWorld('nocturne'), profile, data).world;
  const strip = adaptWorld(getWorld('redline'), profile, data).world;
  for (const k of CITY_TERRAIN_KEYS) assert.equal(range.terrainMods?.[k], undefined);
  for (const k of RIDGE_TERRAIN_KEYS) assert.equal(city.terrainMods?.[k], undefined);
  assert.ok(range.characterScheme);
  assert.equal(city.characterScheme, null);
  assert.equal(strip.characterScheme, null);
  assert.ok(strip.terrainMods?.rollingAmpMul);
  assert.equal(strip.terrainMods?.shoulderMul, undefined);
  assert.equal(filterTerrainMods('city', { shoulderMul: 1.2, cityWidthMul: 0.8 }).shoulderMul, undefined);
});


test('response bounds: sparse is restrained, dense filters accents, quiet stays still', () => {
  const sparse = responseConfigFor('city', { watch: { onset: 0.08, energyMean: 0.3, dyn: 0.3 } });
  const dense = responseConfigFor('city', { watch: { onset: 0.8, energyMean: 0.6, dyn: 0.5 } });
  const quiet = responseConfigFor('city', { watch: { onset: 0.05, energyMean: 0.05, dyn: 0.08 } });
  assert.equal(sparse.band, 'sparse');
  assert.equal(dense.band, 'dense');
  assert.ok(sparse.accentGain > dense.accentGain);
  assert.ok(dense.smoothingMs > sparse.smoothingMs);
  assert.ok(dense.macroMs > sparse.macroMs);
  assert.equal(quiet.quiet, true);
  assert.equal(quiet.cityLightFloor, 0);
  assert.equal(quiet.waterLightFloor, 0);
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
    // Far Side: The Range's real biomes are never synthesized (see below),
    // so the palette path is exercised on a world that still is.
    result = adaptWorld(getWorld('farside'), profile, data);
  } finally {
    console.warn = original;
  }
  assert.equal(result.degraded.palette, true);
  assert.ok(result.proof.dna?.error);
  assert.ok(result.world.terrainMods, 'ridge geometry must survive a palette-only failure');
  assert.ok(result.world.characterScheme);
  assert.ok(warns.some((args) => String(args[0]).includes('palette')));
  assert.equal(result.world.palettes, getWorld('farside').palettes);
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
  const { world, proof } = buildWorldVariant('nocturne', feat);
  assert.equal(world.kind, 'city');
  assert.equal(world.registeredId, 'nocturne');
  assert.notEqual(proof.score, 100);
  assert.ok(proof.score >= 1 && proof.score <= 99);
  assert.equal(world.comfort, getWorld('nocturne').comfort);
});

test('Choose-for-me still picks a base and adapts it, without a privileged custom card', () => {
  const feat = {
    centroid: 0.8, bass: 0.1, air: 0.8, spread: 0.8, dyn: 0.2, energyMean: 0.15,
    phrase: 0.4, landmarks: 3, onset: 0.08, contrast: 0.2, groove: 0.2, warmth: 0.1,
    texture: 0.5, form: 0.3, arc: 0.15, drive: 0.1, bpm: 70, tempoHeat: 0.1, trend: 0,
  };
  const { world, baseId } = buildCustomWorld(feat);
  assert.ok(baseId);
  assert.equal(world.baseId, baseId);
  assert.equal(world.registeredId, baseId);
  assert.notEqual(baseId, 'cathode');
});

test('sampleWorldMusic without a response matches the historical floors; quiet response does not lift silence', () => {
  const plain = sampleWorldMusic({ nowMs: 0 });
  assert.ok(plain.cityLight > 0 && plain.waterLight > 0);
  const quiet = sampleWorldMusic({
    nowMs: 0,
    response: {
      cityLightFloor: 0, waterLightFloor: 0, ambientScale: 0.35,
      accentGain: 0, smoothingMs: 1200, accentWindowMs: 800, accentDecayMs: 150, macroMs: 8000,
    },
  });
  assert.equal(quiet.cityLight, 0);
  assert.equal(quiet.waterLight, 0);
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

for (const id of ['nave', 'foundry', 'redline']) {
  test(`${id}: adaptation preserves material lighting without mutating stock palettes`, () => {
    const base = getWorld(id);
    const before = structuredClone(base.palettes);
    const { data, profile } = song();
    const { world, degraded } = adaptWorld(base, profile, data);
    assert.equal(degraded.palette, false);
    assert.ok(world.palettes.length > 0);
    world.palettes.forEach((palette, i) => {
      assert.equal(palette.edgeLight, base.palettes[i % base.palettes.length].edgeLight);
      if (palette.edgeLight) assert.match(palette.edgeLight, /^#[0-9a-f]{6}$/i);
    });
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
    for (const base of listWorlds()) {
      if (base.kind === 'alpine') continue;
      const { world } = adaptWorld(base, profile, data);
      assert.equal(world.kind, base.kind);
      const particles = new Set(base.palettes.map(p => p.particles.kind));
      const effects = new Set(base.palettes.map(p => p.fx));
      for (const palette of world.palettes) {
        assert.ok(particles.has(palette.particles.kind), `${base.kind}: inappropriate ${palette.particles.kind}`);
        assert.ok(effects.has(palette.fx), `${base.kind}: inappropriate ${palette.fx}`);
      }
    }
  });
}

test('Far Side adaptation keeps an airless dark sky around its primary', () => {
  const { data, profile } = song({ energyAt: () => 0.9, bpm: 160 });
  const base = listWorlds().find(w => w.kind === 'airless');
  const { world } = adaptWorld(base, profile, data);
  for (const palette of world.palettes) {
    for (const color of [...palette.sky, ...palette.skyStops]) {
      assert.ok(color.slice(1).match(/../g).every(byte => parseInt(byte, 16) < 64), color);
    }
  }
});

test('After Hours adaptation keeps the sky subordinate to city lights', () => {
  const { data, profile } = song();
  const base = listWorlds().find(w => w.kind === 'city');
  const { world } = adaptWorld(base, profile, data);
  for (const palette of world.palettes) {
    for (const color of [...palette.sky, ...palette.skyStops]) {
      assert.ok(color.slice(1).match(/../g).every(byte => parseInt(byte, 16) < 112), color);
    }
  }
});
