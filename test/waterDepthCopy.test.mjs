import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RangeScene } from '../src/world/alpine/RangeScene.js';

// The lake layer's native-grid pass copies the depth pre-pass the side's
// target already holds (renderPartition) instead of drawing the terrain
// again; anything it cannot prove identical keeps the redraw.

const UINT = 1014;
const depthTexture = () => ({ type: UINT, format: 1026 });
const gl = () => {
  const calls = [];
  return { calls, READ_FRAMEBUFFER: 'read', DRAW_FRAMEBUFFER: 'draw', FRAMEBUFFER: 'fb', DEPTH_BUFFER_BIT: 256, NEAREST: 9728,
    bindFramebuffer: (t, f) => calls.push(['bind', t, f]), blitFramebuffer: (...a) => calls.push(['blit', ...a]) };
};

function harness({ samples = 0, depth = true } = {}) {
  const noop = () => {};
  const g = gl();
  const fbs = new Map();
  const renders = [];
  const layers = { mask: 1, set(n) { this.mask = 1 << n; }, enable(n) { this.mask |= 1 << n; } };
  const uniform = { uViewportPx: { value: { set: noop } }, uWaterOnly: { value: 0 } };
  const p = { view: {}, uniforms: uniform, depthScene: { name: 'depth' }, forest: { byBand: {} },
    scenes: { far: { children: [] }, mid: { children: [] }, near: { children: [] } } };
  const target = { width: 320, height: 180, samples, texture: {}, depthTexture: depth ? depthTexture() : null };
  const scene = Object.assign(Object.create(RangeScene.prototype), {
    THREE: { UnsignedIntType: UINT }, prepared: new Map([['lake', p]]), contextLost: false, target, sideTargets: { B: null },
    size: { width: 320, height: 180 }, stats: {}, depthCache: { A: { frame: -1 }, B: { frame: -1 } },
    renderer: { getContext: () => g, setRenderTarget: noop, setClearColor: noop, clear: noop,
      properties: { get: t => { if (!fbs.has(t)) fbs.set(t, { __webglFramebuffer: { of: t } }); return fbs.get(t); } },
      render: (s) => renders.push([s.name, layers.mask]) },
    camera: { layers }, canvas: {},
    _setCamera: noop, _setUniforms: noop, _prepareMirror: noop, _setCanvasSize: noop, _clearCanvas: noop, _copyTexture: noop,
    _scenicTarget: (w, h) => ({ width: w, height: h, samples: 0, texture: {}, depthTexture: depthTexture(), dispose: noop }),
  });
  const frame = { frameId: 7, occurrenceId: 'o' };
  const record = (over = {}) => { scene.depthCache.A.content = { target, frame: 7, view: 'lake', occurrenceId: 'o', cut: false, ...over }; };
  return { scene, g, renders, frame, record, target };
}

const depthDraws = renders => renders.filter(([name]) => name === 'depth');

test('the native water pass copies this frame\'s depth instead of drawing the terrain', () => {
  const h = harness();
  h.record({ cut: true });
  assert.ok(h.scene.renderWater(h.frame, 'lake', 320, 180));
  assert.deepEqual(depthDraws(h.renders), []);
  const blit = h.g.calls.find(c => c[0] === 'blit');
  assert.deepEqual(blit.slice(1), [0, 0, 320, 180, 0, 0, 320, 180, 256, 9728]);
  // Read from the scenic target, write the water target, and leave both
  // bindings on the water target (what three.js's state cache holds).
  const binds = h.g.calls.filter(c => c[0] === 'bind');
  assert.equal(binds[0][1], 'read'); assert.equal(binds[0][2].of, h.target);
  assert.equal(binds[1][1], 'draw'); assert.equal(binds[1][2].of, h.scene.nativeWaterTarget);
  assert.deepEqual(binds[2], ['bind', 'fb', binds[1][2]]);
  assert.equal(h.scene.stats.waterDepthCopies, 1);
});

test('a copy without the crown cut adds only the trees\' layer 2 depth', () => {
  const h = harness();
  h.record({ cut: false });
  h.scene.renderWater(h.frame, 'lake', 320, 180);
  assert.deepEqual(depthDraws(h.renders), [['depth', 1 << 2]]);
});

test('anything that is not this frame\'s plain single-sampled depth is redrawn', () => {
  const cases = [
    ['no record', h => {}],
    ['another frame', h => h.record({ frame: 6 })],
    ['another view', h => h.record({ view: 'other' })],
    ['another occurrence', h => h.record({ occurrenceId: 'p' })],
    ['a reallocated target', h => h.record({ target: {} })],
  ];
  for (const [name, set] of cases) {
    const h = harness();
    set(h);
    h.scene.renderWater(h.frame, 'lake', 320, 180);
    assert.deepEqual(depthDraws(h.renders), [['depth', 1 | 1 << 2]], name);
    assert.ok(!h.g.calls.some(c => c[0] === 'blit'), name);
  }
  for (const opts of [{ samples: 4 }, { depth: false }]) {
    const h = harness(opts);
    h.record();
    h.scene.renderWater(h.frame, 'lake', 320, 180);
    assert.equal(depthDraws(h.renders).length, 1, JSON.stringify(opts));
  }
  // Output resolution, captures and travel columns draw their own depth.
  for (const [w, opts] of [[640, {}], [320, { capture: true }], [320, { bandColumns: { x: 0 } }]]) {
    const h = harness();
    h.record();
    h.scene.renderWater(h.frame, 'lake', w, w * 180 / 320, opts);
    assert.ok(!h.g.calls.some(c => c[0] === 'blit'), JSON.stringify([w, opts]));
  }
});

test('the partition records what its target\'s depth holds', () => {
  // renderPartition's bookkeeping, in source: a pre-pass records the
  // target, a crown cut marks it, travel and multisampling clear it.
  const src = RangeScene.prototype.renderPartition.toString();
  assert.match(src, /depth\.content = own \? null : \{ target, frame: frame\.frameId/);
  assert.match(src, /depth\.content = null;/);
  assert.match(src, /if \(depth\.content\) depth\.content\.cut = true;/);
  assert.match(RangeScene.prototype.renderCast.toString(), /if \(depth\.content\) depth\.content\.cut = true;/);
});
