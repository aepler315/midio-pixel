import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApotheosisDirector } from '../src/sim/ApotheosisDirector.js';

function ctx({ epic = 0, surge = 0, calmLevel = 0 } = {}) {
  return { vibe: { epic }, hype: { surge }, calm: { level: calmLevel } };
}

test('charge accrues +1.5 per clean landing and +3 per milestone', () => {
  const a = new ApotheosisDirector();
  a.onCleanLanding();
  assert.equal(a.charge, 1.5);
  a.onCleanLanding();
  a.onMilestone();
  assert.equal(a.charge, 6);
});

test('charge decays at 0.08/s while inactive and stops decaying once active', () => {
  const a = new ApotheosisDirector();
  a.charge = 5;
  a.update(1000, 1, ctx());
  assert.ok(Math.abs(a.charge - 4.92) < 1e-9, `expected ~4.92, got ${a.charge}`);

  // Never decays below 0.
  a.charge = 0.05;
  a.update(2000, 1, ctx());
  assert.equal(a.charge, 0);
});

test('does not trigger below the charge threshold even with music fully ready', () => {
  const a = new ApotheosisDirector();
  a.charge = 5.99;
  a.update(1000, 0, ctx({ epic: 0.9 }));
  assert.equal(a.active, false);
});

test('triggers once charge >= 6 AND (epic > 0.3 OR surge > 0.22), and resets charge to 0', () => {
  const a = new ApotheosisDirector();
  a.charge = 6;
  a.update(1000, 0, ctx({ epic: 0.4 }));
  assert.equal(a.active, true);
  assert.equal(a.justTriggered, true);
  assert.equal(a.charge, 0);
  assert.equal(a.triggerCount, 1);
});

test('does not trigger at full charge if neither epic nor surge clears its gate', () => {
  const a = new ApotheosisDirector();
  a.charge = 6;
  a.update(1000, 0, ctx({ epic: 0.15, surge: 0.05 }));
  assert.equal(a.active, false);
});

test('surge alone (epic low) is sufficient to trigger', () => {
  const a = new ApotheosisDirector();
  a.charge = 6;
  a.update(1000, 0, ctx({ epic: 0, surge: 0.25 }));
  assert.equal(a.active, true);
});

test('never triggers during deep calm even at full charge and high epic', () => {
  const a = new ApotheosisDirector();
  a.charge = 20;
  a.update(1000, 0, ctx({ epic: 0.9, surge: 0.9, calmLevel: 0.85 }));
  assert.equal(a.active, false, 'deep calm (>=0.82) must block the transform outright');
});

test('deactivates automatically after the 12s active window and starts the cooldown', () => {
  const a = new ApotheosisDirector();
  a.forceTrigger(0);
  assert.equal(a.active, true);
  a.update(11999, 0.001, ctx());
  assert.equal(a.active, true, 'should still be active just before the window ends');
  a.update(12000, 0.001, ctx());
  assert.equal(a.active, false);
  assert.equal(a.justEnded, true);
});

test('cooldown blocks a second trigger for 16s after ending, even at full charge', () => {
  const a = new ApotheosisDirector();
  a.forceTrigger(0);
  a.update(12000, 0.001, ctx()); // ends, cooldown starts at t=12000
  a.charge = 6;
  a.update(12000 + 15999, 0, ctx({ epic: 0.9 }));
  assert.equal(a.active, false, 'still inside the 16s cooldown');
  a.update(12000 + 16000, 0, ctx({ epic: 0.9 }));
  assert.equal(a.active, true, 'cooldown should have elapsed');
});

test('never triggers a ninth time in one song (max 8)', () => {
  const a = new ApotheosisDirector();
  let t = 0;
  for (let i = 1; i <= 8; i++) {
    assert.equal(a.forceTrigger(t), true, `trigger ${i} should succeed`);
    t += 12000; a.update(t, 0.001, ctx());
    t += 16000;
  }
  assert.equal(a.triggerCount, 8);
  assert.equal(a.forceTrigger(t), false, 'a ninth trigger must be refused');
  a.charge = 999;
  a.update(t, 0.001, ctx({ epic: 0.9 }));
  assert.equal(a.active, false);
});

test('progress ramps 0->1 over exactly MORPH_SEC (0.6s) after a trigger, and holds at 1 while active', () => {
  const a = new ApotheosisDirector();
  a.forceTrigger(0);
  assert.equal(a.progress, 0, 'progress must not jump on the trigger frame itself');
  a.update(300, 0.3, ctx());
  assert.ok(Math.abs(a.progress - 0.5) < 1e-9, `expected 0.5 halfway through the morph, got ${a.progress}`);
  a.update(600, 0.3, ctx());
  assert.equal(a.progress, 1);
  a.update(9000, 8.4, ctx());
  assert.equal(a.progress, 1, 'progress holds at 1 for the rest of the active window');
});

test('progress ramps back 1->0 over MORPH_SEC after the active window ends, never a jump', () => {
  // Step at a realistic sim cadence (120Hz) so the frame that crosses the
  // active-window boundary has a normal small dt, not an artificially huge one.
  const a = new ApotheosisDirector();
  const STEP_MS = 1000 / 120;
  let t = 0;
  a.forceTrigger(t);
  while (a.progress < 1) { t += STEP_MS; a.update(t, STEP_MS / 1000, ctx()); }
  assert.equal(a.progress, 1);

  while (t + STEP_MS < 12000) { t += STEP_MS; a.update(t, STEP_MS / 1000, ctx()); }
  assert.equal(a.active, true, 'should still be active on the last frame before the window ends');
  const beforeEnd = a.progress;

  t += STEP_MS; // this step crosses the 12000ms boundary
  a.update(t, STEP_MS / 1000, ctx());
  assert.equal(a.active, false);
  assert.ok(beforeEnd - a.progress < 0.05, 'progress must not jump when the active window ends');

  while (a.progress > 0) { t += STEP_MS; a.update(t, STEP_MS / 1000, ctx()); }
  assert.equal(a.progress, 0);
});

test('forceTrigger refuses to double-trigger while already active', () => {
  const a = new ApotheosisDirector();
  assert.equal(a.forceTrigger(0), true);
  assert.equal(a.forceTrigger(100), false);
});
