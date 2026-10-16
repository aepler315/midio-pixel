// The green country that bridges a broken sightline. The properties that
// matter are all about restraint: nothing where the ridge is visible, nothing
// for a graze, nothing for a sliver, and a presence that scales with how
// badly the line is actually broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  occludedSpans, hillCurve, rollAt,
  MIN_OCCLUSION_PX, MIN_SPAN_PX,
} from '../src/world/ConnectorHills.js';

/** Crest points 8px apart (CREST_STEP_PX), from a list of y values. */
function crest(ys) {
  return ys.map((y, i) => ({ x: i * 8, y, stripX: 1000 + i * 8 }));
}
/** A ridge that dips below a flat skyline between `from` and `to`. */
function dipping(n, from, to, depth, skylineY = 300) {
  const ys = new Array(n).fill(skylineY - 40); // comfortably visible by default
  for (let i = from; i <= to; i++) ys[i] = skylineY + depth;
  return { ridge: crest(ys), skyline: new Array(n).fill(skylineY) };
}

test('a ridge standing clear of the skyline produces no hills at all', () => {
  const ridge = crest(new Array(60).fill(200));
  assert.deepEqual(occludedSpans(ridge, new Array(60).fill(300)), []);
});

test('a real dip is found, with the depth it actually reaches', () => {
  const { ridge, skyline } = dipping(60, 20, 40, 50);
  const spans = occludedSpans(ridge, skyline);
  assert.equal(spans.length, 1, `expected one span, got ${spans.length}`);
  assert.equal(spans[0].from, 20);
  assert.equal(spans[0].to, 40);
  assert.ok(Math.abs(spans[0].maxDepth - 50) < 1e-9);
});

test('a graze is not an occlusion', () => {
  const { ridge, skyline } = dipping(60, 20, 40, MIN_OCCLUSION_PX - 1);
  assert.deepEqual(occludedSpans(ridge, skyline), [], 'barely touching is still visible');
});

test('a narrow notch is ignored -- slivers winking in and out are the noise case', () => {
  // Deep enough, but only a few samples (~24px) wide.
  const { ridge, skyline } = dipping(60, 20, 22, 60);
  const spans = occludedSpans(ridge, skyline);
  assert.equal(spans.length, 0, `a ${MIN_SPAN_PX}px floor should reject this`);
});

test('presence scales with how deeply the ridge is buried', () => {
  const shallow = occludedSpans(...Object.values(dipping(60, 10, 50, 20)));
  const deep = occludedSpans(...Object.values(dipping(60, 10, 50, 120)));
  assert.ok(shallow[0].depth01 < deep[0].depth01, 'deeper burial, more presence');
  assert.ok(shallow[0].depth01 >= 0 && deep[0].depth01 <= 1, 'and it stays in range');
});

test('two separate dips are two separate spans', () => {
  const n = 100;
  const ys = new Array(n).fill(260);
  for (let i = 10; i <= 35; i++) ys[i] = 350;
  for (let i = 60; i <= 85; i++) ys[i] = 360;
  const spans = occludedSpans(crest(ys), new Array(n).fill(300));
  assert.equal(spans.length, 2);
  assert.ok(spans[0].to < spans[1].from, 'and they do not overlap');
});

test('a dip running to the very end of the frame still closes', () => {
  const n = 60;
  const ys = new Array(n).fill(260);
  for (let i = 30; i < n; i++) ys[i] = 380;
  const spans = occludedSpans(crest(ys), new Array(n).fill(300));
  assert.equal(spans.length, 1, 'an unterminated span must not be dropped');
  assert.equal(spans[0].to, n - 1);
});

test('the hill curve starts and ends ON the skyline, so it has no seam', () => {
  const { ridge, skyline } = dipping(60, 15, 45, 80);
  const [span] = occludedSpans(ridge, skyline);
  const pts = hillCurve(span, ridge, skyline);
  assert.ok(Math.abs(pts[0].y - skyline[span.from]) < 1e-9, 'emerges from behind the hill');
  assert.ok(Math.abs(pts[pts.length - 1].y - skyline[span.to]) < 1e-9, 'and returns to it');
});

test('the hill curve descends below the skyline in between -- it rolls DOWN', () => {
  const { ridge, skyline } = dipping(60, 15, 45, 80);
  const [span] = occludedSpans(ridge, skyline);
  const pts = hillCurve(span, ridge, skyline);
  const mid = pts[Math.floor(pts.length / 2)];
  assert.ok(mid.y > skyline[span.from] + 5, `middle should hang below the crest, got ${mid.y}`);
  // Screen y only ever grows downward here; it must never rise above the skyline.
  for (const p of pts) assert.ok(p.y >= skyline[0] - 1e-9, 'never pokes above the occluding crest');
});

test('a barely-occluded span yields barely any hill', () => {
  const shallowSet = dipping(60, 15, 45, MIN_OCCLUSION_PX + 2);
  const [shallow] = occludedSpans(shallowSet.ridge, shallowSet.skyline);
  const deepSet = dipping(60, 15, 45, 140);
  const [deep] = occludedSpans(deepSet.ridge, deepSet.skyline);

  const drop = (span, s) => {
    const pts = hillCurve(span, s.ridge, s.skyline);
    return Math.max(...pts.map((p) => p.y)) - s.skyline[0];
  };
  assert.ok(drop(shallow, shallowSet) < drop(deep, deepSet) * 0.5,
    'a graze must not summon the same country a burial does');
});

test('the roll is keyed to the land, not the screen -- it stays put as we scroll', () => {
  // Same strip position must give the same undulation no matter where on
  // screen it currently sits, or the hills would shimmer as the world moves.
  assert.equal(rollAt(5000), rollAt(5000));
  assert.notEqual(rollAt(5000), rollAt(5000 + 210));
  for (const x of [0, 137, 5000, 99999]) assert.ok(Math.abs(rollAt(x)) <= 1.0000001);
});

test('degenerate input is survivable', () => {
  assert.deepEqual(occludedSpans(null, null), []);
  assert.deepEqual(occludedSpans(crest([100]), [200]), [], 'a single point is not a span');
  assert.deepEqual(occludedSpans(crest([100, 110]), []), []);
});
