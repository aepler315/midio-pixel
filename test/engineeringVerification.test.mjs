import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageMetrics, compareCapture, compareBenchmarks, summarize } from '../tools/verification/contracts.mjs';

const image = (v = 100) => ({ width: 16, height: 16, data: Buffer.alloc(16 * 16 * 4, v) });
const limits = { channel: 8, changedRatio: .01, minSsim: .99, edgeMae: .01 };
const run = () => ({ status: 'passed', controlsHash: 'controls', browser: 'chromium-1', renderer: 'swiftshader',
  frames: [{ id: 'ridge', sha256: 'x', width: 16, height: 16 }], source: { commit: 'a', digest: 'b' } });

test('image metrics tolerate subthreshold raster noise and reject a changed silhouette or blank output', () => {
  assert.equal(imageMetrics(image(), image(102), limits).pass, true);
  const changed = image(); changed.data.fill(240, 8 * 16 * 4);
  const diff = imageMetrics(image(), changed, limits);
  assert.equal(diff.pass, false); assert.ok(diff.changedRatio > .4); assert.ok(diff.ssim < .9);
  assert.equal(imageMetrics(image(), image(0), limits).pass, false);
  assert.throws(() => imageMetrics(image(), { ...image(), width: 15 }, limits), /dimension/);
  assert.throws(() => imageMetrics(image(), image(), { ...limits, changedRatio: NaN }), /threshold/);
});

test('capture comparison fails closed on missing approval, controls, environments, frames and failed capture', () => {
  const baseline = run(), candidate = run();
  assert.throws(() => compareCapture(baseline, candidate), /approval/);
  baseline.approval = { reviewer: 'technical-review', reason: 'initial inspection' };
  assert.equal(compareCapture(baseline, candidate).length, 1);
  for (const key of ['controlsHash', 'browser', 'renderer']) {
    assert.throws(() => compareCapture(baseline, { ...candidate, [key]: 'changed' }), /mismatch/);
    assert.throws(() => compareCapture({ ...baseline, [key]: undefined }, { ...candidate, [key]: undefined }), /missing/);
  }
  assert.throws(() => compareCapture(baseline, { ...candidate, status: 'failed' }), /passed/);
  assert.throws(() => compareCapture(baseline, { ...candidate, frames: [] }), /frame/);
  assert.throws(() => compareCapture(baseline, { ...candidate, frames: [candidate.frames[0], candidate.frames[0]] }), /frame/);
});

test('benchmark comparison rejects changed output, incomparable hosts, missing and nonfinite metrics', () => {
  const base = { status: 'passed', environment: { cpu: 'same' }, workloadHash: 'fixture', results: [{ id: 'terrain', checksum: 'geometry', medianMs: 10, p95Ms: 12, maxMs: 14 }] };
  assert.equal(compareBenchmarks(base, structuredClone(base)).pass, true);
  const slow = structuredClone(base); slow.results[0].medianMs = 50;
  assert.equal(compareBenchmarks(base, slow).pass, false);
  assert.throws(() => compareBenchmarks({ ...base, status: 'failed' }, base), /baseline.*passed/);
  assert.throws(() => compareBenchmarks({ ...base, environment: undefined }, { ...base, environment: undefined }), /environment/);
  assert.throws(() => compareBenchmarks({ ...base, workloadHash: undefined }, { ...base, workloadHash: undefined }), /workload/);
  const noChecksum = structuredClone(base); delete noChecksum.results[0].checksum;
  assert.throws(() => compareBenchmarks(noChecksum, noChecksum), /checksum/);
  const duplicates = structuredClone(base); duplicates.results.push({ ...duplicates.results[0] });
  const other = structuredClone(base); other.results.push({ ...other.results[0], id: 'untested' });
  assert.throws(() => compareBenchmarks(duplicates, other), /duplicate.*scenario/);
  const corrupt = structuredClone(base); corrupt.results[0].p95Ms = NaN;
  assert.throws(() => compareBenchmarks(base, corrupt), /finite/);
  const missing = structuredClone(base); missing.results = [];
  assert.throws(() => compareBenchmarks(base, missing), /scenario/);
  assert.throws(() => compareBenchmarks(base, { ...base, environment: { cpu: 'different' } }), /environment/);
  assert.throws(() => compareBenchmarks(base, { ...base, workloadHash: 'other' }), /workload/);
  const changed = structuredClone(base); changed.results[0].checksum = 'changed';
  assert.equal(compareBenchmarks(base, changed).pass, false);
  assert.throws(() => summarize([]), /samples/);
  assert.deepEqual(summarize([3, 1, 2]), { samples: 3, medianMs: 2, p95Ms: 3, maxMs: 3 });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { hash } from '../tools/verification/io.mjs';

test('CLI retains real PNG differences, rejects corruption, and never overwrites a reference', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'midio-verify-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'a'), b = path.join(dir, 'b'), ref = path.join(dir, 'ref');
  await fs.mkdir(a); await fs.mkdir(b);
  const bytes = PNG.sync.write({ ...image(), data: image().data });
  const capture = run(); capture.corpus = { thresholds: limits };
  capture.frames = [{ id: 'ridge', png: 'ridge.png', sha256: hash(bytes), width: 16, height: 16 }];
  for (const dest of [a, b]) { await fs.writeFile(path.join(dest, 'ridge.png'), bytes); await fs.writeFile(path.join(dest, 'report.json'), JSON.stringify(capture)); }
  const cli = (name, args) => spawnSync(process.execPath, [`tools/verification/${name}.mjs`, ...args], { encoding: 'utf8' });
  assert.equal(cli('approve', ['--candidate', a, '--out', ref, '--reviewer', 'test', '--reason', 'fixture only']).status, 0);
  assert.notEqual(cli('approve', ['--candidate', a, '--out', ref, '--reviewer', 'test', '--reason', 'fixture only']).status, 0);
  const same = path.join(dir, 'same');
  assert.equal(cli('compare', ['--baseline', ref, '--candidate', b, '--out', same]).status, 0);
  const changedBytes = PNG.sync.write(image(0));
  const changed = structuredClone(capture); changed.frames[0].sha256 = hash(changedBytes);
  await fs.writeFile(path.join(b, 'ridge.png'), changedBytes); await fs.writeFile(path.join(b, 'report.json'), JSON.stringify(changed));
  const bad = path.join(dir, 'bad');
  assert.equal(cli('compare', ['--baseline', ref, '--candidate', b, '--out', bad]).status, 1);
  assert.ok((await fs.readFile(path.join(bad, 'ridge-diff.png'))).length > 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(bad, 'report.json'))).status, 'failed');
  await fs.writeFile(path.join(b, 'ridge.png'), bytes);
  const corrupt = path.join(dir, 'corrupt');
  assert.equal(cli('compare', ['--baseline', ref, '--candidate', b, '--out', corrupt]).status, 1);
  assert.match(await fs.readFile(path.join(corrupt, 'summary.md'), 'utf8'), /checksum mismatch/);
});

import { normalizeManifest } from '../tools/lib/visual-evaluation.mjs';

test('every committed scenario normalizes against the current production export contract', async () => {
  const corpus = JSON.parse(await fs.readFile('tools/verification/scenarios.json'));
  assert.equal(corpus.scenarios.reduce((n, s) => n + s.timesMs.length, 0), 8);
  for (const s of corpus.scenarios) {
    const manifest = normalizeManifest({ version: 1, settings: { ...corpus.settings, quality: s.quality ?? 0,
      ...(s.debug ? { debug: s.debug } : {}), presentation: { version: 2, look: 'cinematic', quality: 'auto', pixelGrid: s.grid,
        pixelScale: 'original', scaling: 'fit', buildPixelDetail: false } }, songs: [{ id: 'fixture', fixture: 'contrast', seconds: corpus.fixture.seconds, timesMs: s.timesMs }] });
    assert.equal(manifest.settings.presentation.pixelGrid, s.grid);
  }
});

test('handoff CLI snapshots committed task files and refuses changed Git evidence', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'midio-handoff-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // A self-contained repo keeps this test valid on clean main, feature branches
  // and shallow CI checkouts without relying on an origin/main in the caller.
  const repo = path.join(dir, 'repo'); await fs.mkdir(path.join(repo, 'tools/verification'), { recursive: true });
  for (const name of ['handoff.mjs', 'io.mjs']) await fs.copyFile(`tools/verification/${name}`, path.join(repo, 'tools/verification', name));
  const git = args => {
    const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(['init']); git(['add', '.']); git(['commit', '-m', 'base']);
  git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD'])]);
  await fs.writeFile(path.join(repo, 'changed.txt'), 'committed task change');
  git(['add', '.']); git(['commit', '-m', 'task']);
  const record = Object.fromEntries(['objective', 'decisions', 'tests', 'visual', 'performance', 'problems', 'remaining', 'next'].map(k => [k, `${k}: test fixture, not an executed engineering task`]));
  const input = path.join(dir, 'input.json'), out = path.join(dir, 'out'); await fs.writeFile(input, JSON.stringify(record));
  const cli = args => spawnSync(process.execPath, [path.join(repo, 'tools/verification/handoff.mjs'), ...args], { cwd: repo, encoding: 'utf8' });
  assert.equal(cli(['create', '--record', input, '--out', out]).status, 0);
  assert.equal(cli(['resume', '--handoff', out]).status, 0);
  const file = path.join(out, 'report.json'), saved = JSON.parse(await fs.readFile(file));
  assert.deepEqual(saved.state.changedFiles, ['changed.txt']); assert.deepEqual(saved.state.uncommittedFiles, []);
  assert.match(saved.state.taskBase, /^[a-f0-9]{40}$/);
  saved.state.commit = 'stale'; await fs.writeFile(file, JSON.stringify(saved));
  const resumed = cli(['resume', '--handoff', out]); assert.equal(resumed.status, 1); assert.match(resumed.stdout, /Git state changed/);
  delete record.tests; await fs.writeFile(input, JSON.stringify(record));
  assert.notEqual(cli(['create', '--record', input, '--out', path.join(dir, 'invalid')]).status, 0);
});

test('evaluation catalog contains runnable files and keeps model scores unassessed by default', async () => {
  const catalog = JSON.parse(await fs.readFile('evaluations/tasks.json')); assert.equal(catalog.tasks.length, 10);
  for (const task of catalog.tasks) {
    assert.equal(task.rubric.reduce((sum, r) => sum + r.points, 0), 100);
    assert.equal(task.acceptance.length, 3);
    for (const file of task.checks) await fs.access(path.join('test', file));
  }
});

test('capture IDs cannot escape the comparison directory or inject report markup', () => {
  const baseline = run(); baseline.approval = { reviewer: 'test', reason: 'test' };
  for (const id of ['../../escaped', '<img-src=x>', '', 'a/b']) {
    const altered = structuredClone(baseline); altered.frames[0].id = id;
    assert.throws(() => compareCapture(altered, altered), /frame id/);
  }
});

test('CI piped verification commands use explicit bash pipefail semantics', async () => {
  const workflow = await fs.readFile('.github/workflows/agent-verification.yml', 'utf8');
  assert.match(workflow, /defaults:\s+run:\s+shell: bash/);
});

test('geometry signatures include all culling, seam and rail/tour draw metadata', async () => {
  const { geometryChecksum } = await import('../tools/verification/geometry.mjs');
  const geometry = { bands: { near: { positions: new Float32Array([1, 2, 3]), indices: new Uint32Array([0]),
    fringe: new Uint32Array([0]), chunks: { start: new Uint32Array([0]) }, fringeChunks: { count: new Uint32Array([1]) },
    ranges: { rail: [0, 1], tour: [0, 1] }, fringeRanges: { rail: [0, 1] }, tileOrder: { rail: new Uint32Array([0, 1]) } } }, stats: { triangles: 1 } };
  const original = geometryChecksum(geometry);
  for (const field of ['positions', 'indices', 'fringe', 'chunks', 'fringeChunks', 'ranges', 'fringeRanges', 'tileOrder']) {
    const changed = structuredClone(geometry); changed.bands.near[field] = null;
    assert.notEqual(geometryChecksum(changed), original, field);
  }
});
