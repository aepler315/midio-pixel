import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RangePresentation, directTerrainViewport } from '../src/world/alpine/RangePresentation.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';

test('direct terrain grid follows fitted output including overscan', () => {
  const vp = { backingWidth: 1408, backingHeight: 848, logicalWidth: 1408 };
  const grid = { width: 320, height: 180 };
  assert.deepEqual(directTerrainViewport(vp, grid, { width: 1280, height: 720 }),
    { backingWidth: 352, backingHeight: 212, logicalWidth: 1408 });
  assert.equal(directTerrainViewport(vp, grid, { width: 1280, height: 960 }).backingWidth, 352);
  assert.equal(directTerrainViewport(vp, grid, null), vp);
});

test('direct composition draws nearest terrain before its band water', () => {
  const order = [];
  const img = { width: 352, height: 212 };
  const ctx = { save() {}, restore() {}, drawImage() { assert.fail('terrain compositor should draw image'); } };
  const pres = Object.assign(Object.create(RangePresentation.prototype), {
    active: true, frame: {}, viewId: 'test', arrival: 1, directTerrainMode: true,
    scene: { renderPartition() { order.push('render'); return img; } },
    drawTerrainImage(_ctx, source, _stage, size) {
      assert.equal(source, img); assert.deepEqual(size, { width: 352, height: 212 });
      order.push('terrain'); return true;
    },
    _drawDirectWater(_ctx, _stage, pass) { order.push(`water:${pass}`); },
    _noteTiming() {},
  });
  assert.equal(pres.drawPartition(ctx, 'far', { width: 1408, height: 848 }), true);
  assert.deepEqual(order, ['render', 'terrain', 'water:far']);
});

test('direct mid-band reflection backdrop does not paint sky twice', () => {
  let drawSky;
  const image = { width: 20, height: 10 };
  const ctx = { save() {}, restore() {}, drawImage() {}, canvas: { width: 1280, height: 720 } };
  const pres = Object.assign(Object.create(RangePresentation.prototype), {
    active: true, frame: {}, viewId: 'test', arrival: 1, directTerrainMode: true,
    frameInputs: { sim: { biomes: { highResolutionSky: true, rangeSkyLayer: {}, drawHighResolutionSky() {} } } },
    scene: { captureBackdrop(_ctx, _stage, _frame, sky) { drawSky = sky; }, renderPartition() { return image; } },
    _drawDirectWater() {}, _noteTiming() {},
  });
  pres.drawPartition(ctx, 'mid', { width: 20, height: 10 });
  assert.equal(drawSky, null);
});

test('direct water renders the current band twice and masks shoreline on native cells', () => {
  const calls = [];
  const ctx = { canvas: { width: 1280, height: 720 }, save() {}, restore() {}, setTransform() {},
    getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
    drawImage(img) { calls.push(['output', img.width, img.height]); } };
  const pres = Object.assign(Object.create(RangePresentation.prototype), {
    arrival: 1, frame: {}, viewId: 'v', residency: null,
    drawTerrainImage(_ctx, _img, _stage, size) { calls.push(['mask', size.width, size.height]); return true; },
    _makeCanvas(width, height) {
      return { width, height, getContext() { return {
        setTransform() {}, clearRect() {},
        drawImage(_img, ...args) { calls.push(['scratch', width, height, ...args]); },
        set globalCompositeOperation(v) { calls.push(['blend', v]); },
        set imageSmoothingEnabled(v) { calls.push(['smooth', v]); },
      }; } };
    },
    scene: { size: { width: 320, height: 180 }, waterOutputScale: 4, hasWater: () => true,
      renderWater(_frame, _view, w, h, options) { calls.push(['render', w, h, options.pass]); return { width: w, height: h }; } },
  });
  assert.equal(pres._drawDirectWater(ctx, { width: 1280, height: 720 }, 'mid'), true);
  assert.deepEqual(calls.filter(c => c[0] === 'render'), [['render', 320, 180, 'mid'], ['render', 1280, 720, 'mid']]);
  assert.ok(calls.some(c => c[0] === 'blend' && c[1] === 'destination-in'));
  assert.deepEqual(calls.at(-1), ['output', 1280, 720]);
});


test('water-only scene limits its colour draw to the selected band', () => {
  const rendered = [];
  const p = { view: {}, uniforms: { uViewportPx: { value: { set() {} } }, uWaterOnly: { value: 0 } },
    depthScene: 'depth', scenes: { far: 'far', mid: 'mid', near: 'near' } };
  const target = { width: 1280, height: 720, texture: {} };
  const scene = Object.assign(Object.create(RangeScene.prototype), {
    prepared: new Map([['v', p]]), target: {}, waterTarget: target, size: { width: 320, height: 180 },
    renderer: { setRenderTarget() {}, setClearColor() {}, clear() {}, render(which) { rendered.push(which); } },
    camera: { layers: { set() {}, enable() {} } }, canvas: {}, _setCamera() {}, _setUniforms() {},
    _prepareMirror() {}, _setCanvasSize() {}, _copyTexture() {},
  });
  assert.equal(scene.renderWater({}, 'v', 1280, 720, { pass: 'mid' }), scene.canvas);
  assert.deepEqual(rendered, ['depth', 'mid']);
  assert.equal(p.uniforms.uWaterOnly.value, 0);
});

test('direct travel water uses smooth seam blend and side-specific depth columns', () => {
  const sides = [];
  const columns = { A: { near: [0, .6] }, B: { near: [.4, 1] } };
  const pres = Object.assign(Object.create(RangePresentation.prototype), {
    arrival: 1, viewId: 'a', incomingViewId: 'b', scene: { size: {}, renderWater() {} },
    _renderDirectWater(_ctx, _stage, pass, id, side, cols) { sides.push([pass, id, side, cols]); return {}; },
    _compositeSides(_ctx, _stage, layer, a, b, _backing, opts) {
      assert.equal(layer, 'L5'); assert.equal(opts.smooth, true); a(); b(); return true;
    },
  });
  assert.equal(pres._drawDirectWater({}, {}, 'near', columns), true);
  assert.deepEqual(sides, [['near', 'a', 'A', columns.A], ['near', 'b', 'B', columns.B]]);
});

test('direct mode paints mid-depth life once without making a water mask', () => {
  let calls = 0;
  const pres = Object.assign(Object.create(RangePresentation.prototype), { directTerrainMode: true });
  pres.drawMidDepthForWater({}, {}, () => { calls++; });
  assert.equal(calls, 1); assert.equal(pres.waterEffectMask, null);
});

test('direct ground uses native viewport and passes the image through terrain presentation', () => {
  const pres = Object.assign(Object.create(RangePresentation.prototype), {
    active: true, directTerrainMode: true, viewId: 'v', arrival: 1,
    frame: { compositions: { v: { foreground: 'ledge' } }, groundViewport: { backingWidth: 1280, backingHeight: 720 } },
    pixelPolicy: { grid: { width: 320, height: 180 } }, outputSize: { width: 1280, height: 720 },
    scene: { renderGround(_frame, _id, { viewport }) {
      assert.equal(viewport.backingWidth, 320); assert.equal(viewport.backingHeight, 180);
      return { canvas: { width: 320, height: 180 }, stage: {} };
    } },
    drawTerrainImage(_ctx, _image, _stage, size) { assert.deepEqual(size, { width: 320, height: 180 }); return true; },
    timings: { frameRenderMs: 0, frameCopyMs: 0 },
  });
  assert.equal(pres.drawGround({ save() {}, restore() {}, drawImage() { assert.fail('expected terrain callback'); } }, { width: 1280, height: 720 }), true);
});

test('late arrival composes water with terrain before applying arrival opacity once', () => {
  const events = [];
  const transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const layerCtx = { canvas: { width: 800, height: 450 }, setTransform() {}, clearRect() {},
    getTransform() { return transform; }, drawImage() { events.push('water-into-layer'); } };
  const layer = { width: 800, height: 450, getContext: () => layerCtx };
  const target = { canvas: { width: 800, height: 450 }, getTransform() { return transform; },
    save() {}, restore() {}, setTransform() {}, drawImage(image) {
      assert.equal(image, layer); events.push(`output-opacity:${this.globalAlpha}`);
    } };
  const pres = Object.assign(Object.create(RangePresentation.prototype), {
    arrival: .4, viewId: 'v', residency: null, _makeCanvas: () => layer,
    drawTerrainImage() { events.push('terrain-into-layer'); return true; },
    _renderDirectWater() { events.push('render-water'); return {}; },
  });
  assert.equal(pres._drawDirectArrival(target, { width: 800, height: 450 }, 'mid', { width: 200, height: 112 }), true);
  assert.deepEqual(events, ['terrain-into-layer', 'render-water', 'water-into-layer', 'output-opacity:0.4']);
});

test('a denied arrival scratch falls back without drawing a partial layer', () => {
  const pres = Object.assign(Object.create(RangePresentation.prototype), {
    residency: { entries: new Map(), reserve: () => null, release() {} },
  });
  assert.equal(pres._drawDirectArrival({ canvas: { width: 800, height: 450 } }, {}, 'far', {}), false);
});
