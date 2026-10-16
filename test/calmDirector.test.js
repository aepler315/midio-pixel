import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalmDirector } from '../src/sim/CalmDirector.js';

// CalmDirector reads globalEnergyNorm (energy relative to the song's own
// dynamic range) -- a stub returning one fixed value stands for "this song
// sits at this normalized level throughout", which is what these thresholds
// are about. globalEnergy is kept for any absolute-signal consumer.
function fakeEnergy(value) {
  return { globalEnergy: () => value, globalEnergyNorm: () => value };
}

test('CalmDirector settles near full calm (1) under sustained low energy', () => {
  const cd = new CalmDirector();
  let t = 0;
  for (let i = 0; i < 300; i++) { cd.update(t, 1 / 120, fakeEnergy(0.05)); t += 8.33; }
  assert.ok(cd.level > 0.9, `expected near-full calm, got ${cd.level}`);
});

test('CalmDirector settles near fully energetic (0) under sustained high energy', () => {
  const cd = new CalmDirector();
  let t = 0;
  for (let i = 0; i < 300; i++) { cd.update(t, 1 / 120, fakeEnergy(0.9)); t += 8.33; }
  assert.ok(cd.level < 0.1, `expected near-zero calm, got ${cd.level}`);
});

test('CalmDirector transitions smoothly rather than snapping between energy regimes', () => {
  const cd = new CalmDirector();
  let t = 0;
  for (let i = 0; i < 300; i++) { cd.update(t, 1 / 120, fakeEnergy(0.05)); t += 8.33; }
  const before = cd.level;
  assert.ok(before > 0.9);

  // A handful of steps into a sudden loud section: moving toward energetic,
  // but a smoothed EMA should not have fully arrived yet.
  for (let i = 0; i < 15; i++) { cd.update(t, 1 / 120, fakeEnergy(0.9)); t += 8.33; }
  const mid = cd.level;
  assert.ok(mid < before, 'expected calm to start dropping toward energetic');
  assert.ok(mid > 0.05, 'expected a gradual transition, not an instant snap to 0');
});

test('CalmDirector with no energy source at all defaults toward full calm', () => {
  const cd = new CalmDirector();
  let t = 0;
  for (let i = 0; i < 300; i++) { cd.update(t, 1 / 120, null); t += 8.33; }
  assert.ok(cd.level > 0.9);
});
