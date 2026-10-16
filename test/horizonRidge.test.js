import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HORIZON_RANGES, HORIZON_REST, chooseHorizonRange, horizonCrest, crestHeightAt, horizonRidgeLift01,
  MASSIF_SALT, massifCrest, massifRidgeLift01,
} from '../src/world/terrain/HorizonRidge.js';
import { RANGES } from '../src/world/terrain/ranges/index.js';
import { loadRangeProfiles } from '../src/world/terrain/RangeLibrary.js';
import { castRows } from '../src/ui/RangeCaption.js';
import { massifBandLevel } from '../src/world/MountainChoreo.js';

test('the horizon draws only famous skylines in the lower 48 and southern BC and Alberta', () => {
  const byId = new Map(RANGES.map((r) => [r.id, r]));
  for (const id of HORIZON_RANGES) {
    const r = byId.get(id);
    assert.ok(r, `${id} is in the basket`);
    assert.match(r.region, /USA$|British Columbia|Alberta/, id);
    assert.doesNotMatch(r.region, /Alaska|Hawaii/, id);
  }
});

test('a song gets the same horizon every time, never one of its own ridges, and every horizon comes up', () => {
  assert.equal(chooseHorizonRange(99).id, chooseHorizonRange(99).id);
  assert.notEqual(chooseHorizonRange(99, { exclude: [chooseHorizonRange(99).id] }).id, chooseHorizonRange(99).id);
  const seen = new Set();
  for (let s = 1; s <= 800; s++) seen.add(chooseHorizonRange(s * 7919).id);
  assert.equal(seen.size, HORIZON_RANGES.length);
  assert.equal(chooseHorizonRange(1, { exclude: HORIZON_RANGES }), null);
});

test('the crest is the real skyline around its summit, 0..1, and the view slides along it over the song', async () => {
  for (const id of ['tetons', 'rainier']) {
    const crest = horizonCrest((await loadRangeProfiles(id)).L2);
    const hs = [...crest.heights];
    assert.ok(Math.max(...hs) <= 1 + 1e-6 && Math.min(...hs) >= 0);
    assert.ok(Math.abs(Math.max(...hs) - 1) < 1e-6, 'the summit reaches the top');
    assert.ok(crest.travelM > 0);
    // Start and end of the song see different ground.
    let diff = 0;
    for (let u = 0; u <= 1; u += 0.05) diff += Math.abs(crestHeightAt(crest, 0, u) - crestHeightAt(crest, 1, u));
    assert.ok(diff > 0.5, `${id} slides`);
    // Mid-song the summit is on screen.
    let top = 0;
    for (let u = 0; u <= 1; u += 0.005) top = Math.max(top, crestHeightAt(crest, 0.5, u));
    assert.ok(top > 0.97, `${id} summit in view mid-song`);
  }
});

test('the music scales the crest from its foot, so its shape survives and it never flattens', () => {
  const crest = { heights: new Float32Array([0.1, 1, 0.3]), stepM: 1, windowM: 2, travelM: 0 };
  assert.equal(crestHeightAt(crest, 0, 0.5), 1);
  assert.ok(Math.abs(crestHeightAt(crest, 0, 0.75) - 0.65) < 1e-6);
  // Same band level everywhere: every point moves in proportion.
  for (const v of [0, 0.4, 1]) {
    const peak = horizonRidgeLift01(1, v), col = horizonRidgeLift01(0.3, v);
    assert.ok(Math.abs(col / peak - 0.3) < 1e-9);
  }
  assert.equal(horizonRidgeLift01(1, 0), HORIZON_REST);
  assert.equal(horizonRidgeLift01(1, 1), 1);
});

test('the caption names the horizon above the back ridge', () => {
  const rows = castRows({
    horizon: { name: 'Teton Range', region: 'Wyoming, USA' },
    far: { name: 'Sawtooth Range', region: 'Idaho, USA' },
  });
  assert.deepEqual(rows.map((r) => r.label), ['HORIZON', 'BACK']);
});

test('the massif stands on a different famous summit, tapered to its foot at both edges', async () => {
  for (let s = 1; s <= 200; s++) {
    const horizon = chooseHorizonRange(s);
    const massif = chooseHorizonRange(s, { exclude: [horizon.id], salt: MASSIF_SALT });
    assert.notEqual(massif.id, horizon.id);
  }
  const crest = massifCrest((await loadRangeProfiles('rainier')).L2);
  assert.equal(massifRidgeLift01(crest, 0, 1), 0);
  assert.equal(massifRidgeLift01(crest, 1, 1), 0);
  let top = 0;
  for (let u = 0; u <= 1; u += 0.01) top = Math.max(top, massifRidgeLift01(crest, u, 1));
  assert.ok(top > 0.95, 'the summit stands at full height when the band is loud');
  assert.ok(massifRidgeLift01(crest, 0.5, 0) < massifRidgeLift01(crest, 0.5, 1));
});

test('the massif reads its bands bass in the middle, smoothly between columns', () => {
  const eq = [1, 0, 0, 0, 0, 0, 0];
  assert.equal(massifBandLevel(eq, 0.5), 1);
  assert.equal(massifBandLevel(eq, 0), 0);
  const a = massifBandLevel(eq, 0.45), b = massifBandLevel(eq, 0.4);
  assert.ok(a < 1 && a > b && b > 0);
});

test('the caption names the massif under the horizon', () => {
  const rows = castRows({
    horizon: { name: 'Teton Range', region: 'Wyoming, USA' },
    massif: { name: 'Mount Rainier', region: 'Washington, USA' },
    far: { name: 'Sawtooth Range', region: 'Idaho, USA' },
  });
  assert.deepEqual(rows.map((r) => r.label), ['HORIZON', 'MASSIF', 'BACK']);
});

test('horizon travels left nine times the original speed in screen space without running past finite scans', async () => {
  for (const id of HORIZON_RANGES) {
    const profile = (await loadRangeProfiles(id)).L2;
    const old = horizonCrest(profile, { speedMul: 1, zoom: 1 });
    const next = horizonCrest(profile);
    assert.ok(Math.abs(next.travelM / next.windowM - 9 * old.travelM / old.windowM) < 1e-9, id);
    assert.ok(next.windowM <= old.windowM / 1.2 + 1e-6, id);
    assert.ok(next.travelM + next.windowM <= profile.spacingM * (profile.angles.length - 1) + 1e-6, id);
    // The same geographic point arrives farther left as time advances.
    const shift = 0.1 * next.travelM / next.windowM;
    assert.ok(Math.abs(crestHeightAt(next, 0.4, 0.5) - crestHeightAt(next, 0.5, 0.5 - shift)) < 1e-6, id);
  }
});
