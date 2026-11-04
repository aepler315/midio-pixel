// Range v2: the room check that decides whether an approved tour view is
// prepared for both cameras (RangeScene._tourRoom), on the shipped packages
// and libraries. A desktop never refuses an approved tour up front; a phone
// never places a forest it cannot draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { terrainCpuBytes } from '../src/world/alpine/RangeAssets.js';
import { decodeShotLibrary, cameraFootprint } from '../src/world/terrain/ShotLibrary.js';
import { shotTourEligible } from '../src/world/alpine/RangeShotTours.js';
import catalog from '../src/world/terrain/sceneCatalogData.js';

const RUNTIME = fileURLToPath(new URL('../src/assets/range/v2/', import.meta.url));
const MiB = 2 ** 20;
const json = (rel) => JSON.parse(fs.readFileSync(path.join(RUNTIME, rel), 'utf8'));
const gunzip = (dir, url) => { const b = zlib.gunzipSync(fs.readFileSync(path.join(RUNTIME, dir, path.basename(url)))); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); };

function load(view) {
  const manifest = json(view.terrainManifestUrl);
  const data = decodeTerrain(manifest, gunzip('terrain', manifest.payload.url));
  const shots = json(view.shotsManifestUrl);
  const footprint = cameraFootprint(decodeShotLibrary(shots, gunzip('tour', shots.payload.url)));
  const pack = json(view.materialManifestUrl);
  return { manifest, data, view: { ...view, cameraPaths: footprint }, rules: { ...pack.rules, ...(view.materialRules || {}) } };
}

/** What a device holds when it checks: the decoded package as charged, the
 *  material pack and the presentation's targets (probed: about 36 MiB on
 *  Black Mountains). */
function room(v, budget, budgetMiB) {
  const residency = new GraphicsResidency({ budgetBytes: budgetMiB * MiB });
  const cpuKey = 'range:terrain-cpu', resident = [[cpuKey, terrainCpuBytes(v.manifest)], ['material', 12 * MiB], ['presentation', 10 * MiB]];
  for (const [key, bytes] of resident) residency.commit(residency.reserve({ key, bytes, owner: key, evictable: false }), {});
  const scene = Object.assign(Object.create(RangeScene.prototype), { budget, residency });
  return scene._tourRoom(v.view, { data: v.data, key: cpuKey }, v.rules, v.manifest.estimatedBytes[budget], [cpuKey, 'material']);
}

const approved = catalog.views.filter((v) => v.shotsManifestUrl && shotTourEligible(v) && !v.terrainSourceId);

test('every approved tour view is prepared for both cameras on a desktop, or places its forest to check', () => {
  assert.ok(approved.length >= 11, `${approved.length} approved tour views`);
  for (const view of approved) {
    const v = load(view);
    assert.notEqual(room(v, 'desktop', 512), null, `${view.id} on a 512 MiB desktop`);
  }
});

test('a phone prepares the heaviest tours for their rail without placing their forest', () => {
  for (const id of ['black-mountains-catawba', 'teton-jackson-lake']) {
    const v = load(approved.find((x) => x.id === id));
    for (const budgetMiB of [192, 320]) assert.equal(room(v, 'mobile', budgetMiB), null, `${id} on a ${budgetMiB} MiB phone`);
  }
});
