import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBackdropLayout, STAR_COUNT, NEBULA_COUNT } from '../src/ui/TitleBackdrop.js';

test('backdrop layout is deterministic for a given seed', () => {
  const a = buildBackdropLayout(1, 1280, 720);
  const b = buildBackdropLayout(1, 1280, 720);
  assert.equal(a.stars.length, STAR_COUNT);
  assert.equal(a.nebulae.length, NEBULA_COUNT);
  assert.deepEqual(a, b, 'same seed must produce the identical composition');
});

test('different seeds produce different compositions', () => {
  const a = buildBackdropLayout(1, 1280, 720);
  const b = buildBackdropLayout(2, 1280, 720);
  assert.notDeepEqual(a.stars, b.stars, 'different seeds should scatter stars differently');
});

test('stars fill the entire title stage', () => {
  const { stars } = buildBackdropLayout(7, 1280, 720);
  let low = 0, high = 0;
  for (const s of stars) {
    assert.ok(s.x >= 0 && s.x <= 1280, `star x out of range: ${s.x}`);
    assert.ok(s.y >= 0 && s.y <= 720, `star y out of range: ${s.y}`);
    assert.ok(s.r > 0, 'star radius must be positive');
    if (s.y > 720 * 0.65) low++;
    if (s.y < 720 * 0.35) high++;
  }
  assert.ok(low >= 12, `expected stars in the lower sky, got ${low}`);
  assert.ok(high >= 12, `expected stars in the upper sky, got ${high}`);
});

test('nebula hues span the wheel and stay faint', () => {
  const { nebulae } = buildBackdropLayout(3, 1280, 720);
  for (const n of nebulae) {
    assert.ok(n.hue >= 0 && n.hue < 360, `nebula hue out of range: ${n.hue}`);
    assert.ok(n.alpha > 0 && n.alpha <= 0.12, `nebula should be a faint wash, got alpha ${n.alpha}`);
  }
});
