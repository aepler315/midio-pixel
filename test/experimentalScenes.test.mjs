import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAuthoring, buildCatalog } from '../tools/build-range-scene.mjs';
import { chooseSceneForBiome, sceneViewEligible, validateSceneCatalog } from '../src/world/terrain/SceneCatalog.js';
import { shotTourEligible } from '../src/world/alpine/RangeShotTours.js';
import { RangePresentation } from '../src/world/alpine/RangePresentation.js';
import * as exposure from '../tools/lib/range-exposure.mjs';
import catalog from '../src/world/terrain/sceneCatalogData.js';

const shotExperiments = new Map([
  ['sawtooth-redfish-north', { biome: 'CONIFER', regionId: 'sawtooth' }],
  ['shenandoah-stony-man-west', { biome: 'BROADLEAF', regionId: 'shenandoah' }],
  ['superstition-west-front', { biome: 'DESERT', regionId: 'superstition' }],
]);
const railAdditions = new Map([
  ['sierra-whitney-east', { biome: 'STEPPE', regionId: 'sierra-nevada' }],
  ['san-juan-sneffels-north', { biome: 'CONIFER', regionId: 'san-juan-mountains' }],
  ['crater-lake-watchman-east', { biome: 'CONIFER', regionId: 'crater-lake' }],
  ['badlands-pinnacles-south', { biome: 'STEPPE', regionId: 'badlands' }],
]);
const experiments = new Map([...shotExperiments, ...railAdditions]);

test('the seven regional experiments join normal selection without inventing base or tour approvals', () => {
  const enabled = catalog.views.filter(v => v.experimental === true);
  assert.deepEqual(enabled.map(v => v.id).sort(), [...experiments.keys()].sort());
  assert.equal(catalog.views.filter(v => v.status === 'approved').length, 13);
  for (const view of enabled) {
    const expected = experiments.get(view.id);
    assert.equal(view.biome, expected.biome);
    assert.equal(view.regionId, expected.regionId);
    assert.equal(view.status, 'candidate');
    assert.equal(view.evidence.approval, null);
    assert.match(view.evidence.reviewPath, /^docs\/.+\.md$/);
    if (shotExperiments.has(view.id)) {
      assert.equal(view.evidence.reviewPath, 'docs/scenic-expansion-2026-11-05.md');
      assert.equal(view.shotTour.status, 'candidate');
      assert.equal(view.shotTour.approval, null);
      assert.equal(shotTourEligible(view), true, 'existing pinned experimental tours remain eligible');
    } else {
      assert.equal(view.shotsManifestUrl, undefined, 'new geography uses its authored rail');
      assert.equal(view.shotsManifestSha256, undefined);
      assert.equal(view.shotTour, undefined, 'an absent library has no fabricated tour status');
      assert.equal(view.tourManifestUrl, undefined);
      assert.equal(shotTourEligible(view), false);
    }
    const recent = catalog.views.filter(v => sceneViewEligible(v) && v.biome === view.biome && v.id !== view.id).map(v => v.id);
    const selected = chooseSceneForBiome(view.biome, {}, 7, { views: catalog.views, recentViewIds: recent });
    assert.equal(selected.view.id, view.id);
  }
  assert.deepEqual(enabled.filter(v => shotTourEligible(v)).map(v => v.id).sort(), [...shotExperiments.keys()].sort());
  for (const view of catalog.views.filter(v => v.status === 'candidate' && !experiments.has(v.id))) {
    assert.equal(chooseSceneForBiome(view.biome, {}, 7, { views: [view] }).view, null, view.id);
    assert.equal(shotTourEligible(view), false, view.id);
  }
});

test('expanded pools draw every distinct region deterministically, including the new Sierra and San Juan rails', () => {
  for (const [biome, size] of new Map([['CONIFER', 4], ['STEPPE', 3], ['BROADLEAF', 2], ['DESERT', 2]])) {
    const pool = catalog.views.filter(v => v.biome === biome && sceneViewEligible(v));
    assert.equal(pool.length, size, `${biome} eligibility`);
    const regions = new Set(pool.map(v => v.regionId));
    const seen = new Set();
    for (let seed = 0; seed < 256; seed++) {
      const a = chooseSceneForBiome(biome, {}, seed, { views: catalog.views });
      const b = chooseSceneForBiome(biome, {}, seed, { views: [...catalog.views].reverse() });
      assert.equal(a.view.id, b.view.id);
      seen.add(a.view.regionId);
    }
    assert.deepEqual([...seen].sort(), [...regions].sort(), `${biome} regional reach`);
  }
});

test('recent Sierra and San Juan regions sit out while an existing regional alternative remains', () => {
  for (const [id, expected] of railAdditions) {
    const view = catalog.views.find(v => v.id === id);
    assert.ok(view, `${id} is shipped`);
    for (let seed = 0; seed < 64; seed++) {
      const choice = chooseSceneForBiome(expected.biome, {}, seed,
        { views: catalog.views, recentViewIds: [id], recentRegionIds: [expected.regionId] });
      assert.notEqual(choice.view.id, id);
      assert.notEqual(choice.view.regionId, expected.regionId);
    }
  }
});

test('experimental tour selection still rejects every changed package identity and rejected status', () => {
  const original = catalog.views.find(v => shotExperiments.has(v.id));
  const enabled = { ...original, experimental: true };
  assert.equal(shotTourEligible(enabled), true);
  for (const key of ['shotsManifestSha256', 'terrainManifestSha256', 'baseViewSha256']) {
    assert.equal(shotTourEligible({ ...enabled, [key]: '0'.repeat(64) }), false, key);
  }
  assert.equal(shotTourEligible({ ...enabled, status: 'rejected' }), false);
  assert.equal(shotTourEligible({ ...enabled, shotTour: { ...enabled.shotTour, status: 'rejected' } }), false);
  assert.equal(shotTourEligible({ ...enabled, experimental: 'true' }), false);
  const broken = { ...enabled, experimental: 'true' };
  assert.equal(validateSceneCatalog({ catalogVersion: catalog.catalogVersion, views: [broken] }).ok, false);
});

test('catalog generation carries explicit experimental selection without inventing review approval', async () => {
  const doc = await readAuthoring();
  doc.views = doc.views.filter(v => experiments.has(v.id));
  for (const view of doc.views) view.experimental = true;
  const built = await buildCatalog(doc);
  assert.deepEqual(built.views.map(v => v.id).sort(), [...experiments.keys()].sort());
  for (const view of built.views) {
    assert.equal(view.experimental, true);
    assert.equal(view.status, 'candidate');
    assert.equal(view.evidence.approval, null);
    if (shotExperiments.has(view.id)) assert.equal(view.shotTour.approval, null);
    else assert.equal(view.shotTour, undefined);
  }
});

test('new regions use the ordinary scheduled rail when Auto keeps their fallback rail', () => {
  const state = Object.freeze({ policy: 'rail', progress01: .4, effectiveMultiplier: 3 });
  const presentation = Object.assign(Object.create(RangePresentation.prototype), {
    railPlan: { railStateAt: () => state, snapshot: { durationMs: 60000 } },
    frameInputs: { sim: { biomes: {} } }, scene: { prepared: new Map() }, shots: { timeline: () => null },
  });
  for (const id of experiments.keys()) {
    const original = catalog.views.find(v => v.id === id);
    assert.ok(original, `${id} is shipped`);
    const view = { ...original, experimental: true };
    assert.equal(presentation._railState({ view, occurrence: { id } }, { timeMs: 1000, progress01: .2 }), state);
  }
});

test('brief seam occlusion is review information while missing far-crest coverage remains an error', () => {
  const covered = exposure.travelExposureReview?.({ min: .393, minCrest: 1 });
  assert.deepEqual(covered?.errors, []);
  assert.equal(covered.warnings.length, 1);
  const missing = exposure.travelExposureReview({ min: .9, minCrest: .25 });
  assert.equal(missing.errors.length, 1);
  assert.deepEqual(exposure.travelExposureReview({ min: .75, minCrest: 1 }), { errors: [], warnings: [] });
});
