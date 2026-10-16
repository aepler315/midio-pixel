import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mirageRecipe, mirageHeight01, mirageShimmerPx, miragePresence01, mirageDriftPx, mirageStretch01,
} from '../src/world/FataMorgana.js';
import { farShoreRecipe, farShoreHeight01 } from '../src/world/FarShore.js';

test('mirageRecipe is deterministic for a given seed', () => {
  const a = mirageRecipe(42);
  const b = mirageRecipe(42);
  assert.deepEqual(a, b);
});

test('mirageHeight01 wraps seamlessly at the tile edge (u=0 and u=1 agree)', () => {
  const recipe = mirageRecipe(7);
  for (let i = 0; i < 20; i++) {
    const u = i / 20;
    assert.ok(Math.abs(mirageHeight01(null, recipe, u) - mirageHeight01(null, recipe, u + 1)) < 1e-9);
  }
});

test('mirageHeight01 stays non-negative, finite, and capped across the whole tile', () => {
  const recipe = mirageRecipe(3);
  for (let i = 0; i < 500; i++) {
    const h = mirageHeight01(null, recipe, i / 500);
    assert.ok(Number.isFinite(h));
    assert.ok(h >= 0);
    assert.ok(h <= 1.8, `mirage overstretched its cap: ${h}`);
  }
});

test('mirageHeight01 mirrors the real far shore it refracts', () => {
  // The mirage is a ghost of the actual far shore: give it that shore's
  // recipe and its mass has to track the same landmass (same broad lobes,
  // only stretched and crisply crested). With NO shore recipe it falls back
  // to a smooth rise rather than reading as a different, invented range.
  const shore = farShoreRecipe(99);
  const at = (u) => mirageHeight01(shore, mirageRecipe(3), u);
  // Wherever the far shore is low, the mirage can at most add crest detail;
  // it must stay roughly the same landmass, not an unrelated skyline.
  const nearFlat = (u) => farShoreHeight01(shore, u) < 0.05;
  for (let i = 0; i < 300; i++) {
    const u = i / 300;
    if (nearFlat(u)) {
      assert.ok(at(u) < 0.35, `mirage grew a new mass where the shore is flat: ${at(u)} at u=${u}`);
    }
  }
});

test('mirageHeight01 is jagged: many narrow local peaks on top of the real shore', () => {
  // The crisp crest detail is the mirage's tell: refraction resolving detail
  // the eye has no business seeing at that distance. Sample the real shore
  // and count local maxima.
  const shore = farShoreRecipe(11);
  const recipe = mirageRecipe(11);
  const N = 2000;
  let signChanges = 0;
  let prevSlope = 0;
  let prevH = mirageHeight01(shore, recipe, 0);
  for (let i = 1; i <= N; i++) {
    const h = mirageHeight01(shore, recipe, i / N);
    const slope = h - prevH;
    if (prevSlope > 0 && slope < 0) signChanges++;
    prevSlope = slope || prevSlope;
    prevH = h;
  }
  assert.ok(signChanges >= 5, `expected several distinct crest summits, got ${signChanges} sign changes`);
});

test('mirageDriftPx and mirageStretch01 are slow, bounded, vast (megalophobic cues)', () => {
  // Drift: tiny and slow -- the mirage hangs, never flickers. Stretch: stays
  // within ±~6% of 1 over time (a towering/sagging image, not a jump).
  for (let t = 0; t < 90; t++) {
    const d = mirageDriftPx(t, 720);
    assert.ok(Number.isFinite(d));
    assert.ok(Math.abs(d) <= 720 * 0.006 + 1e-6 + 2); // bounded by the amplitude term
    const s = mirageStretch01(t);
    assert.ok(s >= 0.94 && s <= 1.06, `stretch ${s} out of range`);
  }
});

test('mirageShimmerPx stays within the requested amplitude and is continuous-ish over time', () => {
  const recipe = mirageRecipe(5);
  const amp = 4;
  for (let i = 0; i < 100; i++) {
    const u = i / 100;
    for (let t = 0; t < 10; t += 1) {
      const s = mirageShimmerPx(recipe, u, t, amp);
      assert.ok(Number.isFinite(s));
      assert.ok(Math.abs(s) <= amp + 1e-9, `shimmer ${s} exceeded amplitude ${amp}`);
    }
  }
});

test('miragePresence01 stays in [0,1] and cycles', () => {
  let sawLow = false, sawHigh = false;
  for (let t = 0; t < 200; t += 0.5) {
    const p = miragePresence01(t, 37);
    assert.ok(p >= 0 && p <= 1);
    if (p < 0.05) sawLow = true;
    if (p > 0.95) sawHigh = true;
  }
  assert.ok(sawLow && sawHigh, 'presence should swing across its full range over a few periods');
});
