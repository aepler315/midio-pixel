import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BIOMES, biomeByName } from '../src/world/BiomeProfiles.js';
import { BIOME_TEMPERATURE, castBiomes } from '../src/world/Dramaturgy.js';
import { LANDMARKS } from '../src/world/Landmarks.js';
import { ModalRing } from '../src/render/oscillators.js';

// --- Profile validity ---

test('MIRROR is a real biome with the same profile shape as every other biome', () => {
  const mirror = biomeByName('MIRROR');
  assert.equal(mirror.name, 'MIRROR');
  assert.equal(mirror.sky.length, 3);
  for (const hex of mirror.sky) assert.match(hex, /^#[0-9a-f]{6}$/i);
  assert.match(mirror.silhouette, /^#[0-9a-f]{6}$/i);
  assert.ok(['sun', 'moon'].includes(mirror.celestial.kind));
  assert.match(mirror.celestial.color, /^#[0-9a-f]{6}$/i);
  assert.ok(mirror.celestial.radius > 0);
  assert.match(mirror.celestial.haloColor, /^#[0-9a-f]{6}$/i);
  assert.ok(mirror.particles.kind && mirror.particles.count > 0);
  assert.equal(mirror.fx, 'lakeReflection');
});

test('MIRROR owns a landmark painter set like every other biome', () => {
  assert.ok(Array.isArray(LANDMARKS.MIRROR) && LANDMARKS.MIRROR.length > 0);
  for (const b of BIOMES) assert.ok(LANDMARKS[b.name], `missing landmarks for ${b.name}`);
});

// --- Casting conditions: cast for calm (cold-temperature) sections ---

test('MIRROR sits in the cold band of the temperature table, alongside ARCTIC/SAKURA', () => {
  assert.ok('MIRROR' in BIOME_TEMPERATURE);
  assert.ok(BIOME_TEMPERATURE.MIRROR < 0.3, `expected a cold/calm temperature, got ${BIOME_TEMPERATURE.MIRROR}`);
});

test('castBiomes casts MIRROR into a calm (low-energy) section when it is the coldest option nearby', () => {
  // A gently rising energy curve -- the calmest section should land on
  // one of the cold-band biomes (MIRROR now among them).
  const cast = castBiomes([0.02, 0.4, 0.6, 0.98], 11);
  assert.ok(BIOME_TEMPERATURE[cast[0]] < 0.3, `coldest section got ${cast[0]} (temp ${BIOME_TEMPERATURE[cast[0]]})`);
});

test('MIRROR can actually win the coldest slot across a spread of seeds (not dead weight in the roster)', () => {
  let wins = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const cast = castBiomes([0.0, 0.5, 1.0], seed);
    if (cast[0] === 'MIRROR') wins++;
  }
  assert.ok(wins > 0, 'MIRROR never got cast across 40 seeds -- casting condition is unreachable');
});

// --- Ripples: the exact ModalRing configuration/excite formulas BiomeManager
// uses for the lake (modes:3, baseHz:1.1, decaySec:1.4; kick=3+9*vel, drop=22) ---

function makeLakeRing(seed = 1) {
  return new ModalRing({ modes: 3, baseHz: 1.1, decaySec: 1.4, seed });
}

test('a kick-strength ripple stays within a bounded displacement range at every slice angle', () => {
  const ring = makeLakeRing(3);
  ring.excite(3 + 9 * 1); // hardest possible kick (vel=1)
  for (let i = 0; i < 8; i++) {
    const theta = (i / 8) * Math.PI * 2;
    const d = ring.displacementAt(theta);
    assert.ok(Number.isFinite(d));
    assert.ok(Math.abs(d) <= 12, `slice ${i} displacement ${d} exceeds a sane bound`);
  }
});

test('a heavy drop ripple is visibly stronger than a light kick ripple, immediately after exciting', () => {
  const kickRing = makeLakeRing(5);
  const dropRing = makeLakeRing(5);
  kickRing.excite(3 + 9 * 0.5);
  dropRing.excite(22);
  assert.ok(dropRing.energy > kickRing.energy, 'a drop should ring harder than a mid-strength kick');
});

test('the lake ripple rings down toward zero and stays decaying (never re-grows without a new excite)', () => {
  const ring = makeLakeRing(7);
  ring.excite(22);
  let prevEnergy = ring.energy;
  let sawDecay = false;
  for (let i = 0; i < 300; i++) {
    ring.update(1 / 60);
    assert.ok(ring.energy <= prevEnergy + 1e-9, 'energy must never increase without a new excite');
    if (ring.energy < prevEnergy) sawDecay = true;
    prevEnergy = ring.energy;
  }
  assert.ok(sawDecay, 'expected visible ring-down over 5s');
  assert.ok(ring.energy < 0.5, `expected the ring to have mostly died out after 5s, energy=${ring.energy}`);
});

test('with no excitation at all, every slice offset is exactly zero (a calm lake stays calm)', () => {
  const ring = makeLakeRing(9);
  for (let i = 0; i < 8; i++) {
    const theta = (i / 8) * Math.PI * 2;
    assert.equal(ring.displacementAt(theta), 0);
  }
});
