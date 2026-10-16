import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wrappedOffset, islands, ships, seaLifeSchedule, monsterSchedule,
  tsunamiSchedule, tsunamiLift, tsunamiProfile, sprayFlecks, fishArcY, serpentHumpY,
  tsunamiHeightScale, tsunamiActive, tsunamiProgress, tsunamiRowFrac,
  tsunamiPerspectiveScale, tsunamiCenterX, tsunamiDepthLift,
  tsunamiWithdrawalActive, tsunamiWithdrawal01, TSUNAMI_WITHDRAWAL_LEAD_MS,
  OCEAN_LIFE_WRAP_PX, TSUNAMI_WIDTH_PX, TSUNAMI_SWEEP_MS,
  TSUNAMI_APPROACH_UP_FRAC, TSUNAMI_OVERTOP_SCALE, TSUNAMI_ROW_FAR, TSUNAMI_ROW_NEAR,
} from '../src/world/OceanLife.js';

test('wrappedOffset stays within (-wrap/2, wrap/2] and matches unwrapped difference near zero', () => {
  for (let x0 = 0; x0 < OCEAN_LIFE_WRAP_PX; x0 += 777) {
    for (let scroll = -20000; scroll <= 20000; scroll += 3333) {
      const d = wrappedOffset(x0, scroll, OCEAN_LIFE_WRAP_PX);
      assert.ok(d > -OCEAN_LIFE_WRAP_PX / 2 - 1e-6 && d <= OCEAN_LIFE_WRAP_PX / 2 + 1e-6, `out of range: ${d}`);
    }
  }
  assert.ok(Math.abs(wrappedOffset(100, 90) - 10) < 1e-9);
});

test('islands/ships are deterministic per seed, differ across seeds, and respect field ranges', () => {
  const a = islands(11, 4), b = islands(11, 4), c = islands(99, 4);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(a.length, 4);
  for (const isl of a) {
    assert.ok(isl.rowFrac >= 0 && isl.rowFrac <= 1);
    assert.ok(isl.w > 0 && isl.h > 0);
    assert.ok(['cone', 'mesa', 'palm'].includes(isl.kind));
  }
  const sa = ships(5, 3), sb = ships(5, 3);
  assert.deepEqual(sa, sb);
  assert.equal(sa.length, 3);
  for (const s of sa) {
    assert.ok(s.rowFrac >= 0 && s.rowFrac <= 1);
    assert.ok(s.driftPxS !== 0);
    assert.ok(s.size > 0);
    assert.ok(['sail', 'wreck'].includes(s.kind));
  }
});

test('seaLifeSchedule is sorted, deterministic, and spaced within [minGap, maxGap]', () => {
  const durationMs = 180000;
  const a = seaLifeSchedule(7, durationMs);
  const b = seaLifeSchedule(7, durationMs);
  assert.deepEqual(a, b);
  for (let i = 1; i < a.length; i++) {
    assert.ok(a[i].tMs > a[i - 1].tMs, 'events must be sorted');
    const gap = a[i].tMs - a[i - 1].tMs;
    assert.ok(gap >= 7000 - 1e-6 && gap <= 18000 + 1e-6, `gap out of range: ${gap}`);
  }
  for (const ev of a) {
    assert.ok(['fish', 'pod', 'spout'].includes(ev.kind));
    assert.ok(ev.tMs >= 0 && ev.tMs < durationMs);
    assert.ok(ev.u >= 0 && ev.u <= 1);
  }
});

test('monsterSchedule keeps events clear of the margins and enforces the min gap', () => {
  const durationMs = 240000;
  const evs = monsterSchedule(3, durationMs, { marginMs: 20000, minGapMs: 45000 });
  assert.ok(evs.length >= 1 && evs.length <= 2);
  for (const e of evs) {
    assert.ok(e.tMs >= 20000 && e.tMs <= durationMs - 20000);
  }
  for (let i = 1; i < evs.length; i++) assert.ok(evs[i].tMs - evs[i - 1].tMs >= 45000 - 1e-6);
  assert.doesNotThrow(() => monsterSchedule(3, 10000));
});

test('tsunamiSchedule anchors near supplied hotspots and stays sorted/deterministic', () => {
  const durationMs = 200000;
  const hotspots = [50000, 150000];
  const evs = tsunamiSchedule(1, durationMs, hotspots);
  assert.equal(evs.length, 2);
  for (let i = 0; i < evs.length; i++) {
    assert.ok(Math.abs(evs[i].tMs - hotspots[i]) <= 4000 + 1e-6, `tsunami not anchored near hotspot: ${evs[i].tMs} vs ${hotspots[i]}`);
  }
  for (let i = 1; i < evs.length; i++) assert.ok(evs[i].tMs >= evs[i - 1].tMs);
  const again = tsunamiSchedule(1, durationMs, hotspots);
  assert.deepEqual(evs, again);
  const fallback = tsunamiSchedule(1, durationMs, []);
  assert.ok(fallback.length >= 1 && fallback.length <= 2);
});

test('tsunami approaches from far (horizon) toward the player (near edge)', () => {
  const half = TSUNAMI_SWEEP_MS / 2;
  const ev = { tMs: 10000, dir: 1 };
  assert.equal(tsunamiActive(ev, ev.tMs - half - 1), false);
  assert.equal(tsunamiActive(ev, ev.tMs + half + 1), false);
  assert.equal(tsunamiActive(ev, ev.tMs), true);

  // Start of window: far / out-of-sight scale
  assert.ok(tsunamiProgress(-half) <= 1e-9);
  assert.ok(Math.abs(tsunamiRowFrac(0) - TSUNAMI_ROW_FAR) < 1e-9);
  assert.ok(tsunamiPerspectiveScale(0) <= 1e-9, 'invisible at far start');

  // End of window: near the player
  assert.ok(Math.abs(tsunamiProgress(half) - 1) < 1e-9);
  assert.ok(Math.abs(tsunamiRowFrac(1) - TSUNAMI_ROW_NEAR) < 1e-9);
  assert.ok(Math.abs(tsunamiPerspectiveScale(1) - 1) < 1e-9);

  // Monotonic approach: rowFrac decreases (far → near), scale grows
  let prevRf = Infinity, prevScale = -1;
  for (let p = 0; p <= 1; p += 0.05) {
    const rf = tsunamiRowFrac(p);
    const sc = tsunamiPerspectiveScale(p);
    assert.ok(rf <= prevRf + 1e-9, `rowFrac must decrease toward player: ${rf} > ${prevRf}`);
    assert.ok(sc >= prevScale - 1e-9, `scale must grow toward player: ${sc} < ${prevScale}`);
    prevRf = rf;
    prevScale = sc;
  }
  assert.ok(TSUNAMI_ROW_FAR > TSUNAMI_ROW_NEAR);

  // Center X bias from dir.
  const w = 1280;
  const left = tsunamiCenterX({ dir: -1 }, w);
  const right = tsunamiCenterX({ dir: 1 }, w);
  assert.ok(left < w * 0.5 && right > w * 0.5);
});

test('tsunamiLift and tsunamiDepthLift are bounded and peak at zero offset', () => {
  assert.equal(tsunamiLift(0), 1);
  assert.ok(tsunamiLift(TSUNAMI_WIDTH_PX / 2) < 1 && tsunamiLift(TSUNAMI_WIDTH_PX / 2) > 0);
  assert.equal(tsunamiLift(TSUNAMI_WIDTH_PX), 0);
  assert.equal(tsunamiLift(TSUNAMI_WIDTH_PX * 5), 0);
  assert.equal(tsunamiLift(-50), tsunamiLift(50));

  assert.equal(tsunamiDepthLift(0.5, 0.5), 1);
  assert.ok(tsunamiDepthLift(0.5, 0.55) > 0 && tsunamiDepthLift(0.5, 0.55) < 1);
  assert.equal(tsunamiDepthLift(0.5, 0.9), 0);
});

test('tsunamiProfile and shape helpers stay bounded and finite', () => {
  for (let s = -1; s <= 1; s += 0.1) {
    const p = tsunamiProfile(s);
    assert.ok(Number.isFinite(p) && p >= 0 && p <= 1, `profile out of bounds at s=${s}: ${p}`);
  }
  for (let u = 0; u <= 1; u += 0.1) {
    const y = fishArcY(u);
    assert.ok(Number.isFinite(y) && y >= -1e-9);
  }
  assert.ok(Math.abs(fishArcY(0)) < 1e-6 && Math.abs(fishArcY(1)) < 1e-6, 'the leap starts and lands at the water line');
  for (let u = 0; u <= 1; u += 0.1) {
    const y = serpentHumpY(u, 1.3);
    assert.ok(Number.isFinite(y) && Math.abs(y) <= 10 + 1e-9);
  }
});

test('tsunamiHeightScale: 0 at far start, peaks near arrival, eases as it breaks', () => {
  const half = TSUNAMI_SWEEP_MS / 2;
  assert.ok(tsunamiHeightScale(-half) <= 1e-9, 'far away at the very start of the approach');
  const peakAge = -half + TSUNAMI_SWEEP_MS * TSUNAMI_APPROACH_UP_FRAC;
  assert.ok(Math.abs(tsunamiHeightScale(peakAge) - 1) < 1e-9, 'full crest at the approach fraction');
  assert.ok(tsunamiHeightScale(half) < 1, 'settles back down after the break');
  assert.ok(tsunamiHeightScale(half) > 0, 'never drops to nothing right as the window ends');
  let prev = -1;
  for (let age = -half; age <= peakAge; age += 100) {
    const s = tsunamiHeightScale(age);
    assert.ok(Number.isFinite(s) && s >= 0 && s <= 1);
    assert.ok(s >= prev - 1e-9, `must grow monotonically approaching the crest: ${s} < ${prev} at age=${age}`);
    prev = s;
  }
  // Overtop threshold is reachable during the approach
  let crossed = false;
  for (let age = -half; age <= half; age += 50) {
    if (tsunamiHeightScale(age) >= TSUNAMI_OVERTOP_SCALE) { crossed = true; break; }
  }
  assert.ok(crossed, 'heightScale must cross TSUNAMI_OVERTOP_SCALE so floods can arm');
  assert.ok(TSUNAMI_OVERTOP_SCALE > 0 && TSUNAMI_OVERTOP_SCALE <= 1);
});

test('sprayFlecks is deterministic per seed and respects field ranges', () => {
  const a = sprayFlecks(4, 7), b = sprayFlecks(4, 7), c = sprayFlecks(9, 7);
  assert.equal(a.length, 7);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  for (const f of a) {
    assert.ok(f.sOff >= -0.25 && f.sOff <= 0.45);
    assert.ok(f.riseFrac >= 0.15 && f.riseFrac <= 0.7);
    assert.ok(f.phase >= 0 && f.phase < Math.PI * 2);
  }
});

test('the withdrawal window sits immediately before the approach window, never overlapping it', () => {
  const ev = { tMs: 100000 };
  const half = TSUNAMI_SWEEP_MS / 2;
  // Right at the boundary (start of approach): withdrawal must be off, approach on.
  assert.equal(tsunamiWithdrawalActive(ev, ev.tMs - half), false);
  assert.equal(tsunamiActive(ev, ev.tMs - half), true);
  // Just before that boundary: withdrawal on, approach off.
  assert.equal(tsunamiWithdrawalActive(ev, ev.tMs - half - 1), true);
  assert.equal(tsunamiActive(ev, ev.tMs - half - 1), false);
  // Before the withdrawal window even opens: both off.
  assert.equal(tsunamiWithdrawalActive(ev, ev.tMs - half - TSUNAMI_WITHDRAWAL_LEAD_MS - 1), false);
});

test('tsunamiWithdrawal01 is 0 outside its window and rises monotonically toward 1 inside it', () => {
  const ev = { tMs: 50000 };
  const half = TSUNAMI_SWEEP_MS / 2;
  assert.equal(tsunamiWithdrawal01(ev, ev.tMs - half - TSUNAMI_WITHDRAWAL_LEAD_MS - 500), 0);
  assert.equal(tsunamiWithdrawal01(ev, ev.tMs - half + 500), 0, 'zero once the approach window has started');
  let prev = -1;
  for (let age = -(half + TSUNAMI_WITHDRAWAL_LEAD_MS); age < -half; age += 100) {
    const v = tsunamiWithdrawal01(ev, ev.tMs + age);
    assert.ok(v >= prev - 1e-9, `withdrawal01 should rise monotonically, dropped at age=${age}`);
    assert.ok(v >= 0 && v <= 1);
    prev = v;
  }
  assert.ok(prev > 0.9, `expected withdrawal01 to approach 1 right before the approach window, got ${prev}`);
});
