import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sceneViewEligible } from '../src/world/terrain/SceneCatalog.js';
import scenes from '../src/world/terrain/sceneCatalogData.js';
import massifs from '../src/world/terrain/massifCatalogData.js';
import { assembleStage } from '../src/world/alpine/StageAssembly.js';
import { decodeTerrain, terrainHeightAt } from '../src/world/alpine/TerrainMesh.js';
import { measuredViewOutline, songprintReliefScale } from '../src/world/terrain/SongprintTerrain.js';
import { planSongScenes } from '../src/world/terrain/SongScenePlan.js';
import { BIOME_FAMILY, planSongRange, songRangeKey } from '../src/world/terrain/SongRangePlan.js';
import { prepareSongTerrain } from '../src/world/terrain/RangeLibrary.js';

const profile = { watch: { drive: .6, onset: .3, texture: .4, arc: .5, contrast: .5 } };
const viewFor = id => scenes.views.find(view => view.id === id);
const printFor = view => ({ version: 1, skyline: measuredViewOutline(view).map(h => h / 255), passages: [] });
const home = plan => plan.sceneByBiome.get(plan.home).view;
const perturbed = print => ({ ...print, skyline: print.skyline.map((h, i) => .001 * Math.sin(i) + .002 + .996 * h) });
const ross = viewFor('nc-ross-lake-north');

test('each eligible surveyed rail wins its own measured shape, even with a different seed or a close performance', () => {
  for (const view of scenes.views.filter(sceneViewEligible)) {
    const songprint = printFor(view);
    const plan = planSongScenes(profile, 901, { songprint });
    assert.equal(home(plan).id, view.id);
    assert.deepEqual(plan.biomes, [view.biome]);
    assert.equal(home(planSongScenes(null, 187, { songprint: perturbed(songprint) })).id, view.id);
  }
});

test('rejected, unmeasured or camera-revised views cannot be picked by an obsolete outline', () => {
  const songprint = printFor(ross);
  for (const change of [{ status: 'rejected' }, { terrainManifestSha256: '1'.repeat(64) },
    { camera: { ...ross.camera, fovYDeg: ross.camera.fovYDeg + 5 } }]) {
    const catalog = { ...scenes, views: scenes.views.map(v => v === ross ? { ...v, ...change } : v) };
    assert.notEqual(home(planSongScenes(null, 12, { catalog, songprint })).id, ross.id);
  }
});

test('missing, flat, malformed and unsupported prints preserve the original lottery and saved geometry keys', () => {
  const baseline = planSongScenes(profile, 413);
  const range = planSongRange(profile, 413);
  for (const songprint of [null, {}, { version: 1, skyline: [1, 2] }, { version: 1, skyline: Array(16).fill(.2) },
    { version: 2, skyline: printFor(ross).skyline }, { version: 1, skyline: [...Array(15).fill(.2), NaN] }]) {
    assert.deepEqual(planSongScenes(profile, 413, { songprint }), baseline);
    assert.deepEqual(planSongRange(profile, 413, { songprint }), range);
  }
});

test('a composition chooses distinct, fitting real pieces and preserves their identity across replays', () => {
  const byId = new Map(massifs.pieces.map(p => [p.id, p]));
  for (const view of scenes.views.filter(sceneViewEligible)) {
    const songprint = printFor(view);
    const range = planSongRange(profile, 935, { songprint });
    assert.ok(range, view.id);
    assert.equal(range.family, BIOME_FAMILY[view.biome]);
    assert.ok(!Object.hasOwn(range, 'songSeed'));
    assert.equal(songRangeKey(planSongRange(null, 27, { songprint })), songRangeKey(range));
    const template = massifs.templates.find(t => t.id === range.templateId);
    assert.equal(new Set(range.slots.map(s => s.pieceId)).size, template.slots.length);
    for (const placement of range.slots) {
      const piece = byId.get(placement.pieceId);
      const slot = template.slots.find(s => s.id === placement.slotId);
      assert.equal(piece.family, range.family);
      assert.ok(piece.tiles[0] <= slot.tiles[2] && piece.tiles[1] <= slot.tiles[3]);
      assert.ok(piece.peakReliefM >= slot.reliefM[0] && (slot.reliefM[1] == null || piece.peakReliefM <= slot.reliefM[1]));
    }
  }
  const collapsed = { ...massifs, pieces: [] };
  assert.equal(planSongRange(null, 1, { catalog: collapsed, songprint: printFor(ross) }), null);
});

test('musical height across each footprint continuously varies the relief even with identical discrete pieces', () => {
  const songprint = printFor(ross);
  const quieter = { ...songprint, skyline: songprint.skyline.map(h => .9 * h + .05) };
  const first = planSongRange(profile, 0, { songprint });
  const second = planSongRange(profile, 0, { songprint: quieter });
  assert.equal(first.templateId, second.templateId);
  assert.deepEqual(first.slots.map(s => [s.pieceId, s.mirrored]), second.slots.map(s => [s.pieceId, s.mirrored]));
  assert.notEqual(songRangeKey(first), songRangeKey(second));
  assert.notDeepEqual(first.slots.map(s => s.reliefScale), second.slots.map(s => s.reliefScale));
  for (let i = 0; i < first.slots.length; i++) {
    const scale = first.slots[i].reliefScale;
    assert.ok(scale >= .92 && scale <= 1.08);
    assert.ok(Math.abs(scale - second.slots[i].reliefScale) <= .0081);
  }
  assert.equal(songprintReliefScale(Array(16).fill(0), 0, 1), .92);
  assert.equal(songprintReliefScale(Array(16).fill(1), 0, 1), 1.08);
});

test('rendered summit, landmark height and composition provenance share the per-slot relief', () => {
  const id = 'one-piece', slotId = 'B1';
  const template = { ...massifs.templates[0], grid: { width: 65, height: 65, originM: [0, 0], cellSizeM: 20 },
    slots: [{ id: slotId, tiles: [0, 0, 1, 1] }] };
  const catalog = { templates: [template], pieces: [{ id, name: 'Test summit' }] };
  const relief = new Float32Array(65 * 65);
  relief[32 * 65 + 32] = 500;
  const block = { width: 65, height: 65, tiles: [1, 1], relief, flow: new Uint8Array(65 * 65) };
  for (const reliefScale of [.92, 1.08]) {
    const plan = { version: 3, songprintVersion: 1, templateId: template.id, slots: [{ slotId, pieceId: id, reliefScale }] };
    const stage = assembleStage(plan, new Map([[id, block]]), { catalog, forceStride: 1 });
    const { manifest } = stage;
    const terrain = decodeTerrain(manifest, stage.decoded);
    const summit = manifest.landmarks[0], provenance = manifest.source.provenance.composition;
    assert.equal(provenance.pieces[0].reliefScale, reliefScale);
    assert.equal(provenance.key, songRangeKey(plan));
    assert.equal(stage.placed[0].peakReliefM, 500 * reliefScale);
    assert.ok(Math.abs(terrainHeightAt(terrain, ...summit.localM) - summit.demGroundM) < manifest.quantization.stepM);
    assert.ok(Math.abs(terrainHeightAt(terrain, 0, 0) - template.lakeLevelM) < manifest.quantization.stepM);
  }
});

test('playback carries the admitted print on both geographic paths and respects an explicit scene override', async () => {
  const songprint = printFor(ross);
  const read = async url => new Response(await readFile(new URL(url)));
  const catalog = await prepareSongTerrain(profile, 7, [], { songprint, search: '?songRange=0' });
  const replay = await prepareSongTerrain(null, 251, [catalog.ranges.far.id], { songprint, search: '?songRange=0' });
  assert.deepEqual(catalog.biomes, [ross.biome]);
  assert.equal(catalog.songprint, songprint);
  assert.equal(home(catalog).id, ross.id);
  assert.deepEqual(replay.ranges, catalog.ranges);
  assert.equal(replay.horizon.range.id, catalog.horizon.range.id);
  const composed = await prepareSongTerrain(profile, 7, [], { songprint, search: '?songRange=1', songRangeWaitMs: Infinity, fetchImpl: read });
  assert.equal(composed.songprint, songprint);
  assert.equal(home(composed).songRange.plan.principal.pieceId, planSongRange(profile, 7, { songprint }).principal.pieceId);
  assert.equal(composed.sceneByBiome.get(composed.home).fallback.view.id, ross.id);
  const landmarks = home(composed).songprintLandmarks;
  assert.equal(composed.songRange.stage.songprintLandmarks, landmarks);
  assert.ok(landmarks.length > 0 && landmarks.length <= composed.songRange.stage.slots.length);
  for (const mark of landmarks) {
    assert.ok(composed.songRange.stage.slots.some(slot => slot.slotId === mark.slotId));
    assert.ok(mark.pointM.length === 3 && mark.pointM.every(Number.isFinite));
  }
  for (const options of [{ search: '?songRange=0' }, { songprint, search: '?songRange=0&rangeView=teton-jackson-lake' }]) {
    const ordinary = await prepareSongTerrain(profile, 7, [], options);
    assert.equal(ordinary.songprint, undefined);
    assert.deepEqual(ordinary.biomes, planSongScenes(profile, 7).biomes);
  }
});
