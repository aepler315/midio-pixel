import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { songRangeChoice, prepareSongTerrain, songRangeStats } from '../src/world/terrain/RangeLibrary.js';
import { planSongScenes } from '../src/world/terrain/SongScenePlan.js';
import { PROFILE_VERSION } from '../src/audio/SongProfile.js';
import { measuredViewOutline } from '../src/world/terrain/SongprintTerrain.js';
import scenes from '../src/world/terrain/sceneCatalogData.js';

const profile = { version: PROFILE_VERSION, watch: { drive: .6, onset: .3, texture: .4, arc: .5, contrast: .5 } };
const diskFetch = async (url) => {
  const p = fileURLToPath(url);
  return fs.existsSync(p) ? new Response(fs.readFileSync(p)) : new Response(null, { status: 404 });
};
const view = scenes.views.find(v => v.id === 'nc-ross-lake-north');
const songprint = { version: 1, skyline: measuredViewOutline(view).map(h => h / 255), passages: [] };

test('an inland region that misses its loading budget leaves the catalog view on screen', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async url => { await gate; return diskFetch(url); };
  const before = songRangeStats.late;
  const started = Date.now();
  const terrain = await prepareSongTerrain(profile, 77, [], { songprint, search: '', songRangeWaitMs: 20, fetchImpl });
  assert.ok(Date.now() - started < 4000, 'a slow region cannot hold playback');
  assert.equal(songRangeStats.late, before + 1);
  assert.equal(terrain.songRange, null, 'the catalog view carries this play');
  assert.ok(terrain.sceneByBiome.get(terrain.home)?.view, 'a scene is still on screen');
  release();
});

test('a region built in time is the song’s own inland stage, the same on every build', async () => {
  const scenery = planSongScenes(profile, 77, { songprint });
  const first = await songRangeChoice(profile, 77, scenery, { songprint, search: '', fetchImpl: diskFetch });
  assert.ok(first?.view.songRange.plan.inland, 'Returning summits builds an inland region');
  assert.equal(first.view.songRange.plan.slots.length, 2, 'the returning pair stands on the region');
  assert.ok(first.view.songprintComposition, 'the pair is framed');
  const again = await songRangeChoice(profile, 77, planSongScenes(profile, 77, { songprint }), { songprint, search: '', fetchImpl: diskFetch });
  assert.equal(again.view.id, first.view.id);
  assert.deepEqual(again.view.camera, first.view.camera);
});
