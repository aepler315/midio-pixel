import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConstellationWeaver, nextDotPos, edgeRevealFrac, groundFadeAlpha, REGION, GROUND_FADE_START,
  MELODY_STEPS_PER_UPDATE, STALL_EDGE_MS,
} from '../src/world/ConstellationWeaver.js';
import { mulberry32 } from '../src/utils/math.js';

function melodyEvt(tMs, pitch = 60, vel = 0.7) {
  return { tMs, pitch, vel, role: 'MELODY' };
}

function tickMelody(weaver, evt, dtSec = 0.05) {
  weaver.onMelody(evt);
  weaver.update(evt.tMs, dtSec);
}

test('nextDotPos: first dot lands in region, subsequent dots stay in region and hop scales with the field diagonal', () => {
  const rand = mulberry32(1);
  const w = 1280, h = 720;
  // Region spans nearly the whole WIDTH (0.03-0.97 x). Vertically it's
  // bounded above by REGION.yMin and below by REGION.yMax, which sits at
  // the sea horizon (Ocean.js's OCEAN_HORIZON_FRAC) rather than near
  // Midio's ground line: unlike ground-level terrain, the far ocean is
  // water, not something that occludes a figure landing on it, so nothing
  // here may be placed below where the sky actually ends. The ground-fade
  // curve (groundFadeAlpha) handles the safety margin, reaching true 0 by
  // yMax itself.
  const p0 = nextDotPos(null, rand, w, h);
  assert.ok(p0.x >= REGION.xMin * w && p0.x <= REGION.xMax * w);
  assert.ok(p0.y >= REGION.yMin * h && p0.y <= REGION.yMax * h);
  let prev = p0;
  const diag = Math.hypot(w, h);
  // Interior y band that clears the max possible hop (11% of the diagonal)
  // from both the top and bottom REGION edges, so reflection off an edge
  // can't shorten an observed step distance below.
  const maxHopFrac = 0.11 * diag / h;
  const yLo = REGION.yMin + maxHopFrac, yHi = REGION.yMax - maxHopFrac;
  for (let i = 0; i < 50; i++) {
    const p = nextDotPos(prev, rand, w, h);
    assert.ok(p.x >= REGION.xMin * w - 1e-6 && p.x <= REGION.xMax * w + 1e-6);
    assert.ok(p.y >= REGION.yMin * h - 1e-6 && p.y <= REGION.yMax * h + 1e-6);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    // Hop distance (pre-reflection) is 5%-11% of the field diagonal, not a
    // fixed pixel range -- verify it against an interior prev far enough
    // from every REGION edge that reflection can't shorten it.
    if (prev.x > 0.2 * w && prev.x < 0.8 * w && yLo < yHi && prev.y > yLo * h && prev.y < yHi * h) {
      const stepDist = Math.hypot(p.x - prev.x, p.y - prev.y);
      assert.ok(stepDist >= 0.05 * diag - 1e-6 && stepDist <= 0.11 * diag + 1e-6,
        `step ${stepDist} should be within 5%-11% of the diagonal (${diag})`);
    }
    prev = p;
  }
});

test('nextDotPos: hop distance scales up on a larger field, keeping the same proportion of the diagonal', () => {
  // A figure used to stay within ~150px regardless of screen size --
  // averaging out to a small "chunk" on a large canvas. The hop must widen
  // proportionally, not stay pinned to a fixed pixel range.
  const small = { w: 1280, h: 720 };
  const large = { w: 2560, h: 1440 }; // exactly double
  const smallDiag = Math.hypot(small.w, small.h);
  const largeDiag = Math.hypot(large.w, large.h);
  assert.ok(largeDiag > smallDiag * 1.9); // sanity: the field really did grow

  // Same seed, same interior starting point (as a fraction of the field) on
  // both fields, so the only difference is scale.
  const randSmall = mulberry32(7), randLarge = mulberry32(7);
  const prevSmall = { x: 0.5 * small.w, y: 0.5 * small.h };
  const prevLarge = { x: 0.5 * large.w, y: 0.5 * large.h };
  const pSmall = nextDotPos(prevSmall, randSmall, small.w, small.h);
  const pLarge = nextDotPos(prevLarge, randLarge, large.w, large.h);
  const stepSmall = Math.hypot(pSmall.x - prevSmall.x, pSmall.y - prevSmall.y);
  const stepLarge = Math.hypot(pLarge.x - prevLarge.x, pLarge.y - prevLarge.y);
  assert.ok(stepLarge > stepSmall * 1.5, `step on the larger field (${stepLarge}) should scale up from (${stepSmall})`);
});

test('a full figure seeds then connects, closing after targetCount-1 edge-revealing onsets', () => {
  const weaver = new ConstellationWeaver(5, 1280, 720);
  let t = 0;
  // Feed onsets until the first figure is committed (moves out of `building`).
  for (let i = 0; i < 40 && !((weaver.figures.length === 1) && !weaver.building); i++) {
    tickMelody(weaver, melodyEvt(t, 60 + i));
    t += 100;
  }
  assert.equal(weaver.figures.length, 1, 'exactly one figure should have completed');
  assert.equal(weaver.building, null);
  const fig = weaver.figures[0];
  assert.ok(fig.dots.length >= 5 && fig.dots.length <= 8);
  assert.equal(fig.edgeRevealedCount, fig.targetCount - 1);
  assert.equal(fig.phase, 'holding');
});

test('caps hold under a 300-onset spam: figures, dots, and stars stay bounded, no NaN', () => {
  const weaver = new ConstellationWeaver(9, 1280, 720);
  let t = 0;
  for (let i = 0; i < 300; i++) {
    weaver.onMelody(melodyEvt(t, (i * 7) % 128, 0.5));
    weaver.onKick(0.6);
    weaver.update(t, 0.1);
    t += 100;
  }
  // Figures now retire into a graceful fade (over FADE_MS) instead of being
  // deleted outright, so more than MAX_ACTIVE_FIGURES(3) can be tracked at
  // once while old ones fade out -- bounded by the hard MAX_TRACKED_FIGURES
  // safety net (3x that) rather than the old instant-cap of 3.
  assert.ok(weaver.figures.length <= 9, `figures should stay bounded (<=9), got ${weaver.figures.length}`);
  assert.ok(weaver.stars.length <= 6, `stars should cap at 6, got ${weaver.stars.length}`);
  // The dot cap (MAX_DOTS=40) now retires figures into a graceful fade
  // rather than deleting them outright, and a fading figure keeps its dots
  // until FADE_MS elapses -- so total dots can briefly overshoot 40 while
  // several figures fade out at once under sustained spam. The real
  // guarantee is MAX_TRACKED_FIGURES(9) figures at FIGURE_DOTS_MAX(8) dots
  // each, worst case.
  let totalDots = weaver.building ? weaver.building.dots.length : 0;
  for (const f of weaver.figures) totalDots += f.dots.length;
  assert.ok(totalDots <= 72, `total dots should stay bounded (<=72), got ${totalDots}`);
  for (const f of weaver.figures) {
    for (const d of f.dots) assert.ok(Number.isFinite(d.x) && Number.isFinite(d.y));
  }
  assert.ok(Number.isFinite(weaver.pulse));
});

test('figures drain over time: hold then fade then gone (or crystallized), no NaN', () => {
  const weaver = new ConstellationWeaver(3, 1280, 720);
  let t = 0;
  // Complete one figure quickly.
  while (!weaver.figures.length) { tickMelody(weaver, melodyEvt(t, 64)); t += 50; }
  assert.equal(weaver.figures.length, 1);
  // Advance well past hold (5000ms) + fade (3000ms).
  for (let i = 0; i < 200; i++) {
    weaver.update(t, 0.1);
    t += 100;
  }
  assert.equal(weaver.figures.length, 0, 'the figure should have fully drained');
  assert.ok(weaver.stars.length === 0 || weaver.stars.length === 1);
});

test('update(nowMs, 0) is a state no-op for timers', () => {
  const weaver = new ConstellationWeaver(1, 1280, 720);
  weaver.onMelody(melodyEvt(0, 60));
  const before = JSON.stringify(weaver.building);
  weaver.update(0, 0);
  assert.equal(JSON.stringify(weaver.building), before);
});

test('same seed + same event sequence -> identical dot coordinates (determinism)', () => {
  const events = Array.from({ length: 20 }, (_, i) => melodyEvt(i * 120, (i * 5) % 100, 0.6));
  const a = new ConstellationWeaver(77, 1280, 720);
  const b = new ConstellationWeaver(77, 1280, 720);
  for (const e of events) { tickMelody(a, e); tickMelody(b, e); }
  assert.deepEqual(a.figures, b.figures);
  assert.deepEqual(a.building, b.building);
});

test('edgeRevealFrac is monotone in nowMs and bounded 0..1', () => {
  const fig = { targetCount: 6, edgeRevealedCount: 2, edgeStartMs: 1000 };
  let prev = -1;
  for (let now = 1000; now <= 2000; now += 25) {
    const f = edgeRevealFrac(fig, now);
    assert.ok(f >= 0 && f <= 1);
    assert.ok(f >= prev - 1e-9, 'must be monotone non-decreasing');
    prev = f;
  }
});

function fakeCtx2d() {
  const noop = () => {};
  const arcs = [];
  return {
    arcs,
    save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, fill: noop,
    set strokeStyle(v) {}, set fillStyle(v) {}, set lineWidth(v) {}, set globalCompositeOperation(v) {},
    arc(x, y) { arcs.push({ x, y }); },
  };
}

test('draw() rescales dots against the ACTUAL canvas, not the construction-time field size', () => {
  // Built at 1280x720 (a plausible nominal/logical stage size), but the
  // canvas actually handed to draw() is larger -- a camera pull-back or a
  // higher-resolution render target, exactly the mismatch that used to pin
  // every dot to a shrunken box in a corner of the real frame.
  const weaver = new ConstellationWeaver(4, 1280, 720);
  let t = 0;
  while (!weaver.figures.length) { tickMelody(weaver, melodyEvt(t, 64)); t += 50; }
  const fig = weaver.figures[0];
  const rawDot = fig.dots[0];

  const ctx = fakeCtx2d();
  const canvas = { width: 1920, height: 1080 };
  weaver.draw(ctx, canvas, false, 1);

  const sx = canvas.width / weaver.w, sy = canvas.height / weaver.h;
  const expectedX = rawDot.x * sx, expectedY = rawDot.y * sy;
  const found = ctx.arcs.some((p) => Math.abs(p.x - expectedX) < 1e-6 && Math.abs(p.y - expectedY) < 1e-6);
  assert.ok(found, `expected an arc at the rescaled position (${expectedX}, ${expectedY}); got ${JSON.stringify(ctx.arcs)}`);
  // And it must NOT have drawn at the raw, unscaled field coordinate
  // (unless sx/sy happen to be 1, which they aren't here).
  const drewUnscaled = ctx.arcs.some((p) => Math.abs(p.x - rawDot.x) < 1e-6 && Math.abs(p.y - rawDot.y) < 1e-6);
  assert.equal(drewUnscaled, false, 'must not draw at the un-rescaled field coordinate');
});

test('a stalled constellation edge waits for the next kick', () => {
  const weaver = new ConstellationWeaver(5, 1280, 720);
  let t = 0;
  for (let i = 0; i < 40 && !(weaver.building && weaver.building.phase === 'connecting'); i++) {
    tickMelody(weaver, melodyEvt(t, 60 + i));
    t += 80;
  }
  const fig = weaver.building;
  assert.ok(fig && fig.phase === 'connecting', 'figure should be connecting edges');
  const before = fig.edgeRevealedCount;
  const stalled = fig.edgeStartMs + STALL_EDGE_MS + 400;
  weaver.update(stalled, 0.05);
  assert.equal(fig.edgeRevealedCount, before, 'the stall timer alone must not draw the next edge');
  weaver.onKick(0.8, stalled);
  assert.equal(weaver.building, fig, 'one edge must not finish the figure');
  assert.equal(fig.edgeRevealedCount, before + 1);
});

test('onKick pulse rises then decays toward 0', () => {
  const weaver = new ConstellationWeaver(2, 1280, 720);
  weaver.onKick(0.9);
  assert.ok(weaver.pulse > 0.8);
  for (let i = 0; i < 40; i++) weaver.update(i * 50, 0.05);
  assert.ok(weaver.pulse < 0.05, `pulse should have decayed, got ${weaver.pulse}`);
});

// ── Lyric-driven glyph hints: timely, and never stale ────────────────
//
// hintGlyph used to gate acceptance on the cooldown, silently dropping a
// hint that arrived while one was still counting down -- with no way to
// tell that had happened, and no way to fire it once the cooldown cleared.
// It's now unconditional to accept (a newer hint always replaces an older,
// unfired one) and carries a deadline, checked fresh in onMelody, so a
// hint that outlives the lyric line it came from expires instead of
// popping up over whatever the song (or a scrub) has moved on to.

test('hintGlyph builds a glyph-shaped figure on the next melody event, within its deadline', () => {
  const weaver = new ConstellationWeaver(3, 1280, 720);
  weaver.hintGlyph('heart_break', 10_000);
  weaver.onMelody(melodyEvt(0, 64));
  assert.ok(weaver.building, 'a figure should start building immediately');
  assert.ok(weaver.building.interior.length >= 1, 'heart_break carries interior detail the outline alone would not have');
  assert.strictEqual(weaver._pendingGlyph, null, 'the hint is consumed once used');
});

test('hintGlyph: a hint past its own deadline expires -- an ordinary figure builds instead', () => {
  const weaver = new ConstellationWeaver(3, 1280, 720);
  weaver.hintGlyph('heart_break', 500);
  weaver.onMelody(melodyEvt(600, 64)); // arrives after the deadline
  assert.ok(weaver.building, 'a figure should still build -- just not the glyph');
  assert.deepEqual(weaver.building.interior, [], 'an ordinary figure carries no interior detail');
  assert.strictEqual(weaver._pendingGlyph, null, 'the expired hint must not linger for a later attempt');
});

test('hintGlyph: is accepted even while the glyph cooldown is active, unlike before', () => {
  const weaver = new ConstellationWeaver(3, 1280, 720);
  weaver._glyphCooldown = 3; // as if a glyph figure just fired
  weaver.hintGlyph('heart_break', 10_000);
  assert.ok(weaver._pendingGlyph, 'the hint must be queued, not dropped, while cooldown counts down');
  assert.strictEqual(weaver._pendingGlyph.glyphId, 'heart_break');
});

test('hintGlyph: a newer call supersedes an older, still-pending one', () => {
  const weaver = new ConstellationWeaver(3, 1280, 720);
  weaver.hintGlyph('heart_break', 10_000);
  weaver.hintGlyph('ship_wave', 10_000); // the next lyric line's hit
  weaver.onMelody(melodyEvt(0, 64));
  assert.ok(weaver.building, 'a figure should be built');
  // Can't read glyphId back off the built figure directly, so check via a
  // shape-distinguishing property: ship_wave's interior has 3 strokes
  // (mast, flag, wave crest); heart_break has exactly 1 (the crack).
  assert.strictEqual(weaver.building.interior.length, 3, 'should have built ship_wave, not the superseded heart_break');
});

test('interior detail strokes stay hidden until INTERIOR_REVEAL_MS after the outline commits, then fade in', () => {
  const weaver = new ConstellationWeaver(1, 1280, 720);
  weaver.figures.push({
    dots: [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 150, y: 200 }],
    interior: [[{ x: 120, y: 120 }, { x: 180, y: 120 }]],
    targetCount: 3, hue: 0, phase: 'holding',
    edgeRevealedCount: 2, edgeStartMs: 0, holdStartMs: 1000,
  });

  const makeCtx = () => {
    const calls = { stroke: 0 };
    return {
      calls,
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, fill() {},
      set strokeStyle(v) {}, set fillStyle(v) {}, set lineWidth(v) {}, set globalCompositeOperation(v) {},
      arc() {}, stroke() { calls.stroke++; },
    };
  };

  weaver.update(1000, 0.016, 0);
  const ctxAt0 = makeCtx();
  weaver.draw(ctxAt0, { width: 1280, height: 720 }, false, 1);
  const strokesAtCommit = ctxAt0.calls.stroke;

  weaver.update(1000 + 450, 0.016, 0); // holdStartMs + INTERIOR_REVEAL_MS
  const ctxAtReveal = makeCtx();
  weaver.draw(ctxAtReveal, { width: 1280, height: 720 }, false, 1);
  const strokesAtReveal = ctxAtReveal.calls.stroke;

  assert.ok(strokesAtReveal > strokesAtCommit,
    `interior stroke should add draw calls once revealed (at commit: ${strokesAtCommit}, at reveal: ${strokesAtReveal})`);
});

// ── Figures must not reach the ground line ──────────────────────────
//
// Reproduced live: yMax=0.95 let a figure's lowest dot land right at (or
// past) Midio's actual ground line (groundY=0.75 of the nominal stage), and
// since Landmarks.js draws ground-level decoration as unfilled STROKED
// wireframes (paintLatticeTower et al.), nothing there actually occludes it
// the way the "terrain occludes anything below a ridge" reasoning assumed.
// With up to 3 figures alive at once, two both resting on the grass line
// read as exactly the "stars bunched together" complaint this was meant to
// fix -- just bunched on the ground instead of on the X axis.
const GROUND_FRAC = 0.75; // Midio.groundY (540) / Midasus's nominal stageH (720)

test('nextDotPos never lands at or past the ground line, regardless of prior position', () => {
  const rand = mulberry32(2024);
  const w = 1920, h = 1080;
  let prev = null;
  for (let i = 0; i < 200; i++) {
    prev = nextDotPos(prev, rand, w, h);
    assert.ok(prev.y < GROUND_FRAC * h,
      `dot at y=${(prev.y / h).toFixed(3)} of height should stay clear of the ground line at ${GROUND_FRAC}`);
  }
});

test('a full song of figures never produces a dot at or past the ground line', () => {
  const weaver = new ConstellationWeaver(55, 1920, 1080);
  let t = 0;
  for (let i = 0; i < 400; i++) {
    weaver.onMelody(melodyEvt(t, 60 + (i * 5) % 24, 0.6));
    weaver.update(t, 0.5);
    t += 500;
  }
  const allDots = [
    ...(weaver.building ? weaver.building.dots : []),
    ...weaver.figures.flatMap((f) => f.dots),
    ...weaver.stars.flatMap((s) => s.dots),
  ];
  assert.ok(allDots.length > 0, 'fixture should have produced some dots');
  for (const d of allDots) {
    assert.ok(d.y < GROUND_FRAC * 1080,
      `a dot at y=${(d.y / 1080).toFixed(3)} of height sits at or past the ground line`);
  }
});

// ── The vertical-clustering fix ──────────────────────────────────────
//
// A live 3-minute session showed every single dot (figures and crystallized
// stars alike) landing between y=0.05 and y=0.575 of the frame -- never once
// below 58%, no matter how long the song ran. That's the same "stars are
// clustered in the middle" complaint the ambient star catalogue fix (see
// StarCatalogue.js) didn't touch, because this system's dots are far
// brighter and more eye-catching than the ambient field. Fixed by raising
// REGION.yMax and tying groundFadeAlpha's fade-to-zero point to it directly,
// so the region can safely use most of the real open sky.

test('groundFadeAlpha reaches exactly 0 at REGION.yMax, never a visible floor', () => {
  assert.equal(groundFadeAlpha(REGION.yMax), 0);
  assert.equal(groundFadeAlpha(REGION.yMax + 0.15), 0, 'past yMax should stay fully faded, not climb back up');
  assert.equal(groundFadeAlpha(GROUND_FADE_START - 0.1), 1, 'well before the fade starts should be fully visible');
});

// ── The sea-horizon fix ──────────────────────────────────────────────
//
// REGION.yMax used to be a flat 0.70, tuned only against Midio's own
// ground line (0.75) -- reasonable for terrain, which occludes anything
// that lands behind it, but not for the far ocean (Ocean.js), which sits
// at the same depth as the ranges and occludes nothing: a dot placed
// between the sea horizon (~0.38) and the ground line sat visibly IN the
// water in any gap between mountains, reading as a constellation sticking
// out of the sea. yMax now sits at OCEAN_HORIZON_FRAC, so nothing placed
// by this system can ever land below where the sky actually ends.
test('nextDotPos never lands below the sea horizon (REGION.yMax)', () => {
  const rand = mulberry32(7);
  const w = 1920, h = 1080;
  let prev = null;
  for (let i = 0; i < 300; i++) {
    prev = nextDotPos(prev, rand, w, h);
    assert.ok(prev.y / h <= REGION.yMax + 1e-6,
      `dot at y=${(prev.y / h).toFixed(3)} of height should stay at or above the sea horizon (${REGION.yMax})`);
  }
});

test('a full song of figures never produces a dot below the sea horizon (REGION.yMax)', () => {
  const weaver = new ConstellationWeaver(909, 1920, 1080);
  let t = 0;
  for (let i = 0; i < 400; i++) {
    weaver.onMelody(melodyEvt(t, 60 + (i * 5) % 24, 0.6));
    weaver.update(t, 0.5);
    t += 500;
  }
  const allDots = [
    ...(weaver.building ? weaver.building.dots : []),
    ...weaver.figures.flatMap((f) => f.dots),
    ...weaver.stars.flatMap((s) => s.dots),
  ];
  assert.ok(allDots.length > 0, 'fixture should have produced some dots');
  for (const d of allDots) {
    assert.ok(d.y / 1080 <= REGION.yMax + 1e-6,
      `a dot at y=${(d.y / 1080).toFixed(3)} of height sits below the sea horizon (${REGION.yMax})`);
  }
});

test('a catch-up dump of melody notes does not paint a sky of figures in one frame', () => {
  const weaver = new ConstellationWeaver(12, 1280, 720);
  weaver.update(8000, 0.016);
  for (let i = 0; i < 80; i++) weaver.onMelody(melodyEvt(8000 + i * 25, 60 + i));
  assert.equal(weaver.figures.length, 0, 'no figure can finish from a single-frame dump');
  assert.ok(weaver.building, 'at most one figure should have taken a step');
  assert.ok(weaver.building.dots.length <= 2);
  assert.equal(MELODY_STEPS_PER_UPDATE, 1);
  weaver.update(9000, 0.016);
  // After the dump, live melody still completes a figure across frames.
  let t = 10000;
  for (let i = 0; i < 40 && !weaver.figures.length; i++) {
    tickMelody(weaver, melodyEvt(t, 64));
    t += 90;
  }
  assert.equal(weaver.figures.length, 1);
});
