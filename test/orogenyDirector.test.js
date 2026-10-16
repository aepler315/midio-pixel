import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrogenyDirector, findClimaxMs, orogenyGrowthAt } from '../src/world/OrogenyDirector.js';
import { orogenyHeightMul } from '../src/world/MountainChoreo.js';

function fakeEnergyCurves(peakMs, durationMs) {
  return {
    globalEnergy: (tMs) => {
      // A single sharp peak somewhere in the song, low energy elsewhere.
      const d = Math.abs(tMs - peakMs) / durationMs;
      return Math.max(0, 1 - d * 8);
    },
  };
}

test('findClimaxMs lands on the actual energy peak when it falls inside the search window', () => {
  const durationMs = 200000;
  const truePeak = durationMs * 0.75; // inside [0.6, 0.92]
  const ec = fakeEnergyCurves(truePeak, durationMs);
  const climax = findClimaxMs(ec, durationMs);
  assert.ok(Math.abs(climax - truePeak) < durationMs * 0.03, `climax ${climax} not close to true peak ${truePeak}`);
  assert.ok(climax >= durationMs * 0.6 && climax <= durationMs * 0.92);
});

test('findClimaxMs falls back to a fixed fraction with no energy curve or duration', () => {
  assert.equal(findClimaxMs(null, 100000), 100000 * 0.8);
  assert.equal(findClimaxMs(fakeEnergyCurves(1000, 0), 0), 0);
});

test('growth rises monotonically toward the climax, then falls, staying in bounds throughout', () => {
  const durationMs = 180000;
  const climaxMs = durationMs * 0.7;
  let prev = -Infinity;
  for (let t = 0; t <= climaxMs; t += climaxMs / 40) {
    const g = orogenyGrowthAt(t, durationMs, climaxMs);
    assert.ok(g >= prev - 1e-9, `growth dipped at t=${t}: ${prev} -> ${g}`);
    assert.ok(g >= 0 && g <= 1, `growth out of bounds: ${g}`);
    prev = g;
  }
  assert.ok(Math.abs(prev - 1) < 1e-6, 'growth must reach exactly 1 at the climax');

  prev = 1;
  for (let t = climaxMs; t <= durationMs; t += (durationMs - climaxMs) / 40) {
    const g = orogenyGrowthAt(t, durationMs, climaxMs);
    assert.ok(g <= prev + 1e-9, `growth rose after the climax at t=${t}: ${prev} -> ${g}`);
    assert.ok(g >= 0 && g <= 1);
    prev = g;
  }
  assert.ok(prev < 0.3, 'the mountains must visibly have fallen by the end');
});

test('growth handles degenerate spans without throwing or escaping bounds', () => {
  assert.doesNotThrow(() => orogenyGrowthAt(500, 1000, 1000)); // climax at the very end
  assert.doesNotThrow(() => orogenyGrowthAt(500, 1000, 0));    // no valid climax
  const atEnd = orogenyGrowthAt(1000, 1000, 1000);
  assert.ok(atEnd >= 0 && atEnd <= 1);
});

test('OrogenyDirector.update tracks the pure growth function end to end', () => {
  const durationMs = 150000;
  const ec = fakeEnergyCurves(durationMs * 0.8, durationMs);
  const dir = new OrogenyDirector(ec, durationMs, null);
  dir.update(0);
  const startGrowth = dir.growth;
  dir.update(dir.climaxMs);
  assert.ok(Math.abs(dir.growth - 1) < 1e-6);
  assert.ok(dir.growth > startGrowth);
  dir.update(durationMs);
  assert.ok(dir.growth < 1);
});

test('orogenyHeightMul: far layers (L2) grow more than near layers (L5), and g=0 is baseline', () => {
  assert.equal(orogenyHeightMul('L2', 0), 1);
  assert.equal(orogenyHeightMul('L5', 0), 1);
  const l2 = orogenyHeightMul('L2', 1);
  const l5 = orogenyHeightMul('L5', 1);
  assert.ok(l2 > l5, `expected far layer L2 (${l2}) to grow more than near layer L5 (${l5})`);
  assert.ok(l2 > 1 && l5 > 1);
});

test('mountainStripDrawHeight caps peaks so they stay on-frame', async () => {
  const { mountainStripDrawHeight, MOUNTAIN_SKY_HEADROOM_FRAC, orogenyHeightMul } = await import('../src/world/MountainChoreo.js');
  const canvasH = 720;
  const groundY = 540;
  const stripH = 400;
  // Uncapped orogeny would shove the strip top above the sky line.
  const growth = orogenyHeightMul('L2', 1);
  const dh = mountainStripDrawHeight(stripH, growth * 3, canvasH, groundY); // absurd mul on purpose
  const top = (groundY + 40) - dh;
  assert.ok(top >= canvasH * MOUNTAIN_SKY_HEADROOM_FRAC - 1,
    `strip top ${top} must sit below sky headroom ${canvasH * MOUNTAIN_SKY_HEADROOM_FRAC}`);
  // Still taller than a tiny stub at baseline.
  assert.ok(dh > 100);
});
