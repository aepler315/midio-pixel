import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresentingRenderer } from '../src/render/PresentingRenderer.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';

function canvas(width = 1280, height = 720) {
  const target = { width, height, reads: 0, writes: 0, calls: [], fills: [], transforms: [] };
  const ctx = {
    canvas: target, imageSmoothingEnabled: true, globalAlpha: 1, globalCompositeOperation: 'source-over',
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic',
    setTransform(...args) { target.transforms.push(['set', ...args]); },
    translate(...args) { target.transforms.push(['translate', ...args]); },
    save() { target.calls.push(['save']); },
    restore() { target.calls.push(['restore']); },
    beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, stroke() {}, fill() {}, closePath() {}, clip() {},
    rect() {}, strokeRect() {}, fillRect(...args) { target.fills.push(args); },
    fillText(text, x, y) { target.calls.push(['fillText', text, x, y]); },
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    measureText(text) { return { width: String(text).length * 7 }; },
    drawImage(...args) { target.calls.push(['drawImage', ...args]); },
    getImageData() { target.reads++; return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
    putImageData() { target.writes++; },
  };
  target.getContext = (type) => String(type).startsWith('webgl') ? null : ctx;
  target.ownerDocument = { createElement: () => canvas(0, 0) };
  return target;
}

function sim(overrides = {}) {
  return {
    heardTimeMs: 30000,
    durationMs: 120000,
    biomes: {
      world: { kind: 'alpine' },
      sections: [{ startMs: 0, endMs: 60000, role: 'verse' }, { startMs: 60000, endMs: 120000, role: 'chorus' }],
      songprint: {
        timeline: {
          stepMs: 2000,
          loudness: [0.2, 0.4, 0.6, 0.5],
          brightness: [0.3, 0.5, 0.7, 0.6],
          tension: [0.1, 0.2, 0.4, 0.3],
          novelty: [0.1, 0.3, 0.2, 0.1],
          major: [0.5, 0.6, 0.7, 0.6],
          key: { tonic: 0, major: true, confidence: 0.8 },
        },
        skyline: [0.2, 0.3, 0.4, 0.5, 0.6, 0.5, 0.4, 0.3, 0.2, 0.3, 0.4, 0.5, 0.4, 0.3, 0.2, 0.1],
        passages: [{ timeMs: 15000, landmark01: 0.8 }],
      },
    },
    energyCurves: { globalEnergyNorm: (ms) => Math.max(0, Math.min(1, ms / 120000)) },
    ...overrides,
  };
}

test('songprint2d presentation draws a direct 2D frame and skips 3D inner draw', () => {
  const out = canvas();
  let innerDraws = 0;
  const inner = {
    canvasRenderer: { discardFrameCaptures() {} },
    rangePresentation: { enabled: true },
    draw() { innerDraws++; },
    dispose() {},
  };
  const renderer = createPresentingRenderer({
    canvas: out,
    presentation: { pixelated: true, cinematicPixel: true, grid: { width: 320, height: 180 }, scaling: 'fit', songVisualization: 'songprint2d' },
    residency: new GraphicsResidency(),
    rendererFactory: () => inner,
  });

  const result = renderer.draw(sim(), 1);
  assert.equal(innerDraws, 0, '3D scene draw should be skipped');
  assert.equal(result.presented, true);
  assert.equal(renderer.diagnostics.songVisualization, 'songprint2d');
  assert.equal(renderer.diagnostics.effectiveLook, 'songprint2d');
  assert.equal(renderer.diagnostics.directTerrain, false);
  const capture = renderer.getCaptureSource();
  assert.ok(capture, 'capture source should be available for export');
  assert.equal(capture.canvas, out);
  assert.ok(out.calls.some(c => c[0] === 'fillText' && String(c[1]).includes('Songprint Fable')), 'fable label drawn');
  renderer.dispose();
});

test('songprint2d presentation prefers faithful fable descriptor when present', () => {
  const out = canvas();
  const inner = { canvasRenderer: { discardFrameCaptures() {} }, rangePresentation: { enabled: true }, draw() { throw new Error('should not draw 3D'); }, dispose() {} };
  const renderer = createPresentingRenderer({
    canvas: out,
    presentation: { pixelated: true, cinematicPixel: true, grid: { width: 320, height: 180 }, scaling: 'fit', songVisualization: 'songprint2d' },
    rendererFactory: () => inner,
  });
  const slices = 8;
  const chroma = Array.from({ length: slices * 12 }, (_, i) => (i % 12 === 0 ? 1 : 0.1));
  const tone = Array.from({ length: slices * 3 }, (_, i) => (i % 3 === 2 ? -12 : 0));
  const s = sim();
  s.biomes.songprint.fable = { version: 1, slices, sliceSeconds: 2, lastFraction: 1, keyAngle: 0, chroma, tone };
  const result = renderer.draw(s, 1);
  assert.equal(result.presented, true);
  assert.ok(out.calls.some(c => c[0] === 'fillText' && String(c[1]).includes('fable descriptor')), 'fable descriptor source drawn');
  renderer.dispose();
});

test('songprint2d presentation falls back gracefully with missing song data', () => {
  const out = canvas();
  const inner = { canvasRenderer: { discardFrameCaptures() {} }, rangePresentation: { enabled: true }, draw() {}, dispose() {} };
  const renderer = createPresentingRenderer({
    canvas: out,
    presentation: { pixelated: true, cinematicPixel: true, grid: { width: 320, height: 180 }, scaling: 'fit', songVisualization: 'songprint2d' },
    rendererFactory: () => inner,
  });
  const result = renderer.draw({ heardTimeMs: 0, durationMs: 1000, biomes: { world: { kind: 'alpine' } } }, 1);
  assert.equal(result.presented, true);
  renderer.dispose();
});
