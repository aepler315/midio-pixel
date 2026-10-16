import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ObstacleSpawner, obstacleArchetype, emergenceEnvelope, dissolveEnvelope,
  ARCHETYPES, EMERGENCE_PX, DISSOLVE_PX, BURST_LIFE_MS, geoRowTimes, GEO_SHAPES,
} from '../src/sim/ObstacleSpawner.js';

function fakeCtx() {
  const calls = { fill: 0, stroke: 0, save: 0 };
  const grad = { addColorStop() {} };
  return {
    calls,
    save() { calls.save++; }, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    quadraticCurveTo() {}, arc() {}, rotate() {}, scale() {}, translate() {},
    fill() { calls.fill++; }, stroke() { calls.stroke++; }, fillRect() {}, strokeRect() {},
    createLinearGradient() { return grad; }, createRadialGradient() { return grad; },
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {},
    set globalAlpha(_v) {}, set globalCompositeOperation(_v) {},
  };
}

test('ARCHETYPES lists all four ambient obstacle kinds', () => {
  assert.deepEqual([...ARCHETYPES], ['thorn', 'veil', 'echo', 'pipe']);
});

test('obstacleArchetype partitions [0,1) evenly across the four kinds, deterministically', () => {
  assert.equal(obstacleArchetype(0), 'thorn');
  assert.equal(obstacleArchetype(0.24), 'thorn');
  assert.equal(obstacleArchetype(0.26), 'veil');
  assert.equal(obstacleArchetype(0.49), 'veil');
  assert.equal(obstacleArchetype(0.51), 'echo');
  assert.equal(obstacleArchetype(0.74), 'echo');
  assert.equal(obstacleArchetype(0.76), 'pipe');
  assert.equal(obstacleArchetype(0.99), 'pipe');
});

test('emergenceEnvelope: 0 far ahead, ramps to 1 by the time it arrives, clamped both ends', () => {
  assert.equal(emergenceEnvelope(EMERGENCE_PX * 3), 0);
  assert.equal(emergenceEnvelope(0), 1);
  assert.equal(emergenceEnvelope(-50), 1, 'already past the emergence point should stay fully formed');
  const half = emergenceEnvelope(EMERGENCE_PX / 2);
  assert.ok(half > 0 && half < 1);
});

test('dissolveEnvelope: 1 right at the moment of passing, eases to 0 over DISSOLVE_PX, clamped', () => {
  assert.equal(dissolveEnvelope(0), 1);
  assert.equal(dissolveEnvelope(DISSOLVE_PX * 3), 0);
  const half = dissolveEnvelope(DISSOLVE_PX / 2);
  assert.ok(half > 0 && half < 1);
});

test('a fresh ObstacleSpawner has no active obstacles and draw() is a safe no-op', () => {
  const spawner = new ObstacleSpawner({ live: { obstacleDensity: 1 } });
  const ctx = fakeCtx();
  assert.doesNotThrow(() => spawner.draw(ctx, 0, 220, 480));
  assert.equal(ctx.calls.save, 0);
});

test('spawned obstacles carry a deterministic archetype/phase and draw without throwing across the full lifecycle', () => {
  const spawner = new ObstacleSpawner({ live: { obstacleDensity: 1 } }, { seed: 7 });
  // Force a couple of candidates directly (bypassing buildCandidates' musical
  // placement logic, which is covered by obstacleSafety.test.js) to exercise update()'s spawn path.
  spawner.candidates = [{ tMs: 1000 }, { tMs: 1400 }];
  spawner.update(0, 0, 0.22); // scrollSpeedPxMs ~ WORLD_SPEED_PX_S/1000
  assert.ok(spawner.active.length > 0, 'expected at least one obstacle to spawn at density=1');
  for (const o of spawner.active) {
    assert.ok(['thorn', 'veil', 'echo', 'pipe'].includes(o.archetype));
    assert.ok(Number.isFinite(o.phase));
  }

  const ctx = fakeCtx();
  // Approaching, at arrival, and past (dissolving) -- all three lifecycle phases.
  for (const worldX of [-500, spawner.active[0].wx, spawner.active[0].wx + 200]) {
    assert.doesNotThrow(() => spawner.draw(ctx, worldX, 220, 480, {
      nowMs: 1000, energyCurves: null, haloColor: '#8a3a6b', wind: { x: 5, y: 0 }, particleMul: 1, reducedFlash: false,
    }));
  }
});

test('a pipe obstacle draws without throwing across its full approach/arrival/dissolve lifecycle', () => {
  const spawner = new ObstacleSpawner({ live: { obstacleDensity: 1 } }, { seed: 11 });
  spawner.active = [{ wx: 1000, tMs: 5000, height: 46, width: 28, archetype: 'pipe', phase: 1.7 }];
  const ctx = fakeCtx();
  for (const worldX of [1000 - 500, 1000, 1000 + 200]) {
    assert.doesNotThrow(() => spawner.draw(ctx, worldX, 220, 480, {
      nowMs: 5000, haloColor: '#8a3a6b', reducedFlash: false,
    }));
  }
  assert.ok(ctx.calls.fill > 0, 'the pipe body/collar/mouth should have painted something');
  assert.ok(ctx.calls.stroke > 0, 'the halo-tinted outline should have stroked');
});

test('draw() never throws with an energyCurves-driven pulse, reduced-flash, or fractional particleMul', () => {
  const spawner = new ObstacleSpawner({ live: { obstacleDensity: 1 } }, { seed: 3 });
  spawner.candidates = [{ tMs: 500 }];
  spawner.update(0, 0, 0.22);
  const fakeEnergy = { globalEnergy: () => 0.7, sample: () => 0.5 };
  const ctx = fakeCtx();
  assert.doesNotThrow(() => spawner.draw(ctx, 0, 220, 480, {
    nowMs: 500, energyCurves: fakeEnergy, haloColor: '#00ffd0', particleMul: 0.4, reducedFlash: true,
  }));
});

test('geoRowTimes lays count shapes evenly across [from,to], endpoints inclusive and ascending', () => {
  const times = geoRowTimes(1000, 1600, 4);
  assert.equal(times.length, 4);
  assert.equal(times[0], 1000, 'first shape sits at the window start');
  assert.equal(times[3], 1600, 'last shape sits at the window end');
  for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1], 'strictly ascending');
  // even spacing
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  for (const g of gaps) assert.ok(Math.abs(g - gaps[0]) < 1e-9, 'evenly spaced');
  // a single-shape row degenerates to the start, no divide-by-zero
  assert.deepEqual(geoRowTimes(500, 900, 1), [500]);
});

test('a geometric row candidate spawns a full lined-up line of clean polygon obstacles', () => {
  const spawner = new ObstacleSpawner({ live: { obstacleDensity: 1 } }, { seed: 5 });
  spawner.candidates = [{ tMs: 1000, row: { fromMs: 1000, toMs: 1600, count: 4, shape: 6 } }];
  spawner.update(0, 0, 0.22);
  const geos = spawner.active.filter((o) => o.archetype === 'geo');
  assert.equal(geos.length, 4, 'the whole row spawns at once');
  for (const o of geos) {
    assert.ok(GEO_SHAPES.includes(o.sides), 'each shape is from the geometric family');
    assert.equal(o.sides, 6, 'a row is one uniform polygon');
    assert.ok(Number.isFinite(o.phase));
  }
  const ctx = fakeCtx();
  for (const worldX of [-500, geos[0].wx, geos[0].wx + 200]) {
    assert.doesNotThrow(() => spawner.draw(ctx, worldX, 220, 480, {
      nowMs: 1000, energyCurves: { globalEnergy: () => 0.6, sample: () => 0.4 }, haloColor: '#00ffd0', reducedFlash: false,
    }));
  }
});

test('placement math is untouched: nearestAhead behaves as before (no collision -- obstacles are ambient only)', () => {
  const spawner = new ObstacleSpawner({ live: { obstacleDensity: 1 } });
  spawner.active = [{ wx: 100, width: 28, height: 46 }];
  assert.equal(spawner.nearestAhead(0).wx, 100);
});

test('the beat-synced burst fires exactly at the obstacle\'s own scheduled tMs, independent of world position', () => {
  const spawner = new ObstacleSpawner({ live: { obstacleDensity: 1 } }, { seed: 9 });
  spawner.candidates = [{ tMs: 2000 }];
  spawner.update(0, 0, 0.22);
  const o = spawner.active[0];
  // Far enough past in world-space that the shape itself has fully
  // dissolved (worldX - o.wx > DISSOLVE_PX), but still on-screen -- any
  // drawing left over can only be the burst, which reads its own tMs, not
  // Midio's position.
  const farWorldX = o.wx + 250;

  const before = fakeCtx();
  spawner.draw(before, farWorldX, 220, 480, { nowMs: o.tMs - 50 });
  assert.equal(before.calls.save, 0, 'nothing should draw before the burst, with the shape already dissolved');

  const during = fakeCtx();
  spawner.draw(during, farWorldX, 220, 480, { nowMs: o.tMs + 100, haloColor: '#8a3a6b' });
  assert.ok(during.calls.fill > 0, 'the burst should be drawing motes right after its own tMs');

  const after = fakeCtx();
  spawner.draw(after, farWorldX, 220, 480, { nowMs: o.tMs + BURST_LIFE_MS + 500 });
  assert.equal(after.calls.save, 0, 'the burst should be fully spent well after its life window');
});
