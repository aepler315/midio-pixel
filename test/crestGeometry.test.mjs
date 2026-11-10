import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as probeMath from '../src/world/alpine/CrestProbe.js';
import { RangeCrest, fineCrest } from '../src/world/alpine/RangeCrest.js';
import { RangeScene, crestFineSize } from '../src/world/alpine/RangeScene.js';
import { RangePresentation } from '../src/world/alpine/RangePresentation.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';

test('early collection touches no framebuffer and skips missing or lost GPU contexts', () => {
  let collects = 0;
  const scene = { crestProbe: { collect() { collects++; } }, contextLost: false,
    renderer: { setRenderTarget() { throw Error('collection must not bind a framebuffer'); } } };
  RangeScene.prototype.collectCrestProbe.call(scene);
  scene.contextLost = true; RangeScene.prototype.collectCrestProbe.call(scene);
  scene.contextLost = false; scene.crestProbe = null; RangeScene.prototype.collectCrestProbe.call(scene);
  assert.equal(collects, 1);
});

test('fine silhouette packing retains every physical column beyond the old four-times grid', () => {
  assert.equal(typeof probeMath.fineLineLayout, 'function');
  const layout = probeMath.fineLineLayout(8, 49, 73);
  assert.deepEqual(layout, { width: 49, height: 73, row: 20, rowsPerBand: 4, edgeRow: 32 });
  assert.equal(probeMath.fineLineLayout(8, 0, 0).edgeRow, 20, 'legacy edge layout without fine geometry');
});

function fixture() {
  const W = 8, H = 12, F = 6, layout = { width: W * F, height: H * F, row: 20, rowsPerBand: 3, edgeRow: 29 };
  const data = new Uint8Array(W * layout.edgeRow * 4);
  for (let j = 0; j < W; j++) {
    const o = j * 4;
    data[o] = 5; data[o + 2] = 128; data[o + 3] = 255;
  }
  for (let i = 0; i < W * F; i++) {
    const pixel = Math.floor(i / 2), o = ((layout.row + Math.floor(pixel / W)) * W + pixel % W) * 4 + i % 2 * 2;
    const row = i === 2 ? 22 : 24;
    data[o] = row + 1;
  }
  const crest = new RangeCrest({ makeCanvas: (width, height) => ({ width, height,
    getContext: () => ({ setTransform() {}, clearRect() {}, drawImage() {} }) }) });
  crest.update({ probe: { width: W, height: H, data, rows: 3, fine: layout }, frameId: 1, timeMs: 0, viewId: 'v',
    transform: [1, 0, 0, 1, 0, 0], stage: { width: W, height: H }, grid: { width: W, height: H }, instant: true });
  return { crest, W, H, F };
}

test('a live pending miss through the presentation removes prior fine cuts and split drawing safely', () => {
  const { crest, W, H } = fixture();
  assert.equal(crest.snapshot.cut, true);
  assert.equal(crest.snapshot.split, true);
  const p = Object.assign(Object.create(RangePresentation.prototype), { crest, arrival: 1, viewId: 'v',
    frame: { frameId: 2, timeMs: 16, rise01: 1, qualityLevel: 0 }, frameInputs: { sim: {} },
    scene: { crestProbeMode: 'refined', readCrestProbe: () => null } });
  p._finishCrest({ canvas: { width: W, height: H }, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) }, { width: W, height: H });
  assert.equal(crest.snapshot, null);
  assert.ok(Object.values(crest._grid).every(g => g.geometry === null));
  const unexpected = () => { throw Error('a pending miss cannot reuse old GPU geometry'); };
  const fit = { x: 0, y: 0, width: W, height: H, scale: 1 };
  assert.equal(crest.prepareGrid({ ctx: {} }), false);
  assert.equal(typeof crest.finishGrid, 'undefined', 'no palette pass re-quantizes split cells');
  assert.equal(crest.drawTerrain({}, fit, 2, unexpected), false);
  assert.equal(crest.drawCrest({}, fit, 2), true);
  assert.equal(crest.drawShore({}, fit, 2), true);
});

test('fine terrain cut keeps a narrow real peak between native grid centres', () => {
  const { crest, W, H, F } = fixture(), geometry = crest._grid.far.geometry;
  assert.ok(geometry, 'the output silhouette is retained independently of the native grid');
  assert.equal(geometry.count, W * F);
  assert.ok(Math.abs(geometry.x[2] - 2.5 / F) < 1e-6);
  assert.ok(Math.abs(geometry.y[2] - 22 / F) < 1e-6);
  const points = [], ctx = new Proxy({}, { get: (_, key) => (...args) => { if (key === 'lineTo') points.push(args); } });
  assert.equal(crest.drawTerrain(ctx, { x: 0, y: 0, width: W * F, height: H * F, scale: F }, 1, () => true), true);
  assert.ok(points.some(([x, y]) => Math.abs(x - 2.5) < 1e-5 && Math.abs(y - 22) < 1e-5), 'cut follows the retained physical-pixel peak');
  crest.update({ probe: null, frameId: 2, timeMs: 16, viewId: 'v', grid: { width: W, height: H } });
  assert.equal(crest.snapshot, null, 'missing geometry cannot redraw an earlier frame');
});

test('physical fine size follows noninteger output scale and scenic overscan without a fixed multiplier', () => {
  assert.deepEqual(crestFineSize({ width: 352, height: 212 }, 1920 / 320), { width: 2112, height: 1272 });
  assert.deepEqual(crestFineSize({ width: 352, height: 212 }, 2195 / 320), { width: 2415, height: 1455 });
  assert.deepEqual(crestFineSize({ width: 352, height: 212 }, 1), { width: 352, height: 212 });
  assert.equal(crestFineSize({ width: 352, height: 212 }, 100, 16384), null);
});

test('fine ownership is admitted before allocation, denied without eviction, and disposed on resize/release', () => {
  let allocations = 0, disposals = 0;
  const scene = Object.assign(Object.create(RangeScene.prototype), {
    THREE: { WebGLRenderTarget: class { constructor(width, height) { allocations++; this.width = width; this.height = height; } dispose() { disposals++; } } },
    renderer: { capabilities: { maxTextureSize: 16384 } }, contextEpoch: 0, crestOutputScale: 6,
    residency: new GraphicsResidency({ budgetBytes: 1 }),
  });
  assert.equal(scene._crestFineTarget({ width: 8, height: 12 }), null);
  assert.equal(allocations, 0);
  scene.residency.budgetBytes = 1e6;
  const first = scene._crestFineTarget({ width: 8, height: 12 });
  assert.equal(scene.residency.liveBytes > 0, true);
  assert.equal(scene._crestFineTarget({ width: 8, height: 12 }), first);
  assert.equal(allocations, 1);
  scene.crestOutputScale = 7;
  assert.notEqual(scene._crestFineTarget({ width: 8, height: 12 }), first);
  assert.equal(disposals, 1);
  scene._releaseFineTarget();
  assert.equal(disposals, 2);
  assert.equal(scene.residency.usedBytes, 0);
  scene.THREE.WebGLRenderTarget = class { constructor() { throw new Error('allocation interrupted'); } };
  assert.throws(() => scene._crestFineTarget({ width: 8, height: 12 }), /allocation interrupted/);
  assert.equal(scene.residency.usedBytes, 0);
});

test('a modern light/denied probe omits coarse outline and cut instead of fabricating output geometry', () => {
  const { crest, W, H, F } = fixture();
  crest.update({ probe: { width: W, height: H, data: new Uint8Array(W * 20 * 4), rows: 3, fine: null },
    frameId: 2, timeMs: 16, viewId: 'v', transform: [1, 0, 0, 1, 0, 0],
    stage: { width: W, height: H }, grid: { width: W, height: H }, qualityLevel: 4 });
  const methods = [], ctx = new Proxy({}, { get: (_, key) => (...args) => methods.push([key, ...args]), set: () => true });
  const fit = { x: 0, y: 0, width: W * F, height: H * F, scale: F };
  assert.equal(crest.drawTerrain(ctx, fit, 2, () => true), false);
  crest.drawCrest(ctx, fit, 2);
  assert.equal(methods.some(([method]) => method === 'stroke'), false);
});

test('absent fine terrain keeps monotone finite sample positions and does not retain an earlier shape', () => {
  const { crest, W, H } = fixture();
  const g = crest._grid.far, state = crest._bands.far;
  const fine = { width: 48, height: 72, row: 20, rowsPerBand: 3 };
  state.raw.fill(NaN); state.recon.fill(NaN); state.filter.y.fill(NaN);
  crest._fineGeometry({ width: W, height: H, data: new Uint8Array(W * 29 * 4), fine }, 'far', state, g,
    { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, sx: 1, sy: 1, Wg: W });
  for (let i = 0; i < fine.width; i++) {
    assert.ok(Number.isFinite(g.geometry.x[i]));
    assert.ok(Number.isNaN(g.geometry.y[i]));
    if (i) assert.ok(g.geometry.x[i] > g.geometry.x[i - 1]);
  }
});

test('a native split canvas cannot replace the finer silhouette cut at a subcolumn peak', () => {
  const { crest, W, H, F } = fixture();
  crest.snapshot = Object.freeze({ ...crest.snapshot, splitReady: true, splitAlpha: 1, aligned: 1 });
  crest._split = {};
  const ctx = new Proxy({}, { get: () => () => {} });
  assert.equal(crest.drawTerrain(ctx, { x: 0, y: 0, width: W * F, height: H * F, scale: F }, 1, () => true), true);
});

test('a palette scan after a fine frame clears every old output silhouette', () => {
  const { crest, W, H } = fixture();
  assert.ok(crest._grid.far.geometry);
  crest.update({ probe: null, scan: true, palette: 'rgb332', qualityLevel: 6, frameId: 2, timeMs: 16, viewId: 'v',
    grid: { width: W, height: H } });
  for (const band of ['far', 'mid', 'near']) assert.equal(crest._grid[band].geometry, null);
});

test('output stroke follows real subcolumn vertices with physical-pixel width and no invented curve', () => {
  const { crest, W, H, F } = fixture(), ops = [];
  const ctx = new Proxy({ canvas: { width: W * F, height: H * F }, isContextLost: () => false, getImageData: (x, y, w, h) => {
    const data = new Uint8ClampedArray(w * h * 4).fill(100);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    return { data };
  }, createPattern: () => ({ setTransform() {} }) }, {
    get: (target, key) => key in target ? target[key] : (...args) => ops.push([key, ...args]),
    set: (target, key, value) => { ops.push(['set', key, value]); target[key] = value; return true; },
  });
  crest.drawCrest(ctx, { x: 0, y: 0, width: W * F, height: H * F, scale: F }, 1);
  assert.ok(ops.some(([method, x, y]) => method === 'lineTo' && Math.abs(x - 2.5) < 1e-5 && Math.abs(y - 22) < 1e-5));
  const widths = ops.filter(([method, key]) => method === 'set' && key === 'lineWidth').map(([, , width]) => width);
  assert.ok(widths.length > 0);
  assert.ok(widths.every(width => width === 1), 'native-cell scale must never inflate the stroke');
  assert.equal(ops.some(([method]) => method === 'bezierCurveTo' || method === 'quadraticCurveTo'), false);
});

test('packed physical samples provide the same four-sample native metadata without duplicate GPU scans', () => {
  const W = 8, F = 6, fine = probeMath.fineLineLayout(W, W * F, 72);
  const data = new Uint8Array(W * fine.edgeRow * 4);
  for (let i = 0; i < fine.width; i++) {
    const pixel = Math.floor(i / 2), at = ((fine.row + Math.floor(pixel / W)) * W + pixel % W) * 4 + i % 2 * 2;
    data[at] = 25;
  }
  const raw = new Float32Array(W).fill(4), recon = new Float32Array(W).fill(4.5);
  assert.equal(fineCrest({ width: W, height: 12, fine, data, rows: 3 }, 'far', raw, recon), W);
  assert.deepEqual([...recon], Array(W).fill(4));
  const legacy = [], renders = [], set = () => {};
  const probe = Object.assign(Object.create(probeMath.CrestProbe.prototype), {
    width: W, height: 12, fineLayout: fine, target: { viewport: { set }, scissor: { set } },
    material: { uniforms: Object.fromEntries(['uFine', 'uFineK', 'uFineChannel', 'uLineRow', 'uMode'].map(k => [k, { value: 0 }])) },
    renderer: { setRenderTarget() {}, render() { renders.push(1); } },
    _pass: (...args) => legacy.push(args), _edges: () => true,
  });
  assert.equal(probe.fine({ width: W * F, height: 72, texture: {} }), true);
  assert.equal(legacy.length, 0, 'the compact physical rows replace the six duplicate fine scans');
  assert.equal(renders.length, 3);
});

test('releasing a crest retires its output-sized geometry ownership', () => {
  const { crest } = fixture();
  crest.release();
  for (const band of ['far', 'mid', 'near']) assert.equal(crest._grid[band].geometry, null);
});

test('modern edges use one opaque physical-pixel path per band, breaking only at missing or skipped samples', () => {
  const { crest, W, H, F } = fixture(), ops = [];
  const g = crest._grid.far;
  for (let i = 0; i < W; i++) { g.e[i] = i / W; g.vis[i] = i % 2 ? .2 : .8; }
  g.skip[3] = 1;
  g.geometry.y[12] = NaN;
  const ctx = new Proxy({ canvas: { width: W * F, height: H * F }, isContextLost: () => false,
    createPattern: () => ({ setTransform() {} }), getImageData() { throw new Error('no CPU output reads'); } }, {
    get: (target, key) => key in target ? target[key] : (...args) => ops.push([key, ...args]),
    set: (target, key, value) => { ops.push(['set', key, value]); target[key] = value; return true; },
  });
  crest.drawCrest(ctx, { x: 0, y: 0, width: W * F, height: H * F, scale: F }, 1);
  assert.equal(ops.filter(([method]) => method === 'stroke').length, 1, 'rank/visibility changes cannot split a patterned edge into tiny GPU draws');
  const strokeAt = ops.findIndex(([method]) => method === 'stroke');
  const pathAt = ops.slice(0, strokeAt).findLastIndex(([method]) => method === 'beginPath');
  const moves = ops.slice(pathAt, strokeAt).filter(([method]) => method === 'moveTo');
  for (const next of [13, 24]) assert.ok(moves.some(([, x, y]) => Math.abs(x - g.geometry.x[next] * F) < 1e-5
    && Math.abs(y - g.geometry.y[next] * F) < 1e-5), `sample ${next} starts a subpath after the NaN/skip gap`);
  assert.ok(ops.filter(([method, key]) => method === 'set' && key === 'lineWidth').every(([, , v]) => v === 1));
  assert.ok(ops.filter(([method, key]) => method === 'set' && key === 'globalAlpha').every(([, , v]) => v === 1), 'settled mean is not attenuated by old tier or visibility alpha');
  ops.length = 0;
  crest.snapshot = Object.freeze({ ...crest.snapshot, fade: .4 });
  crest.drawCrest(ctx, { x: 0, y: 0, width: W * F, height: H * F, scale: F }, 1);
  const fading = ops.filter(([method, key]) => method === 'set' && key === 'globalAlpha');
  assert.ok(fading.length > 0 && fading.every(([, , alpha]) => alpha === .4), 'the view fade still applies');
});
