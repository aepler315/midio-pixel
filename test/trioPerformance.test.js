import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/sim/Simulation.js';
import { Conductor } from '../src/core/Conductor.js';
import { ParamBus } from '../src/core/ParamBus.js';
import { Midio } from '../src/sim/Midio.js';
import { Broshi } from '../src/sim/Broshi.js';
import { Midasus } from '../src/sim/Midasus.js';
import { synthesizeEnergyCurves } from '../src/core/EnergyCurvesSynth.js';

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

test('Trio Stage owns the three maintained performers without a score or failure state', () => {
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

test('repeated experience changes preserve the shared transport and release all private actor listeners', () => {
  const sim = scene(false, 'landscape');
  try {
    sim.step(0, 12000);
    const conductor = sim.conductor, time = sim.timeMs, heard = sim.heardTimeMs;
    assert.equal(typeof sim.setExperience, 'function');
    for (let i = 0; i < 6; i++) {
      sim.setExperience('trio');
      const stage = sim.trio;
      assert.ok(stage.conductor.aheadRegs.length > 0);
      sim.setExperience('landscape');
      assert.equal(stage.conductor.aheadRegs.length, 0);
      assert.equal(stage.disposed, true);
      assert.equal(sim.trio, null);
      assert.equal(sim.conductor, conductor);
      assert.equal(sim.timeMs, time); assert.equal(sim.heardTimeMs, heard);
      assert.equal(conductor.aheadRegs.length, 0);
    }
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

test('a paused entry reconstructs the destination with current accessibility and particle preferences before any tick', () => {
  const sim = scene(false, 'landscape');
  try {
    sim.timeMs = sim.heardTimeMs = 12000;
    sim.reducedMotion = sim.reducedFlash = true;
    sim.perf = { particleMul: .25 };
    sim.setExperience('trio');
    assert.equal(sim.trio.reducedMotion, true);
    assert.equal(sim.trio.reducedFlash, true);
    assert.equal(sim.trio.broshi.reducedFlash, true);
    assert.equal(sim.trio.midasus.reducedFlash, true);
    assert.equal(sim.trio.particleMul, .25);
    assert.equal(sim.trio.clockMs, 12000);
    assert.equal(sim.trio.lastFlourishMs, -Infinity);
  } finally { sim.dispose(); }
});
