// E2/D1: the production composition order, end to end, without a GPU.
// The real Renderer.draw runs over a real BiomeManager; only leaf painters
// are recorded. This pins the order the VFX inventory documents: scenic
// partitions (far, mid, near), the foreground, the finishing passes, and
// the presentation that both the display and capture read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../src/render/Renderer.js';
import { createPresentingRenderer } from '../src/render/PresentingRenderer.js';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { pixelRenderPolicy } from '../src/render/PixelRenderPolicy.js';

function anyCtx() {
  const noop = () => {};
  const grad = { addColorStop: noop };
  let transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const handler = {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'getTransform') return () => ({ ...transform, transformPoint: (p) => p });
      if (key === 'setTransform') return (a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) => { transform = typeof a === 'object' ? { ...a } : { a, b, c, d, e, f }; };
      if (/^create(Linear|Radial|Conic)Gradient$/.test(key)) return () => grad;
      if (key === 'createPattern') return () => ({ setTransform: noop });
      if (key === 'measureText') return () => ({ width: 10 });
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return noop;
    },
    set(target, key, value) { target[key] = value; return true; },
  };
  return new Proxy({}, handler);
}

function composedFrame() {
  const log = [];
  const rec = (name) => function () { log.push(name); };
  const m = new BiomeManager({
    conductor: { barGrid: [], onBar: () => () => {}, on: () => () => {} },
    durationMs: 60000, canvasWidth: 1280, canvasHeight: 720, groundY: 625, songSeed: 3, worldId: 'range',
  });
  for (const name of ['_drawSky', '_drawSpectrumMassif', '_drawHorizonEQ', '_drawCrestLight', '_drawFarVignettes', '_drawMidDepthLife',
    '_drawGround', '_drawTerrainFooting', '_drawFlood', '_drawForegroundSwell', '_drawTransitionOverlays',
    '_drawFarShore', '_drawOcean', '_drawOceanLife', '_drawFataMorgana', 'drawDeepSky', '_drawCelestial', '_drawMoon']) m[name] = function () {};
  m._drawLegacyScenic = () => '#334455';
  m.spaceRidge.drawAurora = () => {};
  m.stripsFor = () => ({});
  m.drawForeground = rec('foreground');
  const presentation = {
    enabled: true, hasViewComposition: false, arrival: 1,
    setFrameInputs() { log.push('frame-inputs'); },
    beginScenic: () => true,
    drawPartition: (_ctx, pass) => { log.push(`scenic:${pass}`); return true; },
    groundReceivers: () => null,
  };
  const canvas = { width: 1280, height: 720, getContext: () => anyCtx() };
  const renderer = new Renderer(canvas);
  renderer.rangePresentation = presentation;
  renderer._groundResponse = { draw: rec('ground-response'), dispose() {} };
  for (const name of ['_drawBloom', '_drawHeatDistortion', '_drawFilmFinish']) renderer[name] = rec(name.replace(/^_draw/, '').toLowerCase());
  const sim = {
    biomes: m, timeMs: 5000, heardTimeMs: 5000, stageW: 1280, stageH: 720,
    camera: { zoom: 1, shakeX: 0, shakeY: 0, roll: 0 }, lerpState: () => ({ worldX: 0, midioX: 300 }),
    perf: { level: 0, particleMul: 1, heavyPostFx: true, veilEnabled: true }, filmFinish: true,
    reducedFlash: false, reducedMotion: false,
  };
  return { log, renderer, sim, m };
}

test('Renderer.draw composes scenic partitions, ground response, foreground, then finishing', () => {
  const { log, renderer, sim, m } = composedFrame();
  renderer.draw(sim, 1);
  assert.deepEqual(log.filter((x) => x !== 'frame-inputs'), [
    'scenic:far', 'scenic:mid', 'scenic:near', 'ground-response', 'foreground', 'bloom', 'heatdistortion', 'filmfinish']);
  assert.equal(log[0], 'frame-inputs', 'the Range receives this frame\'s viewports before any scenic pass');
  assert.equal(renderer.drawCount, 1);
  m.dispose();
});

test('the presenting renderer finishes the same composed source that capture reads', () => {
  const { log, renderer, sim, m } = composedFrame();
  const source = { width: 1280, height: 720, getContext: () => anyCtx() };
  const output = {
    presentation: { pixelated: false }, diagnostics: { frame: null },
    beginFrame() { log.length = 0; log.push('begin'); return source; },
    finishFrame() { log.push('finish'); return { ok: true }; },
    failFrame(reason) { log.push(`fail:${reason}`); return null; },
    getCaptureSource() { return source; }, setPresentation() {}, dispose() {},
  };
  const presenting = createPresentingRenderer({ canvas: {}, rendererFactory: () => renderer, presentation: {}, residency: new GraphicsResidency() });
  presenting.output.dispose();
  presenting.output = output;
  presenting.draw(sim, 1);
  assert.equal(renderer.canvas, source, 'the scene draws into the presentation source');
  assert.deepEqual([log[0], log.at(-1)], ['begin', 'finish']);
  assert.ok(log.indexOf('filmfinish') < log.indexOf('finish'), 'finishing passes land before the presentation finishes the frame');
  assert.equal(presenting.getCaptureSource(), source, 'capture reads the finished composed source');
  renderer.draw = () => { throw new Error('boom'); };
  assert.throws(() => presenting.draw(sim, 1), /boom/);
  assert.equal(log.at(-1), 'fail:scene-draw', 'a failed draw never finishes (publishes) a stale frame');
  presenting.dispose();
  assert.equal(presenting.getCaptureSource(), null);
  m.dispose();
});

test('latent ground response samples heard time and excludes future speaker-latency hits (M9)', () => {
  const { renderer, sim, m } = composedFrame();
  sim.timeMs = 5350; sim.heardTimeMs = 5000;
  sim.conductor = { timeline: [{ tMs: 4900, vel: .8, kick: true }, { tMs: 5200, vel: .9, kick: true }] };
  let frame;
  renderer._groundResponse.draw = (ctx, inputs) => { frame = inputs; };
  renderer.draw(sim, 1);
  assert.equal(frame.nowMs, 5000);
  assert.deepEqual(frame.hits.map(hit => hit.tMs), [4900]);
  m.dispose();
});
test('pixel caption glyphs enter the composed source after film effects', () => {
  const { renderer, sim, m, log } = composedFrame();
  renderer.canvas = { width: 320, height: 180 };
  renderer.ctx.fillRect = () => { if (renderer.ctx.fillStyle === '#f2f0f8') log.push('pixel-caption'); };
  renderer.pixelPolicy = pixelRenderPolicy({ pixelated: true });
  sim.rangeCaption = { rows: [{ name: 'Teton' }], credit: 'Elevation: USGS 3DEP' };
  renderer.draw(sim, 1);
  assert.ok(log.includes('pixel-caption'));
  assert.ok(log.indexOf('pixel-caption') > log.indexOf('filmfinish'));
  renderer.dispose(); m.dispose();
});

test('shedding shock quality releases its canvas outside the active drop window', () => {
  const { renderer, sim, m } = composedFrame();
  const { residency } = renderer._postBuffers;
  renderer._postBuffers.makeCanvas = () => ({ width: 0, height: 0 });
  renderer._shockCanvas = renderer._postBuffers.ensure('shock', 100, 100);
  const shock = renderer._shockCanvas;
  sim.perf.particleMul = .6;
  renderer._drawDropImpact({}, { width: 100, height: 100 }, { ...sim, timeMs: 5000, hype: { dropAtMs: 0 } }, {}, 625);
  assert.equal(shock.width, 0);
  assert.equal(renderer._postBuffers.buffers.has('shock'), false);
  assert.equal(renderer._shockCanvas, null);
  assert.equal(residency.snapshot().byOwner['canvas-post'], undefined);
  renderer.dispose(); m.dispose();
});
