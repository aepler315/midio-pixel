// Range v2 Task 12: a performer over a pool draws its body once; the layer
// that captures it is reused by its reflection and its composite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerformerCapture, splitContext, segmentedContext, capturePerformerLayers } from '../src/render/PerformerCapture.js';

/** Minimal recording 2D context. */
function mockCtx(canvas, name) {
  const calls = [];
  let t = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const stack = [];
  const ctx = {
    name, canvas, calls, globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', filter: 'none', shadowBlur: 0,
    save() { stack.push({ t: { ...t }, op: this.globalCompositeOperation, alpha: this.globalAlpha }); calls.push(['save']); },
    restore() { const s = stack.pop(); if (s) { t = s.t; this.globalCompositeOperation = s.op; this.globalAlpha = s.alpha; } calls.push(['restore']); },
    setTransform(a, b, c, d, e, f) { t = { a, b, c, d, e, f }; calls.push(['setTransform', a, b, c, d, e, f]); },
    getTransform() { return { ...t }; },
    translate(x, y) { t = { ...t, e: t.e + t.a * x, f: t.f + t.d * y }; calls.push(['translate', x, y]); },
    scale(x, y) { t = { ...t, a: t.a * x, d: t.d * y }; calls.push(['scale', x, y]); },
    getLineDash() { return []; }, setLineDash() {},
    beginPath() { calls.push(['beginPath']); }, moveTo(x, y) { calls.push(['moveTo', x, y]); }, lineTo(x, y) { calls.push(['lineTo', x, y]); },
    closePath() { calls.push(['closePath']); }, arc() { calls.push(['arc']); },
    fill() { calls.push(['fill', this.globalCompositeOperation, this.globalAlpha]); },
    stroke() { calls.push(['stroke', this.globalCompositeOperation]); },
    fillRect() { calls.push(['fillRect']); }, clearRect() { calls.push(['clearRect']); },
    clip() { calls.push(['clip']); },
    drawImage(img, ...a) { calls.push(['drawImage', img.id, this.globalCompositeOperation, this.globalAlpha, ...a]); },
    createLinearGradient() { return { addColorStop() {} }; },
  };
  return ctx;
}
let nextId = 0;
function mockCanvas(w, h) {
  const c = { id: `c${nextId++}`, width: w, height: h };
  const ctx = mockCtx(c, c.id);
  c.getContext = () => ctx;
  return c;
}
function stage(w = 1408, h = 848, transform = [1, 0, 0, 1, 0, 0]) {
  const c = mockCanvas(w, h);
  c.getContext().setTransform(...transform);
  return c.getContext();
}
const body = (draws) => ({ id: 'midio', visible: true, hue: 190, contactY: 600, airbornePx: 0,
  bounds: { x: 300, y: 400, w: 200, h: 240 }, draw: (c) => { draws.count++; c.beginPath(); c.moveTo(310, 420); c.lineTo(480, 600); c.stroke(); } });

test('one body draw per captured performer; composite and reflection share the layer', () => {
  const cap = new PerformerCapture({ createCanvas: mockCanvas });
  const ctx = stage();
  const draws = { count: 0 };
  const [layer] = capturePerformerLayers({ frameId: 7 }, [body(draws)], { ctx, capture: cap });
  assert.equal(draws.count, 1);
  assert.equal(layer.frameId, 7);
  assert.equal(layer.pending, 2, 'composite and reflection both still to consume it');
  cap.composite(ctx, layer);
  const composites = ctx.calls.filter((c) => c[0] === 'drawImage');
  assert.deepEqual(composites.map((c) => [c[1], c[2]]), layer.segments.map((g) => [g.canvas.id, g.op]));
  assert.equal(layer.segments.length, 1, 'a body with no glow uses one segment');
  assert.deepEqual(composites[0].slice(4), [300, 400], 'placed back at its device rectangle');
  assert.equal(draws.count, 1, 'compositing never redraws the body');
});

test('additive glows go to the additive canvas and state reaches both', () => {
  const n = mockCanvas(10, 10), a = mockCanvas(10, 10);
  const nctx = n.getContext(), actx = a.getContext();
  const s = splitContext(nctx, actx);
  s.translate(5, 5);
  s.save();
  s.globalCompositeOperation = 'lighter';
  s.fill();
  s.restore();
  s.stroke();
  assert.equal(nctx.getTransform().e, 5);
  assert.equal(actx.getTransform().e, 5);
  assert.deepEqual(actx.calls.filter((c) => c[0] === 'fill' || c[0] === 'stroke').map((c) => c[0]), ['fill']);
  assert.deepEqual(nctx.calls.filter((c) => c[0] === 'fill' || c[0] === 'stroke').map((c) => c[0]), ['stroke']);
  assert.equal(s.globalCompositeOperation, 'source-over', 'restore returns routing to the normal layer');
});

test('bounds are clipped to the canvas; offscreen or rotated subjects draw directly', () => {
  const cap = new PerformerCapture({ createCanvas: mockCanvas });
  const ctx = stage(800, 600, [2, 0, 0, 2, -100, 0]);
  const draws = { count: 0 };
  const p = { ...body(draws), bounds: { x: 0, y: 250, w: 200, h: 100 } };
  const layer = cap.capture(ctx, 1, p);
  assert.deepEqual(layer.device, { x: 0, y: 500, w: 300, h: 100 }, 'negative left edge and bottom clipped');
  assert.equal(layer.bounds.x, 50);
  assert.equal(cap.capture(ctx, 1, { ...p, bounds: { x: -900, y: 0, w: 100, h: 100 } }), null);
  const rotated = stage(800, 600, [1, 0.1, 0, 1, 0, 0]);
  assert.equal(cap.capture(rotated, 1, p), null);
  assert.equal(draws.count, 1, 'a null capture never drew');
});

test('a layer still in use is never overwritten; a finished one is reused and cleared', () => {
  const cap = new PerformerCapture({ createCanvas: mockCanvas });
  const ctx = stage();
  const draws = { count: 0 };
  const l1 = cap.capture(ctx, 1, body(draws));
  const l2 = cap.capture(ctx, 1, { ...body(draws), id: 'broshi' });
  assert.notEqual(l1.segments[0].canvas, l2.segments[0].canvas, 'busy set not handed out twice');
  cap.release(l1); cap.release(l1);
  cap.release(l2); cap.release(l2);
  const allocated = cap.stats.allocations;
  const l3 = cap.capture(ctx, 2, { ...body(draws), bounds: { x: 300, y: 400, w: 120, h: 90 } });
  assert.equal(cap.stats.allocations, allocated, 'pooled pair reused');
  assert.equal(l3.segments[0].canvas.width, 120, 'resized to the new body size (a resize clears it)');
  const l4 = cap.capture(ctx, 3, { ...body(draws), bounds: { x: 300, y: 400, w: 200, h: 240 } });
  cap.release(l4); cap.release(l4);
  const l5 = cap.capture(ctx, 4, body(draws));
  assert.ok(l5.segments[0].canvas.getContext().calls.some((c) => c[0] === 'clearRect'), 'same-size reuse clears stale pixels');
});

test('capture consumes no randomness and inherits the stage state the body expects', () => {
  const cap = new PerformerCapture({ createCanvas: mockCanvas });
  const ctx = stage();
  ctx.globalAlpha = 0.4;
  ctx.lineJoin = 'round';
  const orig = Math.random;
  Math.random = () => { throw new Error('capture must not draw randomness'); };
  let seen = null;
  try {
    cap.capture(ctx, 1, { ...body({ count: 0 }), draw: (c) => { seen = { alpha: c.globalAlpha, join: c.lineJoin }; } });
  } finally { Math.random = orig; }
  assert.deepEqual(seen, { alpha: 0.4, join: 'round' });
});

test('paint order across blend modes is kept: glow under a later stroke stays under it', () => {
  const cs = Array.from({ length: 4 }, () => mockCanvas(10, 10).getContext());
  const { ctx, used } = segmentedContext(cs, ['source-over', 'lighter', 'source-over', 'lighter']);
  ctx.fill();                                   // body fill
  ctx.globalCompositeOperation = 'lighter'; ctx.stroke(); // glow
  ctx.globalCompositeOperation = 'source-over'; ctx.fillRect(); // stroke over the glow
  const where = cs.map((c) => c.calls.filter((k) => ['fill', 'stroke', 'fillRect'].includes(k[0])).map((k) => k[0]));
  assert.deepEqual(where, [['fill'], ['stroke'], ['fillRect'], []]);
  assert.equal(used(), 2);
  // Every segment saw the same state changes.
  ctx.translate(3, 4);
  assert.ok(cs.every((c) => c.getTransform().e === 3));
});

test('a captured body with glows composites its segments in draw order', () => {
  const cap = new PerformerCapture({ createCanvas: mockCanvas });
  const ctx = stage();
  const layer = cap.capture(ctx, 1, { ...body({ count: 0 }), draw: (c) => {
    c.fill(); c.save(); c.globalCompositeOperation = 'lighter'; c.fill(); c.restore(); c.stroke();
  } });
  assert.deepEqual(layer.segments.map((g) => g.op), ['source-over', 'lighter', 'source-over']);
  cap.composite(ctx, layer);
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'drawImage').map((c) => c[2]), ['source-over', 'lighter', 'source-over']);
});

test('capture canvases are owned in the shared ledger; a refusal draws directly', async () => {
  const { GraphicsResidency, MiB } = await import('../src/render/GraphicsResidency.js');
  const r = new GraphicsResidency({ budgetBytes: 4 * MiB });
  const cap = new PerformerCapture({ createCanvas: mockCanvas, residency: r });
  const ctx = stage();
  const draws = { count: 0 };
  // 200 x 240 x 4 B x 6 segments = 1.1 MiB: fits.
  const l = cap.capture(ctx, 1, body(draws));
  assert.ok(l);
  assert.equal(r.snapshot().byOwner['performer-capture'].live, 200 * 240 * 4 * 6);
  cap.release(l); cap.release(l);
  // A box too large for the budget is refused before any canvas grows.
  const big = cap.capture(ctx, 2, { ...body(draws), bounds: { x: 0, y: 0, w: 1400, h: 840 } });
  assert.equal(big, null);
  assert.ok(r.usedBytes <= 4 * MiB);
  cap.dispose();
  assert.equal(r.usedBytes, 0);
});
