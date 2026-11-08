import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import { parseMaterialFeatureArgs, assessMaterialFeatureExercise, assertMaterialFeatureActivation,
  assertMaterialFeatureFrameMatch, assertMaterialFeatureWasExercised } from '../tools/material-feature-compare.mjs';
import { installPilotProbe, summarizePilotFrames, readPilotTextureContent } from '../tools/lib/pilot-comparison.mjs';

function state(mode) {
  const warp = mode === 'warp', bytes = warp ? 1600 : 0;
  const status = { selected: mode, reason: warp ? null : 'off', bytes, width: warp ? 20 : 0, height: warp ? 20 : 0 };
  return { requested: mode, status, drawn: { ...status, material: mode },
    activation: { mode, define: warp, linkedPrograms: 2, allLinked: true, bandsUseMaterial: true, river: null },
    uniforms: { uGridOrigin: [0, 0], uHasMaterial: 1, uLandRise: [.2, 1000], uDeformAmp: 3,
      uSurface: { texture: true, width: 1, height: 1, content: { provenance: 'gpu-level-0-rgba8', sha256: 'a'.repeat(64) } },
      uReceiver: { texture: true, width: 1, height: 1, content: { provenance: 'gpu-level-0-rgba8', sha256: 'b'.repeat(64) } } },
    geometry: { near: 'abc' }, vertexShaderSha256: 'abc', camera: { projection: [1, 2, 3] },
    soil: { width: 20, height: 20, rawOriginBindings: warp ? [-1, -21] : [3, 5],
      tag: warp ? { version: 1, mode: 'warp', originCell: [-1, -21], width: 20, height: 20 } : null,
      format: { rgba8: true, nearest: true, linearData: true, noMips: true, clamped: true, notFlipped: true, noDepth: true } },
    cache: warp ? { bytes, boundToSoil: true, targetOwnsTexture: true, target: { width: 20, height: 20 },
      plan: { eligible: true, width: 20, height: 20, bytes, originCell: [-1, -21] } } : null,
    memory: { entry: { key: 'view', owner: 'terrain', state: 'live', resourceIsPrepared: true, bytes: 10000 + bytes },
      ledger: { budget: 'desktop', budgetBytes: 100000, liveBytes: 10000 + bytes, pendingBytes: 0, entryCount: 1,
        byOwner: { terrain: { live: 10000 + bytes, pending: 0, count: 1 } } } } };
}

function frame(mode) {
  const materialState = state(mode);
  return { timeMs: 12000, actualTimeMs: 12000, seed: 315, quality: 0, audio: { energy: .7 }, controls: { storm: .3 },
    render: { qualityLevel: 0 }, output: { width: 1280, height: 720 }, dpr: 1, camera: { eyeM: [1, 2, 3] },
    presentation: { requestedLook: 'pixel', effectiveLook: 'pixel', effectiveGrid: { id: 'classic' }, pixelScale: 'original',
      effectivePalette: 'none', effectiveDitherMode: 'selective', output: { width: 1280, height: 720 }, working: { width: 320, height: 180 }, qualityLevel: 0 },
    materialState, materialExercise: assessMaterialFeatureExercise(materialState.uniforms),
    range: { active: true, viewId: 'pilot', narrative: { section: 2 }, scene: { pending: [] } } };
}

test('material comparison arguments are bounded and explicit', () => {
  const args = parseMaterialFeatureArgs(['--out', 'new', '--times', '24000,12000', '--frames', '4', '--hardware-gpu']);
  assert.deepEqual(args.times, [12000, 24000]); assert.equal(args.frames, 4); assert.equal(args.hardware, true);
  for (const argv of [[], ['--out'], ['--out', 'x', '--frames', '0'], ['--out', 'x', '--times', 'NaN'],
    ['--out', 'x', '--times', '1,1'], ['--out', 'x', '--view', '../x'], ['--out', 'x', '--nope', 'yes']]) assert.throws(() => parseMaterialFeatureArgs(argv));
});

test('material activation verifies binding, tag, format, dimensions, byte cap and live owner', () => {
  assert.doesNotThrow(() => assertMaterialFeatureActivation(state('reference'), 'reference'));
  assert.doesNotThrow(() => assertMaterialFeatureActivation(state('warp'), 'warp'));
  const changes = [s => { s.activation.mode = 'reference'; }, s => { s.activation.define = false; },
    s => { s.activation.linkedPrograms = 0; }, s => { s.activation.allLinked = false; }, s => { s.activation.bandsUseMaterial = false; },
    s => { s.cache.boundToSoil = false; }, s => { s.cache.targetOwnsTexture = false; }, s => { s.soil.tag.version = 2; },
    s => { s.soil.tag.originCell[0]++; }, s => { s.soil.tag.width = 257; }, s => { s.cache.target.width++; },
    s => { s.soil.rawOriginBindings[0]++; }, s => { s.soil.tag.originCell[0] = 2 ** 24; },
    s => { s.soil.format.nearest = false; }, s => { s.soil.format = {}; }, s => { s.cache.bytes++; },
    s => { s.status.reason = 'budget'; }, s => { s.memory.entry.resourceIsPrepared = false; },
    s => { s.memory.ledger.budgetBytes = 10; }, s => { s.drawn.material = 'reference'; }];
  for (const change of changes) { const s = state('warp'); change(s); assert.throws(() => assertMaterialFeatureActivation(s, 'warp')); }
  const reference = state('reference'); reference.soil.tag = state('warp').soil.tag;
  assert.throws(() => assertMaterialFeatureActivation(reference, 'reference'), /reference soil/);
});

test('paired material evidence rejects camera, music, geometry, lighting and memory drift', () => {
  assert.doesNotThrow(() => assertMaterialFeatureFrameMatch(frame('reference'), frame('warp')));
  const changes = [f => { f.camera.eyeM[0]++; }, f => { f.materialState.camera.projection[0]++; },
    f => { f.materialState.geometry.near = 'changed'; }, f => { f.controls.storm++; }, f => { f.audio.energy++; },
    f => { f.materialState.uniforms.uDeformAmp++; }, f => { f.presentation.effectiveGrid.id = 'detailed'; },
    f => { f.range.scene.pending.push('asset'); }, f => { f.range.active = false; },
    f => { f.materialState.memory.entry.bytes++; }, f => { f.materialState.memory.ledger.budgetBytes++; },
    f => { f.materialState.memory.ledger.liveBytes++; }, f => { f.materialState.memory.ledger.byOwner.terrain.live++; },
    f => { delete f.materialState.uniforms.uSurface.content; },
    f => { delete f.materialState.uniforms; }];
  for (const change of changes) { const f = frame('warp'); change(f); assert.throws(() => assertMaterialFeatureFrameMatch(frame('reference'), f)); }
});

test('flat opening and unmaterialized terrain cannot alone pass the evidence gate', () => {
  const uniforms = state('reference').uniforms;
  const flat = assessMaterialFeatureExercise({ ...uniforms, uLandRise: [1, 1000] });
  const unmaterialized = assessMaterialFeatureExercise({ ...uniforms, uHasMaterial: 0 });
  assert.equal(flat.exercised, false); assert.equal(unmaterialized.exercised, false);
  assert.throws(() => assertMaterialFeatureWasExercised([flat, unmaterialized].map(s => ({ materialExercised: s.exercised }))), /not exercised/);
  assert.doesNotThrow(() => assertMaterialFeatureWasExercised([{ materialExercised: true }]));
  for (const invalid of [{}, { ...uniforms, uHasMaterial: NaN }, { ...uniforms, uLandRise: [Infinity, 0] },
    { ...uniforms, uLandRise: [1.1, 0] }]) assert.throws(() => assessMaterialFeatureExercise(invalid), /invalid/);
});

test('GPU summaries reject absent, unresolved and disjoint queries instead of reporting zero', () => {
  const f = { queries: 2, resolved: 2, disjoint: false, gpu: { terrain: 5, other: 2 }, cpu: { terrain: 1 }, frameMs: 3,
    calls: { terrain: 4 }, triangles: { terrain: 20 }, queryCoverage: {
      terrain: { attempted: 1, created: 1, failed: 0, resolved: 1 }, other: { attempted: 1, created: 1, failed: 0, resolved: 1 } } };
  const invalid = [{ ...f, queries: 0, resolved: 0 }, { ...f, resolved: 1 }, { ...f, disjoint: true }];
  assert.equal(summarizePilotFrames(invalid).gpuTerrainMs, null);
  const summary = summarizePilotFrames([f, ...invalid]);
  assert.equal(summary.validGpuSamples, 1); assert.equal(summary.gpuTerrainMs.p50, 5); assert.equal(summary.frameSubmissionMs.n, 4);
});

async function probeFrame({ queries = [{}, {}], extension = true, disjoint = false, available = true } = {}) {
  const terrain = {}, other = {}, deleted = [];
  const ext = { TIME_ELAPSED_EXT: 'elapsed', GPU_DISJOINT_EXT: 'disjoint' };
  let clock = 0;
  const gl = { QUERY_RESULT_AVAILABLE: 'available', QUERY_RESULT: 'result',
    getExtension: () => extension ? ext : null, createQuery: () => queries.shift() ?? null,
    beginQuery() {}, endQuery() {}, getParameter: () => disjoint,
    getQueryParameter: (query, key) => key === 'available' ? available : 1000000,
    deleteQuery: q => deleted.push(q) };
  const renderer = { getContext: () => gl, info: { render: { calls: 0, triangles: 0 } },
    render() { this.info.render.calls++; this.info.render.triangles += 10; } };
  const window = { __SMW: { sim: { biomes: { rangePresentation: { scene: {
    renderer, prepared: new Map([['pilot', { scenes: { near: terrain } }]]) } } } } } };
  vm.runInNewContext(`(${installPilotProbe.toString()})()`, { window, setTimeout,
    performance: { now: () => { clock += available ? 1 : 11000; return clock; } } });
  window.__pilotProbe.begin(); renderer.render(terrain); renderer.render(other);
  window.__pilotProbe.end({ frameMs: 2, timeMs: 0 });
  return { frames: await window.__pilotProbe.finish(), deleted };
}

test('actual probe rejects partial query allocation instead of inventing zero terrain GPU time', async () => {
  const { frames } = await probeFrame({ queries: [null, {}] });
  const summary = summarizePilotFrames(frames);
  assert.equal(summary.validGpuSamples, 0);
  assert.equal(summary.gpuTerrainMs, null);
  assert.equal(summary.gpuOtherMs, null, 'any missing query invalidates the whole frame');
  assert.equal(frames[0].queryCoverage.terrain.attempted, 1);
  assert.equal(frames[0].queryCoverage.terrain.failed, 1);
  assert.equal(frames[0].queryCoverage.other.resolved, 1);
});

test('actual probe distinguishes full coverage from absent, disjoint and unresolved queries', async () => {
  const complete = await probeFrame();
  assert.equal(summarizePilotFrames(complete.frames).validGpuSamples, 1);
  assert.equal(summarizePilotFrames(complete.frames).gpuTerrainMs.p50, 1);
  for (const options of [{ extension: false }, { disjoint: true }, { available: false }]) {
    const result = await probeFrame(options);
    assert.equal(summarizePilotFrames(result.frames).validGpuSamples, 0);
    assert.equal(summarizePilotFrames(result.frames).gpuTerrainMs, null);
  }
});

function textureReadbackGL({ incomplete = false, failRead = false } = {}) {
  const previousRead = {}, previousDraw = {}, previousBuffer = {}, deleted = [];
  const parameters = new Map([['readBinding', previousRead], ['drawBinding', previousDraw], ['packBinding', previousBuffer],
    ['alignment', 4], ['rowLength', 8], ['skipPixels', 2], ['skipRows', 3]]);
  const original = new Map(parameters); let attachment;
  const gl = { NO_ERROR: 0, FRAMEBUFFER_COMPLETE: 'complete', READ_FRAMEBUFFER_BINDING: 'readBinding',
    DRAW_FRAMEBUFFER_BINDING: 'drawBinding', PIXEL_PACK_BUFFER_BINDING: 'packBinding', PIXEL_PACK_BUFFER: 'packBuffer',
    PACK_ALIGNMENT: 'alignment', PACK_ROW_LENGTH: 'rowLength', PACK_SKIP_PIXELS: 'skipPixels', PACK_SKIP_ROWS: 'skipRows',
    READ_FRAMEBUFFER: 'read', DRAW_FRAMEBUFFER: 'draw', COLOR_ATTACHMENT0: 'color', TEXTURE_2D: 'texture2d', RGBA: 'rgba', UNSIGNED_BYTE: 'byte',
    getError: () => 0, getParameter: key => parameters.get(key), createFramebuffer: () => ({}),
    bindFramebuffer: (target, value) => parameters.set(target === 'read' ? 'readBinding' : 'drawBinding', value),
    framebufferTexture2D: (target, attachmentKind, textureKind, handle) => { attachment = handle; },
    checkFramebufferStatus: () => incomplete ? 'incomplete' : 'complete', readBuffer() {},
    bindBuffer: (target, value) => parameters.set('packBinding', value), pixelStorei: (key, value) => parameters.set(key, value),
    readPixels: (x, y, width, height, format, type, pixels) => { if (failRead) throw Error('injected read failure'); pixels.set(attachment.pixels); },
    deleteFramebuffer: f => deleted.push(f) };
  return { gl, parameters, original, deleted };
}

test('actual texture readback fingerprints different texels with identical metadata and restores GL state', async () => {
  const read = vm.runInNewContext(`(${readPilotTextureContent.toString()})`, { Uint8Array, crypto: webcrypto });
  const fixture = textureReadbackGL(), firstBytes = new Uint8Array([1, 2, 3, 255]);
  const first = await read({ gl: fixture.gl, textureHandle: { pixels: firstBytes }, width: 1, height: 1 });
  const second = await read({ gl: fixture.gl, textureHandle: { pixels: new Uint8Array([1, 2, 4, 255]) }, width: 1, height: 1 });
  assert.equal(first.sha256, createHash('sha256').update(firstBytes).digest('hex'));
  assert.notEqual(first.sha256, second.sha256);
  assert.deepEqual(fixture.parameters, fixture.original); assert.equal(fixture.deleted.length, 2);
  const reference = frame('reference'), candidate = frame('warp');
  reference.materialState.uniforms.uSurface.content = first;
  candidate.materialState.uniforms.uSurface.content = first;
  assert.doesNotThrow(() => assertMaterialFeatureFrameMatch(reference, candidate));
  candidate.materialState.uniforms.uSurface.content = second;
  assert.throws(() => assertMaterialFeatureFrameMatch(reference, candidate), /different material uniforms/);
});

test('unverifiable texture readbacks fail and restore bindings on error', async () => {
  for (const options of [{ incomplete: true }, { failRead: true }]) {
    const fixture = textureReadbackGL(options);
    await assert.rejects(readPilotTextureContent({ gl: fixture.gl, textureHandle: {}, width: 1, height: 1 }));
    assert.deepEqual(fixture.parameters, fixture.original); assert.equal(fixture.deleted.length, 1);
  }
  await assert.rejects(readPilotTextureContent({ gl: {}, textureHandle: {}, width: 4096, height: 4096 }), /scratch cap/);
});
