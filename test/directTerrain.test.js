import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresentingRenderer } from '../src/render/PresentingRenderer.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';

function canvas(width = 1280, height = 720) {
  const target = { width, height, reads: 0, writes: 0, calls: [], transforms: [] };
  const ctx = { canvas: target, imageSmoothingEnabled: true,
    setTransform(...args) { target.transforms.push(args); }, clearRect() {}, save() {}, restore() {},
    getTransform() { return { a: 1, b: 0 }; },
    drawImage(...args) { target.calls.push({ args, smoothing: this.imageSmoothingEnabled }); },
    getImageData() { target.reads++; return { width: target.width, height: target.height, data: new Uint8ClampedArray(target.width * target.height * 4) }; },
    putImageData() { target.writes++; },
  };
  target.getContext = () => ctx;
  target.ownerDocument = { createElement: () => canvas(0, 0) };
  return target;
}
const presentation = { pixelated: true, grid: { id: 'classic' }, paletteId: 'rgb332', dither: 1, scaling: 'fit', directTerrain: true };

test('direct mode renders at output resolution and palette-quantizes only a terrain partition', () => {
  const out = canvas(), scene = {}, range = { enabled: true };
  const inner = { canvasRenderer: scene, rangePresentation: range, dispose() {}, draw() {
    assert.notEqual(scene.canvas, out);
    assert.deepEqual([scene.canvas.width, scene.canvas.height], [1280, 720]);
    assert.equal(scene.pixelPolicy.active, false);
    assert.equal(range.pixelPolicy.active, true);
    assert.equal(range.directTerrainMode, true);
    assert.equal(range.drawTerrainImage(scene.ctx, { width: 320, height: 180 }, { width: 1280, height: 720 }), true);
  } };
  const manager = { world: { kind: 'alpine' } };
  const residency = new GraphicsResidency();
  const renderer = createPresentingRenderer({ canvas: out, presentation, residency, rendererFactory: () => inner });
  assert.equal(renderer.draw({ biomes: manager }, 0).presented, true);
  assert.equal(manager.highResolutionSky, true);
  assert.equal(manager.directFullResolution, true);
  assert.equal(out.reads, 0);
  const terrain = scene.canvas.calls.at(-1);
  assert.equal(terrain.smoothing, false);
  assert.equal(terrain.args[0].reads, 1);
  assert.equal(terrain.args[0].writes, 1);
  assert.equal(renderer.getCaptureSource().canvas, out);
  assert.equal(renderer.getCaptureSource().pixelated, false);
  assert.equal(renderer.getCaptureSource().terrainPixelated, true);
  renderer.dispose();
  assert.equal(residency.usedBytes, 0);
});

test('direct frame captures become stale on resize and failed frames', () => {
  const out = canvas(), manager = { world: { kind: 'alpine' } };
  const inner = { rangePresentation: { enabled: true }, draw() {}, dispose() {} };
  const renderer = createPresentingRenderer({ canvas: out, presentation, rendererFactory: () => inner });
  renderer.draw({ biomes: manager }, 0);
  assert.ok(renderer.getCaptureSource());
  out.width = 640;
  assert.equal(renderer.getCaptureSource(), null);
  manager._awaitingTerrain = true;
  assert.equal(renderer.draw({ biomes: manager }, 0).reason, 'terrain-not-ready');
  assert.equal(renderer.getCaptureSource(), null);
  renderer.dispose();
});

for (const [width, height] of [[2560, 1080], [800, 600]]) {
  test(`fullscreen direct terrain covers the complete ${width}x${height} output`, () => {
    const out = canvas(width, height), scene = {}, range = { enabled: true };
    const inner = { canvasRenderer: scene, rangePresentation: range, dispose() {}, draw() {
      assert.equal(scene.outputCover, true);
      range.drawTerrainImage(scene.ctx, { width: 320, height: 180 }, { width: 1280, height: 720 });
      const [x, y, paintedWidth, paintedHeight] = scene.canvas.calls.at(-1).args.slice(1);
      assert.ok(x <= 0 && y <= 0, 'terrain must start at or outside the top-left screen edge');
      assert.ok(x + paintedWidth >= width && y + paintedHeight >= height,
        'terrain must extend through the bottom-right screen edge');
    } };
    const renderer = createPresentingRenderer({ canvas: out,
      presentation: { ...presentation, scaling: 'cover', paletteId: 'none' }, rendererFactory: () => inner });
    assert.equal(renderer.draw({ biomes: { world: { kind: 'alpine' } } }, 0).presented, true);
    renderer.dispose();
  });
}


test('terrain grid is aligned to output despite camera rotation and translation', () => {
  const out = canvas(), scene = {}, range = { enabled: true };
  const inner = { canvasRenderer: scene, rangePresentation: range, dispose() {}, draw() {
    scene.ctx.getTransform = () => ({ a: 1.8, b: .3, c: -.3, d: 1.8, e: 23, f: 42 });
    range.drawTerrainImage(scene.ctx, { width: 320, height: 180 }, { width: 1280, height: 720 });
    const result = scene.canvas.calls.at(-1).args[0];
    assert.deepEqual(result.transforms[1], [.45, .075, -.075, .45, 5.75, 10.5]);
    assert.deepEqual(scene.canvas.transforms.at(-1), [1, 0, 0, 1, 0, 0]);
    assert.deepEqual(scene.canvas.calls.at(-1).args.slice(1), [0, 0, 1280, 720]);
  } };
  const renderer = createPresentingRenderer({ canvas: out, presentation, rendererFactory: () => inner });
  renderer.draw({ biomes: { world: { kind: 'alpine' } } }, 0);
  renderer.dispose();
});

test('direct terrain preview is explicitly selected by URL', async () => {
  const { directTerrainExperiment } = await import('../src/render/DirectTerrainExperiment.js');
  assert.equal(directTerrainExperiment(''), false);
  assert.equal(directTerrainExperiment('?directTerrain=1'), true);
  assert.equal(directTerrainExperiment('?directTerrain=0'), false);
});
