import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { glacierSample } from '../src/world/alpine/GlacierField.js';
import { terrainCpuBytes } from '../src/world/alpine/RangeAssets.js';
import { approvalHashes, buildCatalog, readAuthoring, RUNTIME_DIR, localCamera } from '../tools/build-range-scene.mjs';

const glacier = {
  axisStartM: [1000, 2000], axisEndM: [-1000, -2000], halfWidthM: 4000,
  surfaceStartM: 1000, surfaceEndM: 1300, maxThicknessM: 750,
};
const existing = async () => {
  const doc = await readAuthoring();
  const view = doc.views.find((v) => v.id === 'nc-ross-lake-north');
  const build = JSON.parse(await fs.readFile(path.join(RUNTIME_DIR, 'terrain', `${view.id}.build.json`)));
  return { doc, view, build };
};

// Use a real existing published fixture so these assertions exercise the
// actual catalog and on-disk approval contract without creating mock assets.
test('glacier metadata survives catalog authoring and participates in approval identity', async () => {
  const { doc, view, build } = await existing();
  view.glacier = glacier;
  view.approval = { ...view.approval, ...(await approvalHashes(view, build)) };
  const cat = await buildCatalog(doc);
  const runtime = cat.views.find((v) => v.id === view.id);
  assert.deepEqual(runtime.glacier, glacier);
  assert.equal(runtime.status, 'approved');
  const baseline = await approvalHashes(view, build);
  assert.match(baseline.glacierSha256, /^[0-9a-f]{64}$/);
  view.glacier = { ...glacier, maxThicknessM: 751 };
  const changed = await approvalHashes(view, build);
  assert.notEqual(changed.glacierSha256, baseline.glacierSha256);
  assert.equal((await buildCatalog(doc)).views.find((v) => v.id === view.id).status, 'candidate');
  delete view.glacier;
  assert.equal((await buildCatalog(doc)).views.find((v) => v.id === view.id).status, 'candidate', 'removing reviewed ice also voids approval');
});

test('optional glacier identity keeps all old metadata-free approvals valid', async () => {
  const doc = await readAuthoring();
  const cat = await buildCatalog(doc);
  for (const view of doc.views.filter((v) => v.status === 'approved' && !v.glacier)) {
    assert.equal(cat.views.find((v) => v.id === view.id)?.status, 'approved', view.id);
  }
  const { view, build } = await existing();
  assert.equal((await approvalHashes(view, build)).glacierSha256, undefined);
});

test('authoring arc offsets survive local camera conversion and camera identity', async () => {
  const rail = Object.fromEntries(['eyeStart', 'eyeEnd', 'targetStart', 'targetEnd'].map((k) => [k, { heightM: k.startsWith('eye') ? 1600 : 800 }]));
  rail.eyeArcM = [100, 50, -200];
  rail.targetArcM = [-20, 0, 30];
  const points = { eyeStart: { localM: [0, 1000] }, eyeEnd: { localM: [1000, 1000] }, targetStart: { localM: [0, -1000] }, targetEnd: { localM: [1000, -1000] } };
  const camera = localCamera({ id: 'test', rail }, points);
  assert.deepEqual(camera.eyeArcM, rail.eyeArcM);
  assert.deepEqual(camera.targetArcM, rail.targetArcM);
  const { view, build } = await existing();
  const original = await approvalHashes(view, build);
  build.view.camera.eyeArcM = rail.eyeArcM;
  assert.notEqual((await approvalHashes(view, build)).cameraSha256, original.cameraSha256);
});

test('Pend Oreille candidate has a real Newport–Cusick–Ione DEM corridor and south-to-north glacier', async () => {
  const doc = await readAuthoring();
  const view = doc.views.find((v) => v.id === 'pend-oreille-valley');
  assert.ok(view, 'new terrain pilot authored');
  assert.equal(view.status, 'candidate');
  assert.equal(view.dem.source, '3dep13');
  assert.ok(view.dem.centerLonLat[0] < -117 && view.dem.centerLonLat[0] > -118);
  assert.ok(view.dem.centerLonLat[1] > 48.1 && view.dem.centerLonLat[1] < 48.8);
  for (const town of ['Newport', 'Cusick', 'Ione']) assert.ok(view.landmarks.some((l) => l.name.includes(town)), town);
  assert.ok(view.glacier.axisStartM[1] > view.glacier.axisEndM[1], 'Z south: retreat goes north');
  assert.ok(view.glacier.surfaceEndM > view.glacier.surfaceStartM);
  assert.ok(view.glacier.maxThicknessM > 0 && view.glacier.maxThicknessM < 2000);
  for (const p of [view.glacier.axisStartM, view.glacier.axisEndM]) {
    assert.ok(Math.abs(p[0]) < view.dem.extentM[0] / 2);
    assert.ok(Math.abs(p[1]) < view.dem.extentM[1] / 2);
  }
  assert.match(view.notes, /artistic|interpretation/i);
  const cat = await buildCatalog(doc);
  assert.equal(cat.views.find((v) => v.id === view.id)?.status, 'candidate');
  assert.deepEqual(cat.views.find((v) => v.id === view.id)?.glacier, view.glacier);
});


test('published Pend Oreille pilot has pinned real elevation provenance and a bounded mobile terrain footprint', async () => {
  const doc = await readAuthoring();
  const view = doc.views.find((v) => v.id === 'pend-oreille-valley');
  const manifest = JSON.parse(await fs.readFile(path.join(RUNTIME_DIR, 'terrain', `${view.id}.terrain.json`)));
  assert.equal(manifest.grid.cellSizeM, view.dem.cellM);
  assert.ok(manifest.grid.width * manifest.grid.height <= 1600000, 'surface scratch and GPU texture fit mobile residency');
  assert.match(manifest.source.provenance.provider, /U.S. Geological Survey/);
  assert.ok(manifest.source.provenance.urls.every((u) => /^https:\/\/prd-tnm.s3.amazonaws.com\/.*\/historical\//.test(u)));
  assert.ok(manifest.source.provenance.sha256.every((s) => /^[0-9a-f]{64}$/.test(s)));
  assert.equal(manifest.source.verticalReference, 'NAVD88 orthometric height, metres (USGS 3DEP product specification)');
  const gridPx = manifest.grid.width * manifest.grid.height;
  const est = manifest.estimatedBytes.mobile;
  const terrainPeak = terrainCpuBytes(manifest) + est.meshBytes + est.surfaceTextureBytes + gridPx * 12;
  assert.ok(terrainPeak < 100 * 1048576, 'pilot terrain alone must leave space for targets, material and trees');
  assert.equal(manifest.lod.visibility.stations, 61);
  assert.ok(manifest.tiles.every((t) => t.stride === 2 && t.lod.desktop === 2 && t.lod.mobile === 2),
    'published nonlinear ice must retain shared edge samples at all qualities');
  const build = JSON.parse(await fs.readFile(path.join(RUNTIME_DIR, 'terrain', `${view.id}.build.json`)));
  for (const l of build.landmarks) assert.ok(l.demGroundM > 500 && l.demGroundM < 750, `${l.name}: actual river valley floor`);
});


test('bent Cusick valley starts buried and is exposed by northward retreat', async () => {
  const build = JSON.parse(await fs.readFile(path.join(RUNTIME_DIR, 'terrain', 'pend-oreille-valley.build.json')));
  const cusick = build.landmarks.find((l) => l.name.startsWith('Cusick'));
  const initial = glacierSample(build.view.glacier, ...cusick.localM, cusick.demGroundM, 0);
  const exposed = glacierSample(build.view.glacier, ...cusick.localM, cusick.demGroundM, .8);
  assert.ok(initial.thicknessM > 200, 'the river bend must be occupied by thick ice at the beginning');
  assert.equal(exposed.thicknessM, 0);
});
