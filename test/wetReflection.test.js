// Range v2 Task 12: reflections are the captured bodies, mirrored only into
// the exact pools that hold them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawWetReflections, reflectionAlpha, wobbleOffsets, SQUASH } from '../src/world/alpine/WetReflection.js';
import { buildRockStage, insidePolygon } from '../src/world/alpine/RockStage.js';

function recorder() {
  const calls = [];
  return {
    calls, globalAlpha: 1, globalCompositeOperation: 'source-over',
    save() { calls.push(['save']); }, restore() { calls.push(['restore']); },
    beginPath() { calls.push(['beginPath']); }, moveTo(x, y) { calls.push(['moveTo', x, y]); }, lineTo(x, y) { calls.push(['lineTo', x, y]); },
    closePath() { calls.push(['closePath']); }, clip() { calls.push(['clip']); },
    setTransform(...a) { calls.push(['setTransform', ...a]); },
    drawImage(src, ...a) { calls.push(['drawImage', src.id, this.globalCompositeOperation, this.globalAlpha, ...a]); },
  };
}
const pool = {
  id: 'p', alpha: 1, dropPx: 0,
  polygon: [{ x: 300, y: 690 }, { x: 360, y: 684 }, { x: 420, y: 690 }, { x: 360, y: 700 }],
  surfacePolygon: [{ x: 290, y: 670 }, { x: 430, y: 670 }, { x: 430, y: 720 }, { x: 290, y: 720 }],
};
const layer = (over = {}) => ({
  id: 'midio', frameId: 5, visible: true, segments: [{ canvas: { id: 'N' }, op: 'source-over' }, { canvas: { id: 'A' }, op: 'lighter' }],
  device: { x: 300, y: 400, w: 120, h: 200 }, transform: { a: 1, d: 1, e: 0, f: 0 },
  bounds: { x: 300, y: 400, w: 120, h: 200 }, hue: 190, contactY: 600, airbornePx: 0, pending: 2, ...over,
});
const capture = { released: [], release(l) { this.released.push(l.id); } };

test('clipped to the exact pool, then the slab top, then mirrored about the water plane', () => {
  const ctx = recorder();
  const n = drawWetReflections(ctx, { frame: { frameId: 5, timeMs: 1000 }, layers: [layer()], receivers: { pools: [pool] } });
  assert.equal(n, 1);
  const clips = ctx.calls.filter((c) => c[0] === 'clip').length;
  assert.equal(clips, 2);
  const moves = ctx.calls.filter((c) => c[0] === 'moveTo');
  assert.deepEqual(moves[0].slice(1), [300, 690], 'first clip traces the pool polygon');
  assert.deepEqual(moves[1].slice(1), [290, 670], 'second clip traces the slab top');
  const t = ctx.calls.find((c) => c[0] === 'setTransform');
  assert.deepEqual(t.slice(1), [1, 0, 0, -SQUASH, 0, 600 * (1 + SQUASH)]);
  // Both halves of the body: ordinary paint and additive glow.
  const ops = new Set(ctx.calls.filter((c) => c[0] === 'drawImage').map((c) => `${c[1]}:${c[2]}`));
  assert.deepEqual([...ops].sort(), ['A:lighter', 'N:source-over']);
});

test('a body away from the pool, a stale frame or a hidden body reflects nothing', () => {
  for (const l of [layer({ bounds: { x: 900, y: 400, w: 100, h: 200 } }), layer({ frameId: 4 }), layer({ visible: false })]) {
    const ctx = recorder();
    assert.equal(drawWetReflections(ctx, { frame: { frameId: 5, timeMs: 0 }, layers: [l], receivers: { pools: [pool] } }), 0);
    assert.equal(ctx.calls.filter((c) => c[0] === 'drawImage').length, 0);
  }
});

test('every layer is released once by its reflection consumer', () => {
  capture.released.length = 0;
  drawWetReflections(recorder(), { frame: { frameId: 5 }, layers: [layer(), layer({ id: 'broshi', bounds: { x: 900, y: 0, w: 1, h: 1 } })],
    receivers: { pools: [pool] }, capture });
  assert.deepEqual(capture.released, ['midio', 'broshi']);
});

test('height and roughness restrain the reflection; wobble is pure in heard time', () => {
  assert.ok(reflectionAlpha(layer({ airbornePx: 150 }), pool) < reflectionAlpha(layer(), pool));
  assert.ok(reflectionAlpha(layer(), pool, { roughness: 0.8 }) < reflectionAlpha(layer(), pool, { roughness: 0.1 }));
  assert.deepEqual(wobbleOffsets(12.5, 3, 1.6), wobbleOffsets(12.5, 3, 1.6));
  assert.ok(Math.max(...wobbleOffsets(12.5, 3, 1.6).map(Math.abs)) <= 1.6);
  assert.ok(wobbleOffsets(1, 3, 0).every((v) => v === 0));
  // Quality 4+ sheds the wobble: every strip lands at the body's own x.
  const ctx = recorder();
  drawWetReflections(ctx, { frame: { frameId: 5, timeMs: 777 }, layers: [layer()], receivers: { pools: [pool] }, quality: 4 });
  assert.ok(ctx.calls.filter((c) => c[0] === 'drawImage').every((c) => c[8] === 300));
});

test('rock stage pools carry a slab-top surface that contains the water', () => {
  const bars = [];
  for (let x = -64; x < 2600; x += 16) bars.push({ x, width: 16, y: 240 });
  const stage = buildRockStage({ bars, width: 2560, height: 360, seed: 9 });
  assert.ok(stage.pools.length > 0);
  for (const p of stage.pools) {
    assert.ok(p.surfacePolygon.length > 4);
    const cx = p.polygon.reduce((s, q) => s + q.x, 0) / p.polygon.length;
    assert.ok(insidePolygon(p.surfacePolygon, cx, p.waterY), `pool ${p.id} centre on its slab top`);
  }
});

test('water lower than the contact mirrors about its own surface', () => {
  const ctx = recorder();
  drawWetReflections(ctx, { frame: { frameId: 5 }, layers: [layer()], receivers: { pools: [{ ...pool, dropPx: 30 }] } });
  const t = ctx.calls.find((c) => c[0] === 'setTransform');
  assert.deepEqual(t.slice(1), [1, 0, 0, -SQUASH, 0, 630 * (1 + SQUASH)]);
});
