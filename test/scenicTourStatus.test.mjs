import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { statusRows } from '../tools/scenic-tour-status.mjs';
import { packLibrary } from '../tools/build-scenic-tours.mjs';
import { samplePath } from '../src/world/terrain/ShotPath.js';
import catalog from '../src/world/terrain/sceneCatalogData.js';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const id = 'teton-jackson-lake';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scenic-tour-status-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const assetsRoot = path.join(dir, 'assets'), buildRoot = path.join(dir, 'fresh-builds');
  await fs.mkdir(path.join(assetsRoot, 'terrain'), { recursive: true });
  await fs.mkdir(path.join(assetsRoot, 'tour'), { recursive: true });
  const terrain = JSON.stringify({ fixture: 'terrain identity only; no DEM needed' });
  await fs.writeFile(path.join(assetsRoot, 'terrain', `${id}.terrain.json`), terrain);
  const p = samplePath({ eyes: [[0, 500, 0], [1000, 500, 0]], aims: [[0, 1000, -5000], [1000, 1000, -5000]], fovs: 30 });
  const shot = { id: 'rail', subjectId: 'p', move: 'rail', path: p, lengthM: p.s.at(-1), payoffS: p.s.at(-1) / 2,
    holdS: [0, p.s.at(-1)], durationMs: { min: 4000, ideal: 8000, max: 20000 },
    traits: { headingDeg: 90, azimuthDeg: 0, elevationDeg: 5, aglM: 300, distanceM: 5000, lens: 'normal', foreground: 0, side: 'left' }, score: { total: 0.5 } };
  const packed = packLibrary(id, 'tetons', sha(terrain), { subjects: [{ id: 'p', kind: 'peak', posM: [0, 1000, -5000], radiusM: 300 }], shots: [shot], links: [] });
  await fs.writeFile(path.join(assetsRoot, 'tour', `${id}.shots.json`), packed.manifestText);
  await fs.writeFile(path.join(assetsRoot, 'tour', `${id}.shots.bin.gz`), packed.payload);
  const view = { ...structuredClone(catalog.views.find((v) => v.id === id)),
    status: 'approved', shotsManifestUrl: `tour/${id}.shots.json`, shotsManifestSha256: sha(packed.manifestText),
    terrainManifestSha256: sha(terrain), baseViewSha256: 'a'.repeat(64) };
  const identity = Object.fromEntries(['shotsManifestSha256', 'terrainManifestSha256', 'baseViewSha256'].map((k) => [k, view[k]]));
  view.shotTour = { status: 'approved', identity, approval: { ...identity, evidence: ['review/clip.mp4'] } };
  return { view, assetsRoot, buildRoot, options: { catalogData: { views: [view] }, assetsRoot, buildRoot } };
}

test('the status report separates base approval from verified tour eligibility', async (t) => {
  const f = await fixture(t);
  const reported = async () => (await statusRows(f.options)).find((r) => r.view === id).tour;
  f.view.shotTour.status = 'candidate';
  assert.equal(await reported(), 'candidate', 'an approved rail must not approve its candidate tour');
  f.view.shotTour.status = 'approved';
  assert.equal(await reported(), 'approved', 'both approvals and current package identities permit production');
  f.view.status = 'candidate';
  assert.equal(await reported(), 'candidate', 'tour approval cannot promote its candidate base');
  f.view.status = 'approved'; f.view.shotTour.approval.evidence = [];
  assert.equal(await reported(), 'candidate', 'an approval label without evidence is not eligible');
  f.view.shotTour.status = 'rejected';
  assert.equal(await reported(), 'rejected', 'a rejected tour is a review decision, not an identity failure');
  f.view.shotTour.status = 'stale';
  assert.equal(await reported(), 'stale', 'an unexpected tour status fails the runtime identity gate');
});

test('the status report marks stale approval identities and corrupt published bytes as stale', async (t) => {
  const f = await fixture(t);
  const reported = async () => (await statusRows(f.options)).find((r) => r.view === id);
  f.view.shotTour.approval.shotsManifestSha256 = 'b'.repeat(64);
  assert.equal((await reported()).tour, 'stale');
  f.view.shotTour.approval.shotsManifestSha256 = f.view.shotsManifestSha256;
  await fs.appendFile(path.join(f.assetsRoot, f.view.shotsManifestUrl), ' ');
  assert.equal((await reported()).tour, 'stale', 'a changed manifest cannot borrow an old approval');
  f.view.shotsManifestSha256 = sha(await fs.readFile(path.join(f.assetsRoot, f.view.shotsManifestUrl)));
  f.view.shotTour.identity.shotsManifestSha256 = f.view.shotsManifestSha256;
  f.view.shotTour.approval.shotsManifestSha256 = f.view.shotsManifestSha256;
  await fs.appendFile(path.join(f.assetsRoot, 'tour', `${id}.shots.bin.gz`), 'corrupt');
  const corrupt = await reported();
  assert.equal(corrupt.tour, 'stale', 'actual compressed/decoded bytes must match, not only catalog metadata');
  assert.match(corrupt.tourIssue, /payload/);
});

test('the status report reports a malformed published manifest without crashing', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.assetsRoot, f.view.shotsManifestUrl), '{}');
  const row = (await statusRows(f.options)).find((r) => r.view === id);
  assert.equal(row.tour, 'stale');
  assert.equal(row.shots, null); assert.equal(row.links, null);
  assert.match(row.tourIssue, /invalid shot library/);
});

test('the status report keeps a missing library rail-only and reads only the explicit build root', async (t) => {
  const f = await fixture(t);
  delete f.view.shotsManifestUrl;
  await fs.mkdir(path.join(f.buildRoot, id), { recursive: true });
  await fs.writeFile(path.join(f.buildRoot, id, 'fit.json'), JSON.stringify({ shots: 3, links: 2, failed: false,
    bake: { rebaked: false, validation: { ok: true, holes: 0 } } }));
  const row = (await statusRows(f.options)).find((r) => r.view === id);
  assert.equal(row.tour, 'rail only');
  assert.equal(row.shots, 3); assert.equal(row.links, 2); assert.equal(row.budget, 'within');
  assert.equal(row.countsSource, 'build fit'); assert.equal(row.buildRoot, f.buildRoot);
  const other = (await statusRows({ ...f.options, buildRoot: path.join(f.buildRoot, 'unrelated') })).find((r) => r.view === id);
  assert.equal(other.shots, null, 'no implicit search in sibling or historical build directories');
  const tool = fileURLToPath(new URL('../tools/scenic-tour-status.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [tool, '--build-root', f.buildRoot], { encoding: 'utf8' });
  const cli = JSON.parse(output).find((r) => r.view === id);
  assert.equal(cli.shots, 3); assert.equal(cli.links, 2);
  assert.equal(cli.tour, 'rail only', 'selecting fresh build metadata does not publish its library');
  assert.equal(cli.countsSource, 'build fit');
});
