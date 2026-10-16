import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExcursionDirector } from '../src/sim/ExcursionDirector.js';

const STEP_MS = 1000 / 120;

function makeMockExcursion() {
  return { active: false, forceEndCalls: [], forceEnd(nowMs) { this.forceEndCalls.push(nowMs); this.active = false; } };
}

function makeMockMidasus() {
  const voyage = makeMockExcursion();
  return {
    voyage,
    forceVoyageCalls: [],
    forceVoyage(nowMs) {
      if (voyage.active) return false;
      voyage.active = true;
      this.forceVoyageCalls.push(nowMs);
      return true;
    },
  };
}

function makeMockBroshi() {
  const burrow = makeMockExcursion();
  return {
    burrow,
    forceBurrowCalls: [],
    forceBurrow(nowMs, worldX) {
      if (burrow.active) return false;
      burrow.active = true;
      this.forceBurrowCalls.push({ nowMs, worldX });
      return true;
    },
  };
}

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

function makeCtx(overrides = {}) {
  return {
    vibe: { epic: 0, valence: 0 },
    calm: { level: 0 },
    hype: { dropAtMs: -Infinity, surge: 0 },
    energyCurves: { sample: () => 0 },
    conductor: null,
    midasus: makeMockMidasus(),
    broshi: makeMockBroshi(),
    worldX: 1000,
    ...overrides,
  };
}

function run(director, ctx, t, seconds) {
  const steps = Math.round((seconds * 1000) / STEP_MS);
  for (let i = 0; i < steps; i++) {
    t += STEP_MS;
    director.update(t, STEP_MS / 1000, ctx);
  }
  return t;
}

test('no excursion starts during the first 12s regardless of conditions', () => {
  const director = new ExcursionDirector(300000);
  const ctx = makeCtx({ vibe: { epic: 0.9, valence: 0 } });
  run(director, ctx, 0, 11.9);
  assert.equal(ctx.midasus.forceVoyageCalls.length, 0);
});

test('sustained epic for 4s triggers a voyage after the start guard', () => {
  const director = new ExcursionDirector(300000);
  const ctx = makeCtx({ vibe: { epic: 0.9, valence: 0 } });
  let t = run(director, ctx, 0, 13); // past the 12s guard, epic sustained since t=0
  run(director, ctx, t, 4.1); // 4s+ of sustained epic
  assert.equal(ctx.midasus.forceVoyageCalls.length, 1);
});

test('sustained calm + positive valence triggers a voyage (stargazing launch)', () => {
  const director = new ExcursionDirector(300000);
  const ctx = makeCtx({ calm: { level: 0.8 }, vibe: { epic: 0, valence: 0.3 } });
  let t = run(director, ctx, 0, 13);
  run(director, ctx, t, 6.1);
  assert.equal(ctx.midasus.forceVoyageCalls.length, 1);
});

// Burrows are off. The excursion put Broshi underground in a generated
// cavern, and that cave is a second visual world sitting under the first,
// competing with the landscape rather than adding to it. These two used to
// assert the conditions that launched one; they now assert that nothing
// launches, because those conditions still occur and must stay inert.

test('sustained bass no longer sends anyone underground', () => {
  const director = new ExcursionDirector(300000);
  const ctx = makeCtx({ energyCurves: { sample: () => 0.7 } });
  let t = run(director, ctx, 0, 13);
  run(director, ctx, t, 3.1);
  assert.equal(ctx.broshi.forceBurrowCalls.length, 0);
});

test('a fresh hype drop no longer sends anyone underground', () => {
  const director = new ExcursionDirector(300000);
  const ctx = makeCtx();
  let t = run(director, ctx, 0, 13);
  ctx.hype.dropAtMs = t + STEP_MS; // "fires" on the next tick
  run(director, ctx, t, 1);
  assert.equal(ctx.broshi.forceBurrowCalls.length, 0);
});

test('a voyage is blocked while inside a drop window', () => {
  const director = new ExcursionDirector(300000);
  const ctx = makeCtx({ vibe: { epic: 0.9, valence: 0 } });
  // Stay just under the 12s start guard so nothing has fired yet, then set
  // the drop right as it's about to open -- and only advance far enough to
  // stay comfortably inside the 1.5s drop window (not the full 4s+ this
  // sustain condition would otherwise need).
  let t = run(director, ctx, 0, 11.9);
  ctx.hype.dropAtMs = t;
  run(director, ctx, t, 1.4);
  assert.equal(ctx.midasus.forceVoyageCalls.length, 0, 'voyage should not launch into a drop window');
});

test('mutual exclusion: an active voyage blocks a burrow from starting', () => {
  const director = new ExcursionDirector(300000);
  const ctx = makeCtx({ energyCurves: { sample: () => 0.7 } });
  ctx.midasus.voyage.active = true; // pretend a voyage is already underway
  let t = run(director, ctx, 0, 13);
  run(director, ctx, t, 3.1);
  assert.equal(ctx.broshi.forceBurrowCalls.length, 0);
});

test('kick-snapping delays the launch to the nearest upcoming kick, not immediately', () => {
  const director = new ExcursionDirector(300000);
  // The scheduling attempt happens the instant nowMs crosses the 12s start
  // guard (epic has been sustained the whole time, long past the 4s
  // threshold by then) -- so the kick needs to sit just after that moment
  // to actually be within the 400ms snap window when it's checked.
  const kickAt = 12300;
  const ctx = makeCtx({ vibe: { epic: 0.9, valence: 0 }, conductor: makeMockConductor([kickAt]) });
  let t = run(director, ctx, 0, 12.05); // just past the guard -- schedules, waiting on kickAt
  assert.equal(ctx.midasus.forceVoyageCalls.length, 0, 'should still be waiting for the snapped kick');
  run(director, ctx, t, 0.4); // now past kickAt
  assert.equal(ctx.midasus.forceVoyageCalls.length, 1);
  assert.ok(Math.abs(ctx.midasus.forceVoyageCalls[0] - kickAt) < STEP_MS * 2, 'should have launched right at the snapped kick');
});

test('without a conductor, launches fire immediately once conditions are met', () => {
  const director = new ExcursionDirector(300000);
  const ctx = makeCtx({ vibe: { epic: 0.9, valence: 0 }, conductor: null });
  let t = run(director, ctx, 0, 13);
  run(director, ctx, t, 4.05);
  assert.equal(ctx.midasus.forceVoyageCalls.length, 1);
});

test('at most 2 voyages per song, with a cooldown between them', () => {
  const director = new ExcursionDirector(400000);
  const ctx = makeCtx({ vibe: { epic: 0.9, valence: 0 } });
  let t = run(director, ctx, 0, 13);
  t = run(director, ctx, t, 4.1);
  assert.equal(ctx.midasus.forceVoyageCalls.length, 1);
  ctx.midasus.voyage.active = false; // voyage "ends"

  // Immediately re-meeting the epic condition should NOT retrigger inside
  // the 60s per-type cooldown (nor the 25s global cooldown).
  t = run(director, ctx, t, 5);
  assert.equal(ctx.midasus.forceVoyageCalls.length, 1, 'should still be on cooldown');

  t = run(director, ctx, t, 61); // past both cooldowns
  assert.equal(ctx.midasus.forceVoyageCalls.length, 2, 'a second voyage should now be allowed');
  ctx.midasus.voyage.active = false;

  t = run(director, ctx, t, 61); // past cooldowns again, but the cap is 2
  assert.equal(ctx.midasus.forceVoyageCalls.length, 2, 'must not exceed the per-song voyage cap');
});

test('the global cooldown blocks the next excursion from starting right after one ends', () => {
  // This used to prove the point with a burrow as the second excursion: fire
  // a voyage, then satisfy the burrow condition and watch the global cooldown
  // hold it off. With burrows off there is only one excursion type left, so
  // the CROSS-TYPE half of that gate is no longer reachable from here, and
  // the release half can't be shown either -- a second voyage is gated by the
  // 60s per-type cooldown, which outlives the 25s global one, so "it fires
  // eventually" would be testing the wrong constant. What survives, and is
  // what this now pins, is that the global cooldown is timed from the
  // excursion's LAUNCH moment rather than from now: it is still blocking at
  // ~16s because the voyage went up at ~12s.
  const director = new ExcursionDirector(400000);
  const ctx = makeCtx({ vibe: { epic: 0.9, valence: 0 } });
  let t = run(director, ctx, 0, 13); // voyage fires once past the 12s guard
  assert.equal(ctx.midasus.forceVoyageCalls.length, 1);
  ctx.midasus.voyage.active = false;

  // The 25s global cooldown is timed from the voyage's actual launch moment
  // (~12s in, not "now"), so it should still be blocking here.
  t = run(director, ctx, t, 3.5);
  assert.equal(ctx.midasus.forceVoyageCalls.length, 1, 'global cooldown should still be blocking');
});

test('the end guard forces any active excursion home and blocks new ones', () => {
  const director = new ExcursionDirector(30000); // a short song
  const ctx = makeCtx({ vibe: { epic: 0.9, valence: 0 } });
  ctx.midasus.voyage.active = true;
  // 30000 - 25000(end guard) = 5000: past that point everyone should be forced home.
  run(director, ctx, 0, 5.1);
  assert.ok(ctx.midasus.voyage.forceEndCalls.length >= 1);
  assert.equal(ctx.midasus.voyage.active, false);
});

test('with durationMs=0 (unknown length), the start/end guards are skipped entirely', () => {
  const director = new ExcursionDirector(0);
  const ctx = makeCtx({ vibe: { epic: 0.9, valence: 0 } });
  let t = run(director, ctx, 0, 4.1); // well under the usual 12s start guard
  assert.equal(ctx.midasus.forceVoyageCalls.length, 1, 'no known duration -> no start guard to block this');
});

test('the scheduler self-cancels a stale pending launch once anything else is active', () => {
  const director = new ExcursionDirector(300000);
  // As in the kick-snap test above: place the kick just after the moment
  // scheduling is actually attempted (right as the 12s guard opens), so
  // it's a genuinely pending (not yet fired) launch.
  const kickAt = 12300;
  const ctx = makeCtx({ vibe: { epic: 0.9, valence: 0 }, conductor: makeMockConductor([kickAt]) });
  let t = run(director, ctx, 0, 12.05); // schedules, waiting on kickAt
  assert.equal(ctx.midasus.forceVoyageCalls.length, 0);
  ctx.broshi.burrow.active = true; // something else grabs activity before the pending kick arrives
  run(director, ctx, t, 0.4); // now past kickAt, but burrow is active -> voyage must not fire
  assert.equal(ctx.midasus.forceVoyageCalls.length, 0);
});
