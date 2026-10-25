import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DISPLAY_PREFS, resolveDisplayPrefs, resolvePresentation, readDisplayPrefs, writeDisplayPrefs } from '../src/render/DisplayProfile.js';
import { parseBulkArgs } from '../src/render/BulkExport.js';
import { createPresentingRenderer } from '../src/render/PresentingRenderer.js';

test('Cinematic Pixel survives storage and export without changing grid or quality', () => {
  const saved = { ...DEFAULT_DISPLAY_PREFS, look: 'cinematic', pixelGrid: 'classicPlus' };
  assert.deepEqual(resolveDisplayPrefs({ saved }), saved);
  const records = new Map();
  const storage = { getItem: k => records.get(k), setItem: (k,v) => records.set(k,v) };
  assert.equal(writeDisplayPrefs(storage, saved), true);
  assert.deepEqual(readDisplayPrefs(storage), saved);
  const p = resolvePresentation(saved);
  assert.equal(p.cinematicPixel, true);
  assert.equal(p.grid.id, 'classicPlus');
  assert.equal(p.quality, 'auto');
  assert.equal(p.paletteId, 'none');
  assert.deepEqual(parseBulkArgs(['--look', 'cinematic', '--pixel-grid', 'classicPlus', 'song.wav']).presentation, saved);
  assert.equal(resolvePresentation(DEFAULT_DISPLAY_PREFS).cinematicPixel, undefined);
});

test('a live Look switch reaches the terrain and sky on that draw and resets on return', () => {
  const range = {}, manager = { world: { kind: 'alpine' } }, contexts = [];
  const makeCanvas = () => {
    const canvas = { width: 400, height: 225 };
    const ctx = { setTransform(){}, fillRect(){}, drawImage(){} };
    canvas.getContext = kind => kind === '2d' ? ctx : null;
    canvas.ownerDocument = { createElement: makeCanvas };
    return canvas;
  };
  const renderer = createPresentingRenderer({ canvas: makeCanvas(), presentation: resolvePresentation({ ...DEFAULT_DISPLAY_PREFS, look: 'cinematic', pixelGrid:'classicPlus' }),
    rendererFactory: () => ({ rangePresentation: range, draw(){ contexts.push([range.cinematicPixel, manager.cinematicPixel]); }, dispose(){} }) });
  renderer.draw({biomes:manager}, 0);
  assert.deepEqual(contexts[0], [true,true]);
  assert.equal(renderer.diagnostics.effectiveLook, 'cinematic');
  renderer.setPresentation(resolvePresentation({ ...DEFAULT_DISPLAY_PREFS, pixelGrid:'classicPlus' }));
  renderer.draw({biomes:manager}, 0);
  assert.deepEqual(contexts[1], [false,false]);
  assert.equal(renderer.diagnostics.effectiveLook, 'pixel');
  renderer.dispose();
});
