import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyDirector } from '../src/sim/KeyDirector.js';

const STEP_MS = 1000 / 120;

function makeMockConductor(kickTimes) {
  return {
    nearestEventMs(_predicate, nowMs, windowMs) {
      let best = null, bestDist = Infinity;
      for (const tMs of kickTimes) {
        const d = Math.abs(tMs - nowMs);
        if (d <= windowMs && d < bestDist) { bestDist = d; best = { tMs }; }
      }
      return best;
    },
  };
}

/** Steps the director at a realistic 120Hz cadence for durationMs, calling
 *  ctxFn(t) each step to build the {tonic, tonicConfidence, conductor}
 *  context. Returns the final clock value. */
function feed(kd, t0, durationMs, ctxFn) {
  let t = t0, elapsed = 0;
  while (elapsed < durationMs) {
    t += STEP_MS;
    elapsed += STEP_MS;
    kd.update(t, STEP_MS / 1000, ctxFn(t));
  }
  return t;
}

// --- Palette rotation ---

test('palette rotation eases toward 0 for tonic 0 (C) and stays there', () => {
  const kd = new KeyDirector();
  const t = feed(kd, 0, 20000, () => ({ tonic: 0, tonicConfidence: 1 }));
  assert.ok(Math.abs(kd.paletteRotation) < 0.01, `expected ~0, got ${kd.paletteRotation}`);
});

test('palette rotation target uses the shortest signed semitone distance: pc 11 (B) settles near -7.5deg, not +82.5deg', () => {
  const kd = new KeyDirector();
  feed(kd, 0, 60000, () => ({ tonic: 11, tonicConfidence: 1 }));
  assert.ok(Math.abs(kd.paletteRotation - -7.5) < 0.5, `expected settling near -7.5deg, got ${kd.paletteRotation}`);
});

test('circular continuity: B (pc 11) -> C (pc 0) is a short ~7.5deg step, never a ~330deg jump', () => {
  const kd = new KeyDirector();
  feed(kd, 0, 60000, () => ({ tonic: 11, tonicConfidence: 1 })); // settle at B
  const before = kd.paletteRotation;
  kd.update(60000 + STEP_MS, STEP_MS / 1000, { tonic: 0, tonicConfidence: 1 }); // one step to C
  const delta = Math.abs(kd.paletteRotation - before);
  assert.ok(delta < 1, `a single frame's rotation-target step must be small, got delta=${delta}`);
});

test('a strictly higher tonic (within the +0..6 half) yields a larger positive rotation target: monotone within that half', () => {
  const kd2 = new KeyDirector(), kd4 = new KeyDirector();
  feed(kd2, 0, 60000, () => ({ tonic: 2, tonicConfidence: 1 }));
  feed(kd4, 0, 60000, () => ({ tonic: 4, tonicConfidence: 1 }));
  assert.ok(kd4.paletteRotation > kd2.paletteRotation);
});

test('low confidence holds the last rotation target instead of chasing noise', () => {
  const kd = new KeyDirector();
  feed(kd, 0, 60000, () => ({ tonic: 4, tonicConfidence: 1 })); // settle at pc 4
  const settled = kd.paletteRotation;
  feed(kd, 60000, 5000, () => ({ tonic: 9, tonicConfidence: 0.05 })); // low-confidence "noise"
  assert.ok(Math.abs(kd.paletteRotation - settled) < 0.5, 'a low-confidence tonic reading must not move the rotation target');
});

// --- Modulation detector ---

test('a clean 10s C-loop then a confident, sustained switch to G fires exactly one keyChange', () => {
  const kd = new KeyDirector();
  let fires = 0, lastChange = null;
  let t = 0;
  const stepAndCount = (durationMs, ctxFn) => {
    let elapsed = 0;
    while (elapsed < durationMs) {
      t += STEP_MS; elapsed += STEP_MS;
      kd.update(t, STEP_MS / 1000, ctxFn(t));
      if (kd.justKeyChange) { fires++; lastChange = kd.lastKeyChange; }
    }
  };
  stepAndCount(10000, () => ({ tonic: 0, tonicConfidence: 0.9 })); // C, well past the 8s stability threshold
  stepAndCount(4000, () => ({ tonic: 7, tonicConfidence: 0.9 }));  // G, held past the 2.5s hold
  assert.equal(fires, 1, 'expected exactly one modulation event');
  assert.deepEqual(lastChange, { from: 0, to: 7, atMs: lastChange.atMs });
});

test('noisy alternation between two tonics (each held under the hold window) never fires', () => {
  const kd = new KeyDirector();
  let fires = 0;
  let t = 0;
  // Establish C as stable first.
  for (let i = 0; i < Math.ceil(9000 / STEP_MS); i++) {
    t += STEP_MS;
    kd.update(t, STEP_MS / 1000, { tonic: 0, tonicConfidence: 0.9 });
    if (kd.justKeyChange) fires++;
  }
  // Now flicker between two candidates every ~1s (< HOLD_MS=2500), for 20s.
  for (let i = 0; i < Math.ceil(20000 / STEP_MS); i++) {
    t += STEP_MS;
    const flip = Math.floor((t / 1000)) % 2 === 0;
    kd.update(t, STEP_MS / 1000, { tonic: flip ? 4 : 9, tonicConfidence: 0.9 });
    if (kd.justKeyChange) fires++;
  }
  assert.equal(fires, 0, 'rapid alternation should never accumulate a 2.5s hold');
});

test('a candidate below the 15% confidence margin never accumulates toward a modulation', () => {
  const kd = new KeyDirector();
  let t = feed(kd, 0, 9000, () => ({ tonic: 0, tonicConfidence: 0.9 }));
  let fires = 0;
  const t2 = (() => {
    let tt = t, elapsed = 0;
    while (elapsed < 10000) {
      tt += STEP_MS; elapsed += STEP_MS;
      kd.update(tt, STEP_MS / 1000, { tonic: 7, tonicConfidence: 0.1 }); // below CANDIDATE_MARGIN
      if (kd.justKeyChange) fires++;
    }
    return tt;
  })();
  assert.equal(fires, 0, 'low-confidence candidates must never confirm a modulation');
});

test('a tonic that has not held stable for 8s cannot be the "from" of a modulation -- it just re-baselines', () => {
  const kd = new KeyDirector();
  let t = 0;
  // C for only 3s (short of the 8s stability requirement)...
  for (let i = 0; i < Math.ceil(3000 / STEP_MS); i++) { t += STEP_MS; kd.update(t, STEP_MS / 1000, { tonic: 0, tonicConfidence: 0.9 }); }
  // ...then straight to G, held confidently for well over the hold window.
  let fires = 0;
  for (let i = 0; i < Math.ceil(4000 / STEP_MS); i++) {
    t += STEP_MS;
    kd.update(t, STEP_MS / 1000, { tonic: 7, tonicConfidence: 0.9 });
    if (kd.justKeyChange) fires++;
  }
  assert.equal(fires, 0, 'G re-baselines as the new stable tonic instead of firing a change from an unestablished C');
});

test('without a conductor, a confirmed modulation fires immediately (no kick to snap to)', () => {
  const kd = new KeyDirector();
  let t = feed(kd, 0, 9000, () => ({ tonic: 0, tonicConfidence: 0.9 }));
  let fireAtMs = null;
  let elapsed = 0;
  while (elapsed < 3000 && fireAtMs === null) {
    t += STEP_MS; elapsed += STEP_MS;
    kd.update(t, STEP_MS / 1000, { tonic: 7, tonicConfidence: 0.9, conductor: null });
    if (kd.justKeyChange) fireAtMs = t;
  }
  assert.ok(fireAtMs !== null, 'should have fired');
  // It should fire on the very step the 2.5s hold is satisfied -- no extra delay.
  assert.ok(Math.abs(elapsed - 2500) < STEP_MS * 2, `expected the fire right at the hold boundary, elapsed=${elapsed}`);
});

test('with a conductor, a confirmed modulation snaps to the nearest kick within the snap window', () => {
  const kd = new KeyDirector();
  let t = feed(kd, 0, 9000, () => ({ tonic: 0, tonicConfidence: 0.9 }));
  // The hold window will be satisfied at roughly t+2500. Put a kick 100ms
  // after that -- close enough to snap to, but late enough to be checkable.
  const holdSatisfiedAt = t + 2500;
  const kickTMs = holdSatisfiedAt + 100;
  const conductor = makeMockConductor([kickTMs]);
  let fireAtMs = null;
  let elapsed = 0;
  while (elapsed < 4000 && fireAtMs === null) {
    t += STEP_MS; elapsed += STEP_MS;
    kd.update(t, STEP_MS / 1000, { tonic: 7, tonicConfidence: 0.9, conductor });
    if (kd.justKeyChange) fireAtMs = t;
  }
  assert.ok(fireAtMs !== null, 'should have fired');
  assert.ok(Math.abs(fireAtMs - kickTMs) < STEP_MS * 2, `expected the fire snapped to the kick at ${kickTMs}, got ${fireAtMs}`);
});

test('transitionProgress ramps 0->1 over exactly WAVE_SEC (1.2s) after a confirmed change, then transitionActive clears', () => {
  const kd = new KeyDirector();
  let t = feed(kd, 0, 9000, () => ({ tonic: 0, tonicConfidence: 0.9 }));
  let fireAtMs = null;
  let elapsed = 0;
  while (elapsed < 3000 && fireAtMs === null) {
    t += STEP_MS; elapsed += STEP_MS;
    kd.update(t, STEP_MS / 1000, { tonic: 7, tonicConfidence: 0.9, conductor: null });
    if (kd.justKeyChange) fireAtMs = t;
  }
  assert.equal(kd.transitionActive, true);
  assert.equal(kd.transitionProgress, 0);

  kd.update(fireAtMs + 600, 0.6, { tonic: 7, tonicConfidence: 0.9 });
  assert.ok(Math.abs(kd.transitionProgress - 0.5) < 1e-9);

  kd.update(fireAtMs + 1200, 0.6, { tonic: 7, tonicConfidence: 0.9 });
  assert.equal(kd.transitionProgress, 1);
  assert.equal(kd.transitionActive, false);
});

test('justKeyChange is a true one-shot: only true on the firing frame', () => {
  const kd = new KeyDirector();
  let t = feed(kd, 0, 9000, () => ({ tonic: 0, tonicConfidence: 0.9 }));
  let firesSeen = 0;
  let elapsed = 0;
  while (elapsed < 5000) {
    t += STEP_MS; elapsed += STEP_MS;
    kd.update(t, STEP_MS / 1000, { tonic: 7, tonicConfidence: 0.9, conductor: null });
    if (kd.justKeyChange) firesSeen++;
  }
  assert.equal(firesSeen, 1);
});
