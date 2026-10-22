import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createPresentingRenderer } from '../src/render/PresentingRenderer.js';
import { resolvePresentation } from '../src/render/DisplayProfile.js';

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

test('portrait output spends its resolution on the contained landscape picture', () => {
  assert.deepEqual(size({ hybrid: true, cssWidth: 390, cssHeight: 844, dpr: 3 }), { w: 1170, h: 658 });
  assert.deepEqual(size({ hybrid: true, cssWidth: 0, cssHeight: 0, dpr: 1 }), { w: 320, h: 180 });
});

test('uniform pixel scenes retain their native grid and exports retain exact requested dimensions', () => {
  assert.deepEqual(size({ hybrid: false, cssWidth: 3840, cssHeight: 2160, dpr: 2 }), { w: 320, h: 180 });
  assert.deepEqual(size({ hybrid: false, grid: { width: 640, height: 360 } }), { w: 640, h: 360 });
  assert.deepEqual(size({ hybrid: true, exportSize: { w: 3840, h: 2160 } }), { w: 3840, h: 2160 });
});

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const start = main.indexOf('function fitCanvas()');
const fitCanvas = main.slice(start, main.indexOf('\n}\n', start) + 3);
for (const { pixelGrid, experience = 'landscape', bulkExportSize = null, expected } of [
  { pixelGrid: 'classic', expected: [1920, 1080] },
  { pixelGrid: 'detailed', expected: [1920, 1080] },
  { pixelGrid: 'classic', experience: 'trio', expected: [320, 180] },
  { pixelGrid: 'detailed', experience: 'trio', expected: [640, 360] },
  { pixelGrid: 'classicPlus', experience: 'trio', expected: [400, 225] },
  { pixelGrid: 'medium', experience: 'trio', expected: [480, 270] },
  { pixelGrid: 'classic', bulkExportSize: { w: 3840, h: 2160 }, expected: [3840, 2160] },
]) test(`actual fitCanvas keeps ${experience} ${pixelGrid}${bulkExportSize ? ' export' : ''} output separate from terrain`, () => {
  const active = resolvePresentation({ version: 2, look: 'pixel', pixelGrid });
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
    experience, sim: { timeMs: 15950, biomes: { world: { kind: 'alpine' } } }, rangePresentation: { enabled: true },
    lastTimelineData: null, lastWorldId: 'alpine', DEFAULT_WORLD_ID: 'alpine', getWorld: () => ({ kind: 'alpine' }),
    window: { devicePixelRatio: 1.5 }, landscapeHintEl: null,
    resizeStageCanvas(target, w, h) { target.width = w; target.height = h; },
  });
  try {
    vm.runInContext(fitCanvas, context); context.fitCanvas();
    assert.deepEqual([canvas.width, canvas.height], expected);
    assert.equal(context.sim.timeMs, 15950, 'resizing cannot move the heard performance');
    assert.equal(flags.get('retro'), experience === 'trio', 'CSS must not pixelate the completed sky');
    renderer.draw({}, 1);
    assert.deepEqual(terrainSize, [active.grid.width, active.grid.height]);
  } finally { renderer.dispose(); }
});
