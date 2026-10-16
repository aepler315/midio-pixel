// Far-distance vignettes: seeded sector placement -- rare, deterministic,
// and drawn from the whole cast of scenes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vignetteForSector, VIGNETTE_CHANCE } from '../src/world/FarVignettes.js';

test('vignetteForSector is deterministic and never in the opening sector', () => {
  assert.equal(vignetteForSector(5, 0), null, 'sector 0 stays clear (the opening screenful)');
  assert.equal(vignetteForSector(5, -1), null);
  for (let i = 1; i < 30; i++) {
    const a = vignetteForSector(9001, i);
    const b = vignetteForSector(9001, i);
    assert.deepEqual(a, b, `sector ${i} must be stable`);
  }
});

test('density tracks the configured chance, offsets stay inside the sector', () => {
  let hits = 0;
  const kinds = new Set();
  const N = 600;
  for (let i = 1; i <= N; i++) {
    const v = vignetteForSector(1337, i);
    if (!v) continue;
    hits++;
    kinds.add(v.kind);
    assert.ok(v.offset01 >= 0.15 && v.offset01 <= 0.85);
    assert.ok(typeof v.flip === 'boolean');
  }
  const density = hits / N;
  assert.ok(Math.abs(density - VIGNETTE_CHANCE) < 0.08, `density ${density} should sit near ${VIGNETTE_CHANCE}`);
  // Across 600 sectors the whole cast shows up -- aliens included.
  assert.ok(kinds.has('alienDinner'), 'the dinner party must exist');
  assert.ok(kinds.size >= 4, `expected a varied cast, got ${[...kinds].join(', ')}`);
});

test('different songs hide different scenes in different places', () => {
  let differs = 0;
  for (let i = 1; i <= 40; i++) {
    const a = vignetteForSector(1, i);
    const b = vignetteForSector(2, i);
    if (JSON.stringify(a) !== JSON.stringify(b)) differs++;
  }
  assert.ok(differs > 10, 'two songs must not share a vignette map');
});
