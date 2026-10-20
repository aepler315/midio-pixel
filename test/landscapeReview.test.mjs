import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewArgs, makeReviewManifest, validateReviewFrame, requireHardwareRenderer } from '../tools/landscape-review.mjs';

test('review defaults are bounded, Uniform, continuous and headless only', () => {
  const args = parseReviewArgs(['--out', '.smoke/review']);
  assert.deepEqual(args.grids, ['classic', 'detailed']);
  const manifest = makeReviewManifest(args, 'classic');
  assert.equal(manifest.settings.mode, 'continuous');
  assert.equal(manifest.settings.startMs, 12000);
  assert.equal(manifest.settings.presentation.pixelScale, 'original');
  assert.deepEqual(manifest.songs[0].clips, [{ startMs: 12000, durationMs: 2000 }]);
  assert.equal(args.liveSeconds, 0);assert.equal(parseReviewArgs(['--out','x','--ablate-aurora']).ablateAurora,true);
  for (const option of ['--headful', '--open', '--pixel-scale']) assert.throws(() => parseReviewArgs(['--out', 'x', option]), /Unknown/);
});
test('review rejects unbounded clips and invalid grids or live durations before launching a browser', () => {
  for (const args of [['--seconds', '0'], ['--seconds', '11'], ['--grid', 'other'], ['--fps', '0'], ['--live-seconds', '301'], ['--start-ms', '-1']]) {
    assert.throws(() => parseReviewArgs(['--out', 'x', ...args]));
  }
  const live = parseReviewArgs(['--out', 'x', '--live-seconds', '300']);
  assert.equal(live.liveSeconds, 300);assert.equal(makeReviewManifest(live,'classic').songs[0].seconds,315);
  assert.deepEqual(parseReviewArgs(['--out', 'x', '--grid', 'detailed']).grids, ['detailed']);
});
test('hardware review verifies actual renderer and cannot relabel software output', () => {
  for (const renderer of [null, '', 'ANGLE SwiftShader', 'llvmpipe', 'Software Rasterizer']) assert.throws(() => requireHardwareRenderer(renderer));
  assert.doesNotThrow(() => requireHardwareRenderer('ANGLE NVIDIA GeForce RTX 3060 Direct3D11', 'RTX 3060'));
  assert.throws(() => requireHardwareRenderer('ANGLE NVIDIA GeForce RTX 3060 Direct3D11', 'different GPU'));
});
test('review checks effective grid, Uniform scale, readiness and output rather than requested settings', () => {
  const frame = { presentation: { pixelScale: 'original', effectiveGrid: { id: 'classic' } },
    range: { active: true, runtime: 'ready' }, output: { width: 1280, height: 720 } };
  assert.doesNotThrow(() => validateReviewFrame(frame, 'classic'));
  for (const alter of [f => { f.presentation.pixelScale = 'depth'; }, f => { f.presentation.effectiveGrid.id = 'detailed'; },
    f => { f.range.active = false; }, f => { f.output.width = 640; }]) {
    const changed = structuredClone(frame); alter(changed); assert.throws(() => validateReviewFrame(changed, 'classic'));
  }
});

test('a completed live trace cannot pass with stalled delivery, hidden time, exhausted residency or a stopped heard clock', async () => {
  const { liveReviewGates } = await import('../tools/landscape-review.mjs');
  const good = { seconds: 60, startHeardMs: 0, errors: [], delivery: { failedPresentations: 0, delivered: { frames: 3600, p95Ms: 16.7, stallsOver100ms: 0 }, excluded: { hidden: 0 } },
    state: { heardMs: 60000, paused: false, residency: { peakBytes: 500, budgetBytes: 1000, liveBytes: 400, pendingBytes: 0, overcommits: 0 } } };
  assert.ok(Object.values(liveReviewGates(good)).every(Boolean));
  for (const alter of [r => { r.delivery.failedPresentations=1; }, r => { r.delivery.delivered.p95Ms = 70; }, r => { r.delivery.delivered.stallsOver100ms = 5; },
    r => { r.delivery.excluded.hidden = 1; }, r => { r.state.residency.peakBytes = 1001; }, r => { r.state.residency.overcommits = 1; },
    r => { r.state.heardMs = 0; }, r => { r.state.paused = true; }, r => { r.errors.push('renderer failed'); }]) {
    const failed = structuredClone(good); alter(failed); assert.ok(Object.values(liveReviewGates(failed)).some(v => !v));
  }
});

test('hash-addressed snapshots preserve case-distinct source modules and reject tampered bytes', async () => {
  const { loadReviewSnapshot } = await import('../tools/landscape-review.mjs');
  const fs = await import('node:fs/promises'), path = await import('node:path'), os = await import('node:os');
  const { sha256 } = await import('../tools/lib/visual-evaluation-server.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'landscape-snapshot-'));
  try {
    const files = { 'index.html': '<!doctype html>', 'src/TerrainWorker.js': 'class wrapper {}', 'src/terrainWorker.js': 'onmessage=()=>{}' }, hashes = {};
    for (const [name, value] of Object.entries(files)) { const bytes = Buffer.from(value), hash = sha256(bytes);hashes[name] = hash;await fs.writeFile(path.join(dir, hash), bytes); }
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ hashes, digest: sha256(JSON.stringify(hashes)) }));
    const loaded = await loadReviewSnapshot({ snapshot: dir });
    assert.equal(loaded.files.get('/src/TerrainWorker.js').toString(), files['src/TerrainWorker.js']);
    assert.equal(loaded.files.get('/src/terrainWorker.js').toString(), files['src/terrainWorker.js']);
    await fs.writeFile(path.join(dir, hashes['src/TerrainWorker.js']), 'changed');
    await assert.rejects(loadReviewSnapshot({ snapshot: dir }), /snapshot byte hash/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('serialized grid provenance can be compared only after verifying source immutability', async () => {
  const { verifyReviewSource, loadReviewSnapshot } = await import('../tools/landscape-review.mjs');
  const { compareReports } = await import('../tools/lib/visual-evaluation.mjs');
  const { sha256 } = await import('../tools/lib/visual-evaluation-server.mjs');
  const fs = await import('node:fs/promises'), path = await import('node:path'), os = await import('node:os');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'landscape-grid-provenance-'));
  try {
    const hashes = {};
    for (const [name, value] of Object.entries({ 'index.html': '<!doctype html>', 'src/main.js': 'start()' })) {
      hashes[name] = sha256(value); await fs.writeFile(path.join(dir, hashes[name]), value);
    }
    const digest = sha256(JSON.stringify(hashes));
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ hashes, digest }));
    const snapshot = await loadReviewSnapshot({ snapshot: dir });
    const run = { version: 1, status: 'passed', browser: 'test',
      source: { commit: 'a'.repeat(40), digest, hashes: snapshot.hashes },
      environment: { gl: 'test', vendor: 'test', deviceMemory: 8, dpr: 1 },
      settings: makeReviewManifest(parseReviewArgs(['--out', 'unused']), 'classic').settings,
      songs: [{ id: 'review-audio', durationMs: 90000, audioSha256: 'a'.repeat(64),
        schedule: [{ timeMs: 12000, save: true }], clips: [{ startMs: 12000, durationMs: 2000 }],
        frames: [{ timeMs: 12000, actualTimeMs: 12000, png: 'frame.png', sha256: 'b'.repeat(64), thumbnail: [0, 0, 0, 255] }] }] };
    assert.throws(() => compareReports(run, run), /source provenance/);
    await verifyReviewSource({ snapshot: dir }, digest, run.source);
    const serialized = JSON.parse(JSON.stringify(run));
    assert.equal(serialized.source.changedDuringRun, false);
    assert.doesNotThrow(() => compareReports(serialized, serialized));
    hashes['src/main.js'] = sha256('different()');
    await fs.writeFile(path.join(dir, hashes['src/main.js']), 'different()');
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ hashes, digest: sha256(JSON.stringify(hashes)) }));
    await assert.rejects(verifyReviewSource({ snapshot: dir }, digest, run.source), /source changed/);
    assert.equal(run.source.changedDuringRun, true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
