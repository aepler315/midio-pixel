import test from 'node:test';
import assert from 'node:assert/strict';
import { RangeCrest } from '../src/world/alpine/RangeCrest.js';

test('a throttled glow reading never stretches the current opaque terrain row', () => {
  const crest = new RangeCrest(), width = 4, height = 20;
  crest._orig = new Uint8ClampedArray(width * height * 4);
  for (let x = 0; x < width; x++) crest._orig.set(x === 2 ? [90, 80, 70, 255] : [255, 240, 200, 25], (2 * width + x) * 4);
  crest._origRead = { frameId: 1, groups: [{ y0: 2, y1: 3 }] };
  crest._glow = true;
  crest._cut = { band: Int8Array.from([0, 0, 0, -1]), top: Float32Array.from([3, 3, 3, 3]), spanBottom: Float32Array.from([16, 16, 16, 16]) };
  const source = { width, height, getContext: () => ({ getImageData() { throw new Error('the current source is opaque terrain; no additional readback is needed'); } }) };
  const operations = [], ctx = {
    save() {}, restore() {}, beginPath() {}, clip() {},
    drawImage(...args) { operations.push({ type: 'copy', args }); },
    fillRect(...args) { operations.push({ type: 'fill', args, color: this.fillStyle, alpha: this.globalAlpha }); },
  };
  const result = crest._refillGlow(ctx, source, x => x * 3.2, y => y * 3.2, 3.2, width, () => {}, { frameId: 2, fade: 1 });
  assert.equal(operations.some(op => op.type === 'copy' && op.args[0] === source), false,
    'a stale translucent reading must not authorize stretching a now opaque source pixel into a 48px column');
  assert.equal(result, 2, 'only the two verified translucent columns are refilled');
  assert.equal(operations.length, 1, 'adjacent equal glow colors share one fill');
  assert.equal(operations[0].color, 'rgba(255,240,200,0.09803921568627451)');
  assert.equal(operations[0].args[2], 6.4);
  assert.equal(operations[0].args[3], 48);
});

test('unknown or unread glow ownership never fills a terrain cut', () => {
  const crest = new RangeCrest();
  crest._glow = null;
  crest._cut = { band: Int8Array.of(0), top: Float32Array.of(3), spanBottom: Float32Array.of(8) };
  let copies = 0;
  const ctx = { save() {}, restore() {}, beginPath() {}, clip() {}, drawImage() { copies++; }, fillRect() { copies++; } };
  assert.equal(crest._refillGlow(ctx, {}, x => x, y => y, 1, 1, () => {}, { frameId: 1, fade: 1 }), 0);
  assert.equal(copies, 0);
  crest._orig = Uint8ClampedArray.from([255, 240, 200, 25]);
  crest._origRead = { frameId: 1, groups: [{ y0: 0, y1: 1 }] };
  crest._glow = true;
  assert.equal(crest._refillGlow(ctx, {}, x => x, y => y, 1, 1, () => {}, { frameId: 2, fade: 1 }), 0,
    'a valid glow elsewhere does not verify an unread source row');
  assert.equal(copies, 0);
});

test('cached glow redraws keep their verified alpha and apply the snapshot fade once', () => {
  const crest = new RangeCrest();
  crest._orig = Uint8ClampedArray.from([90, 80, 70, 0, 90, 80, 70, 250, 255, 240, 200, 25, 80, 100, 130, 60]);
  crest._origRead = { frameId: 1, groups: [{ y0: 0, y1: 1 }] };
  crest._glow = true;
  crest._cut = { band: Int8Array.from([0, 0, 0, 0]), top: Float32Array.from([1, 1, 1, 1]), spanBottom: Float32Array.from([6, 6, 6, 6]) };
  const draw = () => {
    const fills = [], ctx = { save() {}, restore() {}, beginPath() {}, clip() {},
      drawImage() { assert.fail('current source pixels must not be stretched'); },
      fillRect(...args) { fills.push({ args, color: this.fillStyle, alpha: this.globalAlpha }); } };
    assert.equal(crest._refillGlow(ctx, {}, x => x, y => y, 1, 4, () => {}, { frameId: 2, fade: .4 }), 2);
    return fills;
  };
  const first = draw();
  assert.deepEqual(draw(), first, 'a paused frame redraw is identical');
  assert.deepEqual(first.map(fill => fill.args[0]), [2, 3], 'transparent and opaque columns are never refilled');
  assert.ok(first.every(fill => fill.alpha === .4), 'source alpha stays in the colour and the snapshot fade is applied once');
  assert.deepEqual(first.map(fill => fill.color), ['rgba(255,240,200,0.09803921568627451)', 'rgba(80,100,130,0.23529411764705882)']);
});

test('view, grid and seek resets discard previous glow pixel ownership', () => {
  for (const reason of ['view', 'grid', 'seek']) {
    const crest = new RangeCrest();
    crest._orig = Uint8ClampedArray.from([255, 240, 200, 25]);
    crest._origRead = { frameId: 1, groups: [{ y0: 0, y1: 1 }] };
    crest._glow = true;
    crest._cut = { band: Int8Array.of(0), top: Float32Array.of(1), spanBottom: Float32Array.of(8) };
    crest.reset(reason);
    const ctx = { save() {}, restore() {}, beginPath() {}, clip() {}, fillRect() { assert.fail('the prior view cannot refill the new view'); } };
    assert.equal(crest._refillGlow(ctx, {}, x => x, y => y, 1, 1, () => {}, { frameId: 2, fade: 1 }), 0, reason);
  }
});
