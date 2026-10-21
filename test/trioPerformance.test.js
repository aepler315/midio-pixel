import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/sim/Simulation.js';
import { Conductor } from '../src/core/Conductor.js';
import { ParamBus } from '../src/core/ParamBus.js';
import { Midio } from '../src/sim/Midio.js';
import { Broshi } from '../src/sim/Broshi.js';
import { Midasus } from '../src/sim/Midasus.js';
import { synthesizeEnergyCurves } from '../src/core/EnergyCurvesSynth.js';
import { VoyagePhase } from '../src/sim/SkyVoyage.js';

function scene(silent = false, experience = 'trio', withLead = false) {
  const timeline = silent ? [] : Array.from({ length: 60 }, (_, i) => [
    { tMs: i * 500, durMs: 80, pitch: 36, vel: .85, role: 'RHYTHM', kick: true },
    { tMs: i * 500, durMs: 300, pitch: 36 + i % 5, vel: .8, role: 'BASS', lane: 'BROSHI' },
    { tMs: i * 500 + 150, durMs: 250, pitch: 60 + i % 12, vel: .75, role: 'MELODY', lane: 'MIDASUS' },
    ...(withLead ? [{ tMs: i * 500 + 250, durMs: 150, pitch: 70, vel: .9, role: 'MELODY', lane: 'MIDIO' }] : []),
  ]).flat().sort((a, b) => a.tMs - b.tMs);
  const conductor = new Conductor();
  conductor.load({ timeline, durationMs: 30000, bpm: 120, barGrid: [] });
  const sim = new Simulation(conductor, new ParamBus(), { experience, songSeed: 315,
    energyCurves: synthesizeEnergyCurves(timeline, 30000) });
  sim.biomes.pumpStripPrewarm = () => {};
  return sim;
}

test('Trio owns the three maintained performers without a score or failure state', () => {
  const sim = scene();
  try {
    assert.equal(sim.experience, 'trio');
    assert.ok(sim.trio?.midio instanceof Midio);
    assert.ok(sim.trio.broshi instanceof Broshi);
    assert.ok(sim.trio.midasus instanceof Midasus);
    assert.equal(sim.score, undefined);
    assert.equal(sim.trio.scoreKeeper, undefined);
    assert.equal(sim.rangeNarrativeAt(), null);
    assert.equal(sim.presentation.performers, true);
  } finally { sim.dispose(); }
});

test('the automatic performance jumps, hops to bass and follows melody while silence stays grounded', () => {
  const sim = scene(), quiet = scene(true);
  try {
    assert.ok(sim.trio, 'automatic performance must exist');
    let jump = 0, hop = 0, melodyMove = 0;
    const initial = { ...sim.trio.midasus.p };
    for (let t = 0; t <= 3000; t += 50) {
      sim.step(50, t); quiet.step(50, t);
      jump = Math.max(jump, sim.trio.midio.y);
      hop = Math.max(hop, sim.trio.broshi.hopY);
      melodyMove = Math.max(melodyMove, Math.hypot(sim.trio.midasus.p.x - initial.x, sim.trio.midasus.p.y - initial.y));
      assert.equal(quiet.trio.jump.airborne, false);
      assert.ok(Math.abs(quiet.trio.midio.y) < 6, 'only the small idle breath remains');
    }
    assert.ok(jump > 30 && hop > 5 && melodyMove > 20, JSON.stringify({ jump, hop, melodyMove }));
  } finally { sim.dispose(); quiet.dispose(); }
});

test('a destination seek reconstructs the active choreography and discards stale future effects', () => {
  const sim = scene();
  try {
    assert.ok(sim.trio);
    const snapshot = () => ({ midio: sim.trio.midio.renderY, broshi: sim.trio.broshi.renderX,
      midasus: { ...sim.trio.midasus.p }, worldX: sim.trio.worldX });
    sim.trio.seek(15000); const first = snapshot();
    sim.trio.seek(23000); sim.trio.seek(2000); sim.trio.seek(15000);
    assert.deepEqual(snapshot(), first);
    assert.ok(Object.values(first).filter(v => typeof v === 'number').every(Number.isFinite));
  } finally { sim.dispose(); }
});

test('Landscape and Trio are separate worlds: only Trio builds a cast, and disposing it releases its listeners', () => {
  const landscape = scene(false, 'landscape'), trio = scene();
  try {
    assert.equal(landscape.worldId, 'alpine');
    assert.equal(landscape.trio, null);
    assert.equal(landscape.presentation.performers, false);
    assert.equal(trio.worldId, 'trio');
    assert.ok(trio.trio.conductor.aheadRegs.length > 0);
  } finally { landscape.dispose(); trio.dispose(); }
  assert.equal(trio.trio.disposed, true);
  assert.equal(trio.trio.conductor.aheadRegs.length, 0);
  assert.equal(trio.conductor.aheadRegs.length, 0);
});

test('Trio plays on the procedural pre-terrain range with its sky restored', () => {
  const sim = scene();
  try {
    const biomes = sim.biomes;
    assert.equal(biomes.terrainProfiles, null, 'no real terrain: every ridge layer stays procedural');
    assert.equal(biomes.world.realBiomes, undefined);
    assert.equal(biomes.presentation.performers, true, 'the deep sky draws the voyages of Midasus');
    assert.equal(biomes.presentation.crystalSpaceRidge, true);
    assert.equal(biomes.presentation.rangeSky, false, 'the pre-terrain sky, not The Range composition');
    assert.ok(biomes.skyEnsemble, 'seeded planets hang behind the celestial bodies');
    assert.ok(biomes.spaceRidge && biomes.weaver && biomes.stars?.length > 0);
  } finally { sim.dispose(); }
});

test('the cast stands on the ground the world draws, with Midio as its origin', () => {
  const sim = scene();
  try {
    for (let t = 0; t <= 2000; t += 50) sim.step(50, t);
    const trio = sim.trio;
    assert.equal(trio.ground, sim.groundField);
    assert.equal(sim.worldX, trio.worldX);
    assert.equal(sim.stageAnchor.x, trio.midio.screenX);
    assert.equal(trio.midio.groundY, sim.groundField.heightAt(trio.worldX));
  } finally { sim.dispose(); }
});

test('a sustained epic stretch sends Midasus to space to draw, and she comes home before the end', () => {
  const timeline = Array.from({ length: 240 }, (_, i) => [
    { tMs: i * 500, durMs: 80, pitch: 36, vel: .85, role: 'RHYTHM', kick: true },
    { tMs: i * 500 + 150, durMs: 250, pitch: 60 + i % 12, vel: .75, role: 'MELODY', lane: 'MIDASUS' },
  ]).flat();
  const conductor = new Conductor();
  conductor.load({ timeline, durationMs: 120000, bpm: 120, barGrid: [] });
  const sim = new Simulation(conductor, new ParamBus(), { experience: 'trio', songSeed: 315,
    energyCurves: synthesizeEnergyCurves(timeline, 120000) });
  sim.biomes.pumpStripPrewarm = () => {};
  try {
    const vibe = sim.trio.vibe;
    vibe.update = () => {}; vibe.epic = .9; vibe.valence = .2;
    let launchedAt = null, deep = false, shakes = 0;
    const shake = sim.camera.shake.bind(sim.camera);
    sim.camera.shake = (...args) => { shakes++; return shake(...args); };
    for (let t = 0; t <= 40000; t += 50) {
      sim.step(50, t);
      const voyage = sim.trio.midasus.voyage;
      if (voyage.active && launchedAt == null) launchedAt = t;
      if (voyage.phase === VoyagePhase.DEEP_SPACE) deep = true;
    }
    assert.ok(launchedAt != null && launchedAt >= 12000 && launchedAt <= 20000, `launched at ${launchedAt}`);
    assert.ok(deep, 'she reaches deep space and draws there');
    assert.ok(shakes >= 1, 'the send-off is felt');
    assert.ok(sim.trio.midasus.voyage.atlas.length > 0 || sim.trio.midasus.voyage.constellations.length > 0,
      'her figures stay written in the sky');
    for (let t = 40050; t <= 100000; t += 50) sim.step(50, t);
    assert.equal(sim.trio.midasus.voyage.active, false, 'everyone is home for the last 25 s');
  } finally { sim.dispose(); }
});

test('the trio settles after the audio ends instead of freezing an unfinished pose at duration', () => {
  const sim = scene();
  try {
    sim.trio.seek(29000); sim.trio.update(31000);
    assert.equal(sim.trio.clockMs, 31000);
    assert.equal(sim.trio.jump.airborne, false);
  } finally { sim.dispose(); }
});

test('seeking primes the full lead-accent budget as well as kick arcs', () => {
  const sim = scene(false, 'trio', true);
  try {
    for (let t = 0; t <= 15000; t += 1000 / 120) sim.trio.update(t);
    sim.trio.update(15000);
    const last = sim.trio.lastAirJumpMs, y = sim.trio.jump.y;
    sim.trio.seek(15000);
    assert.equal(sim.trio.lastAirJumpMs, last);
    assert.ok(Math.abs(sim.trio.jump.y - y) < .001);
  } finally { sim.dispose(); }
});
