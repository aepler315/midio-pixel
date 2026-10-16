// The real-range basket: scoring a skyline, matching a song to a range, the
// build-time quality gate, and the generated index.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  AXES, MAX_ARTIFACT, MAX_FLOOR_SHARE, countPeaks, rangeCharacter, skylineArtifact, skylineFeatures, skylineQuality,
} from '../src/world/terrain/RangeCharacter.js';
import {
  FAIR_SHARE, RIDGE_BANDS, bandBaskets, drawOdds, matchRange, matchRidgeSet, rankScores, reliefBand, seedTicket, songPercentile,
  songTerrainTarget,
} from '../src/world/terrain/RangeMatcher.js';
import { RANGES, LOADERS } from '../src/world/terrain/ranges/index.js';
import { profilesFromJSON } from '../src/world/terrain/TerrainProfile.js';
import {
  decodePng, lonLatToPixel, rangeAxisDeg, rangeElongation, rotateGrid, terrariumElevation, valleyCameraElevM,
} from '../tools/lib/terrarium.mjs';

const profileOf = (skylineElevM, angles = skylineElevM.map((v) => v / 1e5)) => ({
  layers: { L2: { spacingM: 400, skylineElevM, angles } },
});

test('a gentle ridge and a jagged one score where they should', () => {
  const gentle = Array.from({ length: 120 }, (_, i) => 900 + 120 * Math.sin(i / 14));
  const jagged = Array.from({ length: 120 }, (_, i) => 3000 + 700 * Math.sin(i / 9) + (i % 3 === 0 ? 260 : -120));
  const a = rangeCharacter(profileOf(gentle));
  const b = rangeCharacter(profileOf(jagged));
  for (const axis of ['energy', 'rawness', 'grandeur']) {
    assert.ok(b.scores[axis] > a.scores[axis], `${axis}: jagged ${b.scores[axis]} > gentle ${a.scores[axis]}`);
  }
  assert.equal(a.archetype, 'serene');
  for (const axis of AXES) assert.ok(a.scores[axis] >= 0 && a.scores[axis] <= 1);
});

test('a lone cone reads as dominant; an even wall does not', () => {
  const cone = Array.from({ length: 101 }, (_, i) => 1200 + 2600 * Math.max(0, 1 - Math.abs(i - 50) / 30));
  const wall = Array.from({ length: 101 }, (_, i) => 2500 + (i % 2 ? 40 : 0));
  assert.ok(rangeCharacter(profileOf(cone)).scores.dominance > 0.6);
  // Its raw top-over-median share is high, but a 40m wiggle is no summit.
  assert.ok(skylineFeatures(wall, 400).dominance > 0.6, 'the raw share alone would call it dominant');
  assert.ok(rangeCharacter(profileOf(wall)).scores.dominance < 0.2);
});

test('countPeaks counts summits by prominence, not by wiggles', () => {
  assert.equal(countPeaks([0, 100, 0, 100, 0]), 2);
  assert.equal(countPeaks([0, 30, 0, 30, 0]), 0, 'under the prominence threshold');
});

test('scores are absolute: a range scores the same whatever else is in the basket', () => {
  const sky = Array.from({ length: 80 }, (_, i) => 2000 + 400 * Math.sin(i / 6));
  const alone = rangeCharacter(profileOf(sky));
  const again = rangeCharacter(profileOf(sky));
  assert.deepEqual(alone.scores, again.scores);
});

test('the quality gate rejects a skyline lying on its own floor', () => {
  const good = Array.from({ length: 100 }, (_, i) => 1 + Math.sin(i / 8));
  const flatWithSpikes = Array.from({ length: 100 }, (_, i) => (i % 20 === 0 ? 5 : 0));
  assert.equal(skylineQuality(profileOf(good, good)).usable, true);
  const bad = skylineQuality(profileOf(flatWithSpikes, flatWithSpikes));
  assert.ok(bad.floorShare > MAX_FLOOR_SHARE);
  assert.equal(bad.usable, false);
});

test('the quality gate rejects a needle the ground does not back up, and keeps a real one', () => {
  const ridge = Array.from({ length: 100 }, (_, i) => 2000 + 300 * Math.sin(i / 7));
  const angles = ridge.map((v) => v / 1e5);
  // A knoll near the camera: the angle leaps while the skyline's elevation dips.
  const knoll = angles.map((a, i) => (i === 40 ? a + 0.02 : a));
  const knollElev = ridge.map((v, i) => (i === 40 ? v - 400 : v));
  assert.ok(skylineArtifact(knoll, knollElev) > MAX_ARTIFACT);
  assert.equal(skylineQuality(profileOf(knollElev, knoll)).usable, false);
  // A real summit: angle and elevation leap together.
  const summitElev = ridge.map((v, i) => (i === 40 ? v + 2000 : v));
  assert.ok(skylineArtifact(summitElev.map((v) => v / 1e5), summitElev) < 0.1);
  assert.equal(skylineQuality(profileOf(summitElev)).usable, true);
});

const range = (id, scores, archetype = 'majestic') => ({ id, archetype, scores });

test('one range in the basket: that one, whatever the song', () => {
  const only = [range('solo', { energy: 0.9, rawness: 0.9, grandeur: 0.9, dominance: 0.9 })];
  assert.equal(matchRange(only, { watch: { drive: 0.1 } }, 3).range.id, 'solo');
});

test('the range nearest a song is the likeliest draw, and wins most songs of its kind', () => {
  const ranges = [
    range('calm', { energy: 0.2, rawness: 0.2, grandeur: 0.1, dominance: 0.3 }, 'serene'),
    range('fierce', { energy: 0.8, rawness: 0.85, grandeur: 0.7, dominance: 0.4 }, 'wild'),
  ];
  const quiet = { watch: { drive: 0.15, onset: 0.1, texture: 0.2, arc: 0.15, contrast: 0.3 } };
  const loud = { watch: { drive: 0.85, onset: 0.9, texture: 0.7, arc: 0.7, contrast: 0.4 } };
  for (const [song, want] of [[quiet, 'calm'], [loud, 'fierce']]) {
    const m = matchRange(ranges, song, 0);
    assert.equal(m.ranked[0].range.id, want);
    let wins = 0;
    for (let seed = 0; seed < 400; seed++) if (matchRange(ranges, song, seed).range.id === want) wins++;
    assert.ok(wins > 220, `${want} won ${wins} of 400`);
  }
});

test('a confident minor key leans toward the heavier archetypes', () => {
  const s = { energy: 0.4, rawness: 0.4, grandeur: 0.4, dominance: 0.5 };
  // Identical scores, so only the key can separate them.
  const ranges = [range('bright', s, 'majestic'), range('dark', { ...s }, 'brooding')];
  const song = (mode) => ({ watch: { drive: 0.4, onset: 0.4, texture: 0.4, arc: 0.4, contrast: 0.5 }, tonal: { mode, confidence: 0.8 } });
  assert.equal(matchRange(ranges, song('minor'), 0).ranked[0].range.id, 'dark');
  assert.equal(matchRange(ranges, song('major'), 0).ranked[0].range.id, 'bright');
});

// A basket of n ranges spread through the four axes.
const spread = (n) => Array.from({ length: n }, (_, i) => range(`r${i}`, {
  energy: ((i * 7) % n) / n, rawness: ((i * 11) % n) / n, grandeur: ((i * 13) % n) / n, dominance: ((i * 17) % n) / n,
}));

test('every range keeps a fair share of every song\'s draw, and a seed always draws the same', () => {
  const basket = spread(48);
  for (const drive of [0.05, 0.5, 0.95]) {
    const song = { watch: { drive, onset: 1 - drive, texture: 0.5, arc: drive, contrast: 0.5 } };
    const odds = drawOdds(matchRange(basket, song, 0).ranked);
    assert.ok(Math.abs(odds.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'the odds sum to one');
    for (const o of odds) assert.ok(o >= FAIR_SHARE / 48 - 1e-12, 'no range falls below its fair floor');
    assert.equal(matchRange(basket, song, 12345).range.id, matchRange(basket, song, 12345).range.id);
  }
  assert.notEqual(seedTicket(7, 0), seedTicket(7, 1), 'each ridge draws its own ticket');
  for (let seed = 0; seed < 50; seed++) {
    const t = seedTicket(seed * 7919, seed % 3);
    assert.ok(t >= 0 && t < 1);
  }
});

test('across many songs every range gets a roughly equal chance', () => {
  const basket = spread(24);
  const hits = new Map();
  const n = 2400;
  for (let i = 0; i < n; i++) {
    // Songs spread over the whole watch space, one seed each.
    const u = (k) => seedTicket(i, 10 + k);
    const song = { watch: { drive: u(0), onset: u(1), texture: u(2), arc: u(3), contrast: u(4) } };
    const id = matchRange(basket, song, i).range.id;
    hits.set(id, (hits.get(id) || 0) + 1);
  }
  const fair = n / basket.length;
  for (const r of basket) {
    const share = (hits.get(r.id) || 0) / fair;
    assert.ok(share > 0.5 && share < 1.8, `${r.id} drew ${share.toFixed(2)}x an equal share`);
  }
});

test('one extreme range does not take every extreme song', () => {
  // The Denali problem: one range far out on grandeur, the rest bunched low.
  const basket = [...spread(35).map((r) => ({ ...r, scores: { ...r.scores, grandeur: r.scores.grandeur * 0.6 } })),
    range('giant', { energy: 0.6, rawness: 0.45, grandeur: 0.98, dominance: 0.6 })];
  const loud = (i) => ({ watch: { drive: 0.6 + (i % 5) * 0.05, onset: 0.6, texture: 0.6, arc: 0.7 + (i % 4) * 0.07, contrast: 0.7 } });
  let giant = 0;
  for (let i = 0; i < 60; i++) if (matchRange(basket, loud(i), i).range.id === 'giant') giant++;
  assert.ok(giant < 20, `giant took ${giant} of 60 loud songs`);
  assert.equal(rankScores(basket).get(basket[basket.length - 1]).grandeur, 1, 'ranked, the giant is simply first');
});

test('recently shown ranges sit the draw out while any other is left', () => {
  const basket = spread(12);
  const song = { watch: { drive: 0.3, onset: 0.6, texture: 0.4, arc: 0.7, contrast: 0.2 } };
  const recent = basket.slice(0, 11).map((r) => r.id);
  for (let seed = 0; seed < 30; seed++) {
    assert.equal(matchRange(basket, song, seed, { recent }).range.id, 'r11');
  }
  const all = basket.map((r) => r.id);
  assert.ok(all.includes(matchRange(basket, song, 3, { recent: all }).range.id), 'all recent: still a range');
});

test('song watch values are read as percentiles of real material', () => {
  const knots = [0.2, 0.3, 0.4, 0.6, 0.7];
  assert.equal(songPercentile(0, knots), 0);
  assert.equal(songPercentile(0.4, knots), 0.5);
  assert.equal(songPercentile(1, knots), 1);
  assert.ok(songPercentile(0.35, knots) > 0.25 && songPercentile(0.35, knots) < 0.5);
  const t = songTerrainTarget({ watch: {} });
  for (const axis of AXES) assert.ok(Math.abs(t[axis] - 0.5) < 0.05, `a song with no readings is typical on ${axis}`);
});

test('three ridges, three bands: high at the back, mid in the middle, low in front', () => {
  const at = (id, reliefM) => ({ ...range(id, { energy: 0.5, rawness: 0.5, grandeur: 0.5, dominance: 0.5 }), reliefM });
  const basket = [at('foothill', 700), at('hills', 1100), at('mid', 1500), at('giant', 3000), at('odd', NaN)];
  assert.deepEqual(RIDGE_BANDS.map((b) => [b.ridge, b.layer, b.band]),
    [['far', 'L2', 'high'], ['mid', 'L3', 'mid'], ['near', 'L4', 'low']]);
  assert.equal(reliefBand(basket[0]), 'low');
  assert.equal(reliefBand({ reliefM: 1200 }), 'mid', 'an edge belongs to the band above');
  assert.equal(reliefBand({ reliefM: 2000 }), 'high');
  assert.equal(reliefBand(basket[4]), null);
  assert.equal(bandBaskets(basket), bandBaskets(basket), 'split once per basket');
  const song = { watch: { drive: 0.5 } };
  const set = matchRidgeSet(basket, song, 42);
  assert.equal(set.far.range.id, 'giant');
  assert.equal(set.mid.range.id, 'mid');
  assert.ok(['foothill', 'hills'].includes(set.near.range.id));
  assert.equal(matchRidgeSet([at('foothill', 700)], song, 1).far, null, 'an empty band leaves its ridge unmatched');
});

test('songTerrainTarget tolerates a missing profile', () => {
  const t = songTerrainTarget(null);
  for (const axis of AXES) assert.ok(t[axis] >= 0 && t[axis] <= 1);
});

test('every range in the generated index has scores, a loader and a loadable profile', async () => {
  assert.ok(RANGES.length >= 50, 'the basket holds the discovered ranges too');
  const bands = bandBaskets(RANGES);
  for (const band of ['high', 'mid', 'low']) {
    assert.ok(bands[band].length >= 15, `${band} relief holds ${bands[band].length} ranges`);
  }
  const ids = new Set();
  for (const r of RANGES) {
    assert.ok(!ids.has(r.id), `${r.id} appears once`); ids.add(r.id);
    for (const axis of AXES) assert.ok(r.scores[axis] >= 0 && r.scores[axis] <= 1, `${r.id}.${axis}`);
    assert.ok(reliefBand(r), `${r.id} has a relief band`);
    assert.equal(typeof LOADERS[r.id], 'function', `${r.id} has a loader`);
    const mod = await LOADERS[r.id]();
    assert.ok(skylineQuality(mod.default).usable, `${r.id} passed the quality gate`);
    assert.ok(Object.keys(profilesFromJSON(mod.default)).length > 0, `${r.id} yields terrain profiles`);
  }
});

// A tiny RGB PNG, one row per filter type, to exercise every unfilter path.
function makePng(width, rows) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(rows.length, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(rows.map(({ filter, bytes }) => Buffer.from([filter, ...bytes])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('decodePng undoes every PNG row filter', () => {
  const png = makePng(2, [
    { filter: 0, bytes: [10, 20, 30, 40, 50, 60] },
    { filter: 2, bytes: [1, 1, 1, 1, 1, 1] },       // up: +previous row
    { filter: 1, bytes: [5, 5, 5, 1, 1, 1] },       // sub: +pixel to the left
    { filter: 3, bytes: [2, 2, 2, 2, 2, 2] },       // average of left and up
    { filter: 4, bytes: [1, 1, 1, 1, 1, 1] },       // Paeth predictor
  ]);
  const { width, height, channels, data } = decodePng(png);
  assert.deepEqual([width, height, channels], [2, 5, 3]);
  // avg: (0 + 5) >> 1 = 2 -> 4; then (4 + 6) >> 1 = 5 -> 7.
  assert.deepEqual(Array.from(data.subarray(18, 24)), [4, 4, 4, 7, 7, 7]);
  // Paeth: first pixel predicts up (4) -> 5; second, of left 5 / up 7 /
  // up-left 4, predicts up (7) -> 8.
  assert.deepEqual(Array.from(data.subarray(24, 30)), [5, 5, 5, 8, 8, 8]);
  assert.deepEqual(Array.from(data.subarray(6, 12)), [11, 21, 31, 41, 51, 61]);
  assert.deepEqual(Array.from(data.subarray(12, 18)), [5, 5, 5, 6, 6, 6]);
});

test('terrarium elevation and tile projection', () => {
  assert.equal(terrariumElevation(128, 0, 0), 0);
  assert.equal(terrariumElevation(128, 100, 128), 100.5);
  const p = lonLatToPixel(0, 0, 1);
  assert.deepEqual([p.x, p.y], [256, 256], 'lon/lat 0,0 sits at the centre of the world');
});

test('a range is rotated onto its own axis, and a cone is left alone', () => {
  const ridge = (bearing) => {
    const W = 100, H = 100, elev = new Float32Array(W * H), r = (bearing * Math.PI) / 180;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      elev[y * W + x] = 3000 - Math.abs((x - 50) * Math.cos(r) + (y - 50) * Math.sin(r)) * 40;
    }
    return { width: W, height: H, elev };
  };
  const g = ridge(30);
  const axis = rangeAxisDeg(g);
  assert.ok(Math.abs(axis - 30) < 1, `measured ${axis}`);
  assert.ok(Math.abs(rangeAxisDeg(rotateGrid(g, axis))) < 1, 'rotated to vertical');
  assert.ok(rangeElongation(g) > 1.8, 'a ridge is elongated');
  const W = 80, cone = new Float32Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) cone[y * W + x] = 3000 - Math.hypot(x - 40, y - 40) * 30;
  assert.ok(rangeElongation({ width: W, height: W, elev: cone }) < 1.2, 'a cone has no axis to align');
});

test('the camera stands above its own valley floor', () => {
  const elev = new Float32Array(100).map((_, i) => 3000 + i * 20);
  const cam = valleyCameraElevM({ elev });
  assert.ok(cam > 3000 && cam < 3900, `camera at ${cam}m in a valley floored at 3000m`);
});
