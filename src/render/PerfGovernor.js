// Perf-degradation ladder (spec §6.2): "under load it sheds in order: vision
// loop -> particle caps -> crack refraction -> L7 foreground veil -> biome
// crossfade quality." Sheds one rung after a sustained run of over-budget
// frames, recovers one rung after a sustained clean window — hysteresis so
// the ladder doesn't chatter around the budget line.
//
// This codebase never built the profile-blend memoization the spec's fifth
// rung ("crossfade quality 128->32 steps") would cheapen, and per-pixel
// crack refraction was likewise never implemented (§4.2.2 already marks it
// desktop-only/optional). Rather than gate fictional features, "crack
// refraction" here sheds the crack glow-tint stroke pass (the nearest real
// cost in that same draw call), and the crossfade-quality rung is folded
// into the particle rung it would otherwise duplicate.
//
// Mobile performance round: the ladder used to be reactive-only (shed after
// ~1s of visible jank, same speed regardless of how far over budget a frame
// ran) and shallow (its four rungs never touched the optional phenomena
// systems or the overlay-pass stack, the actual bulk of the frame on a
// weak GPU). Two extensions:
//  - `sample()` now weighs each over-budget frame by how far over it ran,
//    so a badly blown frame (2-3x budget) sheds a rung in a few frames
//    instead of ~60 — a barely-over-budget frame still takes ~1s, same as
//    before.
//  - Two deeper rungs (5-6) gate the optional phenomena layer and the
//    overlay-pass stack, so a device that's still over budget after the
//    original four rungs degrades to a clean core instead of stuttering.

// What sample() actually receives is the raw rAF-to-rAF delta: the frame
// PERIOD, vsync wait included -- not the time spent working inside it. So
// this threshold has to be a frame-period threshold, and the old value (15,
// described in its own comment as "16.6ms frame budget, ~15ms of it") was a
// WORK budget being compared against a period. On any 60Hz display that made
// every healthy frame ~16.67ms "over budget" and no frame ever clean: the
// accumulator reached 60 in about 54 frames, shed a rung, reset, and did it
// again -- MAX_LEVEL in roughly five seconds, on hardware that was keeping up
// perfectly, with recovery impossible because a clean frame could never
// occur. Everything gated on the deeper rungs (phenomena, the heavy overlay
// passes, the terrain's own detail) switched itself off a few seconds into
// every song on every machine.
//
// 18.5ms sits clear of a 60Hz period (16.67) plus its ordinary vsync jitter,
// and below the 20ms one bad frame is elsewhere taken to mean. Crossing it
// means the frame period slipped past ~54fps, which is a real dropped frame.
// A 120Hz display is comfortably clean. At an explicit 30 FPS cap the
// threshold follows the requested period plus this same jitter allowance.
export const FRAME_BUDGET_MS = 18.5;
const SHED_AFTER_FRAMES = 60; // ~1s sustained overage at 60fps, at exactly-at-budget severity
const SHED_WEIGHT_CAP = 6; // one catastrophic frame (tab hitch, GC pause) can't shed more than ~6 "normal" frames' worth
// ...but a RUN of them is not a hitch, it is a scene the machine cannot
// draw, and the cap was making the ladder unusably slow to react to exactly
// the case that needs it most. A frame at 1fps is ~54x over budget and still
// counted as 6, so shedding one rung took ten such frames -- ten seconds of
// unusable output -- and reaching a rung six deep would have taken a minute.
// Once the machine has produced a short run of catastrophic frames it has
// proven it is not a one-off, and the cap lifts: at 1fps the first rung then
// sheds on the third frame rather than the tenth, and the descent continues
// at that speed instead of crawling.
const CATASTROPHIC_RATIO = 4; // 4x budget = ~74ms = under 14fps
const CATASTROPHIC_RUN_TO_ESCALATE = 3;
const RECOVER_AFTER_MS = 10000; // 10 clean seconds, for a rung not yet proven unaffordable
// Recovery used to be unconditional: ten clean seconds bought a rung back,
// every time, at the same price. That is right for a machine that was
// briefly busy and wrong for one that genuinely cannot afford the rung
// below -- there, the ladder becomes an OSCILLATOR. It sheds down to
// something playable, banks ten clean seconds, climbs back into the rung
// that was drowning it, collapses, and spends however long it takes to shed
// again. At 4K that round trip measured ~10s of 60fps followed by ~10s at
// about 1fps, on repeat: "it'll be 60fps for a few seconds then drop to 1 or
// 2fps for a few seconds", which is the report this exists to answer.
//
// So each rung remembers how often the machine has fallen back out of it
// AFTER HAVING RECOVERED INTO IT, and the clean window required to try it
// again doubles per fall. The qualifier is the whole precision of this: the
// first descent through a rung is not evidence of anything -- it is a cold
// machine, or a load hitch, or another program taking the CPU for a second
// -- and penalising it would slow every ordinary recovery down for nothing.
// Coming back OUT of a rung the ladder had already climbed back into is the
// one thing that actually means "tried it, could not afford it". A machine
// that nearly affords a rung still gets it back on the second or third go;
// one that never will stops spending a tenth of its runtime proving so.
const RECOVER_BACKOFF = 2;
const RECOVER_MAX_MS = 600000; // 10 minutes -- past here, stop asking
// A clean frame used to zero the accumulator outright, so judder --
// frames alternating just above and below budget, the exact pattern that
// reads as visible stutter -- never built up the 60 units needed to shed
// a rung: every other frame wiped out the previous one's contribution.
// Decaying instead (by less than a single over-budget frame's minimum
// severity of 1) lets that alternating pattern still net-accumulate,
// while a genuinely sustained clean run still drains it to zero.
const OVER_DECAY_PER_CLEAN_FRAME = 0.5;
export const MAX_LEVEL = 6;

/** Resolve the initial shed level: a `?perf=lite|high` URL override wins;
 *  otherwise a coarse-pointer/small-viewport device heuristic starts a
 *  phone a rung down so the first second is already smooth rather than
 *  janky-then-corrected. */
export function resolvePerfStartLevel(search = '', { isCoarsePointer = false, isSmallViewport = false } = {}) {
  try {
    const raw = search || '';
    const q = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
    const p = (q.get('perf') || '').toLowerCase();
    if (p === 'lite') return 2;
    if (p === 'high') return 0;
  } catch { /* fall through to the device heuristic */ }
  return (isCoarsePointer || isSmallViewport) ? 1 : 0;
}

// Warm-up grace. Starting a song is inherently janky for a moment: two dozen
// 2048px silhouette strips get baked, shaders and fonts warm up, the first
// frames touch cold paths. None of that is steady-state overdraw, but the
// accumulator could not tell the difference -- at a catastrophic severity of
// 6 per frame it takes only ten such frames to shed a rung, so a load hitch
// alone could cascade several rungs before the scene had settled. That is
// exactly the "all the terrain detail is there for two seconds and then
// gone, permanently" report this exists to fix: everything gated on the
// deeper rungs (phenomena, the heavy overlay passes) was being switched off
// by the load, not by the frame cost of actually running.
//
// Frames inside the window still RENDER normally -- they simply do not vote
// on the shed level. Recovery is unaffected, so a machine that genuinely
// cannot afford the scene still sheds, just a moment later and on evidence
// from a settled frame rather than from its own loading screen.
export const WARMUP_MS = 2500;

// 8-bit mode's own floor, below what the ladder's own deepest rung reaches.
// The ladder is written for a machine that is trying to keep full quality
// and failing; 8-bit is a machine that was never going to manage it, whose
// player has said so. Both numbers below buy DRAW CALLS, not pixels -- at
// 320×180 rasterization is already nearly free, so per-call overhead is
// what is left to cut.
const RETRO_PARTICLE_MUL = 0.35; // vs 0.6 at the ladder's particle rung
// 128 still divides the 2048px strip evenly (16 slices/tile), which the
// dance-column blit requires -- see danceColumnWidth.
const RETRO_DANCE_COLUMN_WIDTH = 128;

export class PerfGovernor {
  constructor({ startLevel = 0, minLevel = 0, retro = false, economy = retro, retroPalette = false } = {}) {
    this._retro = !!economy;
    // "8-bit intensive": the palette pass rides on top of the retro floor,
    // never on its own -- quantizing a 4K frame would cost many times what
    // the whole rest of the frame does. Kept as its own flag rather than a
    // second level on the ladder because it is not a shed: it ADDS work, in
    // exchange for a look, which is the one thing the ladder never does.
    this._retroPalette = !!retroPalette && this._retro;
    this._holdQuality = false;
    this._heldLevel = 0;
    // Evidence fixtures pin an exact rung (setFixtureLevel). Null when off.
    this._fixtureLevel = null;
    this.minLevel = Number.isInteger(minLevel) ? Math.max(0, Math.min(MAX_LEVEL, minLevel)) : 0;
    this.level = this._retro ? MAX_LEVEL : Math.max(this.minLevel, Math.min(MAX_LEVEL, startLevel));
    this._overCount = 0;
    this._cleanSinceMs = null;
    this._warmUntilMs = null;
    this._canvasW = 1280;
    this._targetW = 0; // 0 -> fall back to the live width
    // level -> how many times the machine has shed back out of it after
    // having recovered into it. Drives the recovery backoff above.
    this._fallbacks = new Map();
    // Levels the ladder has climbed back into, so a later shed out of one
    // can be told apart from the first descent through it.
    this._recoveredInto = new Set();
    // Consecutive frames past CATASTROPHIC_RATIO, for the severity escalation.
    this._catastrophicRun = 0;
  }

  /** Discard what the ladder has learned about which rungs are affordable.
   *
   *  For an EXPLICIT quality change by the player -- picking a different
   *  stage resolution mid-song -- not for the governor's own Auto resizing.
   *  Someone who drops from 4K to 720p because the frame rate fell apart has
   *  changed the workload, and the fallback counts gathered at 4K are about a
   *  different machine's worth of work; left in place, a rung they can now
   *  easily afford could stay switched off for up to the capped recovery
   *  window, which is the opposite of what reaching for that menu is for. */
  forgetRecoveryHistory() {
    this._fallbacks.clear();
    this._recoveredInto.clear();
    this._overCount = 0;
    this._catastrophicRun = 0;
    this._cleanSinceMs = null;
  }

  /** Apply an explicit detail budget immediately, retaining automatic shedding. */
  setQualityLimit(level) {
    this.minLevel = Number.isInteger(level) ? Math.max(0, Math.min(MAX_LEVEL, level)) : 0;
    this.forgetRecoveryHistory();
    this.level = this._fixtureLevel ?? (this._holdQuality ? this._heldLevel : this._retro ? MAX_LEVEL : this.minLevel);
  }

  /** How long a clean run has to last before the ladder will try `level`
   *  again, given how many times it has already failed there. */
  recoverWindowMsFor(level) {
    const n = this._fallbacks.get(level) || 0;
    return Math.min(RECOVER_MAX_MS, RECOVER_AFTER_MS * Math.pow(RECOVER_BACKOFF, n));
  }

  /** 8-bit mode (StagePresets.RETRO_PRESET): pin the ladder at its cheapest
   *  rung and hold it there. Pinning is the whole mechanism, not a detail --
   *  every quality gate in the codebase already asks this object what it may
   *  draw, so one flag here sheds all of it without a new gate anywhere else.
   *  It also has to be a PIN rather than a one-off jump to MAX_LEVEL: a
   *  320×180 frame with everything shed is cheap by construction, so the
   *  ladder's own recovery would read ten clean seconds, climb a rung, and
   *  within a minute of smooth play put every expensive pass back on --
   *  undoing the mode the player explicitly asked for, and doing it slowly
   *  enough to look like a mystery rather than a setting. */
  // Compatibility alias for old integrations. Presentation no longer owns cost.
  get economy() { return this._retro; }
  set economy(on) { this.retro = on; }

  get retro() { return this._retro; }

  set retro(on) {
    const next = !!on;
    if (next === this._retro) return;
    this._retro = next;
    // Leaving either direction starts the ladder's evidence over: the frames
    // measured under the old mode say nothing about the new one.
    this._overCount = 0;
    this._cleanSinceMs = null;
    this._catastrophicRun = 0;
    this._fallbacks.clear();
    this._recoveredInto.clear();
    if (next && this._fixtureLevel === null) this.level = MAX_LEVEL;
    if (!next) this._retroPalette = false; // the palette pass never outlives the floor
  }

  /** Whether the composed frame should be quantized to the 256-color
   *  palette (PaletteQuantize.js). Only ever true alongside `retro`. */
  get retroPalette() { return this._retroPalette; }

  set retroPalette(on) { this._retroPalette = !!on && this._retro; }

  /** Restart the warm-up grace: call when a new song starts (or the world is
   *  rebuilt), since that is when the expensive one-off bake happens. */
  beginWarmup(nowMs) {
    this._warmUntilMs = nowMs + WARMUP_MS;
    this._overCount = 0;
    this._cleanSinceMs = null;
    this._catastrophicRun = 0;
  }

  /** Bulk export pins full quality for the whole render.
   *
   *  The ladder's evidence is frame period. An offline render's period is
   *  however long the frame took to draw, which at 2160p is the signal the
   *  ladder uses to shed the picture the file was opened to keep. Holding
   *  level 0 means every frame is the full show. */
  freezeQuality(level = this.level) {
    this._heldLevel = Math.max(0, Math.min(MAX_LEVEL, level));
    this.holdQuality = true;
  }

  get holdQuality() { return this._holdQuality; }

  set holdQuality(on) {
    this._holdQuality = !!on;
    if (this._fixtureLevel !== null) { this.level = this._fixtureLevel; return; }
    if (this._holdQuality) this.level = this._heldLevel;
  }

  /** Controlled evidence captures pin an exact rung, 0..MAX_LEVEL, which
   *  outranks export's full-quality hold and the 8-bit floor while set.
   *  `null` clears the pin and returns the level to what hold/retro/the
   *  ladder would choose. Fixtures clear it in a `finally` so a capture
   *  never leaks its rung into later playback. */
  setFixtureLevel(level) {
    if (level === null) {
      this._fixtureLevel = null;
      if (this._holdQuality) this.level = this._heldLevel;
      else if (this._retro) this.level = MAX_LEVEL;
      return;
    }
    if (!Number.isInteger(level) || level < 0 || level > MAX_LEVEL) {
      throw new RangeError(`fixture quality must be an integer 0..${MAX_LEVEL}, got ${level}`);
    }
    this._fixtureLevel = level;
    this.level = level;
  }

  get fixtureLevel() { return this._fixtureLevel; }

  /** Call once per rendered frame with the raw rAF-to-rAF delta. */
  sample(deltaMs, nowMs, { capFps = 60 } = {}) {
    const budgetMs = Math.max(FRAME_BUDGET_MS, 1000 / ([24, 30, 60].includes(Math.round(capFps)) ? Math.round(capFps) : 60) + (FRAME_BUDGET_MS - 1000 / 60));
    if (this._sampleBudgetMs !== budgetMs) {
      this._sampleBudgetMs = budgetMs;
      this.forgetRecoveryHistory();
    }
    if (this._fixtureLevel !== null) { this.level = this._fixtureLevel; return; }
    if (this._holdQuality) { this.level = this._heldLevel; return; }
    // 8-bit mode holds the floor: neither shedding (already at the bottom)
    // nor recovering (see the `retro` setter -- recovery is exactly the
    // failure mode pinning exists to prevent).
    if (this._retro) { this.level = MAX_LEVEL; return; }
    // Opt-in, not automatic: a governor that has never been told a song is
    // starting behaves exactly as it always did. Seeding this implicitly on
    // the first sample would quietly change the meaning of every existing
    // caller and test for the sake of one call site that can just say so.
    if (this._warmUntilMs !== null && nowMs < this._warmUntilMs) return;
    if (deltaMs > budgetMs) {
      const ratio = deltaMs / budgetMs;
      this._catastrophicRun = ratio > CATASTROPHIC_RATIO ? this._catastrophicRun + 1 : 0;
      // The cap protects against an isolated hitch; a sustained run of them
      // has earned the right to be believed at full weight.
      const escalated = this._catastrophicRun >= CATASTROPHIC_RUN_TO_ESCALATE;
      const severity = escalated ? ratio : Math.min(SHED_WEIGHT_CAP, ratio);
      // Clamped, because at MAX_LEVEL there is no rung left to spend it on
      // and it would otherwise pile up without limit -- a machine stuck at
      // the floor for a minute banked hundreds of units of "evidence", and
      // if it later recovered a rung, the very next over-budget frame would
      // cash that stale total in and shed again immediately. Evidence is for
      // the rung it was gathered at.
      this._overCount = Math.min(SHED_AFTER_FRAMES, this._overCount + severity);
      this._cleanSinceMs = null;
      if (this._overCount >= SHED_AFTER_FRAMES && this.level < MAX_LEVEL) {
        // Only a rung the ladder had CLIMBED BACK INTO counts as a failed
        // attempt: the first descent is a cold machine, not a verdict.
        if (this._recoveredInto.has(this.level)) {
          this._fallbacks.set(this.level, (this._fallbacks.get(this.level) || 0) + 1);
          this._recoveredInto.delete(this.level);
        }
        this.level++;
        this._overCount = 0;
        this._catastrophicRun = 0;
      }
    } else {
      this._catastrophicRun = 0;
      this._overCount = Math.max(0, this._overCount - OVER_DECAY_PER_CLEAN_FRAME);
      if (this._cleanSinceMs === null) this._cleanSinceMs = nowMs;
      else if (this.level > this.minLevel && nowMs - this._cleanSinceMs >= this.recoverWindowMsFor(this.level - 1)) {
        this.level--;
        this._recoveredInto.add(this.level);
        this._overCount = 0; // fresh evidence for the rung just entered
        this._cleanSinceMs = nowMs;
      }
    }
  }

  // Ridge resolution. _drawDancingStrip blits the silhouette in vertical
  // slices, each at its own offset and scale, so the slice width IS the
  // sampling resolution of the dance: neighbouring slices differ by the
  // offset curve's slope times the width, and that difference is a hard
  // vertical step in the skyline. At 64px those steps terrace the mountains
  // visibly -- reported as the ridges looking low-resolution, which is
  // exactly what they were.
  //
  // Total pixels blitted is IDENTICAL at any width -- same strip, same area,
  // just sliced finer -- so the cost of narrowing is per-drawImage-call
  // overhead, not rasterization. That makes it a good ladder rung: spend the
  // calls on a machine that has them, keep the old width on one that does
  // not. Same rung as the rim light, which is the other thing that makes an
  // edge read as sharp.
  //
  // Must divide the 2048px strip width evenly. A width that does not (20 was
  // tried) leaves a ragged narrow column at the end of every tile, carrying
  // its own offset -- a discontinuity reintroduced once per tile, which is
  // the opposite of the point. Powers of two only.
  get danceColumnWidth() {
    if (this._retro) return RETRO_DANCE_COLUMN_WIDTH;
    const base = this.level < 1 ? 16 : this.level < 3 ? 32 : 64;
    return this._canvasW > 2560 ? Math.min(128, base * 2) : base;
  }

  /** Tell the governor the current backing-store width so resolution-aware
   *  quality gates (danceColumnWidth) can adapt. This is the LIVE width,
   *  after Auto's own resolution scaling. */
  set canvasWidth(w) { this._canvasW = w; }

  /** The width the stage would use at full quality -- the preset/display
   *  ceiling, before resolutionScale shrinks it under pressure.
   *
   *  fullFrameFxEnabled has to read this rather than the live width, or it
   *  is not monotonic in level. On Auto with a ~2880px backing store: level
   *  1 sheds the whole-frame passes (2880 > 2560), then level 2 applies the
   *  0.85 resolution scale, the live width drops to ~2448, and the gate
   *  lands in the 1921-2560 branch -- which is `level < 3`, so the most
   *  expensive passes in the frame switch back ON as pressure increases.
   *  The machine then collapses again at level 2 and sticks around level 3,
   *  having shed particles and lighting it never needed to lose. The tier
   *  is a property of the display, not of how hard the ladder is currently
   *  squeezing, so it reads the unscaled target. */
  set targetCanvasWidth(w) { this._targetW = w; }

  get visionAllowed() { return this.level < 1; }
  get particleMul() {
    if (this._retro) return RETRO_PARTICLE_MUL;
    return this.level >= 2 ? 0.6 : 1;
  }
  // Movement VII: the celestial-light passes join the same ladder -- rim
  // light is the pricier per-edge work so it sheds at the particle-cap
  // rung; contact shadows shed alongside crack glow, one rung later.
  get rimLightEnabled() { return this.level < 2; }
  get contactShadowsEnabled() { return this.level < 3; }
  get crackGlowEnabled() { return this.level < 3; }
  // Bloom (music-reactive post-pass, see Renderer._drawBloom): a few
  // downsampled offscreen draws plus one full-frame additive blit -- real
  // but modest cost, shed at the same rung as crack-glow.
  get bloomEnabled() { return this.level < 3; }
  get veilEnabled() { return this.level < 4; }
  // Deeper rungs: the optional phenomena layer (ReactionDiffusion ground
  // texture, CymaticField, Murmuration, SkyEnsemble planets, FarVignettes,
  // MeteorShower) -- all genuinely optional atmosphere, none of it gameplay.
  get phenomenaFull() { return this.level < 5; }
  // The constellation weaver (ambient connect-the-dots, lyric-derived
  // glyphs, crystallized stars) is a few thin 1-3px strokes -- nothing like
  // the pixel-pass cost of ReactionDiffusion or the other rung-5 phenomena.
  // Shedding it with them is how The Range's sky went dark: a machine under
  // load that already lost the heavy atmosphere at rung 5 would then lose
  // the constellations and lyric glyphs too, reading as "the sky's details
  // vanished," not "perf dropped one rung." The weaver holds out to the last
  // rung (with hazeLayers/heavyPostFx/ridgeShadingFull) -- as light as it is,
  // it is never the thing drowning the frame.
  get constellationsEnabled() { return this.level < 6; }
  // RainbowBrush: up to 320 additive dabs redrawn every frame, purely
  // cosmetic trail decoration -- widened spacing via particleMul but never
  // actually gated by a rung. Sheds alongside the other optional atmosphere.
  get brushEnabled() { return this.level < 5; }
  // Collapse the three depth-haze layers to one once still over budget past
  // the phenomena cut.
  get hazeLayers() { return this.level < 6 ? 3 : 1; }
  // The heaviest overlay passes: film-grade wash + vignette, and the hype
  // frame's echo self-blit.
  get heavyPostFx() { return this.level < 6; }

  /** The passes that COPY or RE-BLIT the whole composed frame: the drop
   *  motion-blur ring and the hype frame's echo.
   *
   *  Everything else on this ladder sheds DRAW CALLS, whose cost is roughly
   *  independent of the backing store. These two scale with its pixel count
   *  instead, and they sat on the last rung -- so a 4K stage had to shed its
   *  vision loop, particles, rim light, contact shadows, bloom, the veil,
   *  the whole phenomena layer and two of three haze layers before reaching
   *  the pass that was actually drowning it. Profiled at a 3840x2160 stage,
   *  the motion-blur ring alone was 23% of wall time and the hype echo 9% --
   *  together more than every other pass in the frame combined, while
   *  everything that had already been shed to make room for them cost
   *  fractions of a percent each.
   *
   *  So at a large backing store they shed FIRST rather than last. At 1080p
   *  and below this answers exactly what it always did, so no existing
   *  machine loses an effect it was affording. */
  get fullFrameFxEnabled() {
    if (!this.heavyPostFx) return false; // never outlive the rung they used to sit on
    // The unscaled target, so the tier cannot move under the ladder's own
    // feet -- see targetCanvasWidth.
    const tierW = this._targetW || this._canvasW;
    if (tierW > 2560) return this.level < 1;
    if (tierW > 1920) return this.level < 3;
    return true;
  }
  // Ridge-volume shading (_drawRidgeVolume): up to three clipped gradient
  // fills per range layer, every frame, with no rung of its own -- unlike
  // everything else on this ladder it was never gated at all, so a device
  // still over budget at MAX_LEVEL had no lever left to pull for it. Its
  // own crest/column geometry (_crestPoints) already sheds via
  // danceColumnWidth above, so this only needs to cover what THAT doesn't:
  // the shading fills themselves. Full at every rung above MAX_LEVEL's own
  // "clean core" cut, same tier as hazeLayers/heavyPostFx -- ridge shading
  // is core content ("the range's ONLY source of shading depth", see
  // _drawRidgeVolume's own comment), not optional atmosphere, so it holds
  // out to the very last rung rather than shedding early. Even then it
  // isn't switched off outright: _drawRidgeVolume keeps its catchlight pass
  // regardless (a flat, uncontrasted silhouette was the original bug this
  // system exists to fix) and reads this flag only to drop the shade and
  // aerial-perspective passes, the two more expensive extra fills.
  get ridgeShadingFull() { return this.level < 6; }

  /** Resolution scale for Auto mode. Manual presets are promises and stay
   *  fixed; Auto progressively buys pixels before level 5 removes the
   *  world-defining phenomena layer. Landscape's hybrid output applies it
   *  (fitCanvas -> RenderOutputSize.stageOutputSize, in whole terrain
   *  cells); the pixel grid itself never changes. */
  resolutionScale(_presetH, { adaptive = false } = {}) {
    if (!adaptive) return 1;
    if (this.level >= 4) return 0.625;
    if (this.level >= 3) return 0.75;
    if (this.level >= 2) return 0.85;
    return 1;
  }
}
