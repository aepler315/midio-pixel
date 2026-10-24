import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../src/render/Renderer.js';

function recorder() {
  const draws = [], stack = [];
  const ctx = {
    canvas: { width: 1280, height: 720 }, globalAlpha: 1,
    globalCompositeOperation: 'source-over', strokeStyle: '',
    save() { stack.push([this.globalAlpha, this.globalCompositeOperation, this.strokeStyle]); },
    restore() { [this.globalAlpha, this.globalCompositeOperation, this.strokeStyle] = stack.pop(); },
    beginPath() {}, roundRect() {}, moveTo() {}, lineTo() {}, arc() {},
    stroke() { this.record('stroke'); }, drawImage() { this.record('image'); },
    record(kind) {
      const colorAlpha = /rgba\([^,]+,[^,]+,[^,]+,([^)]+)\)/.exec(this.strokeStyle)?.[1] ?? 1;
      draws.push({ kind, alpha: this.globalAlpha * (kind === 'stroke' ? Number(colorAlpha) : 1),
        op: this.globalCompositeOperation });
    },
  };
  return { ctx, draws };
}

test('both drop shockwave rings draw additively within their alpha budget', () => {
  for (const u of [0.01, 0.13, 0.5]) {
    const { ctx, draws } = recorder();
    Renderer.prototype._drawDropShockwave.call({}, ctx, ctx.canvas, {
      timeMs: 1000, hype: { ringU: () => u },
      midio: { groundY: 540 },
    }, { midioDrawX: 300 });
    assert.equal(draws.length, u > 0.12 ? 2 : 1);
    for (const draw of draws) {
      assert.ok(draw.alpha > 0 && draw.alpha <= 0.55);
      assert.equal(draw.op, 'lighter');
    }
  }
});

test('hype border records an additive stroke and the frame echo', () => {
  const { ctx, draws } = recorder();
  Renderer.prototype._drawHypeFrame.call({}, ctx, ctx.canvas, {
    hype: { slam: 1, surge: 1, fast: 1 },
  });
  const stroke = draws.find(d => d.kind === 'stroke');
  assert.ok(stroke, 'must draw the active border');
  assert.equal(stroke.alpha, 0.68);
  assert.equal(stroke.op, 'lighter');
  assert.equal(draws.filter(d => d.kind === 'image').length, 1);
});

test('drop shock and speed lines draw additively within their alpha budget at the draw boundary', () => {
  for (const age of [0, 80, 200]) {
    const { ctx, draws } = recorder();
    const renderer = { _shockCanvas: { width: 1280, height: 720,
      getContext: () => ({ drawImage() {}, fillRect() {} }) } };
    Renderer.prototype._drawDropImpact.call(renderer, ctx, ctx.canvas, {
      timeMs: 1000 + age, hype: { dropAtMs: 1000, dropCount: 1 },
      midio: { groundY: 540 },
    }, { midioDrawX: 300 });
    assert.equal(draws.length, 3, 'two shock blits and one speed-line stroke');
    for (const draw of draws) {
      assert.ok(draw.alpha > 0 && draw.alpha <= 0.5);
      assert.equal(draw.op, 'lighter');
    }
  }
});
