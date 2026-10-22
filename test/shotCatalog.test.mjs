import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAuthoring, buildCatalog, approvalHashes } from '../tools/build-range-scene.mjs';
import { sceneViewErrors } from '../src/world/terrain/SceneCatalog.js';
import catalog from '../src/world/terrain/sceneCatalogData.js';

// Any shipped JSON file stands in for a library manifest: the catalog only
// hashes its bytes.
const LIBRARY = 'tour/teton-range-tour.tour.json';

test('adding a shot library to an approved view stales its approval until it is re-recorded', async () => {
  const doc = await readAuthoring();
  const id = 'monument-valley-163';
  const original = structuredClone(doc.views.find((v) => v.id === id));
  const view = doc.views.find((v) => v.id === id);
  view.shotsManifestUrl = LIBRARY;
  const stale = (await buildCatalog(doc)).views.find((v) => v.id === id);
  assert.equal(stale.status, 'candidate', 'an unreviewed library never ships as approved');
  assert.match(stale.shotsManifestSha256, /^[a-f0-9]{64}$/);
  const build = JSON.parse(await (await import('node:fs/promises')).readFile(new URL(`../src/assets/range/v2/terrain/${id}.build.json`, import.meta.url), 'utf8'));
  const hashes = await approvalHashes(view, build);
  view.approval = { ...view.approval, shotsManifestSha256: hashes.shotsManifestSha256 };
  const approved = (await buildCatalog(doc)).views.find((v) => v.id === id);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.shotsManifestUrl, LIBRARY);
  assert.deepEqual(sceneViewErrors(approved), []);
  // Removing the library after approval voids it too (the hash is recorded).
  delete view.shotsManifestUrl;
  assert.equal((await buildCatalog(doc)).views.find((v) => v.id === id).status, 'candidate');
  // Views without a library keep their approvals untouched.
  doc.views[doc.views.indexOf(view)] = original;
  assert.equal((await buildCatalog(doc)).views.find((v) => v.id === id).status, 'approved');
});

test('the catalog validator requires a complete shot identity beside a rail', () => {
  const rail = catalog.views.find((v) => v.id === 'monument-valley-163');
  assert.deepEqual(sceneViewErrors({ ...rail, shotsManifestUrl: 'tour/x.shots.json', shotsManifestSha256: 'a'.repeat(64) }), []);
  assert.ok(sceneViewErrors({ ...rail, shotsManifestUrl: 'tour/x.shots.json' }).includes('shot library identity'));
  assert.ok(sceneViewErrors({ ...rail, shotsManifestUrl: 'tour/x.shots', shotsManifestSha256: 'a'.repeat(64) }).includes('shot library identity'));
  const tour = catalog.views.find((v) => v.tourManifestUrl);
  assert.ok(sceneViewErrors({ ...tour, shotsManifestUrl: 'tour/x.shots.json', shotsManifestSha256: 'a'.repeat(64) }).includes('shot library identity'),
    'a highway tour view cannot also carry shots');
});
