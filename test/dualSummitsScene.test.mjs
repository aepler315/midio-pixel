import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { songRangeChoice, prepareSongTerrain, songRangeStats } from '../src/world/terrain/RangeLibrary.js';
import { planSongScenes } from '../src/world/terrain/SongScenePlan.js';
import { PROFILE_VERSION } from '../src/audio/SongProfile.js';
import { planDualSummitsScene, dualSummitsRequested } from '../src/world/terrain/DualSummitsScene.js';
import MASSIF_CATALOG from '../src/world/terrain/massifCatalogData.js';
import { prepareTerrainAssets } from '../src/world/alpine/RangeAssets.js';
import { sceneViewErrors } from '../src/world/terrain/SceneCatalog.js';
import { dualSummitsPose } from '../src/world/alpine/DualSummitsPerformance.js';
import { projectPoint } from '../src/world/terrain/SceneTravel.js';

const profile = { version: PROFILE_VERSION, watch: { drive: .6, onset: .3, texture: .4, arc: .5, contrast: .5 } };
const diskFetch = async (url) => {
  const p = fileURLToPath(url);
  return fs.existsSync(p) ? new Response(fs.readFileSync(p)) : new Response(null, { status: 404 });
};

test('unavailable signature packages keep ordinary catalog scenery and no signature score', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const scenery = planSongScenes(profile, 4242);
  const terrain = await prepareSongTerrain(profile, 4242, [], { signature: 'dual-summits', search: '',
    songRangeWaitMs: Infinity, fetchImpl: async () => new Response(null, { status: 404 }) });
  assert.ok(terrain);
  assert.equal(terrain.songRange, null);
  assert.equal(terrain.signaturePerformance, undefined);
  assert.deepEqual(terrain.sceneByBiome, scenery.sceneByBiome);
});

test('a late signature stage never adopts after preparation returns its catalog fallback', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async url => { await gate; return diskFetch(url); };
  const before = songRangeStats.late;
  const started = Date.now();
  const terrain = await prepareSongTerrain(profile, 4242, [], { signature: 'dual-summits', search: '', songRangeWaitMs: 20, fetchImpl });
  assert.ok(Date.now() - started < 2000, 'the signature cannot hold playback indefinitely');
  assert.equal(songRangeStats.late, before + 1);
  assert.equal(terrain.songRange, null);
  assert.equal(terrain.signaturePerformance, undefined);
  release();
  const prepared = await songRangeChoice(profile, 4242, planSongScenes(profile, 4242), { signature: 'dual-summits', search: '', fetchImpl: diskFetch });
  assert.ok(prepared, 'a subsequent preparation can use the now-ready stage');
  assert.equal(terrain.songRange, null, 'the already admitted fallback never switches under playback');
  assert.equal(terrain.signaturePerformance, undefined);
});

test('explicit Dual Summits selection assembles exactly two measured hero massifs', async () => {
  const scenery = planSongScenes(profile, 4242);
  const choice = await songRangeChoice(profile, 4242, scenery, { signature: 'dual-summits', search: '', fetchImpl: diskFetch });
  assert.ok(choice, 'the explicit performance prepares without the general songRange flag');
  assert.equal(choice.view.signaturePerformance, 'dual-summits');
  assert.deepEqual(choice.view.songRange.plan.slots.map(s => [s.slotId, s.pieceId]), [
    ['B1', 'teton-jackson-lake:grand-teton'], ['B2', 'teton-jackson-lake:mount-moran'],
  ]);
  assert.deepEqual(choice.view.signatureSummits.map(s => [s.id, s.name]), [['A', 'Grand Teton'], ['B', 'Mount Moran']]);
  assert.ok(choice.view.signatureSummits.every(s => s.positionM.length === 3 && s.positionM.every(Number.isFinite)));
  assert.notDeepEqual(choice.view.signatureSummits[0].positionM, choice.view.signatureSummits[1].positionM);
  assert.equal(choice.fallback, scenery.sceneByBiome.get(scenery.home));
  assert.deepEqual(sceneViewErrors(choice.view), []);
  assert.deepEqual(choice.view.camera.eyeStartM, choice.view.camera.eyeEndM, 'the authored signature stays at a fixed safe eye');
  assert.deepEqual(choice.view.camera.targetStartM, choice.view.camera.targetEndM);
  const prepared = await prepareTerrainAssets(choice.view, { baseUrl: new URL('../src/assets/range/v2/', import.meta.url).href, fetchImpl: diskFetch });
  assert.equal(prepared.manifest.lod.fovYDeg, 18, 'stage detail covers the narrowest signature lens');
  assert.equal(prepared.manifest.landmarks.length, 2);
  const pose = dualSummitsPose(choice.view, { id: 'dual-summits', focus01: .5, convergence01: 1, fovYDeg: 40,
    slotRise01: { B1: 1, B2: 1 } }, { baseM: 2050 });
  for (const s of choice.view.signatureSummits) {
    const p = projectPoint(pose, 16 / 9, s.positionM);
    assert.ok(p && Math.abs(p.x) < .7 && Math.abs(p.y) < .75, `${s.name} needs breathing room in the shared image: ${JSON.stringify(p)}`);
  }
});

test('the explicit performance and review URL hold the same two heroes across every song biome', async () => {
  const scenery = planSongScenes(profile, 4242);
  assert.ok(scenery.biomes.length > 1, 'fixture exercises a biome switch');
  const a = await prepareSongTerrain(profile, 4242, [], { signature: 'dual-summits', search: '', songRangeWaitMs: Infinity, fetchImpl: diskFetch });
  const b = await prepareSongTerrain(profile, 777, [], { search: '?performance=dual-summits', songRangeWaitMs: Infinity, fetchImpl: diskFetch });
  assert.equal(a.signaturePerformance.id, 'dual-summits');
  assert.equal(a.songRange.stage.signaturePerformance, 'dual-summits');
  assert.equal(a.songRange.viewId, b.songRange.viewId, 'song identity cannot randomize the authored signature stage');
  for (const biome of a.biomes) {
    const choice = a.sceneByBiome.get(biome);
    assert.equal(choice.view.id, a.signaturePerformance.viewId);
    assert.deepEqual(choice.fallback, scenery.sceneByBiome.get(scenery.home), 'one fallback keeps occurrence handoff deterministic');
  }
  assert.deepEqual(a.signaturePerformance.summits, a.sceneByBiome.get(a.home).view.signatureSummits);
});

test('ordinary songs and unknown performances keep their regular selection', async () => {
  const scenery = planSongScenes(profile, 4242);
  assert.equal(await songRangeChoice(profile, 4242, scenery, { search: '' }), null);
  assert.equal(await songRangeChoice(profile, 4242, scenery, { signature: 'unknown', search: '' }), null);
  assert.equal(dualSummitsRequested({ signature: 'off', search: '?performance=dual-summits' }), false);
  assert.equal(dualSummitsRequested({ search: '?performance=dual-summits' }), true);
});

test('catalogs missing either pinned hero or its stage cannot create a partial signature', () => {
  assert.equal(planDualSummitsScene('CONIFER', { catalog: { ...MASSIF_CATALOG, templates: [] } }), null);
  assert.equal(planDualSummitsScene('CONIFER', { catalog: { ...MASSIF_CATALOG,
    pieces: MASSIF_CATALOG.pieces.filter(p => p.id !== 'teton-jackson-lake:mount-moran') } }), null);
  assert.deepEqual(planDualSummitsScene('CONIFER'), planDualSummitsScene('CONIFER', { catalog: { ...MASSIF_CATALOG,
    pieces: [...MASSIF_CATALOG.pieces].reverse() } }));
});
