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
import { MIDIO_MIN, MIDIO_MAX } from '../src/sim/TrioWander.js';
import { TrioPerformance } from '../src/sim/TrioPerformance.js';

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

// A long 120 bpm song (kick, bass and melody every 500 ms) played straight
// into a TrioPerformance, for multi-seed checks longer than scene()'s 30 s.
const LONG_MS = 125000;
function longTimeline(silent) {
  if (silent) return [];
  return Array.from({ length: LONG_MS / 500 }, (_, i) => [
    { tMs: i * 500, durMs: 80, pitch: 36, vel: .85, role: 'RHYTHM', kick: true },
    { tMs: i * 500, durMs: 300, pitch: 36 + i % 5, vel: .8, role: 'BASS', lane: 'BROSHI' },
    { tMs: i * 500 + 150, durMs: 250, pitch: 60 + i % 12, vel: .75, role: 'MELODY', lane: 'MIDASUS' },
  ]).flat().sort((a, b) => a.tMs - b.tMs);
}
function performance(seed, silent = false) {
  const timeline = longTimeline(silent);
  return new TrioPerformance({ timeline, durationMs: LONG_MS, bpm: 120, barGrid: [],
    energyCurves: synthesizeEnergyCurves(timeline, LONG_MS), paramBus: new ParamBus(), seed });
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
    assert.equal(biomes.presentation.horizonEq, true, 'the dancing spectrum ridge rides the horizon');
    assert.ok(biomes.skyEnsemble, 'seeded planets hang behind the celestial bodies');
    assert.ok(biomes.spaceRidge && biomes.weaver && biomes.stars?.length > 0);
  } finally { sim.dispose(); }
});

test('the cast stands on the ground the world draws, each at their own screen x from its fixed origin', () => {
  const sim = scene();
  try {
    const trio = sim.trio;
    const xs = new Set();
    for (let t = 0; t <= 12000; t += 50) {
      sim.step(50, t);
      assert.equal(trio.ground, sim.groundField);
      assert.equal(sim.worldX, trio.worldX);
      assert.equal(sim.stageAnchor.x, trio.originX, 'the ground is drawn from a fixed origin, not dragged along by Midio');
      const at = x => sim.groundField.heightAt(trio.worldX + x - trio.originX);
      // The cast steps just before the ground's own update in a frame, so
      // allow that one step of the ground's dance.
      assert.ok(Math.abs(trio.midio.groundY - at(trio.midio.screenX)) < 2, `${trio.midio.groundY} vs ${at(trio.midio.screenX)}`);
      assert.ok(Math.abs(trio.broshi.groundY - at(trio.broshi.renderX)) < 2);
      xs.add(Math.round(trio.midio.screenX / 10));
    }
    assert.ok(xs.size > 3, 'he strolls rather than standing on one spot');
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

test('wandering is a pure function of seed and heard time: a seek lands where continuous play is', () => {
  const live = scene();
  const STEP = 1000 / 120, checks = [4000, 9000, 13500, 18250, 26000];
  const seen = [];
  try {
    let next = 0;
    for (let t = 0; next < checks.length; t += STEP) {
      live.trio.update(t);
      if (Math.abs(t - checks[next]) < STEP / 2) {
        const tr = live.trio;
        seen.push({ t, midio: tr.midio.screenX, lean: tr.wander.midio.leanDeg, plan: { ...tr.wander.broshi }, broshi: tr.broshi.renderX,
          facing: tr.broshi.facing, midasus: { ...tr.midasus.p }, away: tr.midasus.voyage.active });
        next++;
      }
    }
  } finally { live.dispose(); }
  for (const want of seen) {
    const sought = scene();
    try {
      const tr = sought.trio;
      tr.seek(want.t);
      // Exact up to the float rounding of where each 120 Hz lattice lands.
      assert.ok(Math.abs(tr.midio.screenX - want.midio) < 1e-6, `Midio's spot at ${want.t}`);
      assert.ok(Math.abs(tr.wander.midio.leanDeg - want.lean) < 1e-6, `Midio's carriage at ${want.t}`);
      for (const k of Object.keys(want.plan)) {
        const a = tr.wander.broshi[k], b = want.plan[k];
        assert.ok(typeof a === 'number' ? Math.abs(a - b) < 1e-6 : a === b, `Broshi's plan.${k} at ${want.t}`);
      }
      assert.ok(Math.abs(tr.broshi.renderX - want.broshi) < 1, `Broshi at ${want.t}: ${tr.broshi.renderX} vs ${want.broshi}`);
      assert.ok(Math.abs(tr.broshi.facing - want.facing) < 1e-3, `Broshi's facing at ${want.t}`);
      // A seek starts a new excursion budget, so only compare her at home.
      if (!want.away && !tr.midasus.voyage.active) {
        assert.ok(Math.hypot(tr.midasus.p.x - want.midasus.x, tr.midasus.p.y - want.midasus.y) < 2,
          `Midasus at ${want.t}: ${JSON.stringify(tr.midasus.p)} vs ${JSON.stringify(want.midasus)}`);
      }
    } finally { sought.dispose(); }
  }
});

test('a seek puts Broshi where continuous play does, on the same side of Midio, for any seed', () => {
  const STEP = 1000 / 120;
  for (const seed of [1, 7, 99, 315, 1234]) {
    const live = performance(seed), seen = [];
    try {
      for (let t = 0, next = 1000; next <= 60000; t += STEP) {
        live.update(t);
        if (Math.abs(t - next) < STEP / 2) { seen.push({ t, x: live.broshi.renderX, side: live.wander.broshi.side }); next += 1000; }
      }
    } finally { live.dispose(); }
    const sought = performance(seed);
    try {
      for (const want of seen) {
        sought.seek(want.t);
        assert.ok(Math.abs(sought.broshi.renderX - want.x) < 1.5,
          `seed ${seed} at ${Math.round(want.t)}: ${sought.broshi.renderX} vs ${want.x}`);
        assert.equal(sought.wander.broshi.side, want.side);
      }
    } finally { sought.dispose(); }
  }
});

test('the wandering cast keep to the stage: Midio in his window, Broshi on screen, Midasus in the sky and not parked over Midio', () => {
  for (const silent of [false, true]) {
    const sim = scene(silent);
    try {
      const tr = sim.trio, w = tr.w;
      let over = 0, longestOver = 0, run = 0, moved = 0, prevX = tr.midio.screenX;
      for (let t = 0; t <= 30000; t += 50) {
        sim.step(50, t);
        const m = tr.midio, b = tr.broshi, f = tr.midasus;
        assert.ok(m.screenX >= w * MIDIO_MIN - 1e-9 && m.screenX <= w * MIDIO_MAX + 1e-9, `Midio at ${m.screenX}`);
        assert.ok(b.renderX >= 70 - 1e-9 && b.renderX <= w - 70 + 1e-9, `Broshi at ${b.renderX}`);
        assert.ok([m.screenX, m.groundY, b.renderX, b.groundY, b.hopY, f.p.x, f.p.y, m.leanDeg].every(Number.isFinite));
        if (!f.voyage.active) {
          assert.ok(f.p.y < m.groundY - 150, `Midasus flies in the sky (${f.p.y})`);
          if (Math.abs(f.p.x - m.screenX) < 90) { over++; run++; longestOver = Math.max(longestOver, run); } else run = 0;
        } else run = 0;
        moved += Math.abs(m.screenX - prevX); prevX = m.screenX;
      }
      assert.ok(longestOver * 50 < 2500, `Midasus hung over Midio for ${longestOver * 50} ms (silent=${silent})`);
      assert.ok(over / 600 < .2, `Midasus spent ${(over / 6).toFixed(0)}% over Midio (silent=${silent})`);
      assert.ok(moved > 150, `Midio pottered ${moved.toFixed(0)} px (silent=${silent})`);
    } finally { sim.dispose(); }
  }
});

test('over two minutes and many seeds, Midasus never hangs over Midio and Broshi walks the way he faces', () => {
  const STEP = 1000 / 120;
  for (const seed of [1, 42, 315, 1234, 4242, 77777]) {
    for (const silent of [false, true]) {
      const tr = performance(seed, silent);
      try {
        let run = 0, longest = 0, fast = 0, backwards = 0, prevX = null;
        for (let t = 0; t <= 120000; t += STEP) {
          tr.update(t);
          const m = tr.midio, b = tr.broshi, f = tr.midasus;
          if (!f.voyage.active && Math.abs(f.p.x - m.screenX) < 90) { run += STEP; longest = Math.max(longest, run); } else run = 0;
          if (prevX != null) {
            const v = (b.renderX - prevX) / (STEP / 1000);
            if (Math.abs(v) > 20) { fast++; if (Math.abs(b.facing) > .5 && Math.sign(v) !== Math.sign(b.facing)) backwards++; }
          }
          prevX = b.renderX;
        }
        assert.ok(longest < 2500, `seed ${seed} (silent=${silent}): Midasus hung over Midio for ${Math.round(longest)} ms`);
        assert.ok(backwards / fast < .1, `seed ${seed} (silent=${silent}): Broshi moved against his facing in ${(100 * backwards / fast).toFixed(1)}% of moving frames`);
      } finally { tr.dispose(); }
    }
  }
});

test('Midio-anchored effects start from Midio himself while the ground keeps its fixed origin', () => {
  const sim = scene();
  try {
    const tr = sim.trio;
    let glows = 0, poses = 0;
    for (let t = 0; t <= 20000; t += 50) {
      sim.step(50, t);
      const pose = sim.lerpState(1);
      assert.equal(pose.midioDrawX, tr.midio.screenX, 'drop speed-lines and the heat lens start at Midio');
      assert.equal(pose.midioX, tr.originX, 'the ground is still drawn from its origin');
      assert.equal(pose.originX, tr.originX);
      assert.equal(sim.biomes.spotX, tr.midio.screenX, 'the spotlight snaps onto Midio');
      assert.equal(sim.biomes.midioX, tr.originX);
      if (Math.abs(tr.midio.screenX - tr.originX) > 100) {
        poses++;
        // The kick glow (a ground light) lands under Midio, then rides the
        // scrolling ground: within one 50 ms step of scroll (~11 px).
        const fresh = sim.groundField._glows.filter(g => g.startMs >= t - 50);
        for (const g of fresh) {
          const x = g.originWorldX - sim.worldX + tr.originX;
          assert.ok(Math.abs(x - tr.midio.screenX) < 30, `glow at ${x}, Midio at ${tr.midio.screenX}`);
          glows++;
        }
      }
    }
    assert.ok(poses > 20 && glows > 5, JSON.stringify({ poses, glows }));
  } finally { sim.dispose(); }
});

test('a malformed or empty timeline still wanders on finite ground', () => {
  const bad = [{ tMs: NaN, role: 'RHYTHM', kick: true, vel: 1 }, { tMs: 400, pitch: NaN, vel: .9, role: 'MELODY', lane: 'MIDASUS' },
    { tMs: 800, vel: .9, role: 'BASS', lane: 'BROSHI' }, { tMs: 1200, pitch: 64, role: 'MELODY', lane: 'MIDASUS' },
    { tMs: 1300, pitch: 66, vel: NaN, role: 'MELODY', lane: 'MIDASUS' }];
  // A melody note with no velocity used to NaN Midasus's flight.
  const noVel = [{ tMs: 400, pitch: 64, role: 'MELODY', lane: 'MIDASUS' }, { tMs: 900, pitch: 40, role: 'BASS', lane: 'BROSHI' },
    { tMs: 1000, pitch: 36, role: 'RHYTHM', kick: true, vel: NaN }];
  const tr = new TrioPerformance({ timeline: noVel, durationMs: 10000, paramBus: new ParamBus(), seed: 3 });
  try {
    for (let t = 0; t <= 4000; t += 1000 / 120) tr.update(t);
    assert.ok(Number.isFinite(tr.midasus.p.x) && Number.isFinite(tr.midasus.p.y), JSON.stringify(tr.midasus.p));
  } finally { tr.dispose(); }
  for (const timeline of [[], bad]) {
    const conductor = new Conductor();
    conductor.load({ timeline, durationMs: 10000, bpm: 120, barGrid: [] });
    const sim = new Simulation(conductor, new ParamBus(), { experience: 'trio', songSeed: 7, energyCurves: null });
    sim.biomes.pumpStripPrewarm = () => {};
    try {
      for (let t = 0; t <= 9000; t += 50) sim.step(50, t);
      sim.trio.seek(4321);
      const tr = sim.trio;
      assert.ok([tr.midio.screenX, tr.midio.groundY, tr.broshi.renderX, tr.broshi.groundY, tr.midasus.p.x, tr.midasus.p.y,
        tr.gaze.dirX, tr.gaze.dirY, tr.gaze.openness].every(Number.isFinite),
        JSON.stringify({ ...tr.pose(), b: tr.broshi.renderX, bg: tr.broshi.groundY, f: tr.midasus.p, g: [tr.gaze.dirX, tr.gaze.dirY, tr.gaze.openness] }));
    } finally { sim.dispose(); }
  }
});

test('the trio leave no drawn paths behind them', () => {
  const sim = scene();
  try {
    const tr = sim.trio;
    for (let t = 0; t <= 6000; t += 50) {
      sim.step(50, t);
      assert.equal(tr.broshi.trail, undefined, 'no comet-mote trail off Broshi');
      assert.equal(tr.performer.afterimages, undefined, 'no motion-streak ghosts off Midio');
      // Her only motes are note-impact bursts (size 4), never a flight ribbon.
      assert.ok(tr.midasus.particles.active.every(p => p.size === 4));
    }
  } finally { sim.dispose(); }
  const quiet = scene(true);
  try {
    for (let t = 0; t <= 6000; t += 50) quiet.step(50, t);
    assert.equal(quiet.trio.midasus.particles.active.length, 0, 'flying with no notes leaves nothing behind her');
  } finally { quiet.dispose(); }
});

test('Trio steps never reach for Math.random or the wall clock', () => {
  const sim = scene();
  const random = Math.random, now = Date.now;
  try {
    Math.random = () => { throw new Error('Math.random in the Trio step'); };
    Date.now = () => { throw new Error('Date.now in the Trio step'); };
    for (let t = 0; t <= 8000; t += 1000 / 120) sim.trio.update(t);
    sim.trio.seek(20000);
  } finally { Math.random = random; Date.now = now; sim.dispose(); }
});
