import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComboSystem } from '../src/sim/ComboSystem.js';

test('RULE 1: clean landings build streak and multiplier', () => {
  const c = new ComboSystem();
  c.onLanding(1000, true);
  assert.equal(c.streak, 1);
  assert.equal(c.M, 1.1);
  c.onLanding(1500, true);
  assert.equal(c.streak, 2);
  assert.equal(Math.round(c.M * 100), 120);
});

test('RULE 6: display multiplier caps at x3.0 but internal streak keeps counting', () => {
  const c = new ComboSystem();
  for (let i = 0; i < 25; i++) c.onLanding(1000 + i * 500, true);
  assert.equal(c.streak, 25);
  assert.equal(c.M, 3.0); // formula caps at streak=20 internally -> M = 1 + 0.1*20
  assert.equal(c.displayM, 3.0);
});

test('RULE 2/3: multiplier holds during grace beat, then drains afterward', () => {
  const c = new ComboSystem();
  const beatMs = 500;
  for (let i = 0; i < 21; i++) c.onLanding(i * 100, true); // build to the M=3.0 cap
  const lastClean = 20 * 100;
  const mAfterBuild = c.M;
  c.update(lastClean + 100, beatMs); // well within the 1-beat grace window
  assert.equal(c.M, mAfterBuild); // grace: holds flat
  c.update(lastClean + beatMs + 50, beatMs); // just past grace -> drain starts
  assert.ok(c.M < mAfterBuild);
  assert.ok(c.M >= 1);
});

test('RULE 4: two full beats with no clean landing snaps M back to 1 and clears streak', () => {
  const c = new ComboSystem();
  const beatMs = 500;
  c.onLanding(0, true);
  c.onLanding(500, true);
  c.update(500 + 2 * beatMs + 10, beatMs);
  assert.equal(c.streak, 0);
  assert.equal(c.M, 1);
  assert.equal(c.justBroke, true);
});

test('RULE 5: stumble resets streak and multiplier instantly', () => {
  const c = new ComboSystem();
  c.onLanding(0, true);
  c.onLanding(500, true);
  assert.ok(c.M > 1);
  c.onStumble();
  assert.equal(c.streak, 0);
  assert.equal(c.M, 1);
  assert.equal(c.justBroke, true);
});

test('clean-landing window is +/-90ms of the nearest kick', () => {
  assert.equal(ComboSystem.isCleanLanding(1000, 1085), true);
  assert.equal(ComboSystem.isCleanLanding(1000, 1091), false);
  assert.equal(ComboSystem.isCleanLanding(1000, null), false);
});

test('sustain refreshes freshness without growing the streak', () => {
  const combo = new ComboSystem();
  combo.onLanding(1000, true);
  combo.onLanding(1500, true);
  assert.equal(combo.streak, 2);
  // A 2-beat landing gap would break (RULE 4) — a clean press mid-gap keeps it warm.
  combo.sustain(2000);
  combo.update(2510, 500); // 1010ms past the last landing, 510 past the sustain
  assert.equal(combo.streak, 2, 'sustained combo must survive the airtime');
  assert.equal(combo.justBroke, false);
});

test('sustain never resurrects a broken or empty combo', () => {
  const combo = new ComboSystem();
  combo.sustain(1000);
  assert.equal(combo.lastCleanMs, -Infinity, 'no streak, nothing to keep warm');
  combo.onLanding(2000, true);
  combo.sustain(1500); // stale timestamps must not rewind freshness
  assert.equal(combo.lastCleanMs, 2000);
});
