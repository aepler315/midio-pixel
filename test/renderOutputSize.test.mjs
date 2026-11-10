import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createPresentingRenderer } from '../src/render/PresentingRenderer.js';
import { resolvePresentation } from '../src/render/DisplayProfile.js';
import { PerfGovernor } from '../src/render/PerfGovernor.js';
import { resolveRangePipeline } from '../src/render/RenderOutputSize.js';

const { stageOutputSize } = await import('../src/render/RenderOutputSize.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const size = options => {
  assert.equal(typeof stageOutputSize, 'function');
  return stageOutputSize({ grid: { width: 320, height: 180 }, ...options });
};

test('hybrid output matches the displayed content density with a 1080p ceiling', () => {
  assert.deepEqual(size({ hybrid: true, cssWidth: 1280, cssHeight: 720, dpr: 1.5 }), { w: 1920, h: 1080 });
  assert.deepEqual(size({ hybrid: true, cssWidth: 3840, cssHeight: 2160, dpr: 2 }), { w: 1920, h: 1080 });
  assert.deepEqual(size({ hybrid: true, cssWidth: 960, cssHeight: 600, dpr: 1.25 }), { w: 1200, h: 675 });
});

test('fullscreen landscape output matches physical viewport dimensions', () => {
  assert.deepEqual(size({ hybrid: true, fullscreen: true, cssWidth: 1024, cssHeight: 600, dpr: 1.5 }), { w: 1536, h: 900 });
  assert.deepEqual(size({ hybrid: true, fullscreen: true, cssWidth: 2560, cssHeight: 1440, dpr: 1 }), { w: 2560, h: 1440 });
  assert.deepEqual(size({ hybrid: true, fullscreen: true, cssWidth: 800, cssHeight: 480, dpr: 1, scale: 0.625 }), { w: 800, h: 480 });
});

test('portrait output spends its resolution on the contained landscape picture', () => {
  assert.deepEqual(size({ hybrid: true, cssWidth: 390, cssHeight: 844, dpr: 3 }), { w: 1170, h: 658 });
  assert.deepEqual(size({ hybrid: true, cssWidth: 0, cssHeight: 0, dpr: 1 }), { w: 320, h: 180 });
});

test('heavier quality rungs buy pixels first, in whole terrain cells', () => {
  // The ladder's own resolution scale, as fitCanvas passes it.
  const scaleAt = level => { const gov = new PerfGovernor(); gov.setFixtureLevel(level); return gov.resolutionScale(180, { adaptive: true }); };
  // A phone at DPR 2.6 (915x412 CSS): the full 1080p hybrid output at rungs
  // 0-1, then 900, 720 and 540 lines -- multiples of the 180-row grid.
  const phone = level => size({ hybrid: true, cssWidth: 915, cssHeight: 412, dpr: 2.625, scale: scaleAt(level) });
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(level => phone(level).h), [1080, 1080, 900, 720, 540, 540, 540]);
  assert.deepEqual(phone(6), { w: 960, h: 540 });
  // Never below two output rows per grid row, nor above the display.
  const car = level => size({ hybrid: true, cssWidth: 800, cssHeight: 480, dpr: 1, scale: scaleAt(level) });
  assert.deepEqual([0, 1, 2, 4, 6].map(level => car(level).h), [450, 450, 360, 360, 360]);
  const detailed = size({ hybrid: true, grid: { width: 640, height: 360 }, cssWidth: 1920, cssHeight: 1080, dpr: 1, scale: scaleAt(6) });
  assert.deepEqual(detailed, { w: 1280, h: 720 });
  const tiny = size({ hybrid: true, cssWidth: 480, cssHeight: 270, dpr: 1, scale: scaleAt(6) });
  assert.deepEqual(tiny, { w: 480, h: 270 }, 'a display under two rows per cell keeps its own size');
  // Exports and uniform pixel scenes are unaffected by the rung.
  assert.deepEqual(size({ hybrid: true, exportSize: { w: 3840, h: 2160 }, scale: scaleAt(6) }), { w: 3840, h: 2160 });
  assert.deepEqual(size({ hybrid: false, cssWidth: 3840, cssHeight: 2160, dpr: 2, scale: scaleAt(6) }), { w: 320, h: 180 });
});

test('uniform pixel scenes retain their native grid and exports retain exact requested dimensions', () => {
  assert.deepEqual(size({ hybrid: false, cssWidth: 3840, cssHeight: 2160, dpr: 2 }), { w: 320, h: 180 });
  assert.deepEqual(size({ hybrid: false, grid: { width: 640, height: 360 } }), { w: 640, h: 360 });
  assert.deepEqual(size({ hybrid: true, exportSize: { w: 3840, h: 2160 } }), { w: 3840, h: 2160 });
});

test('native stage bounds the complete live picture even in physical-pixel fullscreen', () => {
  assert.deepEqual(size({ hybrid: true, nativeStage: true, fullscreen: true,
    cssWidth: 2560, cssHeight: 1440, dpr: 1.75 }), { w: 320, h: 180 });
  assert.deepEqual(size({ hybrid: true, nativeStage: true, grid: { width: 640, height: 360 },
    cssWidth: 390, cssHeight: 844, dpr: 3 }), { w: 640, h: 360 });
  assert.deepEqual(size({ hybrid: true, nativeStage: true, exportSize: { w: 3840, h: 2160 } }), { w: 3840, h: 2160 });
});

test('diagnostic pipeline selection ignores unknown URL values', () => {
  assert.equal(resolveRangePipeline('?rangePipeline=native'), 'native');
  assert.equal(resolveRangePipeline('?rangePipeline=single'), 'single');
  assert.equal(resolveRangePipeline('?rangePipeline=hybrid'), 'hybrid');
  assert.equal(resolveRangePipeline('?rangePipeline=invalid'), resolveRangePipeline(''));
});

test('ordinary Landscape uses one stage while high-resolution capture and Cinematic use their presentation', () => {
  const begin = main.indexOf('function effectivePresentation()');
  const code = main.slice(begin, main.indexOf('\n}\n', begin) + 3);
  const context = vm.createContext({ bulkPresentation: null, presentation: { scaling: 'fit' },
    directTerrainExperiment: () => false, requestedRangePipeline: resolveRangePipeline(''),
    location: { search: '' }, experience: 'landscape', bulkExportSize: null, document: {}, isFullscreen: () => false });
  vm.runInContext(code, context);
  assert.equal(context.effectivePresentation().rangePipeline, 'single');
  context.presentation.cinematicPixel = true;
  assert.equal(context.effectivePresentation().rangePipeline, 'hybrid');
  context.presentation.cinematicPixel = false;
  context.bulkExportSize = { w: 3840, h: 2160 };
  assert.equal(context.effectivePresentation().rangePipeline, 'hybrid');
});

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
test('fullscreen landscape selects cover and restores the saved fit on exit', () => {
  const start = main.indexOf('function effectivePresentation()');
  const code = main.slice(start, main.indexOf('\n}\n', start) + 3);
  const context = vm.createContext({ bulkPresentation: null, presentation: { scaling: 'fit' },
    directTerrainExperiment: () => false, requestedRangePipeline: 'hybrid', location: { search: '' }, experience: 'landscape',
    bulkExportSize: null, document: {}, isFullscreen: () => true });
  vm.runInContext(code, context);
  assert.equal(context.effectivePresentation().scaling, 'cover');
  context.isFullscreen = () => false;
  assert.equal(context.effectivePresentation().scaling, 'fit');
});
const start = main.indexOf('function fitCanvas()');
const fitCanvas = main.slice(start, main.indexOf('\n}\n', start) + 3);
test('fullscreen entry and exit resize the landscape while retaining the saved scaling preference', () => {
  const prefStart = main.indexOf('function effectivePresentation()');
  const prefCode = main.slice(prefStart, main.indexOf('\n}\n', prefStart) + 3);
  let fullscreen = false, selected;
  const canvas = { width: 320, height: 180, classList: { toggle() {} },
    getBoundingClientRect: () => ({ width: 1024, height: 600 }), getContext: () => ({}) };
  const context = vm.createContext({ bulkPresentation: null, presentation: { scaling: 'fit', grid: { width: 320, height: 180 } },
    directTerrainExperiment: () => false, requestedRangePipeline: 'hybrid', location: { search: '' }, experience: 'landscape',
    document: {}, isFullscreen: () => fullscreen, renderer: { setPresentation(value) { selected = value; } },
    titlePresentation: null, fitPixelLayout() {}, perfGovernor: null, bulkExportSize: null, canvas, stageOutputSize,
    sim: { biomes: { world: { kind: 'alpine' } } }, rangePresentation: { enabled: true }, voxelRangePilot: null,
    lastTimelineData: null, lastWorldId: 'alpine', DEFAULT_WORLD_ID: 'alpine', getWorld: () => ({ kind: 'alpine' }),
    window: { devicePixelRatio: 1.5 }, landscapeHintEl: null,
    resizeStageCanvas(target, w, h) { target.width = w; target.height = h; },
  });
  vm.runInContext(prefCode + '\n' + fitCanvas, context);
  fullscreen = true; context.fitCanvas();
  assert.deepEqual([canvas.width, canvas.height, selected.scaling], [1536, 900, 'cover']);
  fullscreen = false; context.fitCanvas();
  assert.deepEqual([canvas.width, canvas.height, selected.scaling], [1536, 864, 'fit']);
  assert.equal(context.presentation.scaling, 'fit');
});
for (const { pixelGrid, bulkExportSize = null, fullscreen = false, rangePipeline, buildPixelDetail = false, expected } of [
  { pixelGrid: 'classic', expected: [1920, 1080] },
  { pixelGrid: 'detailed', expected: [1920, 1080] },
  { pixelGrid: 'classic', bulkExportSize: { w: 3840, h: 2160 }, expected: [3840, 2160] },
  { pixelGrid: 'classic', fullscreen: true, expected: [1920, 1080] },
  { pixelGrid: 'classic', rangePipeline: 'single', buildPixelDetail: true, expected: [1920, 1080] },
  { pixelGrid: 'classic', rangePipeline: 'native', expected: [320, 180] },
  { pixelGrid: 'detailed', rangePipeline: 'single', expected: [640, 360] },
  { pixelGrid: 'classic', rangePipeline: 'single', fullscreen: true, expected: [320, 180] },
]) test(`actual fitCanvas sizes landscape ${pixelGrid}${rangePipeline ? ' ' + rangePipeline : ''}${bulkExportSize ? ' export' : ''}`, () => {
  const active = { ...resolvePresentation({ version: 2, look: 'pixel', pixelGrid, buildPixelDetail }),
    ...(rangePipeline ? { rangePipeline, scaling: fullscreen ? 'cover' : 'fit' } : {}) };
  const flags = new Map(), outputCtx = { setTransform() {}, fillRect() {}, drawImage() {} };
  const makeCanvas = () => ({ width: 0, height: 0, getContext: () => ({}) });
  let laidOut = false, terrainSize;
  const canvas = { width: 320, height: 180, classList: { toggle: (name, value) => flags.set(name, value), add: name => flags.set(name, true) },
    getBoundingClientRect() { assert.ok(laidOut, 'CSS integer fitting must precede physical sizing'); return { width: 1280, height: 720 }; },
    getContext: () => outputCtx, ownerDocument: { createElement: makeCanvas } };
  const renderer = createPresentingRenderer({ canvas, presentation: active, rendererFactory: () => ({
    draw() { terrainSize = [this.canvas.width, this.canvas.height]; }, dispose() {},
  }) });
  const context = vm.createContext({ effectivePresentation: () => active, renderer, titlePresentation: null,
    fitPixelLayout() { laidOut = true; }, perfGovernor: null, bulkExportSize, canvas, stageOutputSize,
    sim: { timeMs: 15950, biomes: { world: { kind: 'alpine' } } }, rangePresentation: { enabled: true }, voxelRangePilot: null,
    lastTimelineData: null, lastWorldId: 'alpine', DEFAULT_WORLD_ID: 'alpine', getWorld: () => ({ kind: 'alpine' }),
    window: { devicePixelRatio: 1.5 }, document: {}, isFullscreen: () => fullscreen, landscapeHintEl: null,
    resizeStageCanvas(target, w, h) { target.width = w; target.height = h; },
  });
  try {
    vm.runInContext(fitCanvas, context); context.fitCanvas();
    assert.deepEqual([canvas.width, canvas.height], expected);
    assert.equal(context.sim.timeMs, 15950, 'resizing cannot move the heard performance');
    assert.equal(flags.get('retro'), !!rangePipeline);
    assert.equal(flags.get('nativeCover'), !!rangePipeline && fullscreen, 'CSS crop must match fullscreen pointer mapping');
    renderer.draw(context.sim, 1);
    assert.deepEqual(terrainSize, [active.grid.width, active.grid.height]);
  } finally { renderer.dispose(); }
});

test('growing single-stage detail admits physical output once and honors quality in fullscreen', () => {
  const opts = { grid: { width: 320, height: 180 }, hybrid: true, nativeStage: true,
    progressiveDetail: true, cssWidth: 1280, cssHeight: 720, dpr: 1 };
  assert.deepEqual(stageOutputSize(opts), { w: 1280, h: 720 });
  assert.deepEqual(stageOutputSize({ ...opts, scale: .75 }), { w: 960, h: 540 });
  assert.deepEqual(stageOutputSize({ ...opts, fullscreen: true, scale: .75 }), { w: 960, h: 540 });
  assert.deepEqual(stageOutputSize({ ...opts, progressiveDetail: false }), { w: 320, h: 180 });
  assert.deepEqual(stageOutputSize({ ...opts, exportSize: { w: 1920, h: 1080 } }), { w: 1920, h: 1080 });
});

test('growing detail fits continuously while preserving the saved fixed integer preference', () => {
  const begin = main.indexOf('function effectivePresentation()');
  const code = main.slice(begin, main.indexOf('\n}\n', begin) + 3);
  const context = vm.createContext({ bulkPresentation: null,
    presentation: { scaling: 'integer', buildPixelDetail: true, paletteId: 'none' },
    directTerrainExperiment: () => false, requestedRangePipeline: 'single', voxelRangePilot: null,
    location: { search: '' }, experience: 'landscape', bulkExportSize: null, document: {}, isFullscreen: () => false });
  vm.runInContext(code, context);
  assert.equal(context.effectivePresentation().scaling, 'fit');
  assert.equal(context.presentation.scaling, 'integer');
  context.presentation.buildPixelDetail = false;
  assert.equal(context.effectivePresentation().scaling, 'integer');
});

for (const userAgent of ['Android 13', 'Desktop']) test(`actual ${userAgent} landscape snapshot temporarily selects fixed detail and restores growing playback`, async () => {
  const { captureDetailSnapshots, snapshotCapturePlan } = await import('../src/ui/DetailSnapshots.js');
  const begin = main.indexOf('async function saveDetailSnapshots()');
  const code = main.slice(begin, main.indexOf('\n}\n', begin) + 3);
  const savedPrefs = { version: 2, look: 'pixel', pixelGrid: 'medium', buildPixelDetail: true };
  const captured = [], drawn = [];
  const context = vm.createContext({ snapshotBusy: false, running: true, sim: {}, paused: true, playbackPreparing: false,
    bulkExportArmed: false, songRecorder: null, snapshotPlayerPrefs: null, bulkExportSize: null, displayPrefs: savedPrefs,
    presentation: resolvePresentation(savedPrefs), navigator: { userAgent }, canvas: { width: 960, height: 540 },
    resolvePresentation, snapshotCapturePlan, captureDetailSnapshots, snapshotFileName: (_date, level) => level,
    syncDetailControls() {}, syncDisplayControls() {}, wakeHud() {},
    fitCanvas() { context.canvas.width = context.bulkExportSize?.w || context.presentation.grid.width;
      context.canvas.height = context.bulkExportSize?.h || context.presentation.grid.height; },
    renderer: { draw() { drawn.push(context.presentation.buildPixelDetail); return { presented: true }; } },
    canvasToPng: async () => ({}), saveSnapshotFile(_png, name) { captured.push(name); },
    setTimeout(fn) { fn(); }, console: { error(error) { throw error; }, warn(error) { throw error; } },
    showErrorBanner(error) { throw Error(error); },
  });
  vm.runInContext(code, context);
  await context.saveDetailSnapshots();
  assert.equal(captured.length, userAgent.startsWith('Android') ? 1 : 5);
  assert.ok(drawn.slice(0, -1).every(growing => growing === false));
  assert.equal(drawn.at(-1), true);
  assert.equal(context.displayPrefs, savedPrefs);
  assert.equal(context.bulkExportSize, null);
  assert.equal(context.snapshotBusy, false);
});
