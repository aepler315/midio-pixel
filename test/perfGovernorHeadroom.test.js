import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerfGovernor, MAX_LEVEL, WARMUP_MS } from '../src/render/PerfGovernor.js';
import { FrameCadence } from '../src/render/FrameCadence.js';

// Model raw 60 Hz callbacks, including draws skipped by the real FPS limiter.
// Only rendered callbacks supply measured work; skipped callbacks supply null.
function run(governor, { capFps = 60, workMs = 5, durationMs, startMs = 0, stopAtLevel = null } = {}) {
  const cadence = new FrameCadence();
  let nowMs = startMs;
  const endMs = nowMs + durationMs;
  while (nowMs < endMs) {
    nowMs += 1000 / 60;
    const rendered = cadence.shouldDraw(nowMs, capFps);
    governor.sample(1000 / 60, nowMs, { capFps, workMs: rendered ? workMs : null });
    if (governor.level === stopAtLevel) break;
  }
  return nowMs;
}

for (const capFps of [24, 30, 60]) {
  test(`${capFps} FPS: stable callbacks with little CPU headroom do not buy more detail`, () => {
    const governor = new PerfGovernor({ startLevel: 2 });
    run(governor, { capFps, workMs: 1000 / capFps * .8, durationMs: 35000 });
    assert.equal(governor.level, 2);
  });

  test(`${capFps} FPS: cheap rendered frames recover one rung per sustained window`, () => {
    const governor = new PerfGovernor({ startLevel: 3 });
    let nowMs = run(governor, { capFps, durationMs: 9900 });
    assert.equal(governor.level, 3, 'a partial window must not recover');
    nowMs = run(governor, { capFps, startMs: nowMs, durationMs: 600 });
    assert.equal(governor.level, 2, 'rendered work can establish headroom despite skipped draws');
    nowMs = run(governor, { capFps, startMs: nowMs, durationMs: 9000 });
    assert.equal(governor.level, 2, 'the recovered rung needs its own evidence');
    run(governor, { capFps, startMs: nowMs, durationMs: 2000 });
    assert.equal(governor.level, 1);
  });

  test(`${capFps} FPS: sustained CPU pressure lowers detail before a missed callback`, () => {
    const governor = new PerfGovernor();
    run(governor, { capFps, workMs: 1000 / capFps * .94, durationMs: 2000, stopAtLevel: 1 });
    assert.equal(governor.level, 1);
  });
}

test('skipped callbacks alone cannot establish or finish a measured recovery window', () => {
  const governor = new PerfGovernor({ startLevel: 2 });
  let nowMs = run(governor, { durationMs: 9000 });
  for (let i = 0; i < 1200; i++) {
    nowMs += 1000 / 60;
    governor.sample(1000 / 60, nowMs, { workMs: null });
  }
  assert.equal(governor.level, 2, 'no rendered work was observed during twenty seconds of skipped callbacks');
  governor.sample(1000 / 60, nowMs + 1000 / 60, { workMs: 2 });
  assert.equal(governor.level, 2, 'a fresh measurement cannot redeem stale headroom');
});

test('omitting work after measured timing was established cannot silently enable period-only recovery', () => {
  const governor = new PerfGovernor({ startLevel: 1 });
  governor.sample(1000 / 60, 0, { workMs: 2 });
  for (let i = 1; i < 1000; i++) governor.sample(1000 / 60, i * 1000 / 60);
  assert.equal(governor.level, 1);
});

test('a failed measured recovery rolls back quickly, tolerates one hitch, and backs off', () => {
  const governor = new PerfGovernor({ startLevel: 1 });
  let nowMs = run(governor, { durationMs: 11000, stopAtLevel: 0 });
  assert.equal(governor.level, 0);
  governor.sample(100, nowMs += 100, { workMs: 100 });
  nowMs = run(governor, { startMs: nowMs, durationMs: 500 });
  assert.equal(governor.level, 0, 'one hitch must not fail the probe');
  assert.equal(governor.recoverWindowMsFor(0), 10000);
  const pressureAtMs = nowMs;
  nowMs = run(governor, { startMs: nowMs, workMs: 16, durationMs: 500, stopAtLevel: 1 });
  assert.equal(governor.level, 1, 'the probe should roll back before another second of pressure');
  assert.ok(nowMs - pressureAtMs < 500);
  assert.equal(governor.recoverWindowMsFor(0), 20000);
  nowMs = run(governor, { startMs: nowMs, durationMs: 11000 });
  assert.equal(governor.level, 1, 'a failed probe must not retry on the initial ten-second schedule');
  run(governor, { startMs: nowMs, durationMs: 10000, stopAtLevel: 0 });
  assert.equal(governor.level, 0);
});

test('a measured probe has a bounded observation period', () => {
  const governor = new PerfGovernor({ startLevel: 1 });
  const nowMs = run(governor, { durationMs: 11000, stopAtLevel: 0 });
  assert.equal(governor.diagnostics.probeLevel, 0);
  run(governor, { startMs: nowMs, durationMs: 3000 });
  assert.equal(governor.level, 0);
  assert.equal(governor.diagnostics.probeLevel, null);
});

test('one hitch at the measured probe deadline is still only one hitch', () => {
  const governor = new PerfGovernor({ startLevel: 1 });
  const recoveredAtMs = run(governor, { durationMs: 11000, stopAtLevel: 0 });
  const nowMs = run(governor, { startMs: recoveredAtMs, durationMs: 1800 });
  governor.sample(300, nowMs + 300, { workMs: 300 });
  assert.equal(governor.level, 0, 'the deadline must not turn a single hitch into a failed probe');
  run(governor, { startMs: nowMs + 300, durationMs: 1000 });
  assert.equal(governor.level, 0);
  assert.equal(governor.recoverWindowMsFor(0), 10000);
});

test('one hitch after a skipped draw cannot expire a measured probe', () => {
  for (const capFps of [24, 30, 60]) {
    const governor = new PerfGovernor({ startLevel: 1 });
    const recoveredAtMs = run(governor, { capFps, durationMs: 11000, stopAtLevel: 0 });
    let nowMs = run(governor, { capFps, startMs: recoveredAtMs, durationMs: 1800 });
    governor.sample(1000, nowMs += 1000, { capFps, workMs: null });
    assert.equal(governor.level, 0, `${capFps} FPS: one null-work hitch is not failed timing evidence`);
    governor.sample(1000 / 60, nowMs += 1000 / 60, { capFps, workMs: null });
    run(governor, { capFps, startMs: nowMs, durationMs: 1000 });
    assert.equal(governor.level, 0);
    assert.equal(governor.recoverWindowMsFor(0), 10000);
  }
});

test('skipped callbacks on high-refresh displays cannot erase sustained rendered CPU pressure', () => {
  for (const refreshHz of [60, 120, 240, 360]) {
    const governor = new PerfGovernor();
    const cadence = new FrameCadence();
    let nowMs = 0;
    while (nowMs < 2000 && governor.level === 0) {
      nowMs += 1000 / refreshHz;
      const rendered = cadence.shouldDraw(nowMs, 24);
      governor.sample(1000 / refreshHz, nowMs, { capFps: 24, workMs: rendered ? 39 : null });
    }
    assert.equal(governor.level, 1, `${refreshHz} Hz callbacks should preserve CPU pressure from 24 FPS draws`);
  }
});

test('a probe without further rendered measurements rolls back within a bounded time', () => {
  const governor = new PerfGovernor({ startLevel: 1 });
  let nowMs = run(governor, { durationMs: 11000, stopAtLevel: 0 });
  for (let i = 0; i < 180; i++) {
    governor.sample(1000 / 60, nowMs += 1000 / 60, { workMs: null });
  }
  assert.equal(governor.level, 1);
  assert.equal(governor.recoverWindowMsFor(0), 20000);
});

test('cheap CPU submission cannot hide sustained callback pressure from slow GPU work', () => {
  const governor = new PerfGovernor();
  let nowMs = 0;
  for (let i = 0; i < 60; i++) governor.sample(1000 / 30, nowMs += 1000 / 30, { workMs: 2 });
  assert.ok(governor.level > 0);
});

test('changing the FPS cap discards old headroom and starts a fresh recovery window', () => {
  const governor = new PerfGovernor({ startLevel: 2 });
  let nowMs = run(governor, { capFps: 24, durationMs: 9000 });
  nowMs = run(governor, { capFps: 60, startMs: nowMs, durationMs: 2000 });
  assert.equal(governor.level, 2);
  run(governor, { capFps: 60, startMs: nowMs, durationMs: 9000, stopAtLevel: 1 });
  assert.equal(governor.level, 1);
});

test('invalid periods and timestamps never count toward measured recovery or pressure', () => {
  for (const deltaMs of [-10, 0, NaN, Infinity]) {
    const governor = new PerfGovernor({ startLevel: 2 });
    for (let i = 0; i < 1000; i++) governor.sample(deltaMs, i * 20, { workMs: 1000 });
    governor.sample(1000 / 60, NaN, { workMs: 1000 });
    assert.equal(governor.level, 2, String(deltaMs));
    run(governor, { durationMs: 11000, startMs: 30000, stopAtLevel: 1 });
    assert.equal(governor.level, 1, 'valid evidence must still work after invalid samples');
  }
});

test('invalid work cannot count as cheap work but valid zero-duration measurements can', () => {
  for (const workMs of [-1, NaN, Infinity, '1']) {
    const governor = new PerfGovernor({ startLevel: 1 });
    const nowMs = run(governor, { workMs, durationMs: 30000 });
    assert.equal(governor.level, 1, String(workMs));
    run(governor, { startMs: nowMs, workMs: 0, durationMs: 11000, stopAtLevel: 0 });
    assert.equal(governor.level, 0);
  }
});

test('warmup discards measured headroom and measured CPU pressure cannot escape quality pins', () => {
  const governor = new PerfGovernor({ startLevel: 3 });
  let nowMs = run(governor, { durationMs: 9000 });
  governor.beginWarmup(nowMs);
  nowMs = run(governor, { startMs: nowMs, workMs: 100, durationMs: WARMUP_MS - 100 });
  assert.equal(governor.level, 3);
  nowMs = run(governor, { startMs: nowMs, durationMs: 1000 });
  assert.equal(governor.level, 3, 'warmup work is not recovery evidence');
  governor.setFixtureLevel(2);
  nowMs = run(governor, { startMs: nowMs, workMs: 100, durationMs: 20000 });
  assert.equal(governor.level, 2);
  governor.freezeQuality(1);
  governor.setFixtureLevel(null);
  nowMs = run(governor, { startMs: nowMs, workMs: 100, durationMs: 20000 });
  assert.equal(governor.level, 1);
  governor.holdQuality = false;
  governor.retro = true;
  run(governor, { startMs: nowMs, workMs: 0, durationMs: 30000 });
  assert.equal(governor.level, MAX_LEVEL);
});

test('measured recovery respects the explicit General quality ceiling', () => {
  const governor = new PerfGovernor({ minLevel: 3, startLevel: 5 });
  run(governor, { durationMs: 70000 });
  assert.equal(governor.level, 3);
});
