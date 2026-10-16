// Simulation._applyCues: the arm that turns a fired conductor cue into an
// actual engine call, plus the director-side entry points those calls need.
//
// The through-line every one of these guards: a cue is AUTHORED, so honoring
// it must not be conditional on a probability roll or on a threshold the
// author can't see from the drum editor. The music-driven paths next to them
// keep all their gating -- that asymmetry is the feature, and it's what
// these tests pin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/sim/Simulation.js';
import { CueKind } from '../src/core/ConductorTrack.js';
import { HypeDirector } from '../src/sim/HypeDirector.js';
import { CalmDirector } from '../src/sim/CalmDirector.js';
import { KeyDirector } from '../src/sim/KeyDirector.js';
import { WeatherDirector } from '../src/sim/WeatherDirector.js';
import { LightningFX } from '../src/world/Lightning.js';
import { EnsembleDirector } from '../src/sim/EnsembleDirector.js';

/** A bare-prototype Simulation with every cue target replaced by a recorder.
 *  _applyCues touches nothing else, so the full sim graph isn't needed. */
function bareSimWithCues(cues) {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  const sim = Object.create(Simulation.prototype);
  sim.cues = { fired: cues };
  sim.hype = { cueDrop: rec('cueDrop') };
  sim.apotheosis = { forceTrigger: rec('forceTrigger') };
  sim.ensemble = { maybeDisc: rec('maybeDisc') };
  sim.keyDirector = { forceChange: rec('forceChange') };
  sim.calm = { cueCalm: rec('cueCalm') };
  sim.biomes = { cueMeteors: rec('cueMeteors'), cueLightning: rec('cueLightning') };
  sim.weather = { cueKind: rec('cueKind') };
  sim.camera = { shake: rec('shake') };
  sim.groundField = { impulse: rec('impulse') };
  sim.rippleFX = { trigger: rec('trigger') };
  sim.fever = { spark: rec('spark') };
  sim.perf = { particleMul: 1 };
  sim.vibe = { epic: 0.5 };
  sim.worldX = 100;
  sim.midio = { groundY: 500 };
  sim._pendingDiscReason = null;
  return { sim, calls };
}

const cue = (kind, value = 1, tMs = 1000) => ({ tMs, kind, value, bucket: 8 });

test('each live cue kind reaches its own engine entry point', () => {
  const cases = [
    [CueKind.KEY_CHANGE, 'forceChange'],
    [CueKind.CALM, 'cueCalm'],
    [CueKind.METEORS, 'cueMeteors'],
    [CueKind.LIGHTNING, 'cueLightning'],
    [CueKind.SHAKE, 'shake'],
  ];
  for (const [kind, expected] of cases) {
    const { sim, calls } = bareSimWithCues([cue(kind)]);
    sim._applyCues(1000);
    assert.ok(calls.some((c) => c[0] === expected), `${kind} should call ${expected}`);
  }
});

test('retired actor cues cannot revive flourishes, apotheosis or scoring fever', () => {
  const { sim, calls } = bareSimWithCues([cue(CueKind.FLOURISH), cue(CueKind.APOTHEOSIS), cue(CueKind.FEVER)]);
  sim._applyCues(1000);
  assert.deepEqual(calls, []);
  assert.equal(sim._pendingDiscReason, null);
});

test('a drop cue surges world hype without arming a performer flourish', () => {
  const { sim, calls } = bareSimWithCues([cue(CueKind.DROP, 0.75)]);
  sim._applyCues(1000);
  assert.deepEqual(calls[0], ['cueDrop', 1000, 0.75]);
  // Matches the detected drop's own one-phase deferral (see step()).
  assert.equal(sim._pendingDiscReason, null);
});

test('a weather cue passes the named kind through, not a strength', () => {
  const { sim, calls } = bareSimWithCues([{ tMs: 0, kind: CueKind.WEATHER, value: 'embers', bucket: 4 }]);
  sim._applyCues(0);
  assert.deepEqual(calls[0], ['cueKind', 0, 'embers']);
});

test('a ground-pulse cue shocks terrain without a performer impact echo', () => {
  const { sim, calls } = bareSimWithCues([cue(CueKind.GROUND_PULSE, 0.5)]);
  sim._applyCues(1000);
  assert.deepEqual(calls.map((c) => c[0]), ['impulse']);
});

test('cue strength scales the effect it drives', () => {
  const soft = bareSimWithCues([cue(CueKind.SHAKE, 0.125)]);
  soft.sim._applyCues(0);
  const loud = bareSimWithCues([cue(CueKind.SHAKE, 1)]);
  loud.sim._applyCues(0);
  assert.ok(loud.calls[0][1] > soft.calls[0][1], 'fff must shake harder than ppp');
});

test('every cue in one step is applied, not just the first', () => {
  const { sim, calls } = bareSimWithCues([
    cue(CueKind.SHAKE), cue(CueKind.WEATHER, 'embers'), cue(CueKind.CALM),
  ]);
  sim._applyCues(1000);
  assert.equal(calls.length, 3);
});

test('an unknown cue kind is ignored rather than throwing mid-step', () => {
  const { sim, calls } = bareSimWithCues([{ tMs: 0, kind: 'notARealCue', value: 1 }]);
  assert.doesNotThrow(() => sim._applyCues(0));
  assert.equal(calls.length, 0);
});

// --- The director-side entry points --------------------------------------

test('a cued drop fires regardless of the energy envelope the detector needs', () => {
  const hype = new HypeDirector();
  // No energy curves at all: the detector's own quiet-ceiling/delta test
  // could never fire here, which is exactly the case a cue has to survive.
  hype.update(0, 0.016, null);
  assert.equal(hype.dropCount, 0);
  hype.cueDrop(1000, 1);
  assert.equal(hype.dropCount, 1);
  assert.equal(hype.surge, 1);
  assert.equal(hype.dropAtMs, 1000);
});

test('a cued calm survives the update that recomputes level from energy', () => {
  const calm = new CalmDirector();
  const loud = { globalEnergyNorm: () => 1 }; // energy says "not calm at all"
  for (let t = 0; t < 2000; t += 16) calm.update(t, 0.016, loud);
  assert.ok(calm.level < 0.1, 'sanity: loud energy should read as un-calm');

  calm.cueCalm(2000, 1);
  calm.update(2016, 0.016, loud);
  assert.ok(calm.level > 0.9, 'the cue must not be erased by the next update');
});

test('a cued calm releases on its own rather than flattening the rest of the song', () => {
  const calm = new CalmDirector();
  const loud = { globalEnergyNorm: () => 1 };
  calm.cueCalm(0, 1);
  // Stepped continuously, not jumped: `level` also depends on the G energy
  // EMA, which only converges by advancing, so a single huge step would
  // leave the world reading calm for a reason that has nothing to do with
  // the cue and prove nothing about its release.
  let heldAt2s = null;
  for (let t = 0; t <= 30000; t += 16) {
    calm.update(t, 0.016, loud);
    if (heldAt2s === null && t >= 2000) heldAt2s = calm.level;
  }
  assert.ok(heldAt2s > 0.9, 'still held inside the hold window');
  assert.ok(calm.level < 0.1, 'long past the release the music is back in charge');
});

test('a cued calm only ever raises calm, never holds the world loud', () => {
  const calm = new CalmDirector();
  const quiet = { globalEnergyNorm: () => 0 };
  calm.cueCalm(0, 0.2); // a weak cue during a genuinely quiet passage
  calm.update(100, 0.016, quiet);
  assert.ok(calm.level > 0.9, 'the music’s own calm must win over a weaker cue');
});

test('a cued key change fires the wave without waiting for the stability gates', () => {
  const key = new KeyDirector();
  key.update(0, 0.016, { tonic: 0, tonicConfidence: 0.9 });
  assert.equal(key.justKeyChange, false);

  key.forceChange(1000);
  key.update(1000, 0.016, { tonic: 0, tonicConfidence: 0 }); // confidence irrelevant now
  assert.equal(key.justKeyChange, true);
  assert.ok(key.lastKeyChange);
  assert.ok(key.transitionActive);
});

test('a cued weather kind actually lands instead of being re-evaluated away', () => {
  const w = new WeatherDirector();
  assert.equal(w.cueKind(0, 'embers'), true);
  // Drive the crossfade through: the outgoing field eases to 0, then the
  // cued kind takes over -- and the mood evaluator must not have queued
  // something else on top in the meantime.
  for (let t = 0; t < 8000; t += 16) {
    w.update(t, 0.016, { valence: 1, epic: 0, calm: 0, energySlow: 0.5 });
  }
  assert.equal(w.kind, 'embers');
});

test('cueKind rejects a kind the weather system does not have', () => {
  const w = new WeatherDirector();
  assert.equal(w.cueKind(0, 'frogs'), false);
  assert.equal(w.cueKind(0, w.kind), false, 'cueing the live kind is a no-op');
});

test('a cued bolt strikes at any dynamic, where the music path would not', () => {
  const soft = 0.2; // well under maybeTrigger's own 0.66 velocity gate
  const a = new LightningFX(1);
  a.maybeTrigger(1000, soft, 1280, 600);
  assert.equal(a.flash, 0, 'sanity: the music path ignores a soft hit');

  const b = new LightningFX(1);
  b.strike(1000, 1280, 600);
  assert.equal(b.flash, 1, 'an authored bolt always lands');
});

test('a cued flourish skips the probability roll a plain section change rolls', () => {
  // rand() = 0.99 fails any chance roll, isolating the transition bypass.
  const ens = new EnsembleDirector(1, { stageW: 1280, stageH: 720 });
  ens._discGate.rand = () => 0.99;
  ens._discGate.chance = 0;
  ens._discGate.intensityChance = 0;
  assert.equal(ens.maybeDisc(100000, 'section', 0.5), false, 'sanity: a rolled cue can be denied');

  ens._discGate.lastFireMs = -Infinity; // clear the floor the attempt above left
  assert.equal(ens.maybeDisc(200000, 'cue', 0.5), true, 'an authored flourish is not rolled for');
});
