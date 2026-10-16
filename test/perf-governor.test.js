import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerfGovernor, MAX_LEVEL, resolvePerfStartLevel, FRAME_BUDGET_MS } from '../src/render/PerfGovernor.js';

// Derived from the budget rather than hardcoded, so these test the
// severity-weighted shedding BEHAVIOUR and not a particular threshold --
// the old literals silently encoded a 15ms budget that turned out to be
// measuring the wrong quantity entirely (see FRAME_BUDGET_MS).
const BARELY_OVER = FRAME_BUDGET_MS + 0.1;   // severity ~1.0
const TRIPLE = FRAME_BUDGET_MS * 3;          // severity 3.0
const framesToShed = (deltaMs) => Math.ceil(60 / Math.min(6, deltaMs / FRAME_BUDGET_MS));

function feedFrames(gov, n, deltaMs, startMs = 0, stepMs = 16.6) {
  let t = startMs;
  for (let i = 0; i < n; i++) { gov.sample(deltaMs, t); t += stepMs; }
  return t;
}

test('stays at level 0 under a healthy frame budget', () => {
  const gov = new PerfGovernor();
  feedFrames(gov, 200, 10);
  assert.equal(gov.level, 0);
  assert.equal(gov.visionAllowed, true);
  assert.equal(gov.particleMul, 1);
  assert.equal(gov.crackGlowEnabled, true);
  assert.equal(gov.bloomEnabled, true);
  assert.equal(gov.veilEnabled, true);
  assert.equal(gov.rimLightEnabled, true);
  assert.equal(gov.contactShadowsEnabled, true);
});

test('sheds one rung after sustained over-budget frames, in spec order', () => {
  const gov = new PerfGovernor();
  // A modest overage: severity-weighted shedding crosses the threshold
  // sooner than the 60-frame nominal (see the scaled-shedding tests below).
  const over = FRAME_BUDGET_MS * (20 / 15); // same proportional overage as before
  const n = framesToShed(over);
  feedFrames(gov, n - 1, over);
  assert.equal(gov.level, 0, 'should not shed before the sustained-severity threshold');
  feedFrames(gov, 1, over);
  assert.equal(gov.level, 1);
  assert.equal(gov.visionAllowed, false, 'vision loop sheds first');
  assert.equal(gov.particleMul, 1, 'particles untouched at level 1');
  assert.equal(gov.rimLightEnabled, true, 'rim light untouched at level 1');
  assert.equal(gov.contactShadowsEnabled, true, 'contact shadows untouched at level 1');
});

test('rim light sheds at level 2 alongside the particle cap; contact shadows survive one rung longer', () => {
  const gov = new PerfGovernor();
  const over2 = FRAME_BUDGET_MS * (20 / 15);
  feedFrames(gov, framesToShed(over2) * 2, over2); // two shed rungs -> level 2
  assert.equal(gov.level, 2);
  assert.equal(gov.particleMul, 0.6);
  assert.equal(gov.rimLightEnabled, false);
  assert.equal(gov.contactShadowsEnabled, true, 'contact shadows shed at level 3, not 2');
});

test('a frame barely over budget still takes ~60 frames (~1s) to shed', () => {
  const gov = new PerfGovernor();
  feedFrames(gov, 59, BARELY_OVER);
  assert.equal(gov.level, 0);
  feedFrames(gov, 1, BARELY_OVER);
  assert.equal(gov.level, 1);
});

test('a badly over-budget frame sheds a rung in far fewer frames', () => {
  const gov = new PerfGovernor();
  // 3x budget -- severity 3, so 20 frames (not 60) sheds.
  feedFrames(gov, 19, TRIPLE);
  assert.equal(gov.level, 0);
  feedFrames(gov, 1, TRIPLE);
  assert.equal(gov.level, 1);
});

test('severity is capped so one catastrophic frame cannot shed multiple rungs at once', () => {
  const gov = new PerfGovernor();
  gov.sample(5000, 0); // one huge stall (e.g. a tab coming back into focus)
  assert.equal(gov.level, 0, 'a single frame, however bad, only ever adds capped severity');
});

test('sheds progressively further under sustained pressure', () => {
  const gov = new PerfGovernor();
  let t = 0;
  // Barely-over-budget severity (~1x) so each 60-frame batch sheds exactly
  // one rung with no carry-over into the next, isolating "does the ladder
  // walk down in order" from the severity-scaling behavior (tested above).
  for (let lvl = 1; lvl <= MAX_LEVEL; lvl++) {
    t = feedFrames(gov, 60, BARELY_OVER, t);
    assert.equal(gov.level, lvl);
  }
  // Fully shed: every lever off.
  assert.equal(gov.visionAllowed, false);
  assert.equal(gov.particleMul, 0.6);
  assert.equal(gov.crackGlowEnabled, false);
  assert.equal(gov.bloomEnabled, false);
  assert.equal(gov.veilEnabled, false);
  assert.equal(gov.phenomenaFull, false);
  assert.equal(gov.hazeLayers, 1);
  assert.equal(gov.heavyPostFx, false);
  assert.equal(gov.brushEnabled, false);

  // Further over-budget frames don't shed past MAX_LEVEL.
  feedFrames(gov, 200, 20, t);
  assert.equal(gov.level, MAX_LEVEL);
});

test('a single over-budget frame does not reset recovery progress unnecessarily, but recovers after 10 clean seconds', () => {
  const gov = new PerfGovernor();
  let t = feedFrames(gov, 60, 20, 0); // shed to level 1
  assert.equal(gov.level, 1);

  // Under 10s of clean frames: no recovery yet.
  t = feedFrames(gov, 100, 5, t, 90); // ~9s of clean frames
  assert.equal(gov.level, 1);

  // Push past the 10s clean threshold.
  t = feedFrames(gov, 20, 5, t, 90); // another ~1.8s
  assert.equal(gov.level, 0);
});

test('judder -- frames alternating just above and below budget -- still sheds a rung eventually', () => {
  const gov = new PerfGovernor();
  let t = 0;
  // Alternate one badly-over-budget frame (severity 2) with one clean frame.
  // A hard reset-to-zero on every clean frame would erase all accumulated
  // severity and this loop would never shed; decaying instead lets it
  // net-accumulate every pair.
  for (let i = 0; i < 400 && gov.level === 0; i++) {
    gov.sample(30, t); t += 16.6;
    gov.sample(5, t); t += 16.6;
  }
  assert.equal(gov.level, 1, 'sustained judder should shed a rung, not stay at 0 forever');
});

test('deeper rungs (5-6) gate phenomena and the overlay-pass stack, past the original four', () => {
  const gov = new PerfGovernor();
  gov.level = 4;
  assert.equal(gov.phenomenaFull, true, 'still full at the end of the original ladder');
  assert.equal(gov.hazeLayers, 3);
  assert.equal(gov.heavyPostFx, true);
  assert.equal(gov.brushEnabled, true, 'brush still on at the end of the original ladder');

  gov.level = 5;
  assert.equal(gov.phenomenaFull, false, 'rung 5 sheds optional phenomena');
  assert.equal(gov.hazeLayers, 3, 'haze still full at rung 5');
  assert.equal(gov.heavyPostFx, true);
  assert.equal(gov.brushEnabled, false, 'rung 5 sheds the rainbow brush alongside phenomena');

  gov.level = 6;
  assert.equal(gov.phenomenaFull, false);
  assert.equal(gov.hazeLayers, 1, 'rung 6 collapses haze to a single layer');
  assert.equal(gov.heavyPostFx, false, 'rung 6 also drops the heaviest overlay passes');
  assert.equal(gov.brushEnabled, false);
});

test('ridgeShadingFull: _drawRidgeVolume\'s shade/aerial passes hold out to the very last rung', () => {
  // Unlike everything else on this ladder, _drawRidgeVolume never had a shed
  // lever at all before this -- it's core content (the range's own shading),
  // not optional atmosphere, so it's meant to be the LAST thing given up,
  // same tier as hazeLayers/heavyPostFx rather than an earlier rung like
  // phenomena or the brush.
  const gov = new PerfGovernor();
  gov.level = 5;
  assert.equal(gov.ridgeShadingFull, true, 'still full one rung short of MAX_LEVEL');
  gov.level = MAX_LEVEL;
  assert.equal(gov.ridgeShadingFull, false, 'only sheds at the very last rung');
});

test('constellationsEnabled: the constellation weaver outlives the phenomena layer it used to shed with', () => {
  // The connect-the-dots / lyric-glyph weaver is a few thin strokes -- far
  // cheaper than the ReactionDiffusion/atmosphere layers that share rung 5.
  // Shedding it with phenomena is what made The Range's sky go dark under
  // load, so it now holds out to the last rung with hazeLayers/heavyPostFx.
  const gov = new PerfGovernor();
  gov.level = 0;
  assert.equal(gov.constellationsEnabled, true);
  gov.level = 5;
  assert.equal(gov.phenomenaFull, false, 'heavy phenomena already shed at rung 5');
  assert.equal(gov.constellationsEnabled, true, 'constellations survive the phenomena cut');
  gov.level = MAX_LEVEL;
  assert.equal(gov.constellationsEnabled, false, 'only sheds at the very last rung');
});

test('Auto quality lowers backing resolution before world-defining phenomena are removed', () => {
  const gov = new PerfGovernor();
  gov.level = 0;
  assert.equal(gov.resolutionScale(1080, { adaptive: true }), 1);

  gov.level = 2;
  assert.equal(gov.resolutionScale(1080, { adaptive: true }), 0.85);
  assert.equal(gov.phenomenaFull, true, 'world phenomena remain intact at the first resolution step');

  gov.level = 4;
  assert.equal(gov.resolutionScale(1080, { adaptive: true }), 0.625);
  assert.equal(gov.phenomenaFull, true, 'Auto buys pixels before shedding world identity at level 5');
});

test('holdQuality stays at full detail through a run of slow frames', () => {
  const gov = new PerfGovernor({ startLevel: 0 });
  gov.holdQuality = true;
  for (let t = 0; t < 5000; t += 100) gov.sample(100, t);
  assert.equal(gov.level, 0);
  gov.holdQuality = false;
  feedFrames(gov, 60, 20, 0);
  assert.equal(gov.level, 1);
});

test('manual resolution overrides remain fixed under governor pressure', () => {
  const gov = new PerfGovernor({ startLevel: MAX_LEVEL });
  assert.equal(gov.resolutionScale(2160, { adaptive: false }), 1);
  assert.equal(gov.resolutionScale(720), 1);
});

test('constructor accepts a proactive startLevel, clamped to [0, MAX_LEVEL]', () => {
  assert.equal(new PerfGovernor().level, 0, 'defaults to 0');
  assert.equal(new PerfGovernor({ startLevel: 2 }).level, 2);
  assert.equal(new PerfGovernor({ startLevel: -3 }).level, 0, 'clamped at the floor');
  assert.equal(new PerfGovernor({ startLevel: 99 }).level, MAX_LEVEL, 'clamped at the ceiling');
});

test('resolvePerfStartLevel: ?perf=lite|high overrides the device heuristic', () => {
  assert.equal(resolvePerfStartLevel('?perf=lite', { isCoarsePointer: false }), 2);
  assert.equal(resolvePerfStartLevel('?perf=high', { isCoarsePointer: true }), 0);
  assert.equal(resolvePerfStartLevel('perf=lite'), 2, 'works without a leading ?');
});

test('resolvePerfStartLevel: falls back to a coarse-pointer/small-viewport device heuristic', () => {
  assert.equal(resolvePerfStartLevel('', {}), 0, 'a normal desktop starts at full quality');
  assert.equal(resolvePerfStartLevel('', { isCoarsePointer: true }), 1, 'touch devices start a rung down');
  assert.equal(resolvePerfStartLevel('', { isSmallViewport: true }), 1, 'small viewports start a rung down');
});

test('resolvePerfStartLevel tolerates a malformed search string', () => {
  assert.equal(resolvePerfStartLevel(undefined, {}), 0);
});

test('an over-budget frame during a clean streak resets the recovery timer', () => {
  const gov = new PerfGovernor();
  let t = feedFrames(gov, 60, 20, 0); // shed to level 1
  t = feedFrames(gov, 100, 5, t, 90); // ~9s clean, not yet recovered
  assert.equal(gov.level, 1);

  gov.sample(20, t); // one bad frame resets the clean-streak clock
  t += 90;
  t = feedFrames(gov, 100, 5, t, 90); // another ~9s clean — still shy of 10s since reset
  assert.equal(gov.level, 1, 'recovery timer should have restarted after the interruption');
});

// --- Warm-up grace -------------------------------------------------------
// Starting a song bakes two dozen 2048px strips and touches every cold path
// in the renderer. Those frames are catastrophically long but say nothing
// about steady-state cost, and at severity 6 apiece only ten of them shed a
// rung -- so a load hitch alone used to cascade the governor several rungs
// deep and switch off every optional pass permanently, which is what "the
// terrain detail is only there for the first two seconds" actually was.

test('a load hitch does not vote: the warm-up window absorbs it', async () => {
  const { PerfGovernor, WARMUP_MS } = await import('../src/render/PerfGovernor.js');
  const g = new PerfGovernor({ startLevel: 0 });
  let t = 0;
  g.beginWarmup(t);   // what main.js does the moment a song starts
  // 120 catastrophic frames, all inside the warm-up window.
  for (let i = 0; i < 120; i++) { g.sample(200, t); t += 12; }
  assert.equal(g.level, 0, 'the bake must not shed a single rung');
  assert.ok(t < WARMUP_MS, 'sanity: this burst really was inside the window');
});

test('a genuinely over-budget scene still sheds, just after the window', async () => {
  const { PerfGovernor, WARMUP_MS } = await import('../src/render/PerfGovernor.js');
  const g = new PerfGovernor({ startLevel: 0 });
  g.beginWarmup(0);
  let t = WARMUP_MS + 1;
  for (let i = 0; i < 400; i++) { g.sample(45, t); t += 16; }
  assert.ok(g.level > 0, 'a sustained real overage must still shed');
});

test('beginWarmup re-arms the grace for a new song', async () => {
  const { PerfGovernor, WARMUP_MS } = await import('../src/render/PerfGovernor.js');
  const g = new PerfGovernor({ startLevel: 0 });
  let t = 0;
  g.beginWarmup(t);
  t += WARMUP_MS + 1;
  g.beginWarmup(t);                       // new song loads here
  for (let i = 0; i < 120; i++) { g.sample(200, t); t += 12; }
  assert.equal(g.level, 0, 'the second song\'s bake must be absorbed too');
});

test('a machine holding a steady 60fps must never shed a rung', () => {
  // sample() is fed the raw rAF-to-rAF delta, which is the frame PERIOD
  // (~16.67ms on a 60Hz display), not the time spent working inside it.
  // Compared against a 15ms *work* budget, every healthy frame counted as
  // over budget and no frame was ever clean, so the accumulator marched to
  // 60 in under a second, shed a rung, and repeated -- reaching MAX_LEVEL in
  // ~5s and never recovering, on hardware that was keeping up perfectly.
  // That is what "the textures disappear after 2 seconds" actually was.
  const gov = new PerfGovernor({ startLevel: 0 });
  let t = 0;
  for (let i = 0; i < 60 * 20; i++) { gov.sample(1000 / 60, t); t += 1000 / 60; }
  assert.equal(gov.level, 0, `shed to ${gov.level} while holding 60fps`);
});

test('ordinary vsync jitter at 60fps is not an overage either', () => {
  const gov = new PerfGovernor({ startLevel: 0 });
  let t = 0;
  for (let i = 0; i < 60 * 20; i++) {
    const d = i % 7 === 0 ? 17.6 : 16.7; // the usual ragged edge of a 60Hz vsync
    gov.sample(d, t); t += d;
  }
  assert.equal(gov.level, 0, `jitter alone shed to ${gov.level}`);
});

test('a machine genuinely missing frames still sheds', () => {
  const gov = new PerfGovernor({ startLevel: 0 });
  let t = 0;
  for (let i = 0; i < 60 * 20; i++) { gov.sample(33.3, t); t += 33.3; } // a hard 30fps
  assert.ok(gov.level > 0, 'a real 30fps scene must still degrade');
});

// ── 8-bit mode (StagePresets.RETRO_PRESET) ─────────────────────────
//
// The menu entry only means something if the governor actually holds the
// floor. Two things have to be true and neither is automatic: every gate
// reports its cheapest answer, and the ladder never climbs back out.

test('8-bit mode starts pinned at the cheapest rung with every optional pass off', () => {
  const gov = new PerfGovernor({ retro: true });
  assert.equal(gov.retro, true);
  assert.equal(gov.level, MAX_LEVEL);
  assert.equal(gov.visionAllowed, false);
  assert.equal(gov.rimLightEnabled, false);
  assert.equal(gov.contactShadowsEnabled, false);
  assert.equal(gov.crackGlowEnabled, false);
  assert.equal(gov.bloomEnabled, false);
  assert.equal(gov.veilEnabled, false);
  assert.equal(gov.phenomenaFull, false);
  assert.equal(gov.brushEnabled, false);
  assert.equal(gov.heavyPostFx, false);
  assert.equal(gov.hazeLayers, 1);
  assert.equal(gov.ridgeShadingFull, false);
});

test('8-bit mode does not recover out of itself after clean frames', () => {
  // THE regression this pins. A 320x180 frame with everything shed is cheap
  // by construction, so every frame reads clean -- the ordinary recovery
  // path would climb a rung every 10s and hand back full quality within a
  // minute, silently undoing the setting the player picked.
  const gov = new PerfGovernor({ retro: true });
  let t = 0;
  for (let i = 0; i < 60 * 120; i++) { gov.sample(1000 / 60, t); t += 1000 / 60; } // 2 clean minutes
  assert.equal(gov.level, MAX_LEVEL, `recovered to ${gov.level} -- 8-bit mode leaked away`);
  assert.equal(gov.heavyPostFx, false);
});

test('8-bit mode holds the floor at a 30fps cap as well as at 60', () => {
  // At a 30fps cap the draw is skipped every other frame but rAF still
  // fires at the display's own rate, so the governor sees ~16.7ms deltas at
  // 60Hz and ~33.3ms ones if the display itself is 30Hz. Neither may move it.
  for (const deltaMs of [1000 / 60, 1000 / 30]) {
    const gov = new PerfGovernor({ retro: true });
    let t = 0;
    for (let i = 0; i < 60 * 60; i++) { gov.sample(deltaMs, t); t += deltaMs; }
    assert.equal(gov.level, MAX_LEVEL, `moved off the floor at ${(1000 / deltaMs).toFixed(0)}fps`);
  }
});

test('8-bit mode buys draw calls too, below what the ladder alone reaches', () => {
  const laddered = new PerfGovernor({ startLevel: MAX_LEVEL });
  const retro = new PerfGovernor({ retro: true });
  assert.ok(
    retro.particleMul < laddered.particleMul,
    `retro particleMul ${retro.particleMul} should undercut the ladder's ${laddered.particleMul}`,
  );
  assert.ok(retro.particleMul > 0, 'particles thinned, not switched off entirely');
  assert.ok(
    retro.danceColumnWidth >= laddered.danceColumnWidth,
    'wider dance columns mean fewer per-ridge blit calls',
  );
  // _drawDancingStrip slices a 2048px strip into columns of this width; a
  // width that does not divide it evenly leaves a ragged column per tile.
  assert.equal(2048 % retro.danceColumnWidth, 0);
});

test('leaving 8-bit mode hands the ladder back, rather than staying pinned', () => {
  const gov = new PerfGovernor({ retro: true });
  let t = 0;
  for (let i = 0; i < 100; i++) { gov.sample(1000 / 60, t); t += 1000 / 60; }
  assert.equal(gov.level, MAX_LEVEL);

  gov.retro = false;
  assert.equal(gov.retro, false);
  assert.equal(gov.particleMul, 0.6, 'back on the ladder\'s own particle rung');
  // And it can now climb back out on clean frames like any other run.
  for (let i = 0; i < 60 * 30; i++) { gov.sample(1000 / 60, t); t += 1000 / 60; }
  assert.ok(gov.level < MAX_LEVEL, `stayed pinned at ${gov.level} after leaving retro`);
});

test('entering 8-bit mode mid-song drops straight to the floor from any level', () => {
  const gov = new PerfGovernor({ startLevel: 0 });
  assert.equal(gov.heavyPostFx, true);
  gov.retro = true;
  assert.equal(gov.level, MAX_LEVEL);
  assert.equal(gov.heavyPostFx, false);
  assert.equal(gov.phenomenaFull, false);
});

test('a warm-up grace does not let 8-bit mode drift off the floor', () => {
  // beginWarmup() makes sample() return early; the retro pin must not
  // depend on sample() running at all.
  const gov = new PerfGovernor({ retro: true });
  gov.beginWarmup(0);
  for (let i = 0; i < 200; i++) gov.sample(500, i * 12); // catastrophic frames, inside warm-up
  assert.equal(gov.level, MAX_LEVEL);
  assert.equal(gov.retro, true);
});

// ── 8-bit intensive (StagePresets.PALETTE_PRESET) ──────────────────
//
// The palette pass is the one thing in this file that ADDS work rather than
// shedding it, so it is deliberately not a rung: it is a flag that only
// holds while the retro floor does.

test('the palette pass rides on the retro floor and never runs without it', () => {
  const intensive = new PerfGovernor({ retro: true, retroPalette: true });
  assert.equal(intensive.retro, true);
  assert.equal(intensive.retroPalette, true);
  assert.equal(intensive.level, MAX_LEVEL, 'intensive still sheds everything the cheap mode does');

  // Asking for the palette without the floor would quantize a full-size
  // frame -- many times the cost of everything else in it.
  const paletteOnly = new PerfGovernor({ retro: false, retroPalette: true });
  assert.equal(paletteOnly.retroPalette, false);
  assert.equal(paletteOnly.level, 0, 'and it must not silently pin the ladder either');
});

test('plain 8-bit does not quietly get the palette pass', () => {
  const plain = new PerfGovernor({ retro: true });
  assert.equal(plain.retro, true);
  assert.equal(plain.retroPalette, false);
});

test('leaving retro drops the palette pass with it', () => {
  const gov = new PerfGovernor({ retro: true, retroPalette: true });
  gov.retro = false;
  assert.equal(gov.retroPalette, false, 'a full-resolution frame must never stay quantized');
  // And it cannot be switched back on while the floor is off.
  gov.retroPalette = true;
  assert.equal(gov.retroPalette, false);
});

test('switching between the two 8-bit modes mid-song toggles only the palette', () => {
  const gov = new PerfGovernor({ retro: true });
  gov.retroPalette = true;
  assert.equal(gov.retroPalette, true);
  assert.equal(gov.level, MAX_LEVEL);
  gov.retroPalette = false;
  assert.equal(gov.retroPalette, false);
  assert.equal(gov.retro, true, 'the cheap floor stays put either way');
  assert.equal(gov.level, MAX_LEVEL);
});

test('the palette pass does not disturb the pin: intensive still never recovers', () => {
  const gov = new PerfGovernor({ retro: true, retroPalette: true });
  let t = 0;
  for (let i = 0; i < 60 * 120; i++) { gov.sample(1000 / 60, t); t += 1000 / 60; }
  assert.equal(gov.level, MAX_LEVEL);
  assert.equal(gov.retroPalette, true);
});

// --- The ladder must not oscillate.
//
// Recovery used to be unconditional: ten clean seconds bought a rung back,
// every time, at the same price. On a machine that genuinely cannot afford
// the rung below, that makes the ladder an oscillator -- shed to something
// playable, bank ten clean seconds, climb back into the rung that was
// drowning it, collapse, shed again. The reported shape was "60fps for a few
// seconds then 1 or 2fps for a few seconds", on repeat.

test('the first descent through a rung is not held against it', () => {
  const gov = new PerfGovernor();
  let t = feedFrames(gov, 60, 20, 0);
  assert.equal(gov.level, 1, 'shed once');
  assert.equal(
    gov.recoverWindowMsFor(0), 10000,
    'a cold machine, a load hitch or another program taking the CPU is not evidence '
    + 'that a rung is unaffordable -- the ordinary ten-second recovery must be unchanged',
  );
  feedFrames(gov, 700, 5, t, 16.6); // ~11.6s clean
  assert.equal(gov.level, 0, 'and it recovers on the usual schedule');
});

test('falling back out of a rung it had climbed into doubles the price of trying again', () => {
  const gov = new PerfGovernor();
  let t = feedFrames(gov, 60, 20, 0);          // 0 -> 1
  t = feedFrames(gov, 700, 5, t, 16.6);        // recover 1 -> 0
  assert.equal(gov.level, 0);
  assert.equal(gov.recoverWindowMsFor(0), 10000, 'not yet failed at level 0');

  t = feedFrames(gov, 60, 20, t);              // fall back out of 0
  assert.equal(gov.level, 1);
  assert.equal(gov.recoverWindowMsFor(0), 20000, 'that attempt failed, so the next costs twice as long');

  // Ten clean seconds no longer buys it back.
  t = feedFrames(gov, 660, 5, t, 16.6);        // ~11s clean
  assert.equal(gov.level, 1, 'the old ten-second window must no longer be enough');
  feedFrames(gov, 700, 5, t, 16.6);            // past 20s total
  assert.equal(gov.level, 0, 'but a long enough clean run still earns it back');
});

test('the backoff compounds, so a rung that never holds stops being retried', () => {
  const gov = new PerfGovernor();
  let t = feedFrames(gov, 60, 20, 0);
  const windows = [];
  for (let round = 0; round < 4; round++) {
    // A clean run long enough to climb back in, however long that has become.
    const need = gov.recoverWindowMsFor(gov.level - 1);
    t = feedFrames(gov, Math.ceil(need / 16.6) + 40, 5, t, 16.6);
    assert.equal(gov.level, 0, `round ${round}: should have recovered`);
    windows.push(gov.recoverWindowMsFor(0));
    t = feedFrames(gov, 60, 20, t); // and fall straight back out
    assert.equal(gov.level, 1);
  }
  assert.deepEqual(windows, [10000, 20000, 40000, 80000],
    'each failed attempt doubles the clean run required before the next one');
});

test('the backoff is capped, and 8-bit mode clears the history', () => {
  const gov = new PerfGovernor();
  for (let i = 0; i < 40; i++) gov._fallbacks.set(0, i);
  assert.ok(gov.recoverWindowMsFor(0) <= 600000, 'the window must not grow without bound');
  gov._fallbacks.set(0, 3);
  gov.retro = true;
  gov.retro = false;
  assert.equal(gov.recoverWindowMsFor(0), 10000, 'switching modes starts the evidence over');
});

// --- Full-frame passes shed on backing-store size, not on draw calls.
//
// The drop motion-blur ring and the hype echo COPY the whole composed frame.
// Profiled at a 3840x2160 stage they were 23% and 9% of wall time -- together
// more than every other pass combined -- while gated on the ladder's LAST
// rung, so a 4K machine shed its vision loop, particles, rim light, bloom,
// the veil and the entire phenomena layer before reaching them.

test('at 1080p and below the full-frame passes behave exactly as they always did', () => {
  for (const w of [1280, 1920]) {
    const gov = new PerfGovernor();
    gov.canvasWidth = w;
    for (let lvl = 0; lvl < MAX_LEVEL; lvl++) {
      gov.level = lvl;
      assert.equal(gov.fullFrameFxEnabled, true, `${w}px level ${lvl}: no machine should lose an effect it was affording`);
    }
    gov.level = MAX_LEVEL;
    assert.equal(gov.fullFrameFxEnabled, false, `${w}px: still off at the last rung, as before`);
  }
});

test('a 4K stage sheds the whole-frame copies at the first rung instead of the last', () => {
  const gov = new PerfGovernor();
  gov.canvasWidth = 3840;
  assert.equal(gov.fullFrameFxEnabled, true, 'level 0 still gets them');
  gov.level = 1;
  assert.equal(gov.fullFrameFxEnabled, false, 'one rung of pressure is enough at 4K');
  assert.equal(gov.phenomenaFull, true, 'and the world-defining layers are still intact at that point');
  assert.equal(gov.particleMul, 1, 'nothing else has been shed to pay for them');
});

test('1440p sits between the two, shedding them mid-ladder', () => {
  const gov = new PerfGovernor();
  gov.canvasWidth = 2560;
  gov.level = 1;
  assert.equal(gov.fullFrameFxEnabled, true, '2560 is not past the 4K threshold');
  gov.canvasWidth = 2561;
  assert.equal(gov.fullFrameFxEnabled, false);
  const mid = new PerfGovernor();
  mid.canvasWidth = 2000;
  mid.level = 2;
  assert.equal(mid.fullFrameFxEnabled, true);
  mid.level = 3;
  assert.equal(mid.fullFrameFxEnabled, false);
});

test('8-bit mode has them off, as it has everything else off', () => {
  const gov = new PerfGovernor({ retro: true });
  gov.canvasWidth = 320;
  assert.equal(gov.fullFrameFxEnabled, false);
});

// --- The symptom, simulated end to end.
//
// "it'll be 60fps for a few seconds then drop to 1 or 2fps for a few seconds."
// That is what an oscillating ladder produces on a machine that cannot afford
// its top rung: recover, collapse, spend an age shedding, recover, collapse.
// This drives the governor with a machine of exactly that shape and measures
// how much of its runtime is spent unplayable.

/** A machine where `badLevel` and above-quality rungs cost `badMs` a frame and
 *  everything below is a comfortable 60fps. Returns the share of wall time
 *  spent in frames slower than 10fps. */
function simulateMachine(gov, { badMs = 1000, goodMs = 16.6, runMs = 600000 } = {}) {
  let t = 0;
  let badTime = 0;
  while (t < runMs) {
    // The expensive whole-frame passes are the thing this machine cannot
    // afford, so it is slow exactly while the ladder is handing them out.
    const delta = gov.fullFrameFxEnabled ? badMs : goodMs;
    if (delta > 100) badTime += delta;
    t += delta;
    gov.sample(delta, t);
  }
  return badTime / t;
}

test('a machine that cannot afford the top rung settles instead of oscillating', () => {
  const gov = new PerfGovernor();
  gov.canvasWidth = 3840;
  const badShare = simulateMachine(gov);
  // Over ten minutes it should spend a small opening stretch discovering the
  // problem and then essentially none of its runtime back in it.
  assert.ok(
    badShare < 0.05,
    `expected well under 5% of runtime unplayable, got ${(badShare * 100).toFixed(1)}%`,
  );
  assert.ok(gov.level >= 1, 'and it should be sitting below the rung it cannot afford');
});

test('the same machine under the old rules would have oscillated -- the backoff is what stops it', () => {
  // Same simulation with the backoff disabled, to show the test above is
  // measuring the fix and not something that was always true.
  const gov = new PerfGovernor();
  gov.canvasWidth = 3840;
  gov.recoverWindowMsFor = () => 10000; // the old flat window
  const badShare = simulateMachine(gov);
  assert.ok(
    badShare > 0.1,
    `the flat window should leave the machine oscillating; got ${(badShare * 100).toFixed(1)}%`,
  );
});

test('a machine that CAN afford the rung keeps it', () => {
  const gov = new PerfGovernor();
  gov.canvasWidth = 1920;
  // Never over budget: the ladder must never take anything away.
  for (let t = 0, i = 0; i < 40000; i++, t += 16.6) gov.sample(16.6, t);
  assert.equal(gov.level, 0);
  assert.equal(gov.fullFrameFxEnabled, true);
});

test('a machine that is merely a little slow still gets its rung back', () => {
  // The backoff must not punish a machine that only briefly stumbled: it
  // recovers, holds, and is never demoted again.
  const gov = new PerfGovernor();
  let t = feedFrames(gov, 60, 20, 0);
  assert.equal(gov.level, 1);
  for (let i = 0; i < 4000; i++, t += 16.6) gov.sample(16.6, t);
  assert.equal(gov.level, 0, 'a clean machine climbs all the way back');
  assert.equal(gov.recoverWindowMsFor(0), 10000, 'and pays no penalty for the one stumble');
});

test('sustained catastrophic frames shed in a few frames, not a few seconds', () => {
  const gov = new PerfGovernor();
  // ~1fps: 54x over budget. Under the plain cap this took ten frames -- ten
  // seconds of unusable output -- to buy a single rung.
  let t = 0;
  let frames = 0;
  while (gov.level === 0 && frames < 60) { gov.sample(1000, t); t += 1000; frames++; }
  assert.ok(frames <= 4, `expected a rung shed within ~3 frames at 1fps, took ${frames}`);
});

test('an isolated hitch is still capped -- one bad frame must not cascade', () => {
  const gov = new PerfGovernor();
  // A single 2-second stall surrounded by healthy frames: a tab hitch, a GC
  // pause, the OS swapping. It must not shed anything on its own.
  for (let t = 0, i = 0; i < 30; i++, t += 16.6) gov.sample(16.6, t);
  gov.sample(2000, 600);
  for (let t = 2600, i = 0; i < 30; i++, t += 16.6) gov.sample(16.6, t);
  assert.equal(gov.level, 0, 'one catastrophic frame is a hitch, not a verdict');
});

test('two isolated hitches far apart still do not escalate', () => {
  const gov = new PerfGovernor();
  let t = 0;
  for (let round = 0; round < 5; round++) {
    gov.sample(1000, t); t += 1000;
    for (let i = 0; i < 120; i++, t += 16.6) gov.sample(16.6, t);
  }
  assert.equal(gov.level, 0, 'clean frames between hitches must reset the run');
});

// --- Shedding must be monotonic in level.
//
// fullFrameFxEnabled keys off the stage width, and under Auto the LIVE width
// shrinks as the ladder sheds (resolutionScale). Keyed off that live number
// the gate is not monotonic: on a ~2880px backing store, level 1 sheds the
// whole-frame passes (2880 > 2560), then level 2's 0.85 scale drops the live
// width to ~2448, which lands in the 1921-2560 branch -- `level < 3` -- and
// switches the most expensive passes in the frame back ON as pressure rises.
// The machine collapses again and sticks a rung or two lower, having shed
// particles and lighting it never needed to lose.

test('the full-frame gate never re-enables as the ladder sheds further', () => {
  for (const targetW of [1280, 1920, 1921, 2560, 2561, 2880, 3840]) {
    const gov = new PerfGovernor();
    gov.targetCanvasWidth = targetW;
    let wasOff = false;
    for (let lvl = 0; lvl <= MAX_LEVEL; lvl++) {
      gov.level = lvl;
      // Auto shrinks the live backing store as the level rises; the gate must
      // not care, because the tier is a property of the display.
      gov.canvasWidth = Math.round(targetW * gov.resolutionScale(targetW * 9 / 16, { adaptive: true }));
      const on = gov.fullFrameFxEnabled;
      if (!on) wasOff = true;
      assert.ok(!(on && wasOff), `${targetW}px: the gate came back on at level ${lvl} after shedding`);
    }
  }
});

test('the 2880px Auto case specifically -- the one the live width got wrong', () => {
  const gov = new PerfGovernor();
  gov.targetCanvasWidth = 2880;
  gov.level = 1;
  gov.canvasWidth = 2880; // scale is still 1 at level 1
  assert.equal(gov.fullFrameFxEnabled, false, 'shed at level 1, as a >2560 stage should');
  gov.level = 2;
  gov.canvasWidth = Math.round(2880 * 0.85); // 2448 -- inside the 1921-2560 tier
  assert.equal(
    gov.fullFrameFxEnabled, false,
    'more pressure must not hand the most expensive passes back',
  );
});

test('without a target width it still works off the live one', () => {
  // Manual presets and every existing caller that never sets a target.
  const gov = new PerfGovernor();
  gov.canvasWidth = 3840;
  assert.equal(gov.fullFrameFxEnabled, true);
  gov.level = 1;
  assert.equal(gov.fullFrameFxEnabled, false);
});

// --- An explicit quality change is a new workload, not more evidence.

test('forgetRecoveryHistory clears the backoff a player has just made irrelevant', () => {
  const gov = new PerfGovernor();
  let t = feedFrames(gov, 60, 20, 0);
  t = feedFrames(gov, 700, 5, t, 16.6);   // recover
  t = feedFrames(gov, 60, 20, t);         // and fall back out
  assert.equal(gov.recoverWindowMsFor(0), 20000, 'the backoff is in force');

  // The player drops the stage resolution. Everything learned at the old one
  // is about a different amount of work.
  gov.forgetRecoveryHistory();
  assert.equal(gov.recoverWindowMsFor(0), 10000, 'the ladder starts listening again');
  feedFrames(gov, 700, 5, t, 16.6);
  assert.equal(gov.level, 0, 'and a now-affordable rung comes back on the usual schedule');
});

test('forgetRecoveryHistory does not itself change the level', () => {
  // It clears evidence, not the current state: the ladder climbs back on the
  // ordinary clean-run rule, it does not jump.
  const gov = new PerfGovernor();
  feedFrames(gov, 60, 20, 0);
  feedFrames(gov, 60, 20, 5000);
  const before = gov.level;
  gov.forgetRecoveryHistory();
  assert.equal(gov.level, before);
});

test('30 fps cap retains quality while real FrameCadence delivers its requested cadence (M5)', async () => {
  const { FrameCadence } = await import('../src/render/FrameCadence.js');
  for (const [fps, work, expected] of [[30, 20, 0], [30, 40, 6], [60, 20, 6]]) {
    const g = new PerfGovernor(), cadence = new FrameCadence();
    let previous = 0, now = 0, drawn = 0;
    for (let i = 0; i < 1200; i++) {
      if (i) g.sample(now - previous, now, { capFps: fps });
      previous = now;
      const draw = cadence.shouldDraw(now, fps);
      if (draw) drawn++;
      now += draw ? Math.ceil(work / (1000 / 60)) * (1000 / 60) : 1000 / 60;
    }
    assert.equal(g.level, expected, `${fps} fps cap with ${work}ms work`);
    if (work === 20 && fps === 30) assert.ok(Math.abs(drawn * 1000 / now - 30) < .1);
  }
});

test('governor accepts the FPS period roundtrip main.js actually passes', () => {
  const g = new PerfGovernor();
  const capFps = 1000 / (1000 / 30);
  for (let i = 0; i < 600; i++) g.sample(1000 / 30, i * 1000 / 30, { capFps });
  assert.equal(g.level, 0);
});
