// The regression this file exists for: Broshi's and Midasus's disc spins
// fired on ComboSystem.justClean with no threshold, no probability and no
// cooldown. The show is autoplay, so every landing is clean -- at a kick-
// quantized jump every ~500ms, a 420ms spin restarted before it could
// resolve and both characters rotated continuously.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnsembleDirector } from '../src/sim/EnsembleDirector.js';
import { Broshi } from '../src/sim/Broshi.js';
import { Midasus } from '../src/sim/Midasus.js';

/** Minimal Conductor stand-in: Broshi only needs the subscription hooks and
 *  a bar grid, none of which we exercise here. */
function fakeConductor() {
  return {
    timeline: [], barGrid: [], durationMs: 120000,
    on() {}, onBar() {}, subscribeAhead() {},
  };
}

const fakeMidio = { screenX: 300, groundY: 480, y: 0, halfWidth: 20 };

function ensembleStep(ens, nowMs, dtSec = 1 / 60) {
  ens.update(nowMs, dtSec, { epic: 0.5, valence: 0 }, 500, null, 0);
}

test('EnsembleDirector: the disc cue never fires twice inside one spin', () => {
  const ens = new EnsembleDirector(42);
  const fires = [];
  // Offer a cue every 500ms for two minutes -- the old justClean cadence.
  for (let t = 0; t < 120000; t += 500) {
    ensembleStep(ens, t);
    if (ens.maybeDisc(t, 'section', 1)) fires.push(t);
  }
  assert.ok(fires.length > 0, 'it should still spin sometimes');
  for (let i = 1; i < fires.length; i++) {
    const gap = fires[i] - fires[i - 1];
    assert.ok(gap >= 6000, `two spins only ${gap}ms apart -- the 420ms move never resolves`);
  }
  // Sanity on the headline number: at the old cadence this was 240 spins.
  assert.ok(fires.length <= 20, `${fires.length} spins in 2 minutes is still constant rotation`);
});

test('EnsembleDirector: a calm song spins less often than a loud one', () => {
  const count = (intensity) => {
    const ens = new EnsembleDirector(7);
    let n = 0;
    for (let t = 0; t < 300000; t += 1000) {
      ensembleStep(ens, t);
      if (ens.maybeDisc(t, 'section', intensity)) n++;
    }
    return n;
  };
  assert.ok(count(1) > count(0), 'intensity should earn a shorter leash');
});

test('EnsembleDirector: discCue is a one-frame flag', () => {
  const ens = new EnsembleDirector(3);
  ensembleStep(ens, 0);
  assert.equal(ens.maybeDisc(0, 'drop', 1), true);
  assert.equal(ens.discCue, true, 'raised for the characters to read this step');
  ensembleStep(ens, 16);
  assert.equal(ens.discCue, false, 'cleared at the top of the next step');
});

test('EnsembleDirector: the move log records denials, not just fires', () => {
  const ens = new EnsembleDirector(11);
  for (let t = 0; t < 5000; t += 500) { ensembleStep(ens, t); ens.maybeDisc(t, 'drop', 1); }
  const log = ens.moveLog.toArray();
  assert.ok(log.some((m) => m.allowed), 'fires are logged');
  assert.ok(log.some((m) => !m.allowed), 'denials are logged -- that is what makes over-firing visible');
  assert.ok(log.every((m) => m.move === 'disc'));
});

test('Broshi: a clean landing alone no longer starts a disc spin', () => {
  const b = new Broshi(fakeConductor(), null);
  const before = b._discStartMs;
  b.update(1000, 1 / 60, fakeMidio, null, 0, 480, 0, {
    justClean: true, justLanded: true, midioAirborne: false, discCue: false,
  }, null);
  assert.equal(b._discStartMs, before, 'justClean must not trigger the spin any more');
  // ...but the cheer it legitimately owns still fires.
  assert.equal(b._cheerStartMs, 1000, 'the cheer/jaw/tail response is unchanged');
});

test('Broshi: the ensemble disc cue does start a spin', () => {
  const b = new Broshi(fakeConductor(), null);
  b.update(2000, 1 / 60, fakeMidio, null, 0, 480, 0, {
    justClean: false, justLanded: false, midioAirborne: false, discCue: true,
  }, null);
  assert.equal(b._discStartMs, 2000);
});

test('Midasus: a clean landing alone no longer starts a disc spin', () => {
  const m = new Midasus([], fakeMidio);
  const before = m._discStartMs;
  m.update(1000, 1 / 60, 0, { justClean: true, discCue: false });
  assert.equal(m._discStartMs, before);
  m.update(1016, 1 / 60, 0, { justClean: false, discCue: true });
  assert.equal(m._discStartMs, 1016, 'the rate-limited cue does trigger it');
});

test('Midasus: back-to-back loud notes cannot restart the pirouette mid-move', () => {
  // A dense run of vel>0.85 notes -- the exact input that used to restart the
  // 320ms roll on every onset so it never reached its eased-out landing.
  const notes = [];
  for (let i = 0; i < 40; i++) {
    notes.push({ tMs: i * 150, pitch: 60 + (i % 12), vel: 0.95, role: 'MELODY' });
  }
  const m = new Midasus(notes, fakeMidio, { noteFilter: () => true });
  const starts = [];
  let last = -Infinity;
  for (let t = 0; t < 6000; t += 16) {
    m.update(t, 16 / 1000, 0, null);
    if (m._pirouetteStartMs !== last) { starts.push(m._pirouetteStartMs); last = m._pirouetteStartMs; }
  }
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] - starts[i - 1] >= 2500,
      `pirouettes ${starts[i] - starts[i - 1]}ms apart; the move itself is 320ms`);
  }
});
