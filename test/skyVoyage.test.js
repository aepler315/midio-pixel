import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSTELLATION_HOLD_SEC,
  CONSTELLATION_LIFE_SEC,
  SkyVoyage,
  VoyagePhase,
  constellationLife01,
} from '../src/sim/SkyVoyage.js';

const STEP_MS = 1000 / 120;

/** Advances the voyage by `seconds` of simulated time starting from `t`,
 * returning the new `t` -- callers thread this explicitly rather than
 * re-deriving "now" from any voyage-internal field (which changes on every
 * phase transition and would silently reset elapsed progress). */
function advance(voyage, t, seconds, { epicMood = 0.5, anchor = { x: 300, y: 200 } } = {}) {
  const steps = Math.round((seconds * 1000) / STEP_MS);
  for (let i = 0; i < steps; i++) {
    t += STEP_MS;
    voyage.update(t, STEP_MS / 1000, epicMood, anchor);
  }
  return t;
}

test('a fresh voyage is idle and inactive', () => {
  const v = new SkyVoyage(1);
  assert.equal(v.phase, VoyagePhase.IDLE);
  assert.equal(v.active, false);
  assert.equal(v.depth, 0);
});

test('trigger enters WINDUP and becomes active', () => {
  const v = new SkyVoyage(1);
  const ok = v.trigger(1000, { x: 100, y: 400 }, 1280, 720);
  assert.equal(ok, true);
  assert.equal(v.phase, VoyagePhase.WINDUP);
  assert.equal(v.active, true);
});

test('trigger is a no-op while already active (self-guarded mutual exclusion)', () => {
  const v = new SkyVoyage(1);
  v.trigger(1000, { x: 100, y: 400 }, 1280, 720);
  const stationBefore = { ...v._station };
  const ok = v.trigger(1000, { x: 999, y: 999 }, 1280, 720);
  assert.equal(ok, false);
  assert.deepEqual(v._station, stationBefore, 'a second trigger must not reset voyage state');
});

// ── The station used to be confined to a small right-of-center, near-top
// zone (x in [0.48,0.78], y in [0.12,0.20]) -- every voyage, every song,
// performed its whole bright multi-figure show anchored to that one small
// patch of sky. Confirmed live against the actual deployed game that this
// reads exactly as "the [bright things] are clustered in the middle,"
// independent of (and not fixed by) the ambient-star and constellation-
// weaver clustering fixes elsewhere. See the comment in trigger().
test('an unguided voyage station uses BOTH halves of the sky width, not just right-of-center', () => {
  const w = 1920, h = 1080;
  // Clearly left/right of center, not just a hair either side of 0.5 --
  // the old [0.48, 0.78] range technically dipped 2% below center, which
  // would pass a naive "< 0.5" check without the station ever really
  // reading as being in the left half.
  let sawClearlyLeft = false, sawClearlyRight = false;
  for (let seed = 1; seed <= 60; seed++) {
    const v = new SkyVoyage(seed);
    v.trigger(0, { x: 200, y: 400 }, w, h);
    if (v._station.x < w * 0.40) sawClearlyLeft = true;
    if (v._station.x > w * 0.60) sawClearlyRight = true;
  }
  assert.ok(sawClearlyLeft, 'across many seeds, the station should sometimes land clearly left of center');
  assert.ok(sawClearlyRight, 'across many seeds, the station should sometimes land clearly right of center');
});

test('an unguided voyage station uses a real vertical spread, not a sliver near the top', () => {
  const w = 1920, h = 1080;
  const ys = [];
  for (let seed = 1; seed <= 60; seed++) {
    const v = new SkyVoyage(seed);
    v.trigger(0, { x: 200, y: 400 }, w, h);
    ys.push(v._station.y / h);
  }
  const spread = Math.max(...ys) - Math.min(...ys);
  assert.ok(spread > 0.10, `station y-fraction spread across seeds was only ${spread.toFixed(3)}, still reads as a thin band`);
  // And it must never approach real terrain (peaks ~0.55): the largest
  // figure orbit is roughly 0.21 of stageH, so station.y itself should stay
  // comfortably below 0.55 - 0.21.
  for (const y of ys) {
    assert.ok(y >= 0.12, `station y-fraction ${y.toFixed(3)} still hugs the top of frame`);
    assert.ok(y <= 0.50, `station y-fraction ${y.toFixed(3)} risks dipping into terrain once the figure orbit is added`);
  }
});

// ── A chorus voyage's middle figure is sky-written lyric text, hard-coded
// to scale 2.2 in _pickFigureOrder -- nearly double the eight math
// families' own max scale (1.18). A station placed for the math families'
// narrower margin let that text's own ends run past the left/right edge of
// frame ("a large portion of the drawings midasus makes in space are
// outside the frame"). The station's x-margin must widen to fit whichever
// figure THIS voyage actually draws.
test('a chorus voyage (sky-written lyric text) keeps its station far enough from the edges', () => {
  const w = 1280, h = 720;
  const textHalfSpanPx = 130 * 2.2; // FIGURE_RADIUS_PX * LYRIC_TEXT_SCALE
  for (let seed = 1; seed <= 40; seed++) {
    const v = new SkyVoyage(seed);
    v.trigger(0, { x: 200, y: 400 }, w, h, 'A LINE OF CHORUS');
    assert.ok(
      v._station.x - textHalfSpanPx >= -1 && v._station.x + textHalfSpanPx <= w + 1,
      `seed ${seed}: station.x=${v._station.x.toFixed(0)} leaves the sky-written text off-frame in a ${w}px stage`,
    );
  }
});

test('an unguided (non-chorus) voyage still uses the full width it used to -- the chorus fix must not shrink it', () => {
  const w = 1920, h = 1080;
  let sawClearlyLeft = false, sawClearlyRight = false;
  for (let seed = 1; seed <= 60; seed++) {
    const v = new SkyVoyage(seed);
    v.trigger(0, { x: 200, y: 400 }, w, h); // no chorusText
    if (v._station.x < w * 0.40) sawClearlyLeft = true;
    if (v._station.x > w * 0.60) sawClearlyRight = true;
  }
  assert.ok(sawClearlyLeft && sawClearlyRight, 'a plain voyage should keep using both halves of the sky');
});

// Exact phase boundaries (elapsed seconds since trigger), so test
// checkpoints can land deliberately just past each transition instead of
// guessing durations and accumulating arithmetic error across calls.
const T_WINDUP_END = 0.9;
const T_ASCENT_END = T_WINDUP_END + 1.6;
const T_DEEP_SPACE_END = T_ASCENT_END + 3 * 3.2;
const T_REENTRY_END = T_DEEP_SPACE_END + 0.62;

test('phases progress WINDUP -> ASCENT -> DEEP_SPACE -> REENTRY -> IDLE in order', () => {
  const v = new SkyVoyage(2);
  let t = 1000;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  let elapsed = 0;
  const goTo = (target) => { t = advance(v, t, target - elapsed); elapsed = target; };

  goTo(T_WINDUP_END - 0.2);
  assert.equal(v.phase, VoyagePhase.WINDUP, 'still winding up partway through');
  goTo(T_WINDUP_END + 0.1);
  assert.equal(v.phase, VoyagePhase.ASCENT, 'windup complete, now ascending');
  goTo(T_ASCENT_END + 0.15);
  assert.equal(v.phase, VoyagePhase.DEEP_SPACE, 'ascent complete, now in deep space');
  goTo(T_DEEP_SPACE_END + 0.2);
  assert.equal(v.phase, VoyagePhase.REENTRY, 'figures exhausted, diving home');
  goTo(T_REENTRY_END + 0.2);
  assert.equal(v.phase, VoyagePhase.IDLE, 'reentry complete, voyage over');
  assert.equal(v.active, false);
  assert.equal(v.trail.length, 0, 'trail is cleared once home');
});

test('depth is 0 during windup, ramps to 1 across ascent, holds at 1 in deep space, ramps back down in reentry', () => {
  const v = new SkyVoyage(3);
  let t = 0;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  let elapsed = 0;
  const goTo = (target) => { t = advance(v, t, target - elapsed); elapsed = target; };

  goTo(T_WINDUP_END - 0.2);
  assert.equal(v.depth, 0, 'windup keeps her visually "here"');

  goTo(T_WINDUP_END + 0.1);
  assert.equal(v.phase, VoyagePhase.ASCENT);
  assert.ok(v.depth > 0 && v.depth < 1, `depth should be mid-transition, got ${v.depth}`);

  goTo(T_ASCENT_END + 0.15);
  assert.equal(v.phase, VoyagePhase.DEEP_SPACE);
  assert.equal(v.depth, 1);

  goTo(T_DEEP_SPACE_END + 0.2);
  assert.equal(v.phase, VoyagePhase.REENTRY);
  const midReentryDepth = v.depth;
  assert.ok(midReentryDepth > 0 && midReentryDepth <= 1, `reentry depth should still be high early on, got ${midReentryDepth}`);
});

test('figure switches happen roughly every 3.2s and cycle through exactly 3 figures', () => {
  const v = new SkyVoyage(4);
  let t = 0;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  t = advance(v, t, 0.9 + 1.6 + 0.05); // clear windup + ascent
  assert.equal(v.phase, VoyagePhase.DEEP_SPACE);
  const idx0 = v._figureIdx;
  t = advance(v, t, 3.3);
  const idx1 = v._figureIdx;
  assert.equal(idx1, idx0 + 1, 'should have advanced exactly one figure after ~3.2s');
  t = advance(v, t, 3.3);
  const idx2 = v._figureIdx;
  assert.equal(idx2, idx0 + 2);
  // A third figure switch should end the voyage (exactly 3 figures/voyage).
  t = advance(v, t, 3.3);
  assert.equal(v.phase, VoyagePhase.REENTRY);
});

test('figure order (and therefore the whole trajectory) is deterministic for a given seed', () => {
  const a = new SkyVoyage(42);
  const b = new SkyVoyage(42);
  a.trigger(0, { x: 200, y: 400 }, 1280, 720);
  b.trigger(0, { x: 200, y: 400 }, 1280, 720);
  assert.deepEqual(a._figureOrder, b._figureOrder);
  advance(a, 0, 2.5);
  advance(b, 0, 2.5);
  assert.ok(Math.abs(a.p.x - b.p.x) < 1e-9 && Math.abs(a.p.y - b.p.y) < 1e-9, 'identical seeds should trace identical paths');
});

test('different seeds produce a different figure order', () => {
  const a = new SkyVoyage(1);
  const b = new SkyVoyage(2);
  a.trigger(0, { x: 200, y: 400 }, 1280, 720);
  b.trigger(0, { x: 200, y: 400 }, 1280, 720);
  // Not a strict guarantee for any RNG, but should hold for these two seeds;
  // if it ever flakes, pick different seed literals.
  assert.notDeepEqual(a._figureOrder, b._figureOrder);
});

test('voyage recipes are seed-baked geometric params, not bare kind strings', () => {
  const v = new SkyVoyage(99);
  v.trigger(0, { x: 200, y: 400 }, 1280, 720);
  assert.equal(v._figureOrder.length, 3);
  const kinds = new Set();
  for (const recipe of v._figureOrder) {
    assert.equal(typeof recipe, 'object');
    assert.ok(recipe.kind, 'recipe has a kind');
    assert.ok(Number.isFinite(recipe.rate) && recipe.rate > 0);
    assert.ok(Number.isFinite(recipe.scale) && recipe.scale > 0);
    kinds.add(recipe.kind);
    // No consecutive-family repeat within a voyage (enforced by picker).
  }
  for (let i = 1; i < v._figureOrder.length; i++) {
    assert.notEqual(v._figureOrder[i].kind, v._figureOrder[i - 1].kind, 'no consecutive same family');
  }
  // Across many seeds, multiple families should appear.
  assert.ok(kinds.size >= 1);
});

test('same seed bakes identical recipes; different seed changes params', () => {
  const a = new SkyVoyage(777);
  const b = new SkyVoyage(777);
  const c = new SkyVoyage(778);
  a.trigger(0, { x: 100, y: 300 }, 1280, 720);
  b.trigger(0, { x: 100, y: 300 }, 1280, 720);
  c.trigger(0, { x: 100, y: 300 }, 1280, 720);
  assert.deepEqual(a._figureOrder, b._figureOrder);
  assert.notDeepEqual(a._figureOrder, c._figureOrder);
});

test('a figure switch pens-up instead of drawing a straight morph chord', () => {
  const v = new SkyVoyage(5);
  v._figureOrder = ['lissajous', 'epicycle', 'superformula'];
  let t = 0;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  t = advance(v, t, 0.9 + 1.6 + 3.2 + 0.05); // past first figure switch
  assert.ok(v._figureIdx >= 1);
  // No non-gap trail segment may be a long straight chord.
  let maxStep = 0;
  let sawGap = false;
  for (let i = 1; i < v.trail.length; i++) {
    const a = v.trail[i - 1], b = v.trail[i];
    if (b.gap) { sawGap = true; continue; }
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > maxStep) maxStep = d;
  }
  assert.ok(sawGap, 'figure switch should leave a pen-up gap');
  assert.ok(maxStep < 28, `drawn trail step too large: ${maxStep.toFixed(1)}px`);
});

test('the trail accumulates points and is capped by both time and count', () => {
  const v = new SkyVoyage(6);
  let t = 0;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  advance(v, t, 6); // well into deep space
  assert.ok(v.trail.length > 0, 'trail should have points');
  for (const pt of v.trail) {
    assert.ok(v.trail[v.trail.length - 1].tMs - pt.tMs <= 5500 + STEP_MS, 'no point should be older than the 5.5s trail window');
  }
});

test('completed figures freeze into constellations, capped and eventually expiring', () => {
  const v = new SkyVoyage(7);
  let t = 0;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  t = advance(v, t, 0.9 + 1.6 + 3.3); // clear one figure switch
  assert.ok(v.constellations.length >= 1, 'a completed figure should freeze into a constellation');
  const first = v.constellations[0];
  assert.ok(first.points.length >= 3);

  t = advance(v, t, 3.3 + 3.3); // clear the remaining figure switches (voyage ends around here)
  assert.ok(v.constellations.length <= 4, 'constellations must be capped');

  // Let enough simulated time pass for every constellation to expire (15s life).
  t = advance(v, t, 16);
  const anyOld = v.constellations.some((c) => t - c.bornMs > 15000);
  assert.equal(anyOld, false, 'nothing older than 15s should remain');
});

test('constellationLife01 holds, then smoothly fades to zero', () => {
  assert.equal(constellationLife01(0, CONSTELLATION_HOLD_SEC * 1000), 1, 'life should hold at full brightness through the hold window');
  const midFade = constellationLife01(0, 11000);
  assert.ok(midFade > 0 && midFade < 1, `life at 11s should be in the fade window, got ${midFade}`);
  assert.ok(constellationLife01(0, CONSTELLATION_LIFE_SEC * 1000) <= 1e-9, 'life should be effectively zero by 15s');
});

test('forceEnd immediately begins reentry from any active phase', () => {
  const v = new SkyVoyage(8);
  let t = 0;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  t = advance(v, t, 0.9 + 1.6 + 1); // now in deep space
  assert.equal(v.phase, VoyagePhase.DEEP_SPACE);
  v.forceEnd(t);
  assert.equal(v.phase, VoyagePhase.REENTRY);
});

test('forceEnd is a no-op when already idle', () => {
  const v = new SkyVoyage(9);
  v.forceEnd(1000);
  assert.equal(v.phase, VoyagePhase.IDLE);
});

test('a full voyage never produces NaN/Infinity in position, hue, or depth', () => {
  const v = new SkyVoyage(11);
  v.trigger(0, { x: 200, y: 400 }, 1280, 720);
  let t = 0;
  for (let i = 0; i < 15 * 120; i++) {
    t += STEP_MS;
    v.update(t, STEP_MS / 1000, 0.7, { x: 300, y: 250 });
    assert.ok(Number.isFinite(v.p.x) && Number.isFinite(v.p.y), `position finite at t=${t}`);
    assert.ok(Number.isFinite(v.hue), `hue finite at t=${t}`);
    assert.ok(Number.isFinite(v.depth), `depth finite at t=${t}`);
  }
});

test('a melody onset in deep space retunes her to the pitch class: hue and Lissajous pair', () => {
  const v = new SkyVoyage(20);
  let t = 0;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  t = advance(v, t, 0.9 + 1.6 + 0.1);
  assert.equal(v.phase, VoyagePhase.DEEP_SPACE);

  v.onMelodyOnset({ pitch: 64, vel: 0.8 }); // E -> pitch class 4
  assert.equal(v.hue, 4 * 30);
  assert.deepEqual(v._currentLiss(), [7, 4], 'pitch class 4 selects its coprime pair');

  v.onMelodyOnset({ pitch: 71, vel: 0.5 }); // B -> pitch class 11
  assert.deepEqual(v._currentLiss(), [5, 1]);
});

test('a melody onset outside deep space is ignored', () => {
  const v = new SkyVoyage(21);
  v.trigger(0, { x: 200, y: 400 }, 1280, 720); // WINDUP
  const hueBefore = v.hue;
  v.onMelodyOnset({ pitch: 64, vel: 0.8 });
  assert.equal(v.hue, hueBefore);
  assert.equal(v._liss, null);
});

test('a pitch-class retune morphs the position rather than teleporting it', () => {
  const v = new SkyVoyage(22);
  let t = 0;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  // Force the first figure to be a Lissajous so the retune actually applies.
  v._figureOrder = ['lissajous', 'lissajous', 'lissajous'];
  t = advance(v, t, 0.9 + 1.6 + 1.5); // mid-figure
  const before = { ...v.p };
  v.onMelodyOnset({ pitch: 66, vel: 0.9 }); // F# -> [5,3], very different from default [3,2]
  t = advance(v, t, 1 / 60); // a single ~frame later
  const jump = Math.hypot(v.p.x - before.x, v.p.y - before.y);
  assert.ok(jump < 40, `retune should morph, not teleport: jumped ${jump.toFixed(1)}px in one frame`);
});

test('onset phase-kicks accumulate smoothly, never as an instant time jump', () => {
  const v = new SkyVoyage(23);
  let t = 0;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  t = advance(v, t, 0.9 + 1.6 + 0.5);
  assert.equal(v._kickSmooth, 0);
  v.onMelodyOnset({ pitch: 60, vel: 1.0 });
  assert.equal(v._kickSmooth, 0, 'the kick must not apply instantaneously');
  assert.ok(v._kickTarget > 0.05, 'the kick target should be pending');
  t = advance(v, t, 0.25); // still mid-ease, before bleed drains the target
  assert.ok(v._kickSmooth > 0.03, 'the kick should have eased in by now');
  assert.ok(v._kickSmooth <= 0.32 + 1e-6, 'kick is hard-capped');
});

test('figure switches do not stamp a teleport chord into the trail', () => {
  const v = new SkyVoyage(28);
  v._figureOrder = ['lissajous', 'epicycle', 'superformula'];
  let t = 0;
  v.trigger(t, { x: 220, y: 480 }, 1280, 720);
  // Ride into deep space + past first figure boundary (FIGURE_SEC = 3.2).
  t = advance(v, t, 0.9 + 1.6 + 3.2 + 0.05);
  assert.equal(v.phase, VoyagePhase.DEEP_SPACE);
  assert.ok(v._figureIdx >= 1, 'should have advanced past the first figure');
  // Frame-to-frame steps along the live trail must stay continuous (gaps are
  // marked, never left as huge silent chords for the drawer to stroke).
  let maxStep = 0;
  for (let i = 1; i < v.trail.length; i++) {
    const a = v.trail[i - 1], b = v.trail[i];
    if (b.gap) continue;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > maxStep) maxStep = d;
  }
  assert.ok(maxStep < 42, `non-gap trail step too large: ${maxStep.toFixed(1)}px`);
});

test('kick does not carry across figure boundaries', () => {
  const v = new SkyVoyage(29);
  v._figureOrder = ['lissajous', 'lissajous', 'lissajous'];
  let t = 0;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  t = advance(v, t, 0.9 + 1.6 + 0.2);
  for (let i = 0; i < 8; i++) v.onMelodyOnset({ pitch: 60 + i, vel: 1 });
  t = advance(v, t, 0.3);
  assert.ok(v._kickSmooth > 0, 'kicks active mid-figure');
  // Cross the figure boundary.
  t = advance(v, t, 3.2);
  assert.equal(v._kickSmooth, 0, 'kick clears on figure switch');
  assert.equal(v._kickTarget, 0, 'kick target clears on figure switch');
});

test('kicks in deep space spawn a capped sparkle burst; kicks elsewhere are ignored', () => {
  const v = new SkyVoyage(24);
  v.onKick(0.9);
  assert.equal(v.sparkles.length, 0, 'idle: no sparkles');
  let t = 0;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  t = advance(v, t, 0.9 + 1.6 + 0.1);
  v.onKick(0.9);
  assert.ok(v.sparkles.length >= 5, 'deep space: a burst appears');
  for (let i = 0; i < 20; i++) v.onKick(1.0); // spam
  assert.ok(v.sparkles.length <= 36, `sparkles must stay capped, got ${v.sparkles.length}`);
  t = advance(v, t, 0.8); // past SPARKLE_LIFE_SEC
  assert.equal(v.sparkles.length, 0, 'sparkles expire');
});

test('melody onsets in deep space cut micro-slashes that expire', () => {
  const v = new SkyVoyage(25);
  let t = 0;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  t = advance(v, t, 0.9 + 1.6 + 0.1);
  v.onMelodyOnset({ pitch: 62, vel: 0.7 });
  assert.equal(v.microSlashes.length, 1);
  for (let i = 0; i < 12; i++) v.onMelodyOnset({ pitch: 62 + i, vel: 0.7 });
  assert.ok(v.microSlashes.length <= 6, 'micro-slashes must stay capped');
  t = advance(v, t, 0.4); // past SLASH_LIFE_SEC
  assert.equal(v.microSlashes.length, 0);
});

test('justLanded fires exactly on the frame she returns, then clears', () => {
  const v = new SkyVoyage(26);
  let t = 0;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  let landedFrames = 0;
  for (let i = 0; i < 16 * 120; i++) {
    t += STEP_MS;
    v.update(t, STEP_MS / 1000, 0.5, { x: 300, y: 250 });
    if (v.justLanded) landedFrames++;
  }
  assert.equal(landedFrames, 1, 'justLanded must be a one-frame flag');
  assert.equal(v.phase, VoyagePhase.IDLE);
  assert.equal(v.justLanded, false);
});

test('landing resets the melody tuning for the next voyage', () => {
  const v = new SkyVoyage(27);
  let t = 0;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  t = advance(v, t, 0.9 + 1.6 + 0.1);
  v.onMelodyOnset({ pitch: 66, vel: 0.9 });
  assert.ok(v._liss, 'tuning is live mid-voyage');
  t = advance(v, t, 14); // run the voyage out
  assert.equal(v.phase, VoyagePhase.IDLE);
  assert.equal(v._liss, null, 'tuning cleared for next time');
  assert.equal(v._kickTarget, 0);
});

test('expired constellations crystallize into the atlas instead of vanishing', () => {
  const v = new SkyVoyage(50);
  let t = 0;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  t = advance(v, t, 0.9 + 1.6 + 3.3); // one figure completes -> one bright constellation
  assert.ok(v.constellations.length >= 1);
  assert.equal(v.atlas.length, 0, 'nothing crystallized yet');

  t = advance(v, t, 16); // past the 15s bright life
  assert.equal(v.constellations.length + 0, v.constellations.length); // (sanity no-op)
  assert.ok(v.atlas.length >= 1, 'the expired constellation should now live in the atlas');
  const entry = v.atlas[0];
  assert.ok(entry.stars.length >= 3);
  for (const s of entry.stars) {
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y));
    assert.ok(Number.isFinite(s.phase), 'each star carries its own twinkle phase');
  }
});

test('the atlas persists after the voyage ends and across a second voyage', () => {
  const v = new SkyVoyage(51);
  let t = 0;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  t = advance(v, t, 30); // full voyage + everything expired into the atlas
  assert.equal(v.phase, VoyagePhase.IDLE);
  const atlasAfterFirst = v.atlas.length;
  assert.ok(atlasAfterFirst >= 1, 'the sky remembers the first voyage');

  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  t = advance(v, t, 30);
  assert.ok(v.atlas.length > atlasAfterFirst, 'the second voyage adds to the same map');
});

test('the atlas is capped at 8 entries, oldest dropped first', () => {
  const v = new SkyVoyage(52);
  let t = 0;
  // Four voyages x up to 3 constellations each would exceed the cap.
  for (let k = 0; k < 4; k++) {
    v.trigger(t, { x: 200, y: 400 }, 1280, 720);
    t = advance(v, t, 22);
    assert.equal(v.phase, VoyagePhase.IDLE, `voyage ${k} should have completed`);
  }
  assert.ok(v.atlas.length <= 8, `atlas must stay capped, got ${v.atlas.length}`);
  assert.ok(v.atlas.length >= 6, 'but should have accumulated plenty');
});

test('_navTarget is null on an unwritten sky and finds the densest cluster otherwise', () => {
  const v = new SkyVoyage(60);
  assert.equal(v._navTarget(), null);

  // A tight 12-star cluster near (900, 80) vs a lone sparse 3-star entry
  // far away: the cluster must win.
  v.atlas.push({
    stars: Array.from({ length: 12 }, (_, i) => ({ x: 900 + (i % 4) * 10, y: 80 + Math.floor(i / 4) * 10, phase: 0 })),
    hue: 120,
  });
  v.atlas.push({
    stars: [{ x: 200, y: 200, phase: 0 }, { x: 210, y: 205, phase: 0 }, { x: 190, y: 195, phase: 0 }],
    hue: 240,
  });
  const nav = v._navTarget();
  assert.ok(nav, 'a written sky yields a target');
  assert.ok(Math.hypot(nav.x - 915, nav.y - 90) < 30, `expected the dense cluster's centroid, got (${nav.x.toFixed(0)}, ${nav.y.toFixed(0)})`);
});

test('past voyages pull the next station toward the densest cluster (she revisits her myths)', () => {
  // The pull is deliberately OCCASIONAL (NAV_REVISIT_CHANCE), not every
  // voyage: applying it every time made its own output its next input and
  // collapsed a whole song's stations onto one patch of sky -- see
  // skyVoyageStationSpread.test.js. So this compares RATES across many
  // seeds rather than one voyage against one voyage. A single pair proves
  // nothing now, and asserting on one would just re-pin the bug.
  const clusterAt = { x: 950, y: 100 };
  const NEAR_PX = 220;
  let nearPlain = 0, nearGuided = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const plain = new SkyVoyage(seed);
    const guided = new SkyVoyage(seed);
    guided.atlas.push({
      stars: Array.from({ length: 10 }, (_, i) => ({ x: clusterAt.x + i, y: clusterAt.y + i, phase: 0 })),
      hue: 90,
    });
    plain.trigger(0, { x: 200, y: 400 }, 1280, 720);
    guided.trigger(0, { x: 200, y: 400 }, 1280, 720);
    if (Math.hypot(plain._station.x - clusterAt.x, plain._station.y - clusterAt.y) < NEAR_PX) nearPlain++;
    if (Math.hypot(guided._station.x - clusterAt.x, guided._station.y - clusterAt.y) < NEAR_PX) nearGuided++;
  }
  assert.ok(nearGuided > nearPlain,
    `a written sky should draw her back more often than an empty one (${nearGuided} vs ${nearPlain} of 40)`);

  // One guided voyage, for the safe-band assertions below.
  const guided = new SkyVoyage(61);
  guided.atlas.push({
    stars: Array.from({ length: 10 }, (_, i) => ({ x: clusterAt.x + i, y: clusterAt.y + i, phase: 0 })),
    hue: 90,
  });
  guided.trigger(0, { x: 200, y: 400 }, 1280, 720);

  // And the pull can never drag her out of the safe sky band.
  assert.ok(guided._station.x >= 1280 * 0.08 - 1 && guided._station.x <= 1280 * 0.92 + 1);
  assert.ok(guided._station.y >= 720 * 0.12 - 1 && guided._station.y <= 720 * 0.50 + 1);
});

test('detonateAtlas converts every atlas star into a staggered nova and spends the map', () => {
  const v = new SkyVoyage(62);
  v.atlas.push({ stars: [{ x: 100, y: 50, phase: 1 }, { x: 120, y: 60, phase: 2 }], hue: 30 });
  v.atlas.push({ stars: [{ x: 300, y: 90, phase: 3 }], hue: 200 });
  v.detonateAtlas(5000);
  assert.equal(v.atlas.length, 0, 'the map is spent');
  assert.equal(v.novae.length, 3, 'one nova per star');
  for (const n of v.novae) {
    assert.ok(n.delayMs >= 0 && n.delayMs < 900, 'popcorn stagger within the window');
    assert.equal(n.bornMs, 5000);
    assert.ok(Number.isFinite(n.hue) && Number.isFinite(n.phase));
  }
  // A second detonation with nothing left is a harmless no-op.
  v.detonateAtlas(6000);
  assert.equal(v.novae.length, 3);
});

test('novae expire after their delay + life, aging even while the voyage is idle', () => {
  const v = new SkyVoyage(63);
  v.atlas.push({ stars: [{ x: 100, y: 50, phase: 0 }], hue: 60 });
  v.detonateAtlas(0);
  assert.equal(v.novae.length, 1);
  assert.equal(v.phase, VoyagePhase.IDLE, 'she is home; the cascade plays anyway');

  let t = 0;
  for (let i = 0; i < Math.round(2.2 * 120); i++) { // 2.2s > max delay (0.9) + life (1.1)
    t += STEP_MS;
    v.update(t, STEP_MS / 1000, 0.5, { x: 300, y: 250 });
  }
  assert.equal(v.novae.length, 0, 'the cascade has fully burned out');
});

test('atlasPulse defaults to 0 and is a plain writable field for the Simulation', () => {
  const v = new SkyVoyage(53);
  assert.equal(v.atlasPulse, 0);
  v.atlasPulse = 0.7; // Simulation writes hype.slam here each step
  assert.equal(v.atlasPulse, 0.7);
});

test('position stays within a sane radius of the sky station throughout deep space', () => {
  const v = new SkyVoyage(12);
  let t = 0;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  t = advance(v, t, 0.9 + 1.6 + 0.1);
  for (let i = 0; i < 9 * 120; i++) {
    t += STEP_MS;
    v.update(t, STEP_MS / 1000, 0.6, { x: 300, y: 250 });
    if (v.phase !== VoyagePhase.DEEP_SPACE) continue;
    const d = Math.hypot(v.p.x - v._station.x, v.p.y - v._station.y);
    assert.ok(d < 400, `figure offset should stay near the station, got ${d.toFixed(0)}px`);
  }
});

// --- Thomas attractor "getting stuck" (reported: she stops for a few
// seconds mid-figure, then comes back) ---

test('a Thomas figure never sits visibly still for a long stretch, even starting near the attractor\'s slow fixed point', () => {
  const v = new SkyVoyage(7);
  let t = 0;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  v._figureOrder = ['thomas', 'thomas', 'thomas'];
  t = advance(v, t, 0.9 + 1.6 + 0.05); // land just into DEEP_SPACE, first figure
  assert.equal(v.phase, VoyagePhase.DEEP_SPACE);
  // The origin is an exact fixed point of Thomas' system (sin(0)-b*0=0 on
  // every axis) -- starting a hair off it lands squarely in the slow
  // "laminar" stretch that reads as her getting stuck.
  v._attractor = { x: 0.01, y: 0.01, z: 0.01 };

  let stillFrames = 0, worstStillStreakSec = 0;
  const dtSec = STEP_MS / 1000;
  for (let i = 0; i < 3 * 120; i++) { // one whole figure's worth (3.2s) plus margin
    const before = { ...v.p };
    t += STEP_MS;
    v.update(t, dtSec, 0.5, { x: 300, y: 250 });
    const moved = Math.hypot(v.p.x - before.x, v.p.y - before.y);
    if (moved < 0.05) { stillFrames++; worstStillStreakSec = Math.max(worstStillStreakSec, stillFrames * dtSec); }
    else stillFrames = 0;
  }
  assert.ok(worstStillStreakSec < 0.5,
    `she visibly stopped moving for ${worstStillStreakSec.toFixed(2)}s -- this is the reported "gets stuck" bug`);
});
