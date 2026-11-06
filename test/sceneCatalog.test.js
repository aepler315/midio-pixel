// Range v2 Task 5: curated scene assignment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseSceneForBiome, assignSongScenes, validateSceneCatalog, forcedSceneChoice, sceneOdds, SCENIC_FAIR_SHARE,
  sceneViewEligible,
} from '../src/world/terrain/SceneCatalog.js';
import { FAIR_SHARE, HOME_BIOME_FAIR_SHARE } from '../src/world/terrain/RangeMatcher.js';
import catalogData from '../src/world/terrain/sceneCatalogData.js';

const camera = { eyeStartM: [0, 1500, 0], eyeEndM: [100, 1500, 0], targetStartM: [0, 700, -9000], targetEndM: [100, 700, -9000], fovYDeg: 35 };
const mk = (id, biome, status = 'approved', scores = {}, regionId = `${id}-region`) => ({
  id, regionId, biome, status, catalogVersion: 3, terrainManifestUrl: `terrain/${id}.terrain.json`,
  materialManifestUrl: 'materials/x.json', camera,
  characterScores: { energy: 0.5, rawness: 0.5, grandeur: 0.5, dominance: 0.5, ...scores },
  evidence: { reviewPath: 'docs/x.md', sourceHashes: [] },
});
const profile = (drive = 0.5) => ({ watch: { drive, onset: 0.3, texture: 0.4, arc: 0.45, contrast: 0.4 } });
const opts = (views, extra = {}) => ({ views, catalogVersion: 3, ...extra });

test('never selects a candidate, rejected or wrong-biome view', () => {
  const views = [mk('cand', 'RAINFOREST', 'candidate'), mk('rej', 'RAINFOREST', 'rejected'), mk('desert', 'DESERT')];
  for (let seed = 0; seed < 200; seed++) {
    const c = chooseSceneForBiome('RAINFOREST', profile(), seed, opts(views));
    assert.equal(c.view, null);
    assert.equal(c.fallbackReason, 'no-approved-view-for-biome');
  }
  assert.equal(chooseSceneForBiome('TUNDRA', profile(), 1, opts(views)).fallbackReason, 'no-view-for-biome');
});

test('one approved view is used whenever its biome is drawn, even if recent', () => {
  const views = [mk('only', 'CANYON'), mk('other', 'DESERT')];
  const c = chooseSceneForBiome('CANYON', profile(), 9, opts(views, { recentViewIds: ['only'], recentRegionIds: ['only-region'] }));
  assert.equal(c.view.id, 'only');
  assert.equal(c.fallbackReason, null);
});

test('recent views and regions sit out while an alternative exists', () => {
  const views = [mk('a', 'CONIFER'), mk('b', 'CONIFER'), mk('c', 'CONIFER', 'approved', {}, 'shared'), mk('d', 'CONIFER', 'approved', {}, 'shared')];
  for (let seed = 0; seed < 100; seed++) {
    const c = chooseSceneForBiome('CONIFER', profile(), seed, opts(views, { recentViewIds: ['a'], recentRegionIds: ['shared'] }));
    assert.equal(c.view.id, 'b');
  }
  // All recent: the pool relaxes to itself rather than going empty.
  const all = chooseSceneForBiome('CONIFER', profile(), 4, opts(views, { recentViewIds: ['a', 'b', 'c', 'd'] }));
  assert.ok(all.view);
});

test('draws are deterministic, order-independent and version-bound', () => {
  const views = [mk('x', 'TAIGA', 'approved', { energy: 0.1 }), mk('y', 'TAIGA', 'approved', { energy: 0.9 }), mk('z', 'TAIGA')];
  const a = chooseSceneForBiome('TAIGA', profile(), 1234, opts(views));
  const b = chooseSceneForBiome('TAIGA', profile(), 1234, opts([...views].reverse()));
  assert.equal(a.view.id, b.view.id);
  assert.equal(chooseSceneForBiome('TAIGA', profile(), 1234, opts(views, { catalogVersion: 4 })).view, null);
});

test('the scenic lottery is 15% equal share plus 85% character, and leans with the song', () => {
  assert.equal(SCENIC_FAIR_SHARE, 0.15);
  const views = [mk('calm', 'STEPPE', 'approved', { energy: 0.1, rawness: 0.1, grandeur: 0.1, dominance: 0.1 }),
    mk('wild', 'STEPPE', 'approved', { energy: 0.9, rawness: 0.9, grandeur: 0.9, dominance: 0.9 })];
  const odds = sceneOdds(views, { energy: 1, rawness: 1, grandeur: 1, dominance: 1 });
  assert.ok(Math.abs(odds[0] + odds[1] - 1) < 1e-12);
  assert.ok(odds[0] >= SCENIC_FAIR_SHARE / 2 - 1e-12, 'every view keeps its equal share');
  assert.ok(odds[1] > odds[0]);
  let wild = 0;
  for (let seed = 0; seed < 2000; seed++) if (chooseSceneForBiome('STEPPE', profile(0.95), seed, opts(views)).view.id === 'wild') wild++;
  assert.ok(wild > 1000, `energetic songs should lean wild: ${wild}/2000`);
  assert.ok(wild < 2000 - 100, 'the calm view still gets its share');
});

test('scenic tuning is separate from the range and home-biome draws', () => {
  assert.equal(FAIR_SHARE, 0.65);
  assert.equal(HOME_BIOME_FAIR_SHARE, 0.65);
  assert.notEqual(SCENIC_FAIR_SHARE, FAIR_SHARE);
});

test('a song assigns each biome once and later biomes avoid the same view', () => {
  const catalog = { catalogVersion: 3, views: [mk('r1', 'RAINFOREST'), mk('r2', 'RAINFOREST'), mk('d1', 'DESERT')] };
  const map = assignSongScenes(['RAINFOREST', 'DESERT', 'ICEFIELD'], profile(), 77, catalog);
  assert.ok(['r1', 'r2'].includes(map.get('RAINFOREST').view.id));
  assert.equal(map.get('DESERT').view.id, 'd1');
  assert.equal(map.get('ICEFIELD').view, null);
  assert.deepEqual([...assignSongScenes(['RAINFOREST', 'DESERT', 'ICEFIELD'], profile(), 77, catalog)].map(([k, v]) => [k, v.view?.id]),
    [...map].map(([k, v]) => [k, v.view?.id]));
});

test('catalog validation and the diagnostic override', () => {
  const good = { catalogVersion: 3, views: [mk('ok', 'DESERT', 'candidate')] };
  assert.equal(validateSceneCatalog(good).ok, true);
  const bad = { catalogVersion: 3, views: [{ ...mk('bad', 'DESERT'), camera: { ...camera, fovYDeg: 1 } }, mk('ok', 'DESERT'), mk('ok', 'DESERT')] };
  const r = validateSceneCatalog(bad);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /bad: .*fovYDeg/);
  assert.match(r.errors.join('\n'), /duplicate/);
  const forced = forcedSceneChoice(good, 'ok');
  assert.equal(forced.view.id, 'ok');
  assert.equal(forced.forcedCandidate, true);
  assert.equal(forcedSceneChoice(good, 'nope').fallbackReason, 'unknown-view:nope');
});

test('the shipped catalog validates and contains no rejected view', () => {
  const r = validateSceneCatalog(catalogData);
  assert.deepEqual(r.errors, []);
  assert.ok(catalogData.views.every((v) => v.status !== 'rejected'));
});

// Range v2 Task 15: the delivered catalog covers every biome.
const BIOMES = ['ICEFIELD', 'TUNDRA', 'TAIGA', 'RAINFOREST', 'CONIFER', 'PINE_OAK', 'BROADLEAF', 'CHAPARRAL', 'STEPPE', 'CANYON', 'DESERT'];

test('every biome has at least one approved scene in the shipped catalog', () => {
  for (const biome of BIOMES) {
    assert.ok(catalogData.views.some((v) => v.biome === biome && v.status === 'approved'), `${biome} has no approved view`);
  }
  assert.ok(catalogData.views.length >= BIOMES.length, `${catalogData.views.length} views`);
});

test('a thirty-view pool remains valid, deterministic and excludes candidates', () => {
  const views = Array.from({ length: 30 }, (_, i) => mk(`location-${i}`, 'CANYON'));
  views.push(mk('unreviewed', 'CANYON', 'candidate'));
  const catalog = { catalogVersion: 3, views };
  assert.equal(validateSceneCatalog(catalog).ok, true);
  for (let seed = 0; seed < 40; seed++) {
    const pick = chooseSceneForBiome('CANYON', profile(), seed, opts(views));
    assert.equal(pick.view.status, 'approved');
    assert.equal(pick.view.id, chooseSceneForBiome('CANYON', profile(), seed, opts(views)).view.id);
  }
});

test("each shipped view wears a material pack made for its own biome", async () => {
  const fs = await import('node:fs/promises');
  const { REAL_BIOMES } = await import('../src/world/RealBiomes.js');
  const names = new Set(REAL_BIOMES.map((b) => b.name));
  for (const v of catalogData.views) {
    assert.ok(names.has(v.biome), `${v.id}: unknown biome ${v.biome}`);
    const pack = JSON.parse(await fs.readFile(new URL(`../src/assets/range/v2/${v.materialManifestUrl}`, import.meta.url), 'utf8'));
    assert.ok(pack.biomes.includes(v.biome), `${v.id}: pack ${pack.id} is not for ${v.biome}`);
  }
});

test('a song through every biome gets each biome its own view, deterministically', () => {
  for (const seed of [1, 42, 9001]) {
    const map = assignSongScenes(BIOMES, profile(), seed, catalogData);
    const again = assignSongScenes(BIOMES, profile(), seed, catalogData);
    for (const biome of BIOMES) {
      const v = map.get(biome).view;
      assert.ok(v, `${biome}: no view`);
      assert.equal(v.biome, biome);
      assert.equal(sceneViewEligible(v), true);
      assert.equal(again.get(biome).view.id, v.id, `${biome}: assignment is not deterministic`);
    }
  }
});

test('without an approved view a biome falls back to legacy scenery explicitly', () => {
  const pruned = { ...catalogData, views: catalogData.views.filter((v) => v.biome !== 'DESERT') };
  const c = chooseSceneForBiome('DESERT', profile(), 5, pruned);
  assert.equal(c.view, null);
  assert.ok(c.fallbackReason);
});

test('a tour candidate uses its verified package identity instead of a legacy rail', () => {
  const view = { ...mk('tour', 'CONIFER', 'candidate'), tourManifestUrl: 'tour/tour.tour.json', tourManifestSha256: 'a'.repeat(64) };
  delete view.camera;
  const catalog = { catalogVersion: 3, views: [view] };
  assert.equal(forcedSceneChoice(catalog, 'tour').view?.id, 'tour');
  assert.equal(chooseSceneForBiome('CONIFER', profile(), 1, opts([view])).view, null);
  const bad = { ...view, tourManifestSha256: '' };
  assert.equal(forcedSceneChoice({ ...catalog, views: [bad] }, 'tour').view, null);
});

test('nearly equal scenery stays nearly equal while substantial relief contrasts retain musical preference', () => {
  const target = { energy: .5, rawness: .5, grandeur: 1, dominance: .5 };
  const pool = gap => [mk('low', 'BROADLEAF', 'approved', { grandeur: .066 }), mk('high', 'BROADLEAF', 'approved', { grandeur: .066 + gap })];
  const tiny = sceneOdds(pool(.003), target), noise = sceneOdds(pool(1e-9), target), broad = sceneOdds(pool(.339), target);
  assert.ok(tiny[1] < .55 && tiny[1] > .5, `small measured difference: ${tiny[1]}`);
  assert.ok(Math.abs(noise[1] - .5) < 1e-6);
  assert.ok(broad[1] > .85, `substantial difference: ${broad[1]}`);
  for (const odds of [tiny, noise, broad]) {
    assert.ok(Math.abs(odds.reduce((a, b) => a + b) - 1) < 1e-12);
    assert.ok(odds.every(p => Number.isFinite(p) && p >= .075));
  }
});

test('each biome keeps its own song ticket when candidate order changes', () => {
  for (let seed = 0; seed < 40; seed++) {
    const a = assignSongScenes(['ICEFIELD', 'STEPPE', 'CONIFER'], profile(.7), seed, catalogData);
    const b = assignSongScenes(['CONIFER', 'ICEFIELD', 'STEPPE'], profile(.7), seed, catalogData);
    for (const biome of a.keys()) assert.equal(a.get(biome).view.id, b.get(biome).view.id, `${biome} seed ${seed}`);
  }
});

test('explicit recent-view filtering retains character coordinates from the full biome pool', async () => {
  const { songTerrainTarget } = await import('../src/world/terrain/RangeMatcher.js');
  const p = profile(.9), target = songTerrainTarget(p);
  const views = [mk('low', 'CONIFER', 'approved', { energy: .1 }), mk('mid', 'CONIFER', 'approved', { energy: .5 }), mk('high', 'CONIFER', 'approved', { energy: .9 })];
  const candidates = views.slice(0, 2);
  // Only energy differs; equal-axis coordinates are .5. Preserve the full
  // pool's energy coordinates 0 and .5 after excluding its high endpoint.
  const kernel = [0, .5].map(energy => Math.exp(-(((target.energy - energy) ** 2
    + ['rawness', 'grandeur', 'dominance'].reduce((sum, axis) => sum + (target[axis] - .5) ** 2, 0)) / .16)));
  const expected = kernel.map(k => .075 + .85 * k / (kernel[0] + kernel[1]));
  for (let seed = 0; seed < 20; seed++) {
    const c = chooseSceneForBiome('CONIFER', p, seed, opts(views, { recentViewIds: ['high'] }));
    assert.ok(Math.abs(c.odds - expected[candidates.findIndex(v => v.id === c.view.id)]) < 1e-12);
  }
});

test('normal biome tickets stay independent when geographic regions span multiple biomes', () => {
  const views = ['ICEFIELD', 'CONIFER'].flatMap(biome => [
    mk(`${biome}-a`, biome, 'approved', {}, 'shared-region'),
    mk(`${biome}-b`, biome, 'approved', {}, `${biome}-other-region`),
  ]);
  const catalog = { catalogVersion: 3, views };
  let varietyObserved = false;
  for (let seed = 0; seed < 80; seed++) {
    const a = assignSongScenes(['ICEFIELD', 'CONIFER'], profile(), seed, catalog);
    const b = assignSongScenes(['CONIFER', 'ICEFIELD'], profile(), seed, catalog);
    for (const biome of a.keys()) assert.equal(a.get(biome).view.id, b.get(biome).view.id);
    const deliberate = assignSongScenes(['ICEFIELD', 'CONIFER'], profile(), seed, catalog, { recentViewIds: [] });
    if (a.get('ICEFIELD').view.regionId === 'shared-region' && a.get('CONIFER').view.regionId === 'shared-region') {
      assert.notEqual(deliberate.get('CONIFER').view.regionId, 'shared-region'); varietyObserved = true;
    }
  }
  assert.equal(varietyObserved, true);
});
