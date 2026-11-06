import test from 'node:test';
import assert from 'node:assert/strict';
import { createSongWorldRecord, copySongWorldRecord, isSongWorldRecord, describeSongWorld } from '../src/library/SongWorld.js';
import { planSongScenes } from '../src/world/terrain/SongScenePlan.js';
import { prepareSongTerrain } from '../src/world/terrain/RangeLibrary.js';
import { assignSongScenes, SCENE_MATCH_VERSION } from '../src/world/terrain/SceneCatalog.js';
import catalog from '../src/world/terrain/sceneCatalogData.js';

const profile = { version: 2, watch: { drive: .7, onset: .55, texture: .6, arc: .7, contrast: .6, unneeded: 99 }, huge: new Float32Array(500) };

test('a compact world record retains exactly the scenery inputs and rejects unknown or malformed identities', () => {
  const record = createSongWorldRecord(profile, 417);
  assert.deepEqual(record, { version: 1, seed: 417, profileVersion: 2, watch: { drive: .7, onset: .55, texture: .6, arc: .7, contrast: .6 } });
  const copy = copySongWorldRecord({ ...record, arbitrary: 'drop', watch: { ...record.watch, extra: 99 } });
  assert.deepEqual(copy, record); assert.notEqual(copy, record); assert.notEqual(copy.watch, record.watch);
  assert.ok(JSON.stringify(record).length < 180);
  for (const invalid of [null, {}, { ...record, version: 7 }, { ...record, profileVersion: 1 },
    { ...record, seed: -1 }, { ...record, seed: 2 ** 32 }, { ...record, seed: NaN },
    { ...record, watch: { ...record.watch, drive: Infinity } }, { ...record, watch: { ...record.watch, drive: 2 } }]) {
    assert.equal(isSongWorldRecord(invalid), false); assert.equal(copySongWorldRecord(invalid), null);
    assert.equal(describeSongWorld(invalid).state, 'pending');
  }
  assert.equal(createSongWorldRecord({ ...profile, version: 1 }, 1), null);
});

test('library descriptions name the same home view as playback planning without fetching terrain', async () => {
  const original = globalThis.fetch; let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw Error('Library descriptions must not load terrain'); };
  try {
    for (let seed = 0; seed < 100; seed++) {
      const record = createSongWorldRecord(profile, seed), plan = planSongScenes(profile, seed);
      const label = describeSongWorld(record), choice = plan.sceneByBiome.get(plan.home);
      assert.equal(label.viewId, choice.view.id);
      assert.equal(label.biome, plan.home);
      assert.equal(label.label, `World: ${choice.view.title}`);
      assert.equal(label.experimental, choice.view.status !== 'approved');
      assert.equal(label.matchingVersion, SCENE_MATCH_VERSION);
      assert.equal(describeSongWorld(record), label, 'repainting reuses the cached description');
    }
    assert.equal(fetched, 0);
  } finally { globalThis.fetch = original; }
});

test('one catalog revision validates once and a new version rebuilds its index', () => {
  let reads = 0;
  const custom = { catalogVersion: catalog.catalogVersion, get views() { reads++; return catalog.views; } };
  for (let seed = 0; seed < 30; seed++) planSongScenes(profile, seed, { catalog: custom });
  assert.equal(reads, 1);
  custom.catalogVersion++;
  planSongScenes(profile, 3, { catalog: custom });
  assert.equal(reads, 2);
});

test('unknown views refresh to an explicit biome fallback and catalog revisions do not leave a stale name', () => {
  const record = createSongWorldRecord(profile, 417), original = describeSongWorld(record);
  const empty = { catalogVersion: catalog.catalogVersion + 1, views: [] };
  const missing = describeSongWorld(record, { catalog: empty });
  assert.equal(missing.viewId, null); assert.equal(missing.state, 'known');
  assert.match(missing.title, /Scenic view unavailable/);
  assert.notEqual(missing.label, original.label);
  assert.equal(describeSongWorld(record).viewId, original.viewId);
});

test('normal song planning ignores transient viewing history and RangeLibrary uses that same plan', async () => {
  const seed = 417, record = createSongWorldRecord(profile, seed), expected = planSongScenes(profile, seed);
  const original = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => /recentViews/.test(key)
    ? JSON.stringify([...expected.sceneByBiome.values()].map(c => c.view.id))
    : /recentRegions/.test(key) ? JSON.stringify([...expected.sceneByBiome.values()].map(c => c.view.regionId)) : '[]' };
  try {
    const terrain = await prepareSongTerrain(profile, seed, []);
    assert.ok(terrain); await terrain.whenAll;
    assert.equal(terrain.home, expected.home);
    for (const biome of expected.biomes) assert.equal(terrain.sceneByBiome.get(biome).view.id, expected.sceneByBiome.get(biome).view.id);
    assert.equal(describeSongWorld(record).viewId, terrain.sceneByBiome.get(terrain.home).view.id);
    assert.equal(terrain.matchingVersion, SCENE_MATCH_VERSION);
    const reverse = assignSongScenes([...expected.biomes].reverse(), profile, seed, catalog);
    for (const biome of expected.biomes) assert.equal(reverse.get(biome).view.id, expected.sceneByBiome.get(biome).view.id);
  } finally { if (original === undefined) delete globalThis.localStorage; else globalThis.localStorage = original; }
});
