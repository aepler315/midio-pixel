// Midio's stage presence (follow-up item 6): apex tricks, motion-streak
// afterimages, a landing flourish on hot combos, beat-synced idle strut,
// and a gold flash + HUD pulse at combo milestones. Layered on top of
// JumpController/TelegraphScanner rather than replacing them -- this class
// only ever *adds* to midio.leanDeg/scaleY or briefly overrides scale
// during a flourish window, so the underlying physics never changes.
import { mulberry32, clamp, smoothstep } from '../utils/math.js';
import { ModalRing } from '../render/oscillators.js';
import { kickEnv } from '../world/MountainChoreo.js';
import { visualNow } from '../core/ChoreoClock.js';

const TRICK_HANG_START = 0.35; // matches JumpController's A
const TRICK_HANG_END = 0.65;   // matches JumpController's A+B
const TRICK_VEL_THRESHOLD = 0.8;
const TRICK_COMBO_THRESHOLD = 2.0;
// Trick vocabulary, unlocked by heat (launch velocity + combo + section
// energy): everyone gets the classics; hot sections add the corkscrew and
// tuck-pop; a blazing run unlocks the 720 helicopter and the double flip.
const TRICKS_BASE = ['spin', 'backflip'];
const TRICKS_HOT = ['corkscrew', 'tuckpop'];
const TRICKS_FIRE = ['helicopter', 'doubleflip'];
const HEAT_HOT = 0.55;
const HEAT_FIRE = 0.8;
const MILESTONES = [5, 10, 20];
const FLOURISH_MS = 90;
const DANCE_MS = 800;          // milestone victory dance (grounded shimmy)
const PIROUETTE_MS = 300;      // hot clean landing: a full ground spin
const PIROUETTE_COMBO = 4;
const PIROUETTE_CHANCE = 0.35;
const FLOURISH_COMBO_THRESHOLD = 2.0;
const GOLD_FLASH_DECAY_SEC = 0.6;
const AFTERIMAGE_INTERVAL_MS = 28;
const AFTERIMAGE_COUNT = 4;
export const GOLD_AFTERIMAGE_LIFE_MS = 1000;
const GOLD_AFTERIMAGE_MAX = 6;
// Restraint pass. A "ferocity pass" had pushed the always-on grounded
// motion up until every one of these ran near its own maximum at the same
// time -- a 4.5deg stomp lean, a second-harmonic skip on top of it, a 10%
// scale dip every beat, and a 26% landing squash, all compounding on a
// character who is on the ground most of the song. Individually each was
// defensible; together they read as hyperactive rather than confident.
//
// These are the ALWAYS-ON terms, so they're the ones that pay: the strut,
// its offbeat skip, and the per-beat dip are all pulled back roughly a
// third. Event-driven punctuation (tricks, milestone dances, pirouettes)
// is deliberately left alone -- it's rare enough to stay a highlight, and
// muting it too would leave him inert instead of composed.
const STRUT_DEG = 3.0;   // was 4.5
const STOMP_DIP = 0.065; // was 0.10 -- per-beat scaleY dip
const SKIP_DEG = 1.0;    // was an inline 1.6 -- offbeat second-harmonic skip
const RECOIL_MS = 200;   // universal landing recoil: squash -> overshoot -> settle
const RECOIL_AMP = 0.19; // was 0.26 -- landing squash depth

// Calm/idle behavior (follow-up item 3): distinctly relaxed vs. energetic
// sections, but never inert. Gated to !airborne so it never fights a trick.
const BREATH_HZ = 0.25;
const BREATH_AMP = 0.02;
const CALM_SWAY_DEG = 3.0;
const CALM_DRIFT_PX = 3.0;
const CALM_DRIFT_HZ = 0.2;
const BLINK_MIN_GAP_MS = 2500;
const BLINK_JITTER_MS = 3000;
const BLINK_DUR_MS = 180;
const BLINK_CALM_THRESHOLD = 0.3;

export class MidioPerformer {
  constructor(seed = 4242) {
    this.rand = mulberry32(seed);
    this._lastTrickType = null;
    this.trick = null; // {type, jumpStartMs, D}
    this._wasAirborne = false;
    this.spinDeg = 0;

    this._flourishUntilMs = -Infinity;

    this._lastMilestoneIdx = -1;
    this.milestoneFlash = false; // one-shot per step
    this.goldFlash = 0;
    this.lastMilestone = null; // {idx, atMs} -- persists for the meteor volley

    this.afterimages = [];
    this._lastCaptureMs = -Infinity;

    // Apotheosis-only: one gold snapshot per kick while transformed, held
    // regardless of airborne state (unlike the trick-jump streaks above).
    this.goldAfterimages = [];

    this.blinkScale = 1; // 1 = eye open, 0 = fully closed
    this._nextBlinkMs = BLINK_MIN_GAP_MS + this.rand() * BLINK_JITTER_MS;
    this._blinkStartMs = -Infinity;

    // Modal body vibration: struck on landings (scaled by impact intensity)
    // and lightly on takeoff, rung down over ~half a second. The Renderer
    // displaces MIDIO_BODY's rim through this field.
    this.modal = new ModalRing({ modes: 4, baseHz: 8, decaySec: 0.55, seed: (seed ^ 0x9e37) >>> 0 });

    this.beatFlash = 0; // additive mesh ignition on every kick -- closed-form kickEnv, see update()
    this._kickTMs = -Infinity; // the latest AUDIBLE kick's onset (ChoreoClock anchoring)
    // Kicks not yet heard: on high-latency outputs (Bluetooth) a new kick
    // can arrive on the song clock before the previous one reaches the ear.
    // Overwriting the anchor directly would keep it perpetually in the
    // future and the flash would never light -- so onsets queue here and
    // update() promotes each to the anchor at its own heard moment.
    this._kickPending = [];
    this.visualLagMs = 0;      // output-latency compensation, set by Simulation each step
    this.holdGlow = 0; // hold-slide charge glow: lights on arm, ramps with paid ticks
    this._landMs = -Infinity;

    this._danceStartMs = -Infinity;     // milestone victory shimmy (grounded)
    this._pirouetteStartMs = -Infinity; // hot clean landing: full ground spin
    this._lastJumpStartMs = -Infinity;  // landing-tie relaunches never un-air, but they are still new jumps
  }

  /** @param {number} [tMs] the kick's true musical onset; the flash is
   *  computed closed-form against it in update() so its peak lands when
   *  the ear gets the kick (ChoreoClock), not when the dispatcher did. */
  onKick(tMs) {
    if (!Number.isFinite(tMs)) return;
    this._kickPending.push(tMs);
    if (this._kickPending.length > 8) this._kickPending.shift(); // update() drains constantly; this is a stall guard
  }

  captureGoldAfterimage(midio, nowMs) {
    this.goldAfterimages.push({ y: midio.renderY, scaleX: midio.scaleX, scaleY: midio.scaleY, rot: midio.leanDeg, bornMs: nowMs });
    if (this.goldAfterimages.length > GOLD_AFTERIMAGE_MAX) this.goldAfterimages.shift();
  }

  clearFrameFlags() {
    this.milestoneFlash = false;
  }

  onLanding(nowMs, isClean, comboDisplay, intensity = 0) {
    if (isClean && comboDisplay >= FLOURISH_COMBO_THRESHOLD) this._flourishUntilMs = nowMs + FLOURISH_MS;
    // A blazing-combo clean landing sometimes sticks into a full ground
    // pirouette — 360 degrees and back to facing front, physics untouched.
    if (isClean && comboDisplay >= PIROUETTE_COMBO && this.rand() < PIROUETTE_CHANCE) {
      this._pirouetteStartMs = nowMs;
    }
    this.modal.excite(2.2 + 6 * intensity);
    this._landMs = nowMs; // every landing recoils, not just the clean ones
  }

  onStreak(streak, nowMs = 0) {
    let idx = -1;
    for (let i = 0; i < MILESTONES.length; i++) if (streak >= MILESTONES[i]) idx = i;
    if (idx > this._lastMilestoneIdx) {
      this._lastMilestoneIdx = idx;
      this.milestoneFlash = true;
      this.goldFlash = 1;
      // Persistent record (not a one-shot flag) so it can't be missed
      // between sim steps -- Simulation hands it to BiomeManager for the
      // meteor volley.
      this.lastMilestone = { idx, atMs: nowMs };
      // And a victory dance: a decaying grounded shimmy (see update()).
      this._danceStartMs = nowMs;
    }
  }

  update(nowMs, dtSec, midio, jump, comboSystem, calmLevel = 0, ensemble = null, holdState = null) {
    this.modal.update(dtSec);
    const justLaunched = jump.airborne && jump.jumpStartMs !== this._lastJumpStartMs;
    if (jump.airborne) this._lastJumpStartMs = jump.jumpStartMs;
    else this._lastJumpStartMs = -Infinity;
    if (justLaunched) {
      this.modal.excite(0.8 + 1.6 * jump.lastLaunchVel);
      const shouldTrick = jump.lastLaunchVel > TRICK_VEL_THRESHOLD || comboSystem.displayM >= TRICK_COMBO_THRESHOLD;
      if (shouldTrick) {
        // Heat decides how deep into the trick book he reaches: launch
        // velocity, combo, and section energy all feed it.
        const heat = clamp(
          jump.lastLaunchVel * 0.5 + comboSystem.displayM / 8 + (1 - calmLevel) * 0.25,
          0, 1.2,
        );
        const pool = [...TRICKS_BASE];
        if (heat > HEAT_HOT) pool.push(...TRICKS_HOT);
        if (heat > HEAT_FIRE) pool.push(...TRICKS_FIRE);
        let type = pool[Math.floor(this.rand() * pool.length)];
        if (type === this._lastTrickType) {
          type = pool[(pool.indexOf(type) + 1) % pool.length]; // never twice in a row
        }
        this.trick = { type, jumpStartMs: jump.jumpStartMs, D: jump.D };
        this._lastTrickType = type;
      } else {
        this.trick = null;
      }
    }
    this._wasAirborne = jump.airborne;
    if (!jump.airborne) this.trick = null;

    this.spinDeg = 0;
    let flipFactor = 1;
    let trickScaleX = 1;
    if (this.trick && jump.airborne) {
      const u = clamp((nowMs - this.trick.jumpStartMs) / this.trick.D, 0, 1);
      const progress = smoothstep(TRICK_HANG_START, TRICK_HANG_END, u);
      switch (this.trick.type) {
        case 'spin':
          this.spinDeg = 360 * progress;
          break;
        case 'helicopter': // the 720: two full rotations across the hang
          this.spinDeg = 720 * progress;
          break;
        case 'backflip':
          flipFactor = Math.cos(progress * Math.PI); // the 2D flip illusion
          break;
        case 'doubleflip': // two full flips, upright again before descent
          flipFactor = Math.cos(progress * 2 * Math.PI);
          break;
        case 'corkscrew': // a spin that drills: rotation + a width pinch
          this.spinDeg = 360 * progress;
          trickScaleX = 1 - 0.28 * Math.sin(progress * Math.PI * 2) ** 2;
          break;
        case 'tuckpop': // ball up mid-air, pop back open with a tilt
          {
            const tuck = Math.sin(progress * Math.PI);
            flipFactor = 1 - 0.38 * tuck;
            trickScaleX = 1 - 0.30 * tuck;
            this.spinDeg = 28 * Math.sin(progress * Math.PI * 2);
          }
          break;
        default:
          break;
      }
    }

    // Composite on top of whatever TelegraphScanner already wrote this step.
    midio.leanDeg += this.spinDeg;
    midio.scaleY *= flipFactor;
    midio.scaleX *= trickScaleX;

    if (nowMs < this._flourishUntilMs) {
      midio.scaleY = 0.65;
      midio.scaleX = 1.55;
    }

    // Milestone victory dance: a decaying grounded shimmy — lean rocking at
    // ~4 Hz with quick scale bounces on top. Additive, so the strut/recoil
    // underneath keep doing their thing.
    const danceU = (nowMs - this._danceStartMs) / DANCE_MS;
    if (!jump.airborne && danceU >= 0 && danceU < 1) {
      const decay = 1 - danceU;
      midio.leanDeg += 14 * decay * Math.sin(danceU * Math.PI * 6);
      midio.scaleY *= 1 + 0.08 * decay * Math.sin(danceU * Math.PI * 12);
    }

    // Ground pirouette: one full revolution, ending exactly front-facing.
    const pirU = (nowMs - this._pirouetteStartMs) / PIROUETTE_MS;
    if (!jump.airborne && pirU >= 0 && pirU < 1) {
      const ease = 1 - (1 - pirU) ** 3;
      midio.leanDeg += 360 * ease;
    }

    if (!jump.airborne && jump.beatPeriodMs > 0) {
      // The stomp rides the ENSEMBLE phase when one is wired: when the trio
      // locks, all three bodies hit together; when it slips, his timing
      // audibly-visibly fights the others'. Falls back to raw song phase.
      const theta = ensemble ? ensemble.phase(0) : ((nowMs % jump.beatPeriodMs) / jump.beatPeriodMs) * Math.PI * 2;
      const s = Math.sin(theta);
      const strutAmp = STRUT_DEG * (1 - 0.6 * calmLevel);
      const swayAmp = CALM_SWAY_DEG * calmLevel;
      // Second harmonic: a little offbeat skip that only shows when the
      // section is running hot — the strut turns into a groove.
      const skip = SKIP_DEG * (1 - calmLevel) * Math.sin(2 * theta + 0.6);
      midio.leanDeg += strutAmp * s * s * s + swayAmp * Math.sin(theta / 2 + 1.7) + skip;
      // The scale dip yields to the flourish window, which owns scale outright.
      if (nowMs >= this._flourishUntilMs) {
        const beatHit = Math.max(0, Math.cos(theta));
        midio.scaleY *= 1 - STOMP_DIP * (1 - calmLevel) * beatHit * beatHit * beatHit;
      }
    }

    // Universal landing recoil: a fast squash that overshoots tall and
    // settles, layered under (and yielding to) the clean-combo flourish.
    const sinceLand = nowMs - this._landMs;
    if (!jump.airborne && sinceLand >= 0 && sinceLand < RECOIL_MS && nowMs >= this._flourishUntilMs) {
      const u = sinceLand / RECOIL_MS;
      const recoil = -RECOIL_AMP * Math.exp(-3.2 * u) * Math.cos(Math.PI * 1.4 * u);
      midio.scaleY *= 1 + recoil;
      midio.scaleX *= 1 - recoil * 0.7;
    }

    if (!jump.airborne && nowMs >= this._flourishUntilMs) {
      // Slow breathing cycle + a light coasting drift, both calm-scaled.
      const tSec = nowMs / 1000;
      midio.scaleY *= 1 + BREATH_AMP * calmLevel * Math.sin(2 * Math.PI * BREATH_HZ * tSec);
      midio.y += CALM_DRIFT_PX * calmLevel * Math.sin(2 * Math.PI * CALM_DRIFT_HZ * tSec);

      if (calmLevel > BLINK_CALM_THRESHOLD && nowMs >= this._nextBlinkMs) {
        this._blinkStartMs = nowMs;
        this._nextBlinkMs = nowMs + BLINK_MIN_GAP_MS + this.rand() * BLINK_JITTER_MS;
      }
    }
    // Closed-form beat flash (ChoreoClock): the mountains' kickEnv anchored
    // on the kick's true onset, evaluated on the heard clock -- exact shape
    // at any step rate, peak aligned with the audible hit.
    const vNow = visualNow(nowMs, this.visualLagMs);
    // Promote each queued kick to the anchor at its own heard moment, so a
    // kick is never orphaned by a newer one that hasn't reached the ear yet.
    while (this._kickPending.length && this._kickPending[0] <= vNow) this._kickTMs = this._kickPending.shift();
    this.beatFlash = kickEnv(vNow - this._kickTMs);

    const sinceBlink = nowMs - this._blinkStartMs;
    this.blinkScale = sinceBlink < BLINK_DUR_MS
      ? Math.abs(sinceBlink / BLINK_DUR_MS - 0.5) * 2
      : 1;

    this.goldFlash = Math.max(0, this.goldFlash - dtSec / GOLD_FLASH_DECAY_SEC);
    while (this.goldAfterimages.length && nowMs - this.goldAfterimages[0].bornMs > GOLD_AFTERIMAGE_LIFE_MS) this.goldAfterimages.shift();

    if (jump.airborne && nowMs - this._lastCaptureMs >= AFTERIMAGE_INTERVAL_MS) {
      this._lastCaptureMs = nowMs;
      this.afterimages.push({ y: midio.renderY, scaleX: midio.scaleX, scaleY: midio.scaleY, rot: midio.leanDeg });
      if (this.afterimages.length > AFTERIMAGE_COUNT) this.afterimages.shift();
    }
    if (!jump.airborne && this.afterimages.length) this.afterimages.length = 0;

    // Hold slide: while a hold note is being ridden (grounded), the pose is
    // owned outright — a low, wide power-slide leaning back into the roll —
    // the same override precedent as the flourish window above. Written
    // last so it wins over strut/dance/recoil for the duration.
    if (holdState && holdState.active && !jump.airborne) {
      midio.scaleY = 0.62;
      midio.scaleX = 1.45;
      midio.leanDeg = -14;
      this.holdGlow = Math.min(1, 0.35 + 0.65 * holdState.chargeU);
    } else {
      this.holdGlow = Math.max(0, this.holdGlow - dtSec / 0.25);
    }
  }
}
