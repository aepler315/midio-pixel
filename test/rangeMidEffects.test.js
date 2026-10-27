import test from 'node:test';
import assert from 'node:assert/strict';

test('mid-depth effects are drawn at output resolution and masked by the near terrain', async () => {
  const mod = await import('../src/world/alpine/RangeMidEffects.js').catch(() => ({}));
  assert.equal(typeof mod.RangeMidEffects, 'function');
  const calls = [], layerCtx = {
    setTransform(...v) { calls.push(['transform', ...v]); }, clearRect() {}, save() {}, restore() {},
    drawImage(...v) { calls.push(['mask', this.globalCompositeOperation, ...v.slice(1)]); },
  };
  const layer = { width: 1280, height: 720, getContext: () => layerCtx };
  const buffers = { ensure: () => layer, dispose() {} };
  const mask = { width: 320, height: 180 };
  const pres = { prepareNearOcclusion: () => true, nearOcclusionMask: mask };
  const src = { canvas: { width: 320, height: 180 }, getTransform: () => ({ a: .25, b: 0, c: 0, d: .25, e: 10, f: 20 }) };
  const frame = { ctx: src };
  const effects = new mod.RangeMidEffects({ buffers });
  assert.equal(effects.prepare(src, frame, f => calls.push(['paint', f.ctx === layerCtx]), { width: 1280, height: 720 }, pres), true);
  const out = { canvas: { width: 1280, height: 720 }, save() {}, restore() {}, setTransform() {}, beginPath() {}, rect() {}, clip() {},
    drawImage(c) { calls.push(['present', c === layer]); } };
  assert.equal(effects.draw(out, { x: 0, y: 0, width: 1280, height: 720, scale: 4 }), true);
  assert.ok(calls.some(c => c[0] === 'transform' && c[1] === 1 && c[5] === 40 && c[6] === 80));
  assert.ok(calls.some(c => c[0] === 'paint' && c[1]));
  assert.ok(calls.some(c => c[0] === 'mask' && c[1] === 'destination-out' && c[4] === 1280));
  assert.deepEqual(calls.at(-1), ['present', true]);
  effects.dispose();
});

test('mid-depth admission failure keeps the native effect path available', async () => {
  const mod = await import('../src/world/alpine/RangeMidEffects.js').catch(() => ({}));
  assert.equal(typeof mod.RangeMidEffects, 'function');
  const effects = new mod.RangeMidEffects({ buffers: { ensure: () => null, dispose() {} } });
  const src = { canvas: { width: 320, height: 180 }, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) };
  assert.equal(effects.prepare(src, { ctx: src }, () => {}, { width: 1280, height: 720 }, { prepareNearOcclusion: () => true }), false);
  effects.dispose();
});

test('deferred particles retain the completed frame state for a later recording', async () => {
  const { captureRangeParticles } = await import('../src/world/alpine/RangeMidEffects.js');
  assert.equal(typeof captureRangeParticles, 'function');
  const seen = [];
  const field = { kind: 'rain', color: '#fff', particles: [{ x: 5 }], draw() { seen.push(this.particles[0].x); } };
  const manager = { fields: new Map([['a', field]]), weatherFields: new Map(), currentBlend: { from: 'a', to: 'a' },
    openingGain: 1, unravel: 0, _rangeSky: { decorativeAlpha: 1 }, _perf: { rimLightEnabled: false }, _activeWeatherIntensity: 0 };
  const frame = { A: { name: 'a' }, B: { name: 'a' }, t: 0, particleMul: 1 };
  const draw = captureRangeParticles(manager, frame, { mandalaColor: '#fff', worldX: 0, originX: 0 });
  field.particles[0].x = 99;
  const ctx = { globalAlpha: 1, save() {}, restore() {} };
  draw({ ...frame, ctx });
  assert.deepEqual(seen, [5]);
});

test('live and larger recording surfaces are retained across alternating frames', async () => {
  const { RangeMidEffects } = await import('../src/world/alpine/RangeMidEffects.js');
  const allocations = [], surfaces = new Map();
  const buffers = { ensure(name, width, height) {
    let surface = surfaces.get(name);
    if (!surface || surface.width !== width || surface.height !== height) {
      allocations.push([name, width, height]);
      const c = { setTransform() {}, clearRect() {}, drawImage() {} };
      surface = { width, height, getContext: () => c }; surfaces.set(name, surface);
    }
    return surface;
  }, dispose() {} };
  const pres = { prepareNearOcclusion: () => true, nearOcclusionMask: { width: 320 } };
  const src = { canvas: { width: 320, height: 180 }, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) };
  const out = (width, height) => ({ canvas: { width, height }, save() {}, restore() {}, setTransform() {},
    beginPath() {}, rect() {}, clip() {}, drawImage() {} });
  const effects = new RangeMidEffects({ buffers });
  for (let i = 0; i < 3; i++) {
    assert.equal(effects.prepare(src, { ctx: src }, () => {}, { width: 1280, height: 720 }, pres), true);
    assert.equal(effects.draw(out(1280, 720), { x: 0, y: 0, width: 1280, height: 720, scale: 4 }), true);
    assert.equal(effects.draw(out(1920, 1080), { x: 0, y: 0, width: 1920, height: 1080, scale: 6 }), true);
  }
  assert.equal(allocations.length, 2);
  effects.dispose();
});
