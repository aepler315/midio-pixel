import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rangeAssetBytes, assetBudgetErrors } from '../tools/lib/scenic-coverage.mjs';
import { budgetErrors } from '../tools/build-scenic-tours.mjs';
import { cloneableShotLibrary, shotPlanRequest } from '../src/world/terrain/ShotRuntime.js';
import { handleShotMessage } from '../src/world/terrain/shot-worker.js';
import { restoreShotLibrary, planShotTour } from '../src/world/terrain/ShotPlanner.js';
import { restoreShotTimeline, buildShotTimeline } from '../src/world/terrain/ShotTimeline.js';
import { motionAudit, planMetrics } from '../tools/plan-scenic-tour.mjs';
import { shotLibraryFixture, rangeShotLibraryFixture, anthemSong } from './fixtures/shot-library-fixture.mjs';

test('delivery byte reporting accepts a Range tree larger than the retired 60 MB ceiling', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'range-delivery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'src/assets/range/v2');
  await fs.mkdir(dir, { recursive: true });
  const file = await fs.open(path.join(dir, 'large.bin'), 'w');
  await file.truncate(64 * 2 ** 20); await file.close();
  assert.equal(await rangeAssetBytes(root), 64 * 2 ** 20);
  assert.deepEqual(await assetBudgetErrors(root), []);
  assert.equal((await assetBudgetErrors(root, { limit: 1024 })).length, 1, 'an explicitly requested limit still applies');
});

test('scenic fitting reports delivery growth without a global cap and retains regional and graphics checks', async () => {
  const config = { budget: { assetBytes: 100e6, desktopTriangles: 100, mobileTriangles: 50 } };
  const packed = { manifestText: '{}', payload: { byteLength: 70e6 } };
  const bake = { rebaked: false, validation: { ok: true } };
  const accepted = await budgetErrors({}, config, packed, bake);
  assert.deepEqual(accepted.errors, []);
  assert.ok(accepted.added > 70e6);
  const regional = await budgetErrors({}, { budget: { ...config.budget, assetBytes: 1000 } }, packed, bake);
  assert.ok(regional.errors.some(x => x.includes("region's 1000")));
  const graphics = await budgetErrors({}, config, packed, { rebaked: true, validation: { ok: true }, budget: { addedBytes: 0, desktopTriangles: 101, mobileTriangles: 51 } }, { rail: 0, tour: 200 * 2 ** 20 });
  for (const kind of ['desktop', 'mobile', 'forest build']) assert.ok(graphics.errors.some(x => x.startsWith(kind)), kind);
});

test('cold request preparation never traverses link geometry on the caller thread', () => {
  const library = shotLibraryFixture();
  let pathReads = 0;
  for (const link of library.links) {
    const geometry = link.path;
    Object.defineProperty(link, 'path', { enumerable: true, get() { pathReads++; return geometry; } });
  }
  const request = shotPlanRequest(library, { durationMs: 5000, sections: [] });
  assert.equal(pathReads, 0, 'bend construction belongs to the worker, not request preparation');
  assert.equal(request.library.planningTables, undefined);
});

test('the worker returns reusable planning tables without changing the resulting timeline', () => {
  const library = shotLibraryFixture(), song = anthemSong();
  const request = { ...song, library: cloneableShotLibrary(library) };
  const cold = handleShotMessage(structuredClone(request));
  assert.equal(cold.message.error, undefined);
  assert.equal(cold.message.planningTables?.linkIds.length, library.links.length);
  const warm = handleShotMessage(structuredClone({ ...request, library: { ...request.library, planningTables: cold.message.planningTables } }));
  assert.deepEqual(warm.message.timeline, cold.message.timeline);
});

test('off-screen ground-truth targets cannot count as hits or reachable visible targets', () => {
  const library = shotLibraryFixture(), song = anthemSong();
  const plan = planShotTour(library, { ...song, visible: [{ startMs: 16000, endMs: song.durationMs }], seed: 0 });
  assert.equal(plan.fallback, null);
  const payoff = plan.items.find(x => !x.hidden && x.payoffMs === 16000);
  assert.ok(payoff, 'the actual plan hits the window boundary');
  const timeline = restoreShotTimeline(buildShotTimeline(library, plan));
  const form = { payoffs: [{ kind: 'offscreen', timeMs: 15900 }, { kind: 'boundary', timeMs: 16000 }] };
  const metrics = planMetrics(library, { ...song, form }, plan, timeline, motionAudit(timeline));
  assert.deepEqual(metrics.groundTruth.map(x => [x.visible, x.hit]), [[false, false], [true, true]]);
  assert.equal(metrics.groundTruthHits, 1);
  assert.equal(metrics.groundTruthVisible, 1);
  assert.ok(metrics.groundTruthReach <= 1);
});

test('an infeasible high-score link cannot hide a legal in-link ending', () => {
  const base = rangeShotLibraryFixture({ seed: 1 });
  const shot = base.shots.find(x => x.id === 'orbit-butte-0-0i');
  const link = base.links.find(x => x.from === shot.id);
  const smooth = { ...link, id: 'smooth', score: { ...link.score, total: .4 }, path: { ...link.path, flow: new Float32Array(link.path.flow.length).fill(.00001) } };
  const bad = { ...link, id: 'bad', to: base.shots.find(x => x.id !== shot.id && x.id !== link.to && x.move !== 'rail').id,
    score: { ...link.score, total: 1 }, path: { ...link.path, flow: new Float32Array(link.path.flow.length).fill(1) } };
  const options = { durationMs: 5000, start: { timeMs: 0, itemKind: 'shot', id: shot.id, s: shot.path.s.at(-1) - 10, speedMps: 4, accelMps2: 0 }, seed: 0 };
  const make = links => restoreShotLibrary({ ...cloneableShotLibrary(base), links });
  const positive = planShotTour(make([smooth]), options);
  assert.equal(positive.fallback, null); assert.equal(positive.items.at(-1).id, 'smooth');
  for (const alternatives of [[smooth, bad], [{ ...bad, to: link.to }, smooth], [smooth, { ...bad, to: link.to }]]) {
    const result = planShotTour(make(alternatives), options);
    assert.equal(result.fallback, null);
    assert.equal(result.items.at(-1).id, 'smooth');
    assert.equal(result.items.at(-1).endMs, 5000);
  }
});
