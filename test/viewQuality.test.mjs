import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scoreEye, buildViewQualityField, curvatureDrop, viewQualityCacheKey } from '../tools/lib/view-quality.mjs';
import { syntheticCrestGrid, syntheticCrestPoints } from './fixtures/synthetic-crest-grid.mjs';

test('an east-side view looks west over the lake and scores above a view over the crest', () => {
  const grid = syntheticCrestGrid(), points = syntheticCrestPoints(grid);
  const low = scoreEye(grid, points, [9500, 1120, 0], { water: grid.water });
  const high = scoreEye(grid, points, [9500, 3700, 0], { water: grid.water });
  const west = scoreEye(grid, points, [-12000, 2720, 0], { water: grid.water });
  assert.ok(low.headingDeg > 220 && low.headingDeg < 320, `heading ${low.headingDeg}`);
  assert.ok(low.score > 0, 'positive crest score');
  assert.ok(low.features.water > 0, 'the lake is in frame');
  assert.ok(low.features.summitVisible > 0, 'a summit is visible');
  assert.ok(high.score < low.score, `high ${high.score}, low ${low.score}`);
  assert.ok(west.score < low.score, `plateau ${west.score}, lake ${low.score}`);
  assert.equal(low.aims.length, 72);
  for (const aim of low.aims) {
    assert.ok([40, 55, 70].includes(aim.hfovDeg));
    assert.ok(Number.isFinite(aim.score) && Number.isFinite(aim.pitchDeg));
    for (const term of Object.values(aim.features)) assert.ok(Number.isFinite(term));
  }
});

test('height reveals additional separated ridge layers', () => {
  const width = 451, height = 41, cellSizeM = 100, originM = [-40000, -2000];
  const heightsM = Float32Array.from({ length: width * height }, (_, i) => {
    const x = originM[0] + i % width * cellSizeM;
    let h = 1000;
    for (const [cx, top] of [[-8000, 2000], [-16000, 2600], [-25000, 3200]]) h = Math.max(h, 1000 + (top - 1000) * Math.exp(-(((x - cx) / 600) ** 2)));
    return h;
  });
  const grid = { width, height, cellSizeM, originM, heightsM, valid: new Uint8Array(width * height).fill(1) };
  const points = [-8000, -16000, -25000].map((x, i) => ({ id: `ridge-${i}`, localM: [x, [2000, 2600, 3200][i], 0], grandeur: .8, reliefM: 2000 }));
  const low = scoreEye(grid, points, [0, 1080, 0], { headings: [270], rayStepDeg: 1 });
  const high = scoreEye(grid, points, [0, 2200, 0], { headings: [270], rayStepDeg: 1 });
  assert.ok(high.features.layers > low.features.layers, `low ${low.features.layers}, high ${high.features.layers}`);
});

test('the scorer keeps Earth curvature/refraction and requires a nearby grand subject', () => {
  assert.ok(Math.abs(curvatureDrop(40000) - 109.1232896) < .001);
  const grid = syntheticCrestGrid(), points = syntheticCrestPoints(grid);
  assert.equal(scoreEye(grid, points.map(p => ({ ...p, grandeur: .39 })), [9500, 1120, 0]).score, 0);
  assert.equal(scoreEye(grid, points, [21000, 1120, 0]).score, 0);
});

test('field output is identical with one or multiple workers and clamps duplicate tiers', async () => {
  const grid = syntheticCrestGrid({ cellSizeM: 200 }), points = syntheticCrestPoints(grid);
  const samples = [{ posM: [9500, 0], floorY: 1120, ceilY: 1420 }, { posM: [9000, 2500], floorY: 1120, ceilY: 2200 }];
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tour-view-cache-'));
  try {
    const args = { grid, points, samples, water: grid.water, cacheDir, log: () => {} };
    const one = await buildViewQualityField({ ...args, workerCount: 1, cache: false });
    const many = await buildViewQualityField({ ...args, workerCount: 2, cache: false });
    assert.deepEqual(one, many);
    assert.deepEqual(one.samples[0].tiers.map(t => t.yM), [1120, 1240, 1420]);
    for (const sample of one.samples) for (const tier of sample.tiers) {
      assert.equal(tier.score.length, 72);
      assert.equal(tier.pitch.length, 36);
      assert.equal(tier.fovIdx.length, 18);
      assert.equal(tier.subjectId.length, 72);
      assert.ok([...tier.subjectId].every(n => n === 65535 || n < points.length));
    }
    const built = await buildViewQualityField({ ...args, workerCount: 1 });
    const cached = await buildViewQualityField({ ...args, workerCount: 2 });
    assert.deepEqual(built, cached);
    assert.equal((await fs.readdir(cacheDir)).length, 1);
  } finally { await fs.rm(cacheDir, { recursive: true, force: true }); }
});

test('cache identity covers source heights, validity, water, subjects and sample geometry', () => {
  const grid = syntheticCrestGrid({ cellSizeM: 1000 }), points = syntheticCrestPoints(grid);
  const args = { grid, points, samples: [{ posM: [9000, 0], floorY: 1100, ceilY: 3000 }], water: grid.water };
  const key = viewQualityCacheKey(args);
  grid.heightsM[0]++;
  assert.notEqual(viewQualityCacheKey(args), key);
  grid.heightsM[0]--;
  const changed = { ...args, points: points.map((p, i) => i ? p : { ...p, grandeur: .2 }) };
  assert.notEqual(viewQualityCacheKey(changed), key);
  assert.notEqual(viewQualityCacheKey({ ...args, samples: [{ ...args.samples[0], ceilY: 2900 }] }), key);
});

test('a malformed worker sample rejects field authoring', async () => {
  const grid = syntheticCrestGrid({ cellSizeM: 1000 }), points = syntheticCrestPoints(grid);
  await assert.rejects(buildViewQualityField({ grid, points, workerCount: 2, cache: false, log: () => {},
    samples: [{ posM: [NaN, 0], floorY: 1100, ceilY: 2000 }, { posM: [9000, 0], floorY: 1100, ceilY: 2000 }] }), /Invalid tour field sample/);
});
