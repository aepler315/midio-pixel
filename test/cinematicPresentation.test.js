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

test('Cinematic runs at its own detail level when none is chosen; a chosen one is kept', async () => {
  const { CINEMATIC_PIXEL_GRID, defaultGridFor } = await import('../src/render/DisplayProfile.js');
  assert.equal(CINEMATIC_PIXEL_GRID, 'detailed');
  assert.equal(defaultGridFor('cinematic'), 'detailed');
  for (const look of ['pixel', 'palette']) assert.equal(defaultGridFor(look), 'classic', `${look} keeps Classic`);
  // A record or export request without a valid grid takes the look's own.
  assert.equal(resolveDisplayPrefs({ saved: { version: 2, look: 'cinematic' } }).pixelGrid, 'detailed');
  assert.equal(resolveDisplayPrefs({ saved: { version: 2, look: 'cinematic', pixelGrid: 'broken' } }).pixelGrid, 'detailed');
  assert.equal(resolveDisplayPrefs({ saved: { version: 2, look: 'pixel' } }).pixelGrid, 'classic');
  assert.equal(parseBulkArgs(['--look', 'cinematic', 'song.wav']).presentation.pixelGrid, 'detailed');
  assert.equal(resolvePresentation({ version: 2, look: 'cinematic' }).grid.id, 'detailed');
  // Explicit choices, saved or requested, stay.
  assert.equal(resolveDisplayPrefs({ saved: { ...DEFAULT_DISPLAY_PREFS, look: 'cinematic', pixelGrid: 'classic' } }).pixelGrid, 'classic');
  const { parseReviewArgs } = await import('../tools/landscape-review.mjs');
  assert.deepEqual(parseReviewArgs(['--out', 'x', '--look', 'cinematic']).grids, ['detailed']);
  assert.deepEqual(parseReviewArgs(['--out', 'x']).grids, ['classic', 'detailed'], 'Pixel reviews keep both');
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

test('quality shedding keeps cinematic shading while skipping optional output reconstruction', async () => {
  const { PixelPresentation } = await import('../src/render/PixelPresentation.js');
  const { GraphicsResidency } = await import('../src/render/GraphicsResidency.js');
  let allocations = 0;
  const canvas = { width: 1280, height: 720, ownerDocument: { createElement() { allocations++; throw Error('must not allocate'); } } };
  const residency = new GraphicsResidency();
  const owner = new PixelPresentation({canvas, residency, presentation:resolvePresentation({...DEFAULT_DISPLAY_PREFS,look:'cinematic'})});
  owner.qualityLevel=2;
  assert.equal(owner.drawForeground({}, {width:320,height:180}, {width:1280,height:720}),false);
  assert.deepEqual(owner.diagnostics.cinematicReconstruction, {applied:false,reason:'quality',bytes:0});
  assert.equal(owner.presentation.cinematicPixel,true);
  assert.equal(allocations,0);
  assert.equal(residency.usedBytes,0);
  owner.dispose();
});
