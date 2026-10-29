import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { RangePresentation, saturateMaskAlpha } from '../src/world/alpine/RangePresentation.js';

/** A canvas whose 2D context blends alpha like a browser would: 'lighter'
 *  adds premultiplied alpha and clamps, and a canvas drawn onto itself is
 *  copied first. Readbacks throw, so a passing caller cannot be using one. */
function alphaCanvas(alpha) {
  const canvas = { width: alpha.length, height: 1, alpha: Uint8Array.from(alpha), reads: 0 };
  const ctx = { globalCompositeOperation: 'source-over', globalAlpha: 1, stack: [],
    save() { this.stack.push([this.globalCompositeOperation, this.globalAlpha]); },
    restore() { [this.globalCompositeOperation, this.globalAlpha] = this.stack.pop(); },
    setTransform() {},
    drawImage(source) {
      const src = Uint8Array.from(source.alpha);
      for (let i = 0; i < canvas.alpha.length; i++) {
        canvas.alpha[i] = this.globalCompositeOperation === 'lighter'
          ? Math.min(255, canvas.alpha[i] + Math.round(src[i] * this.globalAlpha)) : src[i];
      }
    },
    getImageData() { canvas.reads++; throw new Error('no readback'); },
  };
  canvas.getContext = () => ctx;
  return { canvas, ctx };
}

test('the mid-depth water mask saturates every touched pixel without a readback', () => {
  const { canvas, ctx } = alphaCanvas([0, 1, 2, 77, 128, 254, 255, 0]);
  ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = .5;
  assert.equal(saturateMaskAlpha(ctx, canvas), true);
  assert.deepEqual([...canvas.alpha], [0, 255, 255, 255, 255, 255, 255, 0]);
  assert.equal(canvas.reads, 0);
  assert.equal(ctx.globalCompositeOperation, 'multiply', 'context state restored');
  assert.equal(ctx.globalAlpha, .5);
});

test('water capability includes mapped rivers and avoids dry views', () => {
  const scene = { prepared: new Map([
    ['dry', { waterLevelM: null, riverStats: { triangles: 0 } }],
    ['lake', { waterLevelM: 123, riverStats: { triangles: 0 } }],
    ['river', { waterLevelM: null, riverStats: { triangles: 8 } }],
  ]) };
  assert.equal(RangeScene.prototype.hasWater.call(scene, 'dry'), false);
  assert.equal(RangeScene.prototype.hasWater.call(scene, 'lake'), true);
  assert.equal(RangeScene.prototype.hasWater.call(scene, 'river'), true);
  assert.equal(RangeScene.prototype.hasWater.call(scene, 'missing'), false);
});

test('dry and low-quality scenes draw effects only once and allocate no water mask', () => {
  const p = new RangePresentation({ makeCanvas: () => { throw Error('must not allocate'); } });
  p.waterOutputSize = { width: 1920, height: 1080 }; p.arrival = 1; p.viewId = 'dry';
  p.scene = { hasWater: () => false }; p.frame = { qualityLevel: 0 };
  let draws = 0;
  p.drawMidDepthForWater({ canvas: { width: 320, height: 180 } }, {}, () => { draws++; });
  p.scene.hasWater = () => true; p.frame.qualityLevel = 4;
  p.drawMidDepthForWater({ canvas: { width: 320, height: 180 } }, {}, () => { draws++; });
  assert.equal(draws, 2);
  assert.equal(p.waterEffectMask, null);
});

test('near occlusion is admitted before effects and tracks transformed, faded terrain', () => {
  const ops = [];
  const context = {
    setTransform(...args) { ops.push(['transform', ...args]); },
    clearRect() { ops.push(['clear']); },
    drawImage(...args) { ops.push(['draw', this.globalAlpha, ...args.slice(1)]); },
  };
  const p = new RangePresentation({ makeCanvas: (width, height) => ({ width, height, getContext: () => context }) });
  const source = { canvas: { width: 320, height: 180 }, getTransform: () => ({ a: 2, b: 0, c: 0, d: 2, e: -3, f: 4 }) };
  p.arrival = .4;
  assert.equal(p.prepareNearOcclusion(source), true);
  assert.ok(p.nearOcclusionMask);
  p._recordNearOcclusion(source, { width: 200, height: 100 }, {}, 400, 200);
  assert.ok(ops.some(op => op[0] === 'transform' && op[1] === 2 && op[5] === -3));
  assert.ok(ops.some(op => op[0] === 'draw' && op[1] === .4));
  p.setFrameInputs({});
  assert.equal(p.nearOcclusionMask, null);
});

test('live and capture water targets remain independently allocated across frames', () => {
  const targets = [];
  const noop = () => {};
  const uniform = { uViewportPx: { value: { set: noop } }, uWaterOnly: { value: 0 } };
  const p = { view: {}, uniforms: uniform, depthScene: {}, forest: { byBand: {} }, scenes: { far: {}, mid: {}, near: {} } };
  const scene = {
    prepared: new Map([['lake', p]]), contextLost: false, target: {}, size: { width: 320, height: 180 },
    renderer: { setRenderTarget: noop, setClearColor: noop, clear: noop, render: noop },
    camera: { layers: { set: noop, enable: noop } }, canvas: {},
    _setCamera: noop, _setUniforms: noop, _prepareMirror: noop, _setCanvasSize: noop, _clearCanvas: noop, _copyTexture: noop,
    _scenicTarget(w, h) { const t = { width: w, height: h, texture: {}, dispose: noop }; targets.push(t); return t; },
  };
  for (let n = 0; n < 3; n++) {
    RangeScene.prototype.renderWater.call(scene, {}, 'lake', 960, 540);
    RangeScene.prototype.renderWater.call(scene, {}, 'lake', 1920, 1080, { capture: true });
  }
  assert.equal(targets.length, 2);
  assert.equal(scene.waterTarget, targets[0]);
  assert.equal(scene.captureWaterTarget, targets[1]);
});

test('near occlusion survives effect-buffer pressure and is released with its owner', () => {
  const residency = new GraphicsResidency({ budgetBytes: 80 });
  const context = { setTransform() {}, clearRect() {} };
  const p = new RangePresentation({ residency, makeCanvas: (width, height) => ({ width, height, getContext: () => context }) });
  assert.equal(p.prepareNearOcclusion({ canvas: { width: 4, height: 4 } }), true);
  const mask = p.nearOcclusionMask;
  assert.equal(residency.reserve({ key: 'effects', bytes: 32, owner: 'test' }), null);
  assert.equal(p.nearOcclusionMask, mask);
  assert.equal(mask.width, 4);
  p._releaseNearOcclusion();
  assert.equal(mask.width, 0);
  assert.ok(residency.reserve({ key: 'effects', bytes: 32, owner: 'test' }));
});
