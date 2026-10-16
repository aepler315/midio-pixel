// SyncMonitor: measure the beat grid's phase error and CORRECT it.
//
// This used to end in a prompt -- "the sync looks a little off, want to tap
// it in?" -- which was the wrong instrument. If the engine can measure that
// the grid is wrong it can measure how wrong, and asking the viewer to
// hand-tap a correction the machine already knows is work the machine should
// have done. These tests pin the correction, and the one case where the
// honest answer is still to do nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncMonitor, circularVariance, circularMean } from '../src/sim/SyncMonitor.js';

const BEAT = 500;

function feed(sm, kicks, beatMs = BEAT) {
  for (const t of kicks) sm.onKick(t, beatMs, 0);
}

/** Kicks landing `offsetMs` off the grid, with `jitterMs` of looseness. */
function kicksAt(n, offsetMs = 0, jitterMs = 0, beatMs = BEAT) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const wobble = jitterMs === 0 ? 0 : (((i * 37) % 100) / 100) * 2 * jitterMs - jitterMs;
    out.push(i * beatMs + offsetMs + wobble);
  }
  return out;
}

/** Kicks scattered uniformly -- no coherent offset exists in these. */
function scatteredKicks(n, beatMs = BEAT) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(i * beatMs + ((i * 173) % beatMs));
  return out;
}

const settled = (sm, nowMs = 30000, opts = {}) => {
  sm.update(nowMs, { beatPeriodMs: BEAT, anchorConfidence: 0, ...opts });
  return sm.consumeCorrection();
};

test('circularMean finds where a cluster sits, which variance cannot', () => {
  // The whole reason a correction is possible: variance is deliberately blind
  // to a constant offset, so on its own it can only ever say "wrong", never
  // "wrong by this much in this direction".
  const shifted = [1.0, 1.05, 0.95, 1.02].map((x) => x);
  const { mean, R } = circularMean(shifted);
  assert.ok(Math.abs(mean - 1.005) < 0.05, `mean should sit in the cluster, got ${mean}`);
  assert.ok(R > 0.99, 'a tight cluster is highly concentrated');
  assert.ok(circularVariance(shifted) < 0.01, '...and variance calls it locked, offset and all');
});

test('circularMean wraps at ±π instead of averaging across the circle', () => {
  const straddling = [0.05, -0.05, 0.02, 6.25]; // 6.25 rad is just under 2π
  const { mean } = circularMean(straddling);
  assert.ok(Math.abs(mean) < 0.2, `should land near 0, not near π: got ${mean}`);
  assert.deepEqual(circularMean([]), { mean: 0, R: 0 });
});

test('a grid that is right gets left alone', () => {
  const sm = new SyncMonitor();
  feed(sm, kicksAt(16, 0, 4));
  assert.equal(settled(sm), null, 'nothing to correct on an already-locked grid');
});

test('a coherent late offset is corrected toward the kicks', () => {
  // The fixable case: every kick agrees, and they all sit 60ms late of the
  // grid. That is a solvable equation, not something to ask a viewer about.
  const sm = new SyncMonitor();
  feed(sm, kicksAt(16, 60, 3));
  const fix = settled(sm);
  assert.ok(fix != null, 'a coherent offset must produce a correction');
  assert.ok(fix > 0, `kicks are LATE, so the grid moves later: got ${fix}`);
  assert.ok(fix > 20 && fix < 60, `should be a partial step toward 60ms, got ${fix}`);
});

test('...and an early offset moves the grid the other way', () => {
  const sm = new SyncMonitor();
  feed(sm, kicksAt(16, -70, 3));
  const fix = settled(sm);
  assert.ok(fix != null && fix < 0, `kicks are EARLY, grid should move earlier: got ${fix}`);
});

test('repeated corrections converge rather than oscillating', () => {
  // Each pass corrects a fraction, so the residual shrinks. A full snap would
  // sit at the mercy of one unlucky window.
  let grid = 0;
  const trueOffset = 80;
  let last = Infinity;
  for (let round = 0; round < 4; round++) {
    const sm = new SyncMonitor();
    for (let i = 0; i < 16; i++) sm.onKick(i * BEAT + trueOffset, BEAT, grid);
    const fix = settled(sm, 30000 + round);
    if (fix == null) break;
    grid += fix;
    const residual = Math.abs(trueOffset - grid);
    assert.ok(residual < last, `residual grew: ${last} -> ${residual}`);
    last = residual;
  }
  assert.ok(last < 20, `should have converged close to the true offset, residual ${last}`);
});

test('genuinely incoherent kicks are NOT corrected -- there is no offset to apply', () => {
  // The case prompting could never fix either: the kicks do not agree with
  // each other, so no single shift puts them on the grid. Inventing one from
  // the mean of noise would make it worse.
  const sm = new SyncMonitor();
  feed(sm, scatteredKicks(16));
  assert.equal(settled(sm), null, 'must not act on a mean that is noise');
  assert.ok(sm.incoherent, 'but it should still KNOW it is incoherent');
});

test('a confident player anchor wins -- their grid is not second-guessed', () => {
  const sm = new SyncMonitor();
  feed(sm, kicksAt(16, 60, 3));
  assert.equal(settled(sm, 30000, { anchorConfidence: 0.9 }), null);
});

test('sub-perceptual offsets are left alone', () => {
  const sm = new SyncMonitor();
  feed(sm, kicksAt(16, 5, 1));
  assert.equal(settled(sm), null, 'correcting a 5ms error is jitter, not a fix');
});

test('it will not judge on a handful of kicks, or over the very opening', () => {
  const few = new SyncMonitor();
  feed(few, kicksAt(4, 90));
  assert.equal(settled(few), null, 'too few kicks to have an opinion');

  const early = new SyncMonitor();
  feed(early, kicksAt(16, 90, 3));
  assert.equal(settled(early, 500), null, 'not over the opening');
});

test('suppress holds everything without acting', () => {
  const sm = new SyncMonitor();
  feed(sm, kicksAt(16, 90, 3));
  assert.equal(settled(sm, 30000, { suppress: true }), null);
  assert.ok(settled(sm, 30001) != null, 'and resumes once suppression lifts');
});

test('a correction latches until consumed -- frame ordering cannot lose it', () => {
  const sm = new SyncMonitor();
  feed(sm, kicksAt(16, 90, 3));
  sm.update(30000, { beatPeriodMs: BEAT });
  sm.update(30016, { beatPeriodMs: BEAT }); // another frame passes, nobody read it
  const fix = sm.consumeCorrection();
  assert.ok(fix != null, 'the correction survived an unread frame');
  assert.equal(sm.consumeCorrection(), null, 'and is delivered exactly once');
});

test('correcting clears the phases measured against the old grid', () => {
  // Otherwise the same offset is applied twice: the window still holds kicks
  // seen through the grid that has just been moved.
  const sm = new SyncMonitor();
  feed(sm, kicksAt(16, 90, 3));
  assert.ok(settled(sm) != null);
  assert.equal(settled(sm, 40000), null, 'no second verdict on stale phases');
});

test('onCalibrated drops a correction still in flight', () => {
  const sm = new SyncMonitor();
  feed(sm, kicksAt(16, 90, 3));
  sm.update(30000, { beatPeriodMs: BEAT });
  sm.onCalibrated();
  assert.equal(sm.consumeCorrection(), null);
});

test('a missing beat period never produces a nonsense correction', () => {
  const sm = new SyncMonitor();
  feed(sm, kicksAt(16, 90, 3));
  sm.update(30000, { beatPeriodMs: 0 });
  assert.equal(sm.consumeCorrection(), null);
});
