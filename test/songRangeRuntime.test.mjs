import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { songRangeChoice, songRangeStats } from '../src/world/terrain/RangeLibrary.js';
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
