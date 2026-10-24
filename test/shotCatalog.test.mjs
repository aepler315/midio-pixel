import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as authoring from '../tools/build-range-scene.mjs';
import { sceneViewErrors, chooseSceneForBiome } from '../src/world/terrain/SceneCatalog.js';
import { RangeShotTours, shotTourEligible } from '../src/world/alpine/RangeShotTours.js';
import { loadShotLibrary, packShotPaths } from '../src/world/terrain/ShotLibrary.js';
import { samplePath } from '../src/world/terrain/ShotPath.js';
import catalog from '../src/world/terrain/sceneCatalogData.js';

const sha = (x) => createHash('sha256').update(x).digest('hex');
const evidence = ['docs/scenic-tours.md'];
async function fixture(t, { alias = false } = {}) {
  const all = await authoring.readAuthoring();
  const view = structuredClone(all.views.find((v) => v.id === 'nc-ross-lake-north'));
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shot-approval-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  for (const dir of ['terrain', 'materials', 'tour']) await fs.mkdir(path.join(runtimeDir, dir));
  for (const file of [`terrain/${view.id}.terrain.json`, `terrain/${view.id}.build.json`, `materials/${view.materialPack || 'wet-conifer'}.json`]) {
    await fs.copyFile(path.join(authoring.RUNTIME_DIR, file), path.join(runtimeDir, file));
  }
  const build = JSON.parse(await fs.readFile(path.join(runtimeDir, `terrain/${view.id}.build.json`)));
  const terrainSha = sha(await fs.readFile(path.join(runtimeDir, `terrain/${view.id}.terrain.json`)));
  if (alias) {
    view.terrainSourceId = view.id;
    view.id = `${view.id}-alias`;
  }
  const cameraPath = samplePath({ eyes: [[0, 500, 0], [1000, 500, 0]], aims: [[0, 400, -5000], [1000, 400, -5000]], fovs: 30 });
  const shot = { id: 's', subjectId: 'peak', move: 'traverse', path: cameraPath, lengthM: 1000, payoffS: 500, holdS: [250, 750],
    durationMs: { min: 4000, ideal: 10000, max: 20000 }, traits: { headingDeg: 90, aglM: 200, lens: 'normal' }, score: { total: .7 } };
  const decoded = Buffer.from(packShotPaths([shot]));
  const payload = zlib.gzipSync(decoded);
  const record = { ...shot }; delete record.path;
  const manifest = { schema: 'midio.shots', version: 1, viewId: view.id, terrainManifestSha256: terrainSha,
    axes: { x: 'east', y: 'up', z: 'south', units: 'metres' }, subjects: [{ id: 'peak', kind: 'peak', posM: [0, 400, -5000], radiusM: 500 }],
    shots: [record], links: [], payload: { url: `${view.id}.shots.bin.gz`, byteLength: payload.length, sha256: sha(payload), decodedByteLength: decoded.length, decodedSha256: sha(decoded) } };
  view.shotsManifestUrl = `tour/${view.id}.shots.json`;
  await fs.writeFile(path.join(runtimeDir, view.shotsManifestUrl), JSON.stringify(manifest));
  await fs.writeFile(path.join(runtimeDir, 'tour', manifest.payload.url), payload);
  const doc = { catalogVersion: all.catalogVersion, views: [view] };
  const tours = { regions: { [view.id]: { status: 'candidate' } } };
  const options = { tours, runtimeDir };
  const current = async () => (await authoring.buildCatalog(doc, options)).views[0];
  return { view, build, doc, tours, runtimeDir, current, options, manifest };
}

test('an alias library publishes and approves under its own view identity while binding shared terrain', async (t) => {
  const f = await fixture(t, { alias: true });
  f.tours.regions[f.view.id].library = await authoring.shotLibraryIdentity(f.view, f.build, f.options);
  await authoring.approveShotTour(f.doc, f.tours, f.view.id, { evidence, runtimeDir: f.runtimeDir });
  const runtime = await f.current();
  assert.equal(runtime.id, 'nc-ross-lake-north-alias');
  assert.equal(runtime.terrainSourceId, 'nc-ross-lake-north');
  assert.equal(runtime.terrainManifestUrl, 'terrain/nc-ross-lake-north.terrain.json');
  assert.equal(runtime.shotsManifestUrl, 'tour/nc-ross-lake-north-alias.shots.json');
  assert.equal(runtime.shotTour.identity.terrainManifestSha256, f.manifest.terrainManifestSha256);
  assert.equal(runtime.shotTour.approval.terrainManifestSha256, f.manifest.terrainManifestSha256);
  assert.equal(runtime.shotTour.status, 'approved');
  assert.equal(shotTourEligible(runtime), true);
});

test('runtime loads a real alias library using its view identity and the shared terrain hash', async (t) => {
  const f = await fixture(t, { alias: true });
  const runtime = await f.current();
  const playback = new RangeShotTours({ assetBase: pathToFileURL(`${f.runtimeDir}/`).href,
    load: (url, options) => loadShotLibrary(url, { ...options,
      fetchImpl: async (file) => new Response(await fs.readFile(fileURLToPath(file))) }) });
  const entry = await playback._library(runtime);
  assert.equal(entry.state, 'ready', entry.reason);
  assert.equal(entry.library.viewId, 'nc-ross-lake-north-alias');
  assert.equal(entry.library.terrainManifestSha256, runtime.terrainManifestSha256);
  assert.equal(entry.library.shots.length, 1);
});

test('attaching, replacing and removing a candidate library preserves the approved base rail', async (t) => {
  const f = await fixture(t);
  const approval = structuredClone(f.view.approval);
  let runtime = await f.current();
  assert.equal(runtime.status, 'approved', 'candidate shots cannot remove approved biome coverage');
  assert.equal(runtime.shotTour.status, 'candidate');
  assert.equal(shotTourEligible(runtime), false);
  assert.deepEqual(sceneViewErrors(runtime), []);
  assert.equal(chooseSceneForBiome(runtime.biome, {}, 7, { views: [runtime] }).view.id, f.view.id);
  f.view.approval.shotsManifestSha256 = '0'.repeat(64); // legacy combined approval is ignored
  const file = path.join(f.runtimeDir, f.view.shotsManifestUrl);
  await fs.appendFile(file, '\n');
  assert.equal((await f.current()).status, 'approved');
  assert.equal((await authoring.approvalHashes(f.view, f.build, f.options)).shotsManifestSha256, undefined);
  delete f.view.shotsManifestUrl;
  runtime = await f.current();
  assert.equal(runtime.status, 'approved');
  assert.equal(runtime.shotTour, undefined);
  delete f.view.approval.shotsManifestSha256;
  assert.deepEqual(f.view.approval, approval);
});

test('tour approval is an explicit evidence-backed promotion separate from base approval', async (t) => {
  const f = await fixture(t);
  const baseApproval = structuredClone(f.view.approval);
  await authoring.approveShotTour(f.doc, f.tours, f.view.id, { evidence, runtimeDir: f.runtimeDir });
  const runtime = await f.current();
  assert.equal(runtime.status, 'approved');
  assert.equal(runtime.shotTour.status, 'approved');
  assert.equal(shotTourEligible(runtime), true);
  assert.deepEqual(f.view.approval, baseApproval);
  assert.deepEqual(f.tours.regions[f.view.id].approval.evidence, evidence);
  assert.equal(f.tours.regions[f.view.id].approval.shotsManifestSha256, sha(await fs.readFile(path.join(f.runtimeDir, f.view.shotsManifestUrl))));
  assert.equal(f.tours.regions[f.view.id].approval.terrainManifestSha256, f.manifest.terrainManifestSha256);
  assert.match(f.tours.regions[f.view.id].approval.baseViewSha256, /^[a-f0-9]{64}$/);
  f.tours.regions[f.view.id].status = 'candidate';
  const candidate = await f.current();
  assert.equal(candidate.status, 'approved');
  assert.equal(shotTourEligible(candidate), false, 'regional candidate status overrides a matching prior approval');
  assert.equal(shotTourEligible(candidate, { allowCandidates: true }), true);
});

test('tour approval rejects missing evidence, an unapproved base and damaged payload bytes', async (t) => {
  const f = await fixture(t);
  await assert.rejects(authoring.approveShotTour(f.doc, f.tours, f.view.id, { runtimeDir: f.runtimeDir }), /evidence/);
  await assert.rejects(authoring.approveShotTour(f.doc, f.tours, f.view.id, { evidence: ['missing-review-file'], runtimeDir: f.runtimeDir }), /does not exist/);
  f.view.status = 'candidate';
  await assert.rejects(authoring.approveShotTour(f.doc, f.tours, f.view.id, { evidence, runtimeDir: f.runtimeDir }), /approved base/);
  f.view.status = 'approved';
  await fs.appendFile(path.join(f.runtimeDir, 'tour', f.manifest.payload.url), 'damage');
  await assert.rejects(authoring.approveShotTour(f.doc, f.tours, f.view.id, { evidence, runtimeDir: f.runtimeDir }), /payload.*hash|decoded|gunzip/);
  assert.equal(f.tours.regions[f.view.id].status, 'candidate');
  assert.equal(f.tours.regions[f.view.id].approval, undefined);
});

test('local tour approval verifies the exact compressed payload bytes even when decoded bytes are valid', async (t) => {
  const f = await fixture(t);
  const payloadFile = path.join(f.runtimeDir, 'tour', f.manifest.payload.url);
  const decoded = zlib.gunzipSync(await fs.readFile(payloadFile));
  await fs.writeFile(payloadFile, decoded);
  await assert.rejects(authoring.approveShotTour(f.doc, f.tours, f.view.id, { evidence, runtimeDir: f.runtimeDir }), /payload.*hash/);
});

test('a published candidate identity enables diagnostics without granting approval', async (t) => {
  const f = await fixture(t);
  f.tours.regions[f.view.id].library = await authoring.shotLibraryIdentity(f.view, f.build, f.options);
  const runtime = await f.current();
  assert.equal(runtime.status, 'approved');
  assert.equal(runtime.shotTour.status, 'candidate');
  assert.equal(runtime.shotTour.approval, null);
  assert.equal(shotTourEligible(runtime), false);
  assert.equal(shotTourEligible(runtime, { allowCandidates: true }), true);
});

test('a missing optional library keeps the approved rail and disables diagnostic tour playback', async (t) => {
  const f = await fixture(t);
  await authoring.approveShotTour(f.doc, f.tours, f.view.id, { evidence, runtimeDir: f.runtimeDir });
  await fs.rm(path.join(f.runtimeDir, f.view.shotsManifestUrl));
  const runtime = await f.current();
  assert.equal(runtime.status, 'approved');
  assert.deepEqual(sceneViewErrors(runtime), []);
  assert.equal(shotTourEligible(runtime, { allowCandidates: true }), false);
});

test('stale library bytes invalidate only the tour, including diagnostic playback', async (t) => {
  const f = await fixture(t);
  await authoring.approveShotTour(f.doc, f.tours, f.view.id, { evidence, runtimeDir: f.runtimeDir });
  await fs.appendFile(path.join(f.runtimeDir, f.view.shotsManifestUrl), '\n');
  const runtime = await f.current();
  assert.equal(runtime.status, 'approved');
  assert.equal(runtime.shotTour.status, 'candidate');
  assert.equal(shotTourEligible(runtime), false);
  assert.equal(shotTourEligible(runtime, { allowCandidates: true }), false);
  await assert.rejects(authoring.approveShotTour(f.doc, f.tours, f.view.id, { evidence, runtimeDir: f.runtimeDir }), /published.*identity|stale/);
});

for (const change of ['terrain', 'camera', 'material']) test(`${change} changes invalidate base and tour until reviewed again`, async (t) => {
  const f = await fixture(t);
  await authoring.approveShotTour(f.doc, f.tours, f.view.id, { evidence, runtimeDir: f.runtimeDir });
  if (change === 'terrain') await fs.appendFile(path.join(f.runtimeDir, `terrain/${f.view.id}.terrain.json`), '\n');
  if (change === 'camera') {
    f.build.view.camera.eyeStartM[0] += 10;
    await fs.writeFile(path.join(f.runtimeDir, `terrain/${f.view.id}.build.json`), JSON.stringify(f.build));
  }
  if (change === 'material') f.view.materialRules = { forestDensity: .123 };
  const runtime = await f.current();
  assert.equal(runtime.status, 'candidate');
  assert.equal(runtime.shotTour.status, 'candidate');
  assert.equal(shotTourEligible(runtime, { allowCandidates: true }), false);
});

test('tour approval rejects a library authored for another terrain package', async (t) => {
  const f = await fixture(t);
  f.manifest.terrainManifestSha256 = '0'.repeat(64);
  await fs.writeFile(path.join(f.runtimeDir, f.view.shotsManifestUrl), JSON.stringify(f.manifest));
  await assert.rejects(authoring.approveShotTour(f.doc, f.tours, f.view.id, { evidence, runtimeDir: f.runtimeDir }), /terrain identity/);
});

test('malformed optional tour metadata keeps the approved rail in its biome pool', () => {
  const rail = catalog.views.find((v) => v.status === 'approved' && !v.tourManifestUrl);
  const broken = { ...rail, shotsManifestUrl: 'tour/x.shots.json', shotTour: { status: 'approved' } };
  assert.deepEqual(sceneViewErrors(broken), []);
  assert.equal(chooseSceneForBiome(rail.biome, {}, 7, { views: [broken] }).view.id, rail.id);
  assert.equal(shotTourEligible(broken), false);
});
