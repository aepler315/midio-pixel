import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAuthoring, buildCatalog } from '../tools/build-range-scene.mjs';
import { chooseSceneForBiome, validateSceneCatalog } from '../src/world/terrain/SceneCatalog.js';
import { shotTourEligible } from '../src/world/alpine/RangeShotTours.js';
import { RangePresentation } from '../src/world/alpine/RangePresentation.js';
import * as exposure from '../tools/lib/range-exposure.mjs';
import catalog from '../src/world/terrain/sceneCatalogData.js';

const additions = new Map([
  ['sawtooth-redfish-north', 'CONIFER'],
  ['shenandoah-stony-man-west', 'BROADLEAF'],
  ['superstition-west-front', 'DESERT'],
]);

test('only the three new regions join normal selection while retaining their candidate identities', () => {
  const enabled = catalog.views.filter(v => v.experimental === true);
  assert.deepEqual(enabled.map(v => v.id).sort(), [...additions.keys()].sort());
  assert.equal(catalog.views.filter(v => v.status === 'approved').length, 13);
  for (const view of enabled) {
    assert.equal(view.status, 'candidate');
    assert.equal(view.evidence.approval, null);
    assert.equal(view.evidence.reviewPath, 'docs/scenic-expansion-2026-11-05.md');
    assert.equal(view.shotTour.status, 'candidate');
    assert.equal(view.shotTour.approval, null);
    assert.equal(shotTourEligible(view), true, 'pinned new-region tours work without a diagnostic URL');
    const recent = catalog.views.filter(v => v.status === 'approved' && v.biome === view.biome).map(v => v.id);
    const selected = chooseSceneForBiome(view.biome, {}, 7, { views: catalog.views, recentViewIds: recent });
    assert.equal(selected.view.id, view.id);
  }
  for (const view of catalog.views.filter(v => v.status === 'candidate' && !additions.has(v.id))) {
    assert.equal(chooseSceneForBiome(view.biome, {}, 7, { views: [view] }).view, null, view.id);
    assert.equal(shotTourEligible(view), false, view.id);
  }
});

test('each expanded regional pool is deterministic and draws both distinct regions normally', () => {
  for (const [id, biome] of additions) {
    const seen = new Set();
    for (let seed = 0; seed < 256; seed++) {
      const a = chooseSceneForBiome(biome, {}, seed, { views: catalog.views });
      const b = chooseSceneForBiome(biome, {}, seed, { views: [...catalog.views].reverse() });
      assert.equal(a.view.id, b.view.id);
      seen.add(a.view.regionId);
    }
    assert.ok(seen.has(catalog.views.find(v => v.id === id).regionId));
    assert.equal(seen.size, 2, biome);
  }
});

test('experimental tour selection still rejects every changed package identity and rejected status', () => {
  const original = catalog.views.find(v => additions.has(v.id));
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
  doc.views = doc.views.filter(v => additions.has(v.id));
  for (const view of doc.views) view.experimental = true;
  const built = await buildCatalog(doc);
  assert.equal(built.views.length, 3);
  for (const view of built.views) {
    assert.equal(view.experimental, true);
    assert.equal(view.status, 'candidate');
    assert.equal(view.evidence.approval, null);
    assert.equal(view.shotTour.approval, null);
  }
});

test('new regions use the ordinary scheduled rail when Auto keeps their fallback rail', () => {
  const state = Object.freeze({ policy: 'rail', progress01: .4, effectiveMultiplier: 3 });
  const presentation = Object.assign(Object.create(RangePresentation.prototype), {
    railPlan: { railStateAt: () => state, snapshot: { durationMs: 60000 } },
    frameInputs: { sim: { biomes: {} } }, scene: { prepared: new Map() }, shots: { timeline: () => null },
  });
  for (const id of additions.keys()) {
    const view = { ...catalog.views.find(v => v.id === id), experimental: true };
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
