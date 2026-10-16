import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GazeDirector } from '../src/sim/Gaze.js';

function baseSim(overrides = {}) {
  return {
    worldX: 0,
    midio: { screenX: 200, groundY: 500 },
    obstacles: { nearestAhead: () => null },
    midasus: { p: { x: 400, y: 300 } },
    focus: { subject: null },
    biomes: { currentLight: () => ({ x: 900, y: 100 }) },
    hype: { dropAtMs: -Infinity },
    jump: { airborne: false, pendingLanding: null, anticipatingLaunch: () => false },
    ...overrides,
  };
}

test('idle: no obstacle, no voyage focus -> defaults to celestial', () => {
  const g = new GazeDirector();
  g.update(baseSim(), 0.1, 1000);
  assert.equal(g.mode, 'celestial');
});

test('a near obstacle wins over everything else', () => {
  const g = new GazeDirector();
  const sim = baseSim({
    obstacles: { nearestAhead: () => ({ wx: 300, height: 40 }) },
    focus: { subject: 'voyage' }, // even with voyage in focus, the obstacle should still win
  });
  g.update(sim, 0.1, 1000);
  assert.equal(g.mode, 'obstacle');
});

test('a far obstacle (beyond notice distance) is ignored', () => {
  const g = new GazeDirector();
  const sim = baseSim({ obstacles: { nearestAhead: () => ({ wx: 5000, height: 40 }) } });
  g.update(sim, 0.1, 1000);
  assert.equal(g.mode, 'celestial');
});

test('voyage focus, no near obstacle -> looks at Midasus', () => {
  const g = new GazeDirector();
  const sim = baseSim({ focus: { subject: 'voyage' } });
  g.update(sim, 0.1, 1000);
  assert.equal(g.mode, 'voyage');
});

test('look direction eases toward the target rather than snapping', () => {
  const g = new GazeDirector();
  const sim = baseSim(); // celestial at (900,100), well to the right and above
  g.update(sim, 0.016, 1000); // one small step
  const one = g.irisOffset(10);
  g.update(sim, 10, 1016); // a huge dt -- should be fully converged now
  const converged = g.irisOffset(10);
  assert.ok(Math.abs(one.x) < Math.abs(converged.x), 'one small step should not have fully converged yet');
});

test('a fresh drop pulls the iris toward centered (flinch)', () => {
  const g = new GazeDirector();
  const sim = baseSim({ hype: { dropAtMs: 1000 } });
  // Converge onto the celestial target first.
  for (let i = 0; i < 50; i++) g.update(sim, 0.05, 1000 + i * 50);
  const beforeDrop = g.irisOffset(10);
  assert.ok(Math.abs(beforeDrop.x) > 0.5, 'should be looking well off-center by now');

  // Drop lands right now.
  const sim2 = baseSim({ hype: { dropAtMs: 3500 } });
  g.update(sim2, 0.016, 3500);
  const atDrop = g.irisOffset(10);
  assert.ok(Math.abs(atDrop.x) < Math.abs(beforeDrop.x), 'flinch should pull the offset back toward centered');
});

test('a stale drop (outside the flinch window) has no effect', () => {
  const g = new GazeDirector();
  const sim = baseSim({ hype: { dropAtMs: 0 } }); // long past DROP_FLINCH_MS by nowMs=100000
  g.update(sim, 0.016, 100000);
  assert.equal(g.flinch, 0);
});

test('anticipation rises ahead of a kick-scheduled launch', () => {
  const g = new GazeDirector();
  const sim = baseSim({
    jump: { airborne: false, pendingLanding: null, anticipatingLaunch: () => true },
  });
  g.update(sim, 0.016, 1000);
  assert.ok(g.anticipation > 0);
});

test('anticipation also rises on the frame a tap-launch fires (justLaunched)', () => {
  const g = new GazeDirector();
  const sim1 = baseSim({ jump: { airborne: false, pendingLanding: null, anticipatingLaunch: () => false } });
  g.update(sim1, 0.016, 1000); // establishes _wasAirborne = false

  const sim2 = baseSim({ jump: { airborne: true, pendingLanding: null, anticipatingLaunch: () => false } });
  g.update(sim2, 0.016, 1016); // airborne flips true this step -> justLaunched
  assert.ok(g.anticipation > 0);
});

test('settle spikes to 1 on landing and decays back toward 0', () => {
  const g = new GazeDirector();
  const sim = baseSim({ jump: { airborne: false, pendingLanding: { vLandPxMs: 1 }, anticipatingLaunch: () => false } });
  g.update(sim, 0.016, 1000);
  assert.equal(g.settle, 1);

  const simNoLanding = baseSim({ jump: { airborne: false, pendingLanding: null, anticipatingLaunch: () => false } });
  g.update(simNoLanding, 0.3, 1300);
  assert.ok(g.settle < 1 && g.settle >= 0);
});

test('openness stays within a sane, bounded range', () => {
  const g = new GazeDirector();
  g.flinch = 1; g.anticipation = 1; g.settle = 0;
  assert.ok(g.openness <= 1.5);
  g.flinch = 0; g.anticipation = 0; g.settle = 1;
  assert.ok(g.openness >= 0.4);
});

test('irisOffset with maxPx=0 is always the origin, regardless of direction', () => {
  const g = new GazeDirector();
  for (let i = 0; i < 20; i++) g.update(baseSim(), 0.05, 1000 + i * 50);
  const off = g.irisOffset(0);
  assert.equal(Math.abs(off.x), 0); // Math.abs normalizes -0 -> 0 (negative direction * 0 is IEEE754 -0)
  assert.equal(Math.abs(off.y), 0);
});
