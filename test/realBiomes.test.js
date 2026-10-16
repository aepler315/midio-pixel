import { WALL_SHARE } from '../src/world/terrain/ranges/shapes.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REAL_BIOMES, REAL_BIOME_NAMES, REAL_BIOME_TEMPERATURE, biomeForEcoregion, biomeOfRange, rangesByBiome,
} from '../src/world/RealBiomes.js';
import { RANGES } from '../src/world/terrain/ranges/index.js';
import { chooseSongBiomes, chooseBiomeRidges, castSongBiomes, SONG_BIOME_COUNT } from '../src/world/terrain/BiomeSet.js';
import { blendSections, travelMs, TRAVEL_MIN_MS, TRAVEL_MAX_MS } from '../src/world/BiomeSchedule.js';
import { travelSeam } from '../src/world/BiomeManager.js';
import { LANDMARKS } from '../src/world/Landmarks.js';
import { getWorld, listWorlds } from '../src/world/Worlds.js';

test('every range in the basket stands in one of the real biomes', () => {
  for (const r of RANGES) assert.ok(REAL_BIOME_NAMES.includes(biomeOfRange(r.id)), r.id);
  const groups = rangesByBiome();
  for (const name of REAL_BIOME_NAMES) assert.ok(groups.get(name).length >= 3, `${name} has fewer than three ranges`);
});

test('ecoregion rules split the biomes that cover unlike places', () => {
  assert.equal(biomeForEcoregion({ biome: 'Temperate Conifer Forests', ecoregion: 'British Columbia coastal conifer forests' }), 'RAINFOREST');
  assert.equal(biomeForEcoregion({ biome: 'Temperate Conifer Forests', ecoregion: 'Arizona Mountains forests' }), 'PINE_OAK');
  assert.equal(biomeForEcoregion({ biome: 'Temperate Conifer Forests', ecoregion: 'Colorado Rockies forests' }), 'CONIFER');
  assert.equal(biomeForEcoregion({ biome: 'Deserts & Xeric Shrublands', ecoregion: 'Great Basin shrub steppe' }), 'STEPPE');
  assert.equal(biomeForEcoregion({ biome: 'Deserts & Xeric Shrublands', ecoregion: 'Colorado Plateau shrublands' }), 'CANYON');
  assert.equal(biomeForEcoregion({ biome: 'Deserts & Xeric Shrublands', ecoregion: 'Mojave desert' }), 'DESERT');
  assert.equal(biomeForEcoregion({ biome: 'N/A', ecoregion: 'Rock and Ice' }), 'ICEFIELD');
  assert.equal(biomeForEcoregion({ biome: 'Mangroves' }), null);
});

test('real biomes carry what the renderer reads, and a temperature spread over 0..1', () => {
  for (const b of REAL_BIOMES) {
    assert.equal(b.sky.length, 3, b.name);
    assert.match(b.silhouette, /^#[0-9a-f]{6}$/i);
    assert.ok(b.celestial?.kind && b.particles?.kind && b.title);
    assert.ok(b.real);
    if (b.density.L4 + b.density.L5 > 0) assert.ok(LANDMARKS[b.name], `${b.name} has density but no landmarks`);
  }
  const temps = Object.values(REAL_BIOME_TEMPERATURE).sort((a, b) => a - b);
  assert.equal(temps[0], 0);
  assert.equal(temps[temps.length - 1], 1);
});

test('The Range plays in real biomes; the other worlds are still registered', () => {
  const alpine = getWorld('alpine');
  assert.equal(alpine.realBiomes, true);
  assert.equal(alpine.palettes, REAL_BIOMES);
  assert.ok(listWorlds().length > 1, 'the other worlds keep their source and registry entry');
});

test('a song gets distinct biomes, the same ones every time', () => {
  const profile = { watch: { drive: 0.4, onset: 0.3, texture: 0.4, arc: 0.5, contrast: 0.5 } };
  const a = chooseSongBiomes(profile, 1234);
  assert.equal(a.length, SONG_BIOME_COUNT);
  assert.equal(new Set(a).size, a.length);
  assert.deepEqual(chooseSongBiomes(profile, 1234), a);
});

test('home biomes are drawn roughly evenly across songs', () => {
  const home = new Map();
  const N = 2200;
  for (let s = 1; s <= N; s++) {
    const d = (s * 0.618) % 1;
    const profile = { watch: { drive: d, onset: 1 - d, texture: 0.4, arc: d, contrast: 0.5 } };
    const b = chooseSongBiomes(profile, s * 7919)[0];
    home.set(b, (home.get(b) || 0) + 1);
  }
  const equal = N / REAL_BIOME_NAMES.length;
  for (const name of REAL_BIOME_NAMES) {
    const share = (home.get(name) || 0) / equal;
    assert.ok(share > 0.6 && share < 1.5, `${name} is home ${share.toFixed(2)}x an equal share`);
  }
});

test('a biome puts an open skyline in front and orders the back pair by relief', () => {
  for (const name of REAL_BIOME_NAMES) {
    const set = chooseBiomeRidges(name, {}, 42);
    const ids = [set.far, set.mid, set.near].filter(Boolean).map((m) => m.range.id);
    assert.equal(ids.length, 3, name);
    assert.equal(new Set(ids).size, 3);
    for (const id of ids) assert.equal(biomeOfRange(id), name);
    assert.ok(set.far.range.reliefM >= set.mid.range.reliefM);
    assert.ok(WALL_SHARE[set.near.range.id] <= 0.25, name);
  }
});

test('the opening label keeps the home biome; louder labels get more violent ground', () => {
  const biomes = ['CONIFER', 'BROADLEAF', 'ICEFIELD', 'CANYON', 'TUNDRA'];
  const cast = castSongBiomes([0.5, 0.1, 0.95, 0.4], biomes);
  assert.equal(cast[0], 'CONIFER');
  const t = (n) => REAL_BIOME_TEMPERATURE[n];
  assert.ok(t(cast[2]) > t(cast[3]) && t(cast[3]) > t(cast[1]));
  // More labels than biomes: reuse, never twice in a row.
  const many = castSongBiomes([0.5, 0.1, 0.2, 0.3, 0.4, 0.6, 0.7], ['CONIFER', 'DESERT']);
  for (let i = 1; i < many.length; i++) assert.notEqual(many[i], many[i - 1]);
});

test('a change of biome is travelled over its own span, and a return is too', () => {
  const sections = [
    { startMs: 0, barMs: 2000, profile: 'CONIFER', transition: 'fade' },
    { startMs: 20000, barMs: 2000, profile: 'DESERT', transition: 'cut' },
  ];
  const span = travelMs(sections[1]);
  assert.equal(span, 7000);
  const mid = blendSections(sections, 20000 + span / 2, { travel: true });
  assert.equal(mid.travel, true);
  assert.ok(Math.abs(mid.travelP - 0.5) < 1e-9);
  assert.ok(mid.t > 0.4 && mid.t < 0.6);
  // Without travel the cut is 0.3 bars.
  assert.equal(blendSections(sections, 21000).t, 1);
  assert.equal(travelMs({ barMs: 100 }), TRAVEL_MIN_MS);
  assert.equal(travelMs({ barMs: 9000 }), TRAVEL_MAX_MS);
  // Same biome on both sides: nothing to travel into.
  const same = [sections[0], { ...sections[1], profile: 'CONIFER' }];
  assert.equal(blendSections(same, 20100, { travel: true }).travel, undefined);
});

test('the seam enters from the right and the near ranges arrive first', () => {
  const W = 1000;
  for (const k of ['L2', 'L3', 'L4', 'L5']) {
    assert.ok(travelSeam(W, k, 0) > W, 'starts past the right edge');
    assert.ok(travelSeam(W, k, 1) < 0, 'ends past the left edge');
  }
  assert.ok(travelSeam(W, 'L5', 0.5) < travelSeam(W, 'L4', 0.5));
  assert.ok(travelSeam(W, 'L4', 0.5) < travelSeam(W, 'L2', 0.5));
});
