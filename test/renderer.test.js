import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer, dropImpactStrength, speedLineSegments, bloomStrength, BLOOM_BASE, heatAmbient01, dropMotionBlurStrength, dropMotionBlurPasses } from '../src/render/Renderer.js';

test('dropImpactStrength is 0 with no drop yet (dropAtMs = -Infinity, HypeDirector\'s initial state)', () => {
  assert.equal(dropImpactStrength(0, -Infinity), 0);
  assert.equal(dropImpactStrength(100000, -Infinity), 0);
});

test('dropImpactStrength peaks at 1 right at the drop and eases to 0 by the end of its life', () => {
  assert.equal(dropImpactStrength(1000, 1000), 1);
  assert.ok(dropImpactStrength(1319, 1000) > 0, 'should still be positive just before the life ends');
  assert.equal(dropImpactStrength(1320, 1000), 0, 'exactly at DROP_IMPACT_LIFE_MS should be 0');
  assert.equal(dropImpactStrength(2000, 1000), 0);
});

test('dropImpactStrength is 0 before the drop (negative age) and decreases monotonically after it', () => {
  assert.equal(dropImpactStrength(999, 1000), 0);
  let prev = dropImpactStrength(1000, 1000);
  for (let age = 10; age <= 320; age += 10) {
    const v = dropImpactStrength(1000 + age, 1000);
    assert.ok(v <= prev + 1e-9, `must ease down monotonically, age=${age}`);
    prev = v;
  }
});

test('speedLineSegments returns exactly `count` segments', () => {
  const segs = speedLineSegments(100, 100, 24, 1, 3, 500);
  assert.equal(segs.length, 24);
});

test('speedLineSegments: every segment stays within [0.55, 0.75+0.25*s] of maxR from center', () => {
  const cx = 200, cy = 150, maxR = 400;
  for (const s of [0, 0.5, 1]) {
    const segs = speedLineSegments(cx, cy, 24, s, 7, maxR);
    for (const seg of segs) {
      const rInner = Math.hypot(seg.x0 - cx, seg.y0 - cy);
      const rOuter = Math.hypot(seg.x1 - cx, seg.y1 - cy);
      assert.ok(Math.abs(rInner - 0.55 * maxR) < 1e-6, `inner radius drifted at s=${s}`);
      const expectedOuter = (0.75 + 0.25 * s) * maxR;
      assert.ok(Math.abs(rOuter - expectedOuter) < 1e-6, `outer radius drifted at s=${s}`);
    }
  }
});

test('speedLineSegments is deterministic per seed and varies between different seeds', () => {
  const a = speedLineSegments(0, 0, 12, 1, 5, 300);
  const b = speedLineSegments(0, 0, 12, 1, 5, 300);
  assert.deepEqual(a, b, 'same seed must reproduce the same fan of lines');

  const c = speedLineSegments(0, 0, 12, 1, 6, 300);
  const anyDifferent = a.some((seg, i) => Math.abs(seg.x1 - c[i].x1) > 1e-6 || Math.abs(seg.y1 - c[i].y1) > 1e-6);
  assert.ok(anyDifferent, 'a different seed should rotate the fan');
});

// --- bloomStrength -----------------------------------------------------

function fakeHype(slam = 0, surge = 0) { return { slam, surge }; }
function fakeFever(level = 0) { return { level }; }

test('bloomStrength has a steady base at rest, never zero', () => {
  const s = bloomStrength(fakeHype(), fakeFever());
  assert.ok(s > 0, 'a lit scene always catches a little light');
  assert.ok(Math.abs(s - BLOOM_BASE) < 1e-9, 'exactly the base with no reactive signal');
});

test('bloomStrength rises monotonically with hype.slam, hype.surge, and fever.level', () => {
  const base = bloomStrength(fakeHype(0, 0), fakeFever(0));
  assert.ok(bloomStrength(fakeHype(0.5, 0), fakeFever(0)) > base, 'slam raises it');
  assert.ok(bloomStrength(fakeHype(0, 0.5), fakeFever(0)) > base, 'surge raises it');
  assert.ok(bloomStrength(fakeHype(0, 0), fakeFever(0.5)) > base, 'fever raises it');
  let prev = base;
  for (const level of [0.2, 0.4, 0.6, 0.8, 1]) {
    const v = bloomStrength(fakeHype(level, level), fakeFever(level));
    assert.ok(v >= prev, `must rise monotonically, level=${level}`);
    prev = v;
  }
});

test('bloomStrength is bounded: a maxed-out drop during max fever never blows out', () => {
  const s = bloomStrength(fakeHype(1, 1), fakeFever(1));
  assert.ok(s <= 0.24 + 1e-9, `bloom must stay a restrained highlight pass, got ${s}`);
});

test('bloom preserves bright terrain detail instead of additively clipping it to white', () => {
  const bufferCtx = { drawImage() {}, clearRect() {} };
  const buffer = () => ({ width: 320, height: 180, getContext: () => bufferCtx });
  const renderer = Object.create(Renderer.prototype);
  renderer._bloomA = buffer();
  renderer._bloomB = buffer();
  let composite, alpha;
  const ctx = { save() {}, restore() {}, drawImage() {
    composite = this.globalCompositeOperation;
    alpha = this.globalAlpha;
  } };
  renderer._drawBloom(ctx, { width: 960, height: 540 }, {
    hype: fakeHype(1, 1), fever: fakeFever(1),
  });
  assert.equal(composite, 'screen', 'highlight spill should use remaining brightness headroom');
  assert.ok(alpha <= 0.24);
});

test('bloomStrength tolerates missing hype/fever (defensive defaults)', () => {
  assert.ok(Math.abs(bloomStrength(null, null) - BLOOM_BASE) < 1e-9);
});

test('heatAmbient01 is 0 with no fire and no ember haze', () => {
  assert.equal(heatAmbient01(false, 0, 0), 0);
  assert.equal(heatAmbient01(false, 1, 0), 0, 'a stale/leftover intensity01 with fireActive=false must not leak through');
});

test('heatAmbient01 tracks an active fire\'s own intensity directly', () => {
  assert.equal(heatAmbient01(true, 0.3, 0), 0.3);
  assert.equal(heatAmbient01(true, 1, 0), 1);
});

test('heatAmbient01: EMBER ambient haze is capped well below a full wildfire blast', () => {
  const full = heatAmbient01(false, 0, 1);
  assert.ok(full > 0 && full < 1, `expected a capped mood, got ${full}`);
  assert.ok(full <= heatAmbient01(true, 1, 0), 'a full ember haze should never exceed a full wildfire strike');
});

test('heatAmbient01 takes the max of fire and ember, not their sum', () => {
  const v = heatAmbient01(true, 0.9, 1);
  assert.ok(v <= 1, `should stay clamped, got ${v}`);
});

test('dropMotionBlurStrength is 0 outside the drop impact window', () => {
  assert.equal(dropMotionBlurStrength(0, -Infinity, 20), 0, 'no drop yet (HypeDirector initial state)');
  assert.equal(dropMotionBlurStrength(999, 1000, 20), 0, 'before the drop');
  assert.equal(dropMotionBlurStrength(1000 + 320, 1000, 20), 0, 'exactly at the end of the impact life');
  assert.equal(dropMotionBlurStrength(2000, 1000, 20), 0, 'long past the drop');
});

test('dropMotionBlurStrength scales with camera travel and saturates at full speed', () => {
  const atDrop = 1000;
  const still = dropMotionBlurStrength(atDrop, atDrop, 0);
  assert.ok(still > 0 && still < 1, `a stationary camera still smears a little at the hit, got ${still}`);
  const medium = dropMotionBlurStrength(atDrop, atDrop, 3.5);
  const full = dropMotionBlurStrength(atDrop, atDrop, 70);
  assert.ok(medium > still, 'more travel, more smear');
  assert.ok(full > medium, 'monotonic in speed');
  assert.equal(full, 1, 'saturated travel reads full strength at the hit');
  assert.ok(dropMotionBlurStrength(1000 + 300, atDrop, 70) < full, 'eases out with the impact envelope');
});

test('dropMotionBlurPasses returns [] at zero strength', () => {
  assert.deepEqual(dropMotionBlurPasses(0, 10, -4), []);
  assert.deepEqual(dropMotionBlurPasses(-0.5, 10, -4), []);
});

test('dropMotionBlurPasses: ghosts step along the travel vector and fade with age', () => {
  const passes = dropMotionBlurPasses(1, 6, -2);
  assert.equal(passes.length, 2);
  assert.equal(passes[0].dx, 6);
  assert.equal(passes[0].dy, -2);
  assert.equal(passes[1].dx, 12, 'second ghost twice as far along the travel');
  assert.equal(passes[1].dy, -4);
  assert.ok(passes[1].alpha < passes[0].alpha, 'older ghost is fainter');
  assert.ok(passes[0].alpha <= 1 && passes[1].alpha > 0, 'alphas stay in range');
});

test('dropMotionBlurPasses drops the older ghost first as strength falls', () => {
  const weak = dropMotionBlurPasses(0.1, 6, -2);
  assert.equal(weak.length, 1, 'a faint second ghost falls below the minimum first');
  const none = dropMotionBlurPasses(0.01, 6, -2);
  assert.equal(none.length, 0, 'everything under the floor composites nothing');
});

test('Range skips full-frame bloom even during a maximum drop', () => {
  const renderer = Object.create(Renderer.prototype);
  renderer._drawBloom({}, { width: 960, height: 540 }, {
    biomes: { world: { kind: 'alpine' } }, hype: fakeHype(1, 1), fever: fakeFever(1),
  });
  assert.ok(!renderer._bloomA, 'the dormant bloom owns no buffer');
});
