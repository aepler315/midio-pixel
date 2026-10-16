import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Midasus } from '../src/sim/Midasus.js';
import { Broshi } from '../src/sim/Broshi.js';
import { Conductor } from '../src/core/Conductor.js';
import { ParamBus } from '../src/core/ParamBus.js';
import { makeNoteEvent, Role } from '../src/core/NoteEvent.js';
import { EnsembleDirector } from '../src/sim/EnsembleDirector.js';
import { BeatAnchor } from '../src/sim/BeatAnchor.js';

function stepFor(fn, totalMs, dtMs = 1000 / 120) {
  for (let t = 0; t < totalMs; t += dtMs) fn(t, dtMs / 1000);
}

test('Midasus consumes melody notes in strict order, never skipping', () => {
  const timeline = [];
  for (let i = 0; i < 20; i++) {
    timeline.push(makeNoteEvent({ tMs: i * 100, pitch: 60 + (i % 7), vel: 0.6, role: Role.MELODY, src: 'midi' }));
  }
  const midio = { screenX: 200, groundY: 480, y: 0 };
  const m = new Midasus(timeline, midio, { groundY: 480, ceilingY: 40 });
  stepFor((t, dt) => m.update(t, dt), 2100);
  assert.equal(m.i, timeline.length); // every note consumed
});

test('Midasus handles a burst of several notes landing in a single sim step', () => {
  const timeline = [
    makeNoteEvent({ tMs: 10, pitch: 60, vel: 0.5, role: Role.MELODY, src: 'midi' }),
    makeNoteEvent({ tMs: 11, pitch: 64, vel: 0.5, role: Role.MELODY, src: 'midi' }),
    makeNoteEvent({ tMs: 12, pitch: 67, vel: 0.5, role: Role.MELODY, src: 'midi' }),
  ];
  const midio = { screenX: 200, groundY: 480, y: 0 };
  const m = new Midasus(timeline, midio, { groundY: 480, ceilingY: 40 });
  m.update(20, 1000 / 120 / 1000); // single step past all three onsets
  assert.equal(m.i, 3);
});

test('Midasus falls into orbital wander after 800ms of silence', () => {
  const timeline = [makeNoteEvent({ tMs: 0, pitch: 60, vel: 0.5, role: Role.MELODY, src: 'midi' })];
  const midio = { screenX: 200, groundY: 480, y: 0 };
  const m = new Midasus(timeline, midio, { groundY: 480, ceilingY: 40 });
  stepFor((t, dt) => m.update(t, dt), 200);
  assert.ok(m.rest < 0.5);
  stepFor((t, dt) => m.update(200 + t, dt), 1200);
  assert.ok(m.rest > 0.9);
});

test('Broshi runs POINT ahead of Midio by default', () => {
  const conductor = new Conductor();
  conductor.load({ timeline: [], barGrid: [], durationMs: 10000 });
  const paramBus = new ParamBus();
  const b = new Broshi(conductor, paramBus);
  const midio = { screenX: 200, groundY: 480, y: 0 };
  stepFor((t, dt) => b.update(t, dt, midio, null, 0, 480), 5000);
  // He leads Midio now rather than trailing him. The set-point is still
  // clamped against the stage (that clamp is what stopped him sliding off
  // the frame when he trailed), so he settles ahead but on-screen.
  assert.ok(b.xRel > 20, `should run ahead of Midio, got ${b.xRel}`);
  const screenX = midio.screenX + b.xRel;
  assert.ok(screenX >= 60 && screenX <= 1220, `should stay on frame, got screen x=${screenX}`);
});

test('Broshi never settles off either edge, wherever Midio stands', () => {
  // The regression this guards: a set-point pointing off-screen, with a
  // spring sitting happily on it and no reason to come back. It applied to
  // the left edge when he trailed; running point it is the right edge that
  // can strand him, and the same stage clamp covers both.
  for (const midioX of [120, 200, 340, 640, 1100]) {
    const conductor = new Conductor();
    conductor.load({ timeline: [], barGrid: [], durationMs: 10000 });
    const b = new Broshi(conductor, new ParamBus());
    const midio = { screenX: midioX, groundY: 480, y: 0 };
    stepFor((t, dt) => b.update(t, dt, midio, null, 0, 480), 5000);
    const screenX = midio.screenX + b.xRel;
    assert.ok(screenX >= 60 && screenX <= 1220, `Midio at ${midioX}: Broshi settled at screen x=${screenX}`);
    assert.ok(b.renderX >= 60 && b.renderX <= 1220, `Midio at ${midioX}: Broshi DREW at x=${b.renderX}`);
  }
});

test('Broshi SURGEs on the scripted 8-bar timer', () => {
  const conductor = new Conductor();
  const barGrid = [];
  const barMs = 500;
  for (let i = 0; i < 12; i++) barGrid.push({ tick: i * 4, ms: i * barMs, numerator: 4, denominator: 4 });
  conductor.load({ timeline: [], barGrid, durationMs: 12 * barMs });
  const paramBus = new ParamBus();
  const b = new Broshi(conductor, paramBus);
  b._lastBarPeriodMs = barMs;
  const midio = { screenX: 200, groundY: 480, y: 0 };

  let sawSurge = false;
  const dtMs = 1000 / 120;
  for (let t = 0; t < 12 * barMs; t += dtMs) {
    conductor.dispatchUpTo(t);
    b.update(t, dtMs / 1000, midio, null, 0, 480);
    if (b.state === 'SURGE') sawSurge = true;
  }
  assert.equal(sawSurge, true);
});

test('EnsembleDirector: a confident beat anchor pulls the trio toward its grid but keeps them mutually distinct', () => {
  const ens = new EnsembleDirector(7, { stageW: 1280, stageH: 720 });
  const anchor = new BeatAnchor(500);
  let t = 0;
  for (let i = 0; i < 40; i++) { anchor.tap(t); t += 500; } // a long steady run -> strong confidence
  anchor.update(t);
  assert.ok(anchor.confidence > 0.5, 'a long steady tap run should build strong confidence');

  // Sad/low-drive vibe -> weak Kuramoto coupling (K near/below critical), so
  // this isolates the anchor's own distinct per-character pull rather than
  // competing against the ensemble's own "happy+epic -> phase-lock" mechanic
  // (that lock is intentional design elsewhere, not something this feature
  // needs to fight).
  const vibe = { valence: -0.3, epic: 0.1 };
  stepFor((elapsedMs, dtSec) => ens.update(t + elapsedMs, dtSec, vibe, 500, anchor), 8000);

  const phases = [ens.phase(0), ens.phase(1), ens.phase(2)];
  // "Shouldn't sync to the same time as each other": no two characters may
  // land on (near) the same phase even once the anchor has taken hold.
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      let d = Math.abs(phases[i] - phases[j]);
      d = Math.min(d, Math.PI * 2 - d);
      assert.ok(d > 0.15, `characters ${i} and ${j} landed too close together: ${d.toFixed(3)} rad`);
    }
  }
});

test('EnsembleDirector: an unconfident (never-tapped) anchor behaves exactly like no anchor at all', () => {
  const vibe = { valence: 0.4, epic: 0.4 };
  const ensNoAnchor = new EnsembleDirector(7, { stageW: 1280, stageH: 720 });
  const ensIdleAnchor = new EnsembleDirector(7, { stageW: 1280, stageH: 720 });
  const idleAnchor = new BeatAnchor(500); // never tapped -> confidence stays 0
  stepFor((nowMs, dtSec) => {
    ensNoAnchor.update(nowMs, dtSec, vibe, 500);
    ensIdleAnchor.update(nowMs, dtSec, vibe, 500, idleAnchor);
  }, 2000);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(ensNoAnchor.phase(i) - ensIdleAnchor.phase(i)) < 1e-9, `character ${i} diverged with an unconfident anchor present`);
  }
});
