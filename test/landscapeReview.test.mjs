import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewArgs, makeReviewManifest, validateReviewFrame, requireHardwareRenderer } from '../tools/landscape-review.mjs';

// SwiftShader and RTX 3060 as earlier review runs recorded them; WARP is the same
// constant the route gate tests use (ANGLE's D3D11 form, not seen on this machine).
const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
const RTX_3060 = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const WARP = 'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)';

test('review defaults are bounded, Uniform, continuous and headless only', () => {
  const args = parseReviewArgs(['--out', '.smoke/review']);
  assert.deepEqual(args.grids, ['classic', 'detailed']);
  assert.equal(args.look, 'pixel');
  const manifest = makeReviewManifest(args, 'classic');
  assert.equal(manifest.settings.mode, 'continuous');
  assert.equal(manifest.settings.startMs, 12000);
  assert.equal(manifest.settings.presentation.pixelScale, 'original');
  assert.deepEqual(manifest.songs[0].clips, [{ startMs: 12000, durationMs: 2000 }]);
  assert.equal(args.liveSeconds, 0);assert.equal(parseReviewArgs(['--out','x','--ablate-aurora']).ablateAurora,true);
  for (const option of ['--headful', '--open', '--pixel-scale']) assert.throws(() => parseReviewArgs(['--out', 'x', option]), /Unknown/);
});
test('review selects Cinematic explicitly and retains the same bounded Classic+ controls', () => {
  const args = parseReviewArgs(['--out', 'x', '--look', 'cinematic', '--grid', 'classicPlus', '--live-seconds', '30']);
  const manifest = makeReviewManifest(args, 'classicPlus');
  assert.equal(args.look, 'cinematic');
  assert.equal(manifest.settings.presentation.look, 'cinematic');
  assert.equal(manifest.settings.presentation.pixelGrid, 'classicPlus');
  assert.equal(manifest.settings.presentation.pixelScale, 'original');
  assert.equal(manifest.settings.mode, 'continuous');
  assert.deepEqual(manifest.songs[0].clips, [{ startMs: 12000, durationMs: 2000 }]);
  for (const look of ['palette', 'natural', 'cinematics', '']) {
    assert.throws(() => parseReviewArgs(['--out', 'x', '--look', look]));
  }
});
test('review rejects unbounded clips and invalid grids or live durations before launching a browser', () => {
  for (const args of [['--seconds', '0'], ['--seconds', '181'], ['--grid', 'other'], ['--fps', '0'], ['--live-seconds', '301'], ['--start-ms', '-1']]) {
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
test('hardware review rejects Windows WARP and the masked renderer string, which cannot show what rendered', () => {
  assert.doesNotThrow(() => requireHardwareRenderer(RTX_3060));
  assert.doesNotThrow(() => requireHardwareRenderer(RTX_3060, 'RTX 3060'));
  for (const renderer of [WARP, 'WebKit WebGL', SWIFTSHADER]) {
    assert.throws(() => requireHardwareRenderer(renderer), /Hardware GPU unavailable/, renderer);
  }
});
test('review checks effective grid, Uniform scale, readiness and output rather than requested settings', () => {
  const frame = { presentation: { effectiveLook: 'pixel', pixelScale: 'original', effectiveGrid: { id: 'classic' } },
    range: { active: true, runtime: 'ready' }, output: { width: 1280, height: 720 } };
  assert.doesNotThrow(() => validateReviewFrame(frame, 'classic'));
  for (const alter of [f => { f.presentation.pixelScale = 'depth'; }, f => { f.presentation.effectiveGrid.id = 'detailed'; },
    f => { f.range.active = false; }, f => { f.output.width = 640; }]) {
    const changed = structuredClone(frame); alter(changed); assert.throws(() => validateReviewFrame(changed, 'classic'));
  }
});
test('review rejects an ignored Cinematic request and checks the effective look in both directions', () => {
  const frame = { presentation: { requestedLook: 'cinematic', effectiveLook: 'pixel', pixelScale: 'original', effectiveGrid: { id: 'classicPlus' } },
    range: { active: true, runtime: 'ready' }, output: { width: 1280, height: 720 } };
  assert.throws(() => validateReviewFrame(frame, 'classicPlus', 'cinematic'), /actual selected look/);
  frame.presentation.effectiveLook = 'cinematic';
  assert.doesNotThrow(() => validateReviewFrame(frame, 'classicPlus', 'cinematic'));
  assert.throws(() => validateReviewFrame(frame, 'classicPlus', 'pixel'), /actual selected look/);
  delete frame.presentation.effectiveLook;
  assert.throws(() => validateReviewFrame(frame, 'classicPlus', 'cinematic'), /actual selected look/);
});

test('a completed live trace cannot pass with stalled delivery, hidden time, exhausted residency or a stopped heard clock', async () => {
  const { liveReviewGates } = await import('../tools/landscape-review.mjs');
  const good = { ready: { result: { status: 'ready' }, preparing: false }, seconds: 60, startHeardMs: 0, errors: [], look: 'cinematic', delivery: { failedPresentations: 0, delivered: { frames: 3600, p95Ms: 16.7, stallsOver100ms: 0 }, excluded: { hidden: 0 } },
    state: { heardMs: 60000, paused: false, presentation: { effectiveLook: 'cinematic' }, residency: { peakBytes: 500, budgetBytes: 1000, liveBytes: 400, pendingBytes: 0, overcommits: 0 } } };
  assert.ok(Object.values(liveReviewGates(good)).every(Boolean));
  assert.equal(liveReviewGates({ ...good, ready: { result: { status: 'failed' }, preparing: false } }).renderReady, false);
  assert.equal(liveReviewGates({ ...good, ready: { result: { status: 'failed' }, preparing: false } }).deliveredFrames, true);
  for (const alter of [r => { r.ready.preparing = true; }, r => { r.delivery.failedPresentations=1; }, r => { r.delivery.delivered.p95Ms = 70; }, r => { r.delivery.delivered.stallsOver100ms = 5; },
    r => { r.delivery.excluded.hidden = 1; }, r => { r.state.residency.peakBytes = 1001; }, r => { r.state.residency.overcommits = 1; },
    r => { r.state.heardMs = 0; }, r => { r.state.paused = true; }, r => { r.errors.push('renderer failed'); },
    r => { r.state.presentation.effectiveLook = 'pixel'; }, r => { delete r.state.presentation.effectiveLook; }]) {
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


test('review pins pace and explicit tour choices without changing the short tour default', () => {
  const defaults = makeReviewManifest(parseReviewArgs(['--out', 'x']), 'classic');
  assert.equal(defaults.settings.pace, 3);
  assert.equal(defaults.settings.tour, 'tetons');
  assert.equal(defaults.settings.view, 'teton-range-tour');
  assert.equal(defaults.settings.fps, 12);
  for (const pace of [1, 2, 3, 4]) for (const tour of ['off', 'shots', 'tetons']) {
    const args = parseReviewArgs(['--out', 'x', '--pace', String(pace), '--tour', tour, '--view', 'teton-jackson-lake']);
    const settings = makeReviewManifest(args, 'classic').settings;
    assert.equal(settings.pace, pace);
    assert.equal(settings.tour, tour);
    assert.equal(settings.view, 'teton-jackson-lake');
  }
  for (const pace of ['0', '5', '1.5', 'NaN', 'Infinity']) assert.throws(() => parseReviewArgs(['--out', 'x', '--pace', pace]), /pace/);
  for (const tour of ['none', 'auto', '1']) assert.throws(() => parseReviewArgs(['--out', 'x', '--tour', tour]), /tour/);
});

test('natural view allows automatic landscape selection and disables the fixture biome pin', () => {
  const settings = makeReviewManifest(parseReviewArgs(['--out', 'x', '--view', 'natural', '--tour', 'off']), 'classic').settings;
  assert.equal(settings.view, null);
  assert.equal(settings.biome, null);
  assert.equal(settings.tour, 'off');
});

test('explicit review clips support positive durations through 180 seconds', () => {
  for (const seconds of [0.05, 11, 30, 180]) {
    const m = makeReviewManifest(parseReviewArgs(['--out', 'x', '--seconds', String(seconds)]), 'classic');
    assert.equal(m.songs[0].clips[0].durationMs, seconds * 1000);
    assert.ok(m.songs[0].seconds * 1000 > 12000 + seconds * 1000);
  }
  for (const seconds of ['0', '-1', '180.001', 'NaN', 'Infinity']) assert.throws(() => parseReviewArgs(['--out', 'x', '--seconds', seconds]), /seconds/);
});

test('review diagnostics serialize effective camera state independently from readiness', async () => {
  const { reviewDiagnostics } = await import('../tools/landscape-review.mjs');
  assert.equal(typeof reviewDiagnostics, 'function');
  const rangeState = { active: true, runtime: 'ready', cameraRails: { scheduleId: 'schedule-a', requestedMultiplier: 4, from: { occurrenceId: 'scene-a', viewId: 'teton-jackson-lake', progress01: .7,
      requestedMultiplier: 4, effectiveMultiplier: 2, coverage01: 1, capped: true, policy: 'rail' }, to: null } };
  const schedule = { version: 1, id: 'schedule-a', requestedMultiplier: 4, occurrences: [] };
  const previousWindow = globalThis.window;
  try {
    const scene = { renderer: { getContext: () => ({ getExtension: () => null, RENDERER: 1, getParameter: () => 'test' }) },
      camera: { position: { toArray: () => [1, 2, 3] }, projectionMatrix: { toArray: () => [4, 5, 6] }, fov: 35 },
      snapshot: () => ({ windows: [] }), prepared: new Map() };
    globalThis.window = { __SMW: { sim: { heardTimeMs: 12000, timeMs: 12000,
      biomes: { rangePresentation: { scene, cameraSchedule: schedule, residency: { snapshot: () => ({}) } } } },
      rangeState, renderReadiness: { status: 'failed', reason: 'asset-timeout' }, presentationDiagnostics: {}, playbackPreparing: true, paused: true }, __landscapeReviewPaint: {} };
    const result = await reviewDiagnostics({ evaluate: fn => fn() });
    assert.deepEqual(result.rangeState, rangeState);
    assert.deepEqual(result.cameraRails, rangeState.cameraRails);
    assert.equal(Object.hasOwn(result, 'cameraSchedule'), false, 'full schedule tables are not repeated per frame');
    assert.equal(result.pose.fovYDeg, 35);
    assert.equal(result.renderReadiness.status, 'failed');
    rangeState.cameraRails.from.progress01 = .1;
    assert.equal(result.cameraRails.from.progress01, .7, 'retained evidence must not change after later runtime updates');
  } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});
