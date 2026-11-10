// conductor is a single instance shared across every song (see main.js) --
// it survives a replay or a "back to title" and the next song's Simulation
// is built right on top of the same object. Broshi, BiomeManager,
// FractureEngine and Simulation itself all subscribe to it at construction
// time, and until now none of them ever unsubscribed. Without a teardown,
// every replay leaves the previous instance's listeners registered: they
// keep firing into torn-down state for the rest of the session, and each
// new song's real listeners stack on top rather than replacing them.
//
// dispose() closes that hole. These tests check the primitive directly --
// the conductor's own bookkeeping (listeners/barListeners/aheadRegs) --
// rather than any one subsystem's behavior, so the guard holds regardless
// of what a given class's handlers actually do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conductor } from '../src/core/Conductor.js';
import { FractureEngine } from '../src/world/FractureEngine.js';
import { makeNoteEvent, Role } from '../src/core/NoteEvent.js';

function loadedConductor(durationMs = 4000, kickPeriodMs = 500) {
  const timeline = [];
  for (let t = 0; t < durationMs; t += kickPeriodMs) {
    timeline.push(makeNoteEvent({ tMs: t, pitch: 36, vel: 0.8, role: Role.RHYTHM, kick: true, src: 'audio' }));
  }
  const barGrid = [];
  for (let t = 0; t < durationMs; t += kickPeriodMs * 4) barGrid.push({ tick: 0, ms: t, numerator: 4, denominator: 4 });
  const conductor = new Conductor();
  conductor.load({ timeline, barGrid, durationMs });
  return conductor;
}

/** Total live listener registrations across all three of the conductor's
 *  channels -- role listeners, bar listeners, and the anticipation channel. */
function registrationCount(conductor) {
  let n = conductor.barListeners.size + conductor.aheadRegs.length;
  for (const set of conductor.listeners.values()) n += set.size;
  return n;
}

test('FractureEngine.dispose() removes its bar subscription', () => {
  const conductor = loadedConductor();
  const before = registrationCount(conductor);
  const fx = new FractureEngine(conductor, { canvasWidth: 1280, canvasHeight: 720, songSeed: 1, durationMs: 4000 });
  assert.ok(registrationCount(conductor) > before);
  fx.dispose();
  assert.equal(registrationCount(conductor), before);
});

