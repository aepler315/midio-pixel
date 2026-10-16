// Range v2 Task 11: the rock stage stands on the rendered support curve and
// its wet receivers are the exact pool shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRockStage, supportAt, slabEdges, insidePolygon, COLUMN_PX, STAGE_SLABS } from '../src/world/alpine/RockStage.js';
import { GroundResponse } from '../src/world/alpine/GroundResponse.js';
import * as rockStage from '../src/world/alpine/RockStage.js';

const W = 640, H = 360;
const barsFrom = (fn, width = W, step = 16) => {
  const bars = [];
  for (let x = -64; x < width + 64; x += step) bars.push({ x, width: step, y: fn(x + step / 2) });
  return bars;
};
const flat = barsFrom(() => 240);
const rolling = barsFrom((x) => 240 + 18 * Math.sin(x / 70));

/** Vertices of the first top face (contact slab), as [x, y] pairs. */
function contactVertices(stage) {
  const out = [];
  const { positions, surfaces } = stage;
  for (let q = 0; q < positions.length / 12; q++) {
    if (surfaces[q * 4] > 0.5) continue; // risers are 1
    // Top-left / top-right corners of a top face at depth 0.
    for (const k of [0, 1]) {
      const i = (q * 4 + k) * 3;
      if (positions[i + 2] === 0) out.push([positions[i], positions[i + 1]]);
    }
  }
  return out;
}

test('supportAt joins bar tops at their centres and clamps at the ends', () => {
  const bars = [{ x: 0, width: 10, y: 100 }, { x: 10, width: 10, y: 120 }];
  assert.equal(supportAt(bars, 5), 100);
  assert.equal(supportAt(bars, 10), 110);
  assert.equal(supportAt(bars, -50), 100);
  assert.equal(supportAt(bars, 500), 120);
  assert.ok(Number.isNaN(supportAt([], 3)));
});

test('the contact line is the rendered support curve at every column', () => {
  for (const bars of [flat, rolling]) {
    const stage = buildRockStage({ bars, width: W, height: H, worldX: 1234, originX: 34, seed: 7 });
    const verts = contactVertices(stage);
    assert.ok(verts.length > W / COLUMN_PX, `contact vertices ${verts.length}`);
    for (const [x, y] of verts) assert.ok(Math.abs(y - supportAt(bars, x)) < 1e-3, `contact off support at ${x}`);
  }
});

test('contact holds under zoom and shake: the stage follows the bars it is given', () => {
  // Zoom scales the rendered bars; shake translates them. Either way the
  // stage is rebuilt on the bars the frame drew, so contact is exact.
  const zoomed = rolling.map((b) => ({ x: b.x * 1.25, width: b.width * 1.25, y: 180 + (b.y - 180) * 1.25 }));
  const shaken = rolling.map((b) => ({ ...b, x: b.x + 6, y: b.y - 4 }));
  for (const bars of [zoomed, shaken]) {
    const stage = buildRockStage({ bars, width: W, height: H, seed: 3 });
    for (const [x, y] of contactVertices(stage)) assert.ok(Math.abs(y - supportAt(bars, x)) < 1e-3);
  }
});

test('slab edges are world-anchored and ordered', () => {
  for (let wx = -500; wx < 500; wx += 37) {
    const e = slabEdges(wx, 11);
    assert.equal(e.length, STAGE_SLABS);
    assert.equal(e[0], 0);
    for (let k = 1; k < e.length; k++) assert.ok(e[k] > e[k - 1] && e[k] <= 0.95);
    assert.deepEqual(slabEdges(wx, 11), e);
  }
  // Travelling by d px along the world shifts the same rock by -d on screen.
  const a = buildRockStage({ bars: flat, width: W, height: H, worldX: 1000, originX: 0, seed: 2 });
  const b = buildRockStage({ bars: flat, width: W, height: H, worldX: 1000 + COLUMN_PX * 5, originX: 0, seed: 2 });
  // Column c+5 of `a` and column c of `b` sample the same world x.
  const colY = (s, c) => s.positions[(c * (STAGE_SLABS * 2 - 1) * 4 + 3) * 3 + 1]; // bottom-left of the first face
  for (let c = 0; c < 20; c++) assert.ok(Math.abs(colY(a, c + 5) - colY(b, c)) < 1e-3, `column ${c}`);
});

test('contact slab is a narrow irregular ledge rather than a broad walking plane', () => {
  const edges = Array.from({ length: 200 }, (_, i) => slabEdges(i * 8, 11)[1]);
  assert.ok(Math.max(...edges) < 0.16, 'visible contact slab stays narrow');
  assert.ok(Math.max(...edges) - Math.min(...edges) > 0.025, 'front edge has world-anchored variation');
});

test('ledge shade follows support and leaves the contact rim readable', () => {
  assert.equal(typeof rockStage.drawRockStageShade, 'function');
  const vertices = [], stops = [];
  const ctx = { save() {}, restore() {}, beginPath() {}, closePath() {}, clip() {}, fillRect() {},
    moveTo: (x, y) => vertices.push([x, y]), lineTo: (x, y) => vertices.push([x, y]),
    createLinearGradient: () => ({ addColorStop: (at, color) => stops.push([at, color]) }) };
  rockStage.drawRockStageShade(ctx, { bars: rolling, width: W, height: H });
  for (const b of rolling) assert.ok(vertices.some(([x, y]) => x === b.x + b.width / 2 && y === b.y));
  assert.equal(stops[0][1], 'rgba(0,0,0,0)');
  assert.ok(stops.at(-1)[1].includes('0.68'));
});

test('pools appear only where the support is level across the whole pool', () => {
  const level = buildRockStage({ bars: flat, width: W * 4, height: H, worldX: 0, seed: 9 });
  assert.ok(level.pools.length > 0, 'a level stage carries some pools');
  for (const p of level.pools) assert.ok(p.alpha > 0.99 && p.unevenness < 1e-6);
  // Same endpoints, a hump in the middle of every pool: an endpoint-only
  // test would pass these; the interior samples must reject them.
  const humps = level.pools.map((p) => {
    const xs = p.polygon.map((q) => q.x);
    return { id: p.id, lo: Math.min(...xs), hi: Math.max(...xs) };
  });
  const humped = barsFrom((x) => {
    for (const { lo, hi } of humps) {
      const mid = (lo + hi) / 2, half = (hi - lo) / 2;
      if (Math.abs(x - mid) < half * 0.5) return 240 - 20 * Math.cos(((x - mid) / half) * Math.PI);
    }
    return 240;
  }, W * 4 + 400, 4);
  const stage = buildRockStage({ bars: humped, width: W * 4, height: H, worldX: 0, seed: 9 });
  for (const h of humps) {
    const kept = stage.pools.find((p) => p.id === h.id);
    assert.ok(!kept, `pool ${h.id} kept on a hump (unevenness ${kept?.unevenness})`);
  }
  assert.ok(stage.pools.length < level.pools.length);
});

test('wet masks are the exact pool polygons; dry corners stay dry', () => {
  const stage = buildRockStage({ bars: flat, width: W * 4, height: H, seed: 9 });
  assert.equal(stage.wetMasks.length, stage.pools.length);
  for (const [i, m] of stage.wetMasks.entries()) {
    const p = stage.pools[i];
    assert.equal(m.polygon, p.polygon);
    const xs = p.polygon.map((q) => q.x), ys = p.polygon.map((q) => q.y);
    const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    assert.ok(insidePolygon(p.polygon, (box.x0 + box.x1) / 2, p.waterY), 'pool centre is wet');
    // The bounding-box corners (what a rectangle clip would have wetted).
    for (const [x, y] of [[box.x0 + 1, box.y0 + 0.2], [box.x1 - 1, box.y0 + 0.2], [box.x0 + 1, box.y1 - 0.2], [box.x1 - 1, box.y1 - 0.2]]) {
      assert.ok(!insidePolygon(p.polygon, x, y), 'corner of the box is dry');
    }
    // Pools never sit on the contact slab.
    assert.ok(p.slab >= 1);
  }
});

test('GroundResponse clips a polygon receiver to its path, not a rectangle', () => {
  const calls = [];
  const ctx = { save() {}, restore() {}, beginPath() {}, stroke() {}, clip() { calls.push('clip'); },
    ellipse() {}, closePath() { calls.push('close'); }, rect() { calls.push('rect'); },
    moveTo() { calls.push('move'); }, lineTo() { calls.push('line'); } };
  const polygon = [{ x: 0, y: 0 }, { x: 20, y: -3 }, { x: 40, y: 0 }, { x: 20, y: 3 }];
  new GroundResponse().draw(ctx, {
    receivers: { wetMasks: [{ id: 'p', polygon, alpha: 1 }], litEdges: [] },
    hits: [{ tMs: 900, x: 20, strength: 1 }], nowMs: 1000,
  });
  assert.ok(!calls.includes('rect'), 'no rectangle clip');
  assert.deepEqual(calls.slice(0, 6), ['move', 'line', 'line', 'line', 'close', 'clip']);
});

test('slab edges break: risers vanish along some stretches and stand along others', () => {
  const stage = buildRockStage({ bars: flat, width: W * 6, height: H, seed: 4 });
  const { positions, surfaces } = stage;
  let flush = 0, ledge = 0;
  for (let q = 0; q < positions.length / 12; q++) {
    if (surfaces[q * 4] < 0.5) continue;
    const h = positions[(q * 4 + 3) * 3 + 1] - positions[(q * 4) * 3 + 1];
    if (h < 0.5) flush++; else if (h > 6) ledge++;
  }
  assert.ok(flush > 20 && ledge > 20, `flush ${flush}, ledge ${ledge}`);
});

test('polygon contact rings retain hit strength and reduced motion suppresses rings', () => {
  const opacity = (strength, reducedMotion = false) => {
    const strokes = [];
    const ctx = { save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, clip() {}, ellipse() {},
      stroke() { strokes.push(this.strokeStyle); } };
    new GroundResponse().draw(ctx, { receivers: { wetMasks: [{ polygon: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }], alpha: .5 }] },
      nowMs: 1100, hits: [{ tMs: 1000, strength }], reducedMotion });
    return strokes;
  };
  const strong = opacity(1), weak = opacity(.2);
  assert.equal(strong.length, 1); assert.equal(weak.length, 1);
  const alpha = x => Number(x[0].match(/,([.\d]+)\)$/)[1]);
  assert.ok(alpha(strong) > alpha(weak) * 4);
  assert.deepEqual(opacity(0), []);
  assert.deepEqual(opacity(1, true), []);
});
