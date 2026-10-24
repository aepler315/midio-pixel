import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, readAuthoring } from '../tools/build-range-scene.mjs';
import { sceneViewErrors } from '../src/world/terrain/SceneCatalog.js';

const policy = { condition: 'representative-no-runoff', terrainWater: 'mapped-only' };
const reach = {
  id: 'fixture-creek', name: 'Fixture Creek', permanence: 'perennial', state: 'flowing',
  pathLonLat: [[-109.35, 38.6], [-109.36, 38.61]], widthM: 2, depthM: .1,
  dischargeM3s: .08, velocityMps: .4,
  source: { provider: 'USGS', url: 'https://hydro.nationalmap.gov/', retrievedAt: '2026-10-21',
    estimateKind: 'modeled-mean-annual', flowDirection: 'with-digitized' },
};

test('authored channel geometry and its ordinary-flow policy reach the runtime catalog', async () => {
  const doc = await readAuthoring();
  const view = doc.views.find(v => v.id === 'la-sal-castle-valley');
  view.rivers = [reach]; view.riverPolicy = policy;
  const runtime = (await buildCatalog(doc)).views.find(v => v.id === view.id);
  assert.deepEqual(runtime.rivers, [reach], 'channel data must survive generation');
  assert.deepEqual(runtime.riverPolicy, policy, 'ordinary dry conditions must survive generation');
  assert.deepEqual(sceneViewErrors(runtime), []);
});

test('a catalog view cannot silently accept invalid channel flow or an unknown water policy', async () => {
  const doc = await readAuthoring();
  const view = (await buildCatalog(doc)).views.find(v => v.id === 'la-sal-castle-valley');
  assert.ok(sceneViewErrors({ ...view, rivers: [{ ...reach, dischargeM3s: -1 }] }).length,
    'negative discharge must not reach the GPU');
  assert.ok(sceneViewErrors({ ...view, riverPolicy: { ...policy, terrainWater: 'invent-lakes' } }).length,
    'unknown mask behavior must be rejected');
});
