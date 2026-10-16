// The distant swell that replaces the back ridge when the view angle buries
// it. These pin the two properties the feature actually rests on -- that the
// substitution decision is stable (hysteretic, and only ever asked at a
// section boundary), and that the wave is real motion rather than a static
// band -- plus the bounds that keep it from becoming a wall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  occludedFraction, decideDistantWave, stepDistantWave, swellAt, swellCrest,
  WAVE_ON_FRAC, WAVE_OFF_FRAC, WAVE_FADE_SEC,
} from '../src/world/DistantWave.js';

/** Run n frames at 60fps with a fixed occlusion and no boundaries. */
const runQuiet = (state, occlusion01, n) => {
  let s = state;
  for (let i = 0; i < n; i++) s = stepDistantWave(s, { occlusion01, sectionChanged: false, dtSec: 1 / 60 });
  return s;
};

const ridgeAt = (ys) => ys.map((y) => ({ y }));

test('occlusion fraction counts buried samples, not depth', () => {
  // Skyline flat at 100. Ridge below it (larger screen y) is hidden.
  const skyline = new Array(10).fill(100);
  assert.equal(occludedFraction(ridgeAt(new Array(10).fill(50)), skyline), 0,
    'a ridge standing clear of the skyline is not occluded at all');
  assert.equal(occludedFraction(ridgeAt(new Array(10).fill(300)), skyline), 1,
    'a ridge entirely under the skyline is fully occluded');
  const half = ridgeAt([300, 300, 300, 300, 300, 50, 50, 50, 50, 50]);
  assert.equal(occludedFraction(half, skyline), 0.5);
  // Depth beyond the minimum must not change the answer -- this is a
  // "how much of it" measure, not a "how deep" one (that is occludedSpans).
  const deeper = ridgeAt([9000, 9000, 9000, 9000, 9000, 50, 50, 50, 50, 50]);
  assert.equal(occludedFraction(deeper, skyline), occludedFraction(half, skyline));
});

test('grazing the hill in front does not count as covered', () => {
  const skyline = new Array(8).fill(100);
  // 4px below the skyline: touching, not buried.
  assert.equal(occludedFraction(ridgeAt(new Array(8).fill(104)), skyline), 0);
});

test('empty or mismatched input is 0, not NaN', () => {
  assert.equal(occludedFraction([], []), 0);
  assert.equal(occludedFraction(null, [1, 2]), 0);
  assert.equal(occludedFraction(ridgeAt([300]), []), 0);
});

test('the decision is hysteretic -- a framing near the line settles', () => {
  assert.equal(decideDistantWave(0.9, false), true, 'mostly covered turns it on');
  assert.equal(decideDistantWave(0.1, true), false, 'mostly visible hands the ridge back');
  // The band between the two thresholds keeps whatever it already had.
  const mid = (WAVE_ON_FRAC + WAVE_OFF_FRAC) / 2;
  assert.equal(decideDistantWave(mid, false), false);
  assert.equal(decideDistantWave(mid, true), true);
  assert.ok(WAVE_OFF_FRAC < WAVE_ON_FRAC, 'the thresholds must not be the same number');
});

test('it takes a majority of the ridge to trigger the swap', () => {
  // "mostly covered" should mean mostly -- half a ridge showing is still a
  // ridge, and swapping it for water would be a lie about the scene.
  assert.equal(decideDistantWave(0.5, false), false);
  assert.ok(WAVE_ON_FRAC > 0.5);
});

test('the horizon cannot change identity mid-section, however buried it gets', () => {
  // This is the requirement, not a nicety: a ridge that is fully covered for
  // a solid ten seconds still does not summon the wave until a boundary.
  let s = { on: false, mix: 0 };
  s = runQuiet(s, 1, 600);
  assert.equal(s.on, false, 'ten seconds of total occlusion swapped the horizon mid-section');
  assert.equal(s.mix, 0);
  // ...and the boundary is what lets it through.
  s = stepDistantWave(s, { occlusion01: 1, sectionChanged: true, dtSec: 1 / 60 });
  assert.equal(s.on, true);
});

test('and it cannot change back mid-section either', () => {
  let s = stepDistantWave({ on: false, mix: 0 }, { occlusion01: 1, sectionChanged: true, dtSec: 1 / 60 });
  s = runQuiet(s, 600); // fade in
  // The ridge comes fully back into view, but not on a boundary.
  s = runQuiet(s, 0, 600);
  assert.equal(s.on, true, 'the wave withdrew without a section change');
  assert.equal(s.mix, 1, 'and it should still be at full presence');
  s = stepDistantWave(s, { occlusion01: 0, sectionChanged: true, dtSec: 1 / 60 });
  assert.equal(s.on, false);
});

test('the swap crossfades rather than cutting', () => {
  // A hard swap at a boundary would be a pop on the largest thing on screen.
  let s = stepDistantWave({ on: false, mix: 0 }, { occlusion01: 1, sectionChanged: true, dtSec: 1 / 60 });
  assert.ok(s.mix > 0 && s.mix < 0.2, `first frame after the boundary jumped to ${s.mix}`);
  const halfway = runQuiet(s, 1, Math.round(60 * WAVE_FADE_SEC * 0.5));
  assert.ok(halfway.mix > 0.3 && halfway.mix < 0.75, `midway through the fade: ${halfway.mix}`);
  const done = runQuiet(s, 1, Math.round(60 * WAVE_FADE_SEC) + 5);
  assert.equal(done.mix, 1, 'the fade has to actually finish');
});

test('mix stays in [0,1] under absurd frame times and junk state', () => {
  const huge = stepDistantWave({ on: true, mix: 0 }, { occlusion01: 1, sectionChanged: false, dtSec: 30 });
  assert.equal(huge.mix, 1, 'a long stall overshoots to exactly 1, never past it');
  const back = stepDistantWave({ on: false, mix: 1 }, { dtSec: 30 });
  assert.equal(back.mix, 0);
  const fromNothing = stepDistantWave(undefined, { occlusion01: 1, sectionChanged: true, dtSec: 1 / 60 });
  assert.equal(fromNothing.on, true);
  assert.ok(fromNothing.mix > 0);
});

test('successive boundaries at a steady framing do not oscillate', () => {
  // Hysteresis has to survive the repeated asking, not just one call: a song
  // framed right at the threshold gets asked this at every single section.
  let s = { on: false, mix: 0 };
  const occ = (WAVE_ON_FRAC + WAVE_OFF_FRAC) / 2;
  const decisions = [];
  for (let section = 0; section < 8; section++) {
    s = stepDistantWave(s, { occlusion01: occ, sectionChanged: true, dtSec: 1 / 60 });
    decisions.push(s.on);
    s = runQuiet(s, occ, 600);
  }
  assert.deepEqual(decisions, new Array(8).fill(false), 'the horizon flickered between sections');
});

test('the swell is bounded, and never flattens to a still line', () => {
  let lo = Infinity, hi = -Infinity;
  const seen = new Set();
  for (let t = 0; t < 120; t += 0.05) {
    const v = swellAt(0, t);
    assert.ok(Number.isFinite(v));
    if (v < lo) lo = v; if (v > hi) hi = v;
    seen.add(v.toFixed(3));
  }
  assert.ok(lo >= -1 - 1e-9 && hi <= 1 + 1e-9, `swell escaped [-1,1]: ${lo}..${hi}`);
  assert.ok(lo < -0.2 && hi > 0.2, 'it has to actually swing, in both directions');
  assert.ok(seen.size > 500, `only ${seen.size} distinct heights -- that is a pose, not a wave`);
});

test('crests travel: the same world point rises and falls over time', () => {
  // The whole reason this exists is to put motion back on a horizon that
  // lost it, so a static profile would be a failure of the feature itself.
  const a = swellCrest({ width: 400, baselineY: 200, ampPx: 20, tSec: 0 });
  const b = swellCrest({ width: 400, baselineY: 200, ampPx: 20, tSec: 1.7 });
  let moved = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i].y - b[i].y) > 0.5) moved++;
  assert.ok(moved > a.length * 0.6, `only ${moved}/${a.length} samples moved in 1.7s`);
});

test('it is planted in the world, not smeared across the screen', () => {
  // Scrolling by dx at a fixed time must be exactly the same water shifted
  // by dx -- otherwise the wave slides over the land as the camera pans.
  const step = 12, dx = step * 5;
  const at0 = swellCrest({ width: 600, baselineY: 300, ampPx: 18, tSec: 3.3, scrollX: 0, stepPx: step });
  const at1 = swellCrest({ width: 600, baselineY: 300, ampPx: 18, tSec: 3.3, scrollX: dx, stepPx: step });
  for (let i = 5; i < at0.length; i++) {
    assert.ok(Math.abs(at0[i].y - at1[i - 5].y) < 1e-9,
      `sample ${i} did not simply shift with the scroll`);
  }
});

test('amplitude respects its bound at every energy, and never inverts', () => {
  for (const e of [0, 0.5, 1]) {
    const pts = swellCrest({ width: 800, baselineY: 500, ampPx: 24, tSec: 9.1, energy01: e });
    for (const p of pts) {
      assert.ok(Math.abs(p.y - 500) <= 24 + 1e-9,
        `energy=${e} overshot the amplitude bound at x=${p.x}: ${p.y}`);
    }
  }
  const span = (e) => {
    const pts = swellCrest({ width: 800, baselineY: 500, ampPx: 24, tSec: 9.1, energy01: e });
    const ys = pts.map((p) => p.y);
    return Math.max(...ys) - Math.min(...ys);
  };
  assert.ok(span(1) > span(0), 'a louder section should raise the swell, not lower it');
});

test('the crest spans past both edges so the water never ends on screen', () => {
  const pts = swellCrest({ width: 640, baselineY: 100, ampPx: 10, tSec: 0, stepPx: 12 });
  assert.ok(pts[0].x < 0);
  assert.ok(pts[pts.length - 1].x > 640);
});

// --- Foreground swell: the isthmus reveal --------------------------------
// A different question from the distant wave's. That one replaces lost
// motion at the horizon; this one answers "where are they actually?" -- pull
// the camera back and the strip of ground turns out to be a neck of land
// with sea on the near side too.
import {
  isthmusReveal01, foregroundSwellAt, foregroundSwellCrest,
  FG_REVEAL_START, FG_REVEAL_FULL,
} from '../src/world/DistantWave.js';

test('the near water is absent at normal framing and only a wide shot reveals it', () => {
  assert.equal(isthmusReveal01(0), 0);
  assert.equal(isthmusReveal01(FG_REVEAL_START), 0, 'the dead zone is closed at its top');
  assert.ok(isthmusReveal01(FG_REVEAL_START + 0.01) > 0, 'and opens immediately past it');
  assert.equal(isthmusReveal01(FG_REVEAL_FULL), 1);
  assert.equal(isthmusReveal01(1), 1, 'saturates rather than overshooting');
});

test('it eases in with the camera rather than switching on', () => {
  // The reveal IS the effect -- a hard cut would just be water appearing.
  let prev = -1;
  for (let p = 0; p <= 1.0001; p += 0.02) {
    const v = isthmusReveal01(p);
    assert.ok(v >= prev - 1e-9, `reveal went backwards at pullback ${p}`);
    assert.ok(v >= 0 && v <= 1, `out of range at ${p}: ${v}`);
    prev = v;
  }
  // Smoothstep: the midpoint of the ramp is near half, and the ends are flat.
  const mid = (FG_REVEAL_START + FG_REVEAL_FULL) / 2;
  assert.ok(Math.abs(isthmusReveal01(mid) - 0.5) < 0.05);
});

test('near water is bigger and faster than the horizon swell -- that is the depth cue', () => {
  const span = (fn) => {
    let lo = Infinity, hi = -Infinity;
    for (let x = 0; x < 4000; x += 7) { const v = fn(x, 3.5); if (v < lo) lo = v; if (v > hi) hi = v; }
    return hi - lo;
  };
  assert.ok(span(foregroundSwellAt) > 0.5, 'it has to actually swell');
  // Faster: the same world point changes more over the same short interval.
  const move = (fn) => {
    let sum = 0;
    for (let x = 0; x < 2000; x += 11) sum += Math.abs(fn(x, 1.0) - fn(x, 1.3));
    return sum;
  };
  assert.ok(move(foregroundSwellAt) > move(swellAt) * 1.2,
    'near water should pass the eye faster than the horizon does');
});

test('the near crest is bounded and planted in the world', () => {
  const pts = foregroundSwellCrest({ width: 800, baselineY: 700, ampPx: 26, tSec: 5.5 });
  for (const p of pts) assert.ok(Number.isFinite(p.y));
  assert.ok(pts[0].x < 0 && pts[pts.length - 1].x > 800, 'must span past both edges');
  // Scrolling shifts the same water rather than deforming it.
  const step = 12, dx = step * 4;
  const a = foregroundSwellCrest({ width: 600, baselineY: 700, ampPx: 26, tSec: 2, scrollX: 0, stepPx: step });
  const b = foregroundSwellCrest({ width: 600, baselineY: 700, ampPx: 26, tSec: 2, scrollX: dx, stepPx: step });
  for (let i = 4; i < a.length; i++) {
    assert.ok(Math.abs(a[i].y - b[i - 4].y) < 1e-9, `sample ${i} did not shift with the scroll`);
  }
});

test('louder sections raise the near swell without inverting it', () => {
  const spanAt = (e) => {
    const ys = foregroundSwellCrest({ width: 800, baselineY: 700, ampPx: 26, tSec: 4, energy01: e })
      .map((p) => p.y);
    return Math.max(...ys) - Math.min(...ys);
  };
  assert.ok(spanAt(1) > spanAt(0));
});
