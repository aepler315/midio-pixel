import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { songRangeChoice, songRangeStats, prepareSongTerrain } from '../src/world/terrain/RangeLibrary.js';
import { planSongScenes } from '../src/world/terrain/SongScenePlan.js';
import { RangePresentation } from '../src/world/alpine/RangePresentation.js';
import { sceneViewErrors } from '../src/world/terrain/SceneCatalog.js';
import { prepareTerrainAssets } from '../src/world/alpine/RangeAssets.js';
import { PROFILE_VERSION } from '../src/audio/SongProfile.js';

// Serve file: URLs from disk, as the browser would serve the asset tree.
const diskFetch = async (url) => {
  const p = fileURLToPath(url);
  if (!fs.existsSync(p)) return new Response(null, { status: 404 });
  return new Response(fs.readFileSync(p));
};
const profile = { version: PROFILE_VERSION, watch: { drive: .6, onset: .3, texture: .4, arc: .5, contrast: .5 } };
const seed = 4242;

test('with the flag off, songs keep their catalog views', async () => {
  const scenery = planSongScenes(profile, seed);
  assert.equal(await songRangeChoice(profile, seed, scenery, { search: '' }), null);
});

test('a forced composed range assembles from its pinned pieces and keeps the catalog view as fallback', async () => {
  const scenery = planSongScenes(profile, seed);
  const before = { ...songRangeStats };
  const choice = await songRangeChoice(profile, seed, scenery, { search: '?songRange=force', fetchImpl: diskFetch });
  assert.ok(choice, `fell back: ${songRangeStats.lastReason}`);
  assert.equal(choice.songRange, true);
  assert.equal(choice.forced, true);
  assert.equal(choice.view.biome, scenery.home);
  assert.deepEqual(sceneViewErrors(choice.view), []);
  assert.equal(choice.fallback, scenery.sceneByBiome.get(scenery.home));
  assert.equal(songRangeStats.assembled, before.assembled + 1);
  // The scene's loader takes the same assembled stage, with no residency.
  const prepared = await prepareTerrainAssets(choice.view, { baseUrl: new URL('../src/assets/range/v2/', import.meta.url).href, fetchImpl: diskFetch });
  assert.equal(prepared.manifest.kind, 'song-range-stage');
  assert.equal(prepared.data.tiles.size, 35 * 35);
});

test('a stage that cannot load keeps the catalog view and is counted', async () => {
  const scenery = planSongScenes(profile, seed + 1);
  const before = songRangeStats.fallbacks;
  const failing = async () => new Response(null, { status: 404 });
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(await songRangeChoice(profile, seed + 1, scenery, { search: '?songRange=force', fetchImpl: failing }), null);
  } finally { console.warn = warn; }
  assert.equal(songRangeStats.fallbacks, before + 1);
  assert.ok(songRangeStats.lastReason);
});

test('the presentation resolves a composed view, and its catalog fallback once it fails', () => {
  const stage = { id: 'song-range-abc', songRange: {} }, catalogView = { id: 'teton-jackson-lake' };
  const choice = { view: stage, songRange: true, fallback: { view: catalogView } };
  const self = { forced: null, failures: new Map(), sceneByBiome: new Map([['CONIFER', choice]]), catalog: { views: [catalogView] } };
  self._songRangeChoice = RangePresentation.prototype._songRangeChoice;
  self._stageRiseSnapshot = RangePresentation.prototype._stageRiseSnapshot;
  const choiceFor = (b) => RangePresentation.prototype._choiceFor.call(self, b);
  const viewFor = (o) => RangePresentation.prototype._viewForOccurrence.call(self, o);
  assert.equal(choiceFor('CONIFER').view, stage);
  assert.equal(viewFor({ viewId: stage.id }), stage);
  assert.equal(viewFor({ viewId: catalogView.id }), catalogView);
  self.failures.set(stage.id, 'decode: broken');
  assert.equal(choiceFor('CONIFER').view, catalogView);
  assert.equal(viewFor({ viewId: stage.id }), catalogView);
  const snap = RangePresentation.prototype._songRangeSnapshot.call({ ...self, scene: null });
  assert.equal(snap.state, 'fallback');
  assert.equal(snap.fallbackViewId, catalogView.id);
  assert.equal(snap.rise, null, 'no score yet: no slot rise to report');
});

test('?songRangeLayout runs a Phase 1 pilot layout through the runtime path', async () => {
  const { pilotPlan, songRangeKey } = await import('../src/world/terrain/SongRangePlan.js');
  const pilot = JSON.parse(fs.readFileSync(new URL('../data/terrain/song-range-pilot.json', import.meta.url), 'utf8')).layouts[0];
  const plan = pilotPlan(pilot.id, 'CANYON');
  assert.equal(plan.biome, 'CANYON');
  assert.equal(plan.principal.pieceId, pilot.slots.B2.piece);
  for (const s of plan.slots) assert.equal(s.pieceId, pilot.slots[s.slotId].piece);
  assert.equal(pilotPlan('nope', 'CANYON'), null);
  const scenery = planSongScenes(profile, seed);
  const choice = await songRangeChoice(profile, seed, scenery, { search: `?songRangeLayout=${pilot.id}`, fetchImpl: diskFetch });
  assert.equal(choice.view.songRange.key, songRangeKey(plan));
});

test('a composed range that misses its wait leaves the song its catalog terrain on time', async () => {
  const scenery = planSongScenes(profile, seed + 2);
  const before = songRangeStats.late;
  const hanging = () => new Promise(() => {}); // the stage pieces never arrive
  const warn = console.warn; console.warn = () => {};
  let terrain;
  const t0 = Date.now();
  try {
    terrain = await prepareSongTerrain(profile, seed + 2, [], { songRangeWaitMs: 50, search: '?songRange=force', fetchImpl: hanging });
  } finally { console.warn = warn; }
  assert.ok(terrain, 'the home biome still loads');
  assert.ok(Date.now() - t0 < 2000, 'preparation is not held by the stage');
  assert.equal(terrain.songRange, null);
  assert.equal(terrain.sceneByBiome.get(scenery.home).view.id, scenery.sceneByBiome.get(scenery.home).view.id);
  assert.equal(songRangeStats.late, before + 1);
});

test('with an unbounded wait (exports), preparation keeps the composed range', async () => {
  const scenery = planSongScenes(profile, seed);
  const terrain = await prepareSongTerrain(profile, seed, [], { songRangeWaitMs: Infinity, search: '?songRange=force', fetchImpl: diskFetch });
  assert.ok(terrain?.songRange, `fell back: ${songRangeStats.lastReason}`);
  assert.equal(terrain.sceneByBiome.get(scenery.home).songRange, true);
});

test('a replay retries a composed range that failed in the previous generation', () => {
  const camera = { eyeStartM: [0, 1500, 0], eyeEndM: [1000, 1600, 0], targetStartM: [0, 700, -9000], targetEndM: [2000, 700, -8000], fovYDeg: 35 };
  const catalogView = { id: 'catalog-a', biome: 'ALPINE', status: 'approved', camera, terrainManifestUrl: 'a.json' };
  const stage = { id: 'song-range-0123456789abcdef', biome: 'ALPINE', status: 'candidate', camera, songRange: {} };
  const terrain = { sceneByBiome: new Map([['ALPINE', { view: stage, songRange: true, fallback: { view: catalogView } }]]) };
  const mgr = { sections: [{ startMs: 0, profile: 'ALPINE', barMs: 750 }], durationMs: 60000, songSeed: 7, worldId: 'range', world: {} };
  const p = new RangePresentation({ mode: 'v2', shots: false, retryDelaysMs: [] });
  p.setSong({ terrain, mgr, generation: 1 });
  assert.equal(p.railPlan.occurrences[0].viewId, stage.id);
  p.failures.set(stage.id, 'decode: broken');
  p.setSong({ terrain, mgr, generation: 2 });
  assert.equal(p.failures.size, 0);
  assert.equal(p.railPlan.occurrences[0].viewId, stage.id, 'the new plan asks for the composed range again');
});
