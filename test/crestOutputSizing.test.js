import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresentingRenderer } from '../src/render/PresentingRenderer.js';
import { RangePresentation } from '../src/world/alpine/RangePresentation.js';
import { pixelGrid } from '../src/render/PixelRenderPolicy.js';

function surface(width = 1280, height = 720) {
  const canvas = { width, height };
  const ctx = { canvas, setTransform() {}, save() {}, restore() {}, fillRect() {}, clearRect() {}, drawImage() {} };
  canvas.getContext = () => ctx;
  canvas.ownerDocument = { createElement: () => surface(0, 0) };
  return canvas;
}
const pixel = { pixelated: true, grid: pixelGrid(), paletteId: 'none', scaling: 'fit', rangePipeline: 'hybrid' };

test('crest resolution follows the physical output before drawing and is cleared for disabled overlays', () => {
  const canvas = surface(), seen = [];
  const range = { enabled: true, crestEnabled: false, drawCrestForeground() { return true; } };
  const inner = { rangePresentation: range, draw() {
    seen.push({ size: range.crestOutputSize, enabled: range.crestEnabled, native: [this.canvas.width, this.canvas.height] });
  }, dispose() {} };
  const renderer = createPresentingRenderer({ canvas, presentation: pixel, rendererFactory: () => inner });
  const sim = { biomes: { world: { kind: 'alpine' } } };
  const draw = () => { assert.equal(renderer.draw(sim, 0).presented, true); return seen.at(-1); };
  assert.deepEqual(draw(), { size: { width: 1280, height: 720 }, enabled: true, native: [320, 180] });
  canvas.width = 800; canvas.height = 600;
  assert.deepEqual(draw().size, { width: 800, height: 600 }, 'fullscreen uses physical canvas dimensions, not CSS or native grid size');
  renderer.setPresentation({ ...pixel, rangePipeline: 'single' });
  assert.deepEqual(draw(), { size: null, enabled: false, native: [320, 180] });
  renderer.setPresentation(pixel);
  assert.equal(draw().enabled, true);
  range.enabled = false;
  assert.equal(draw().size, null);
  renderer.dispose();
});

test('entering direct terrain after a crest frame clears the obsolete crest output size', () => {
  const canvas = surface(), range = { enabled: true, crestEnabled: false, drawCrestForeground() { return true; } };
  const renderer = createPresentingRenderer({ canvas, presentation: pixel,
    rendererFactory: () => ({ rangePresentation: range, draw() {}, dispose() {} }) });
  const sim = { biomes: { world: { kind: 'alpine' } } };
  renderer.draw(sim, 0);
  assert.deepEqual(range.crestOutputSize, { width: 1280, height: 720 });
  renderer.setPresentation({ ...pixel, directTerrain: true });
  assert.equal(renderer.draw(sim, 0).presented, true);
  assert.equal(range.crestEnabled, false);
  assert.equal(range.crestOutputSize, null);
  renderer.dispose();
});

const view = {
  id: 'crest-sizing-view', regionId: 'crest-sizing-region', biome: 'RAINFOREST', status: 'candidate', catalogVersion: 1,
  terrainManifestUrl: 'terrain/view.terrain.json', materialManifestUrl: 'materials/view.json',
  camera: { eyeStartM: [0, 1500, 0], eyeEndM: [10, 1500, 0], targetStartM: [0, 700, -9000], targetEndM: [10, 700, -9000], fovYDeg: 35 },
};
const inputs = () => ({
  sim: { songSeed: 1, perf: { level: 0 }, biomes: { currentBlend: { from: view.biome, to: view.biome, t: 1 },
    sections: [{ profile: { name: view.biome } }], tSec: 1, durationMs: 1000, _profile: () => null, world: {} } },
  pose: { worldX: 0, midioX: 0, midioDrawX: 0, midioY: 0 },
  scenicViewport: { logicalWidth: 1408, logicalHeight: 848, backingWidth: 1408, backingHeight: 848 },
  groundViewport: { logicalWidth: 1408, logicalHeight: 848 },
});

test('Range converts crest output dimensions against the selected pixel grid without using direct-mode outputSize', async () => {
  const scene = { prepared: new Map(), contextLost: false, prepare: async () => ({}), isReady: () => true,
    resize() {}, release() {}, dispose() {}, snapshot: () => ({}) };
  const range = new RangePresentation({ mode: 'v2', shots: false, catalog: { catalogVersion: 1, views: [view] }, sceneFactory: async () => scene });
  range.setSong({ terrain: { sceneByBiome: new Map([[view.biome, { view }]]) }, generation: 1 });
  await range.whenReady();
  range.pixelated = true; range.crestEnabled = true;
  range.outputSize = { width: 9999, height: 9999 };
  const begin = () => { range.setFrameInputs(inputs()); assert.equal(range.beginScenic(), true); return scene.crestOutputScale; };
  range.pixelPolicy = { active: true, grid: pixelGrid() };
  range.crestOutputSize = { width: 1280, height: 720 };
  assert.equal(begin(), 4);
  range.crestOutputSize = { width: 800, height: 600 };
  assert.equal(begin(), 600 / 180, 'cover needs enough fine columns for the larger fitted axis');
  range.pixelPolicy = { active: true, grid: pixelGrid('detailed') };
  assert.equal(begin(), 600 / 360, 'changing detail uses its actual grid dimensions');
  range.crestOutputSize = { width: 160, height: 90 };
  assert.equal(begin(), 1, 'small output does not undersample the native grid');
  range.crestOutputSize = { width: 1280, height: 720 };
  range.crestEnabled = false;
  assert.equal(begin(), 1);
  range.crestEnabled = true; range.directTerrainMode = true;
  assert.equal(begin(), 1);
  range.directTerrainMode = false; range.pixelated = false;
  assert.equal(begin(), 1);
  range.pixelated = true; range.pixelPolicy = null;
  assert.equal(begin(), 1);
  range.dispose();
});
