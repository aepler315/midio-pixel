// The three-phase apex jump curve (spec §2.1) — launch (quadratic ease-out),
// apex hang (sin^2 wobble, C1-continuous into/out of the hang), fall
// (quadratic ease-in, accelerating/heavy). Kick-quantized takeoffs with
// mid-air retargeting so a new kick always lands Midio back on the grid.
import { clamp, clamp01 } from '../utils/math.js';

// Player beat-anchor (BeatAnchor.js): below this confidence the anchor is
// treated as absent everywhere it's consulted (JumpController, EnsembleDirector).
const ANCHOR_MIN_CONFIDENCE = 0.05;

// Jump-curve shape (fractions of the total duration D; A+B+GAMMA = 1 so the
// arc lands exactly at u=1). Tuned for a tighter, more satisfying timing:
// a snappier launch, a longer/more readable float at the apex (so the peak
// visibly hangs on the beat), and a crisper drop into the landing. The
// offline replicas (JumpPlanner/NoteChart) import these, so they stay in
// lockstep automatically, and a longer/higher hang only ever widens the
// obstacle-clearance window (re-verified by obstacleSafety.test).
//
// LAUNCH was cut further (0.32 -> 0.12, the freed 0.20 folded into HANG)
// to close a real "video is late" gap: onKick() fires the launch reactively,
// exactly at the kick's own tMs (no anticipation -- see _launchOrRetarget),
// which is the correct trigger for a takeoff that has to start from the
// ground. But at the OLD 0.32, Midio didn't visibly reach the swell/peak
// that reads as "the hit" until 32% of D after that kick -- ~120-190ms for
// the common D range, squarely in "I heard it before I saw it" territory.
// This is worst on sparse/rubato tracks (JumpController falls back to a raw
// ground launch on nearly every beat there instead of the continuous
// mid-air retargeting a dense, steady song keeps him in), but it's the same
// arc everywhere, so every fresh ground launch reads snappier now.
// Provably no less safe for obstacle clearance: A+B is unchanged (still
// 1-GAMMA), so the FALL phase and the landing instant are byte-identical to
// before -- only how the SAME total rise budget (launch+hang) is split
// changes. And a quadratic ease-out that reaches the same height Ha in a
// SHORTER launch fraction is >= the old curve at every instant along the
// way (reaches Ha sooner, then holds at/above Ha through hang while the old
// curve was still ramping up to it) -- so this can only clear an obstacle
// the old timing cleared EARLIER, never later.
export const A = 0.12;   // LAUNCH fraction -- reaches the peak close to the kick, not a third of D later
export const B = 0.56;   // APEX HANG fraction -- absorbs what LAUNCH gave up
export const GAMMA = 0.32; // FALL fraction -- crisper drop, unchanged
export const W = 0.08;   // apex headroom fraction

export function jumpY(u, H) {
  const Ha = (1 - W) * H;
  if (u < A) {
    const p = u / A;
    return Ha * (1 - (1 - p) * (1 - p));
  }
  if (u < A + B) {
    const q = (u - A) / B;
    const s = Math.sin(Math.PI * q);
    return Ha + W * H * s * s;
  }
  const r = clamp((u - A - B) / GAMMA, 0, 1);
  return Ha * (1 - r * r);
}

export const H_BASE = 190; // px -- the bigger stage (Midio.groundY moved from 480 to 540)
export const D_MIN = 380, D_MAX = 1200; // ms
export const RETARGET_FALL_MS = 120;
const HIGH_BPM_HALFTIME = 170;
// A jump's landing lands ON the next audible kick whenever one falls in
// range, rather than merely on the beat-period EMA -- the EMA is only ever
// right for perfectly steady four-on-the-floor; any syncopation, fill, or
// tempo drift used to land him off-beat "usually", with the EMA
// coincidentally matching the true next gap only "occasionally" (spec: the
// exact "sometimes outstanding, usually weird" symptom). The chart's kick
// list is known in advance (or, live, the next kick has already sounded/
// been scheduled), so there's no reason to guess when the real target is
// sitting right there. Below this floor a "next kick" is really the same
// hit (layered/duplicate onsets) or one the existing airborne/retarget
// logic already owns -- not a fresh landing target.
export const LANDING_MIN_GAP_MS = 200;

// Now that D is routinely chosen to land EXACTLY on the next kick, a kick
// arriving right at an arc's nominal touchdown is the COMMON case, not a
// freak coincidence -- and which side of "still airborne" it falls on
// decides whether that beat gets a jump or gets swallowed. The shared rule,
// in both the live controller and the offline replicas (JumpPlanner,
// NoteChart): a kick within this tolerance of the scheduled landing IS the
// landing -- resolve the touchdown and relaunch ON that kick. The
// tolerance is a hair over one 120Hz sim step because that's the real slop
// between the replicas' exact math and the live controller's fixed-step
// landing/compress resolution.
export const LANDING_QUANT_EPS_MS = 10;

/**
 * Whether a mid-air retarget may engage at `nowMs` for the current arc
 * (launched at `jumpStartMs`, duration `D`): only when that arc isn't
 * already about to land on its OWN correctly-scheduled kick within
 * RETARGET_FALL_MS. Before double-step hops (D can now go below D_MIN),
 * the retarget window (u in [A+B, A+B+0.3*GAMMA)) could never start earlier
 * than ~247ms into an arc -- safely past LANDING_MIN_GAP_MS (200ms), the
 * floor every other kick-consumption path in this file uses to recognize a
 * near-duplicate onset. A short (<D_MIN) arc's retarget window can now
 * start well under that floor: a near-duplicate kick the dedupe rule would
 * otherwise ignore can land inside r<0.3 and hijack the schedule with a
 * fixed-length compress -- which then SWALLOWS the real target kick if it
 * arrives mid-compress (every branch is gated behind !this.compress),
 * leaving Midio visibly airborne through the beat that was supposed to be
 * his landing. Requiring the arc's own landing to still be comfortably
 * ahead keeps a short hop's own honest touchdown from ever being preempted.
 */
export function canRetarget(nowMs, jumpStartMs, D) {
  const remainingToOwnLanding = jumpStartMs + D - nowMs;
  return remainingToOwnLanding > RETARGET_FALL_MS;
}

/**
 * The jump duration for a launch at `takeoffMs`: exactly the gap to
 * `nextKickMs` when that gap is a plausible landing target (beyond the
 * dedupe floor, within a sane upper bound so a long silence doesn't stretch
 * one jump for seconds), clamped to [D_MIN, D_MAX] same as always; the
 * beat-period EMA otherwise (no known/plausible next kick -- silence, the
 * song's tail, or a target so far out it should be treated as a rest, not
 * chased). Pure and shared by every replica that must schedule the same
 * jump the same way: JumpPlanner.predictJumpArcs (obstacle placement),
 * NoteChart.replayTakeoffTriggers (the tap chart), and this class's own
 * live launch/retarget (see test/jumpPlanner.test.js's lockstep check).
 */
/**
 * @param {object|null} [anchor] the player's BeatAnchor (see BeatAnchor.js),
 *   optional and `null` by default so every existing caller -- the offline
 *   replicas (JumpPlanner, NoteChart) and every internal call site that
 *   doesn't pass one -- schedules byte-identically to before. When passed
 *   and confident, the grid this function reasons about shifts from
 *   "multiples of the song's beat-period EMA, anchored at THIS takeoff" to
 *   "the anchor's own absolute grid (anchorMs + k*periodMs)" -- the whole
 *   point of a player-felt beat anchor.
 */
export function scheduledJumpD(takeoffMs, nextKickMs, beatPeriodMs, anchor = null) {
  const anchorConf = anchor ? clamp01(anchor.confidence) : 0;
  const anchorLive = anchor != null && anchorConf > ANCHOR_MIN_CONFIDENCE;

  if (!anchorLive) {
    // Land ON the next real, plausible kick -- including a syncopated one
    // that doesn't sit on a clean beat multiple of the takeoff. An earlier
    // version of this branch preferred the beat grid over an off-grid kick
    // (to avoid chasing every onset on dense drums), but that silently
    // broke the double-step feature this file documents at length: a
    // syncopated back-to-back pair like [1224, 1901] landed on a
    // beat-period guess (~1641) instead of the real 1901 kick -- the exact
    // "sails past the kick into musical no-man's-land" bug the double-step
    // work fixed. See test/jumpScheduling.test.js for the covered cases.
    const beat = Math.max(1, beatPeriodMs);
    const gridD = clamp(beat, D_MIN, D_MAX);
    const gap = nextKickMs != null ? nextKickMs - takeoffMs : NaN;
    if (!(gap >= LANDING_MIN_GAP_MS && gap <= 2000)) return gridD;

    // Short double-step: land on the nearby kick even below D_MIN (low hop).
    if (gap < D_MIN) return Math.min(gap, D_MAX);

    return Math.min(gap, D_MAX);
  }

  // Anchor-aware: blend the working beat toward the anchor's own period by
  // confidence, and land on the anchor's own absolute grid point rather
  // than the chart's -- so a landing genuinely lines up with where the
  // player is tapping, not just wherever this takeoff happened to fall.
  const beat = Math.max(1, beatPeriodMs * (1 - anchorConf) + anchor.periodMs * anchorConf);
  const gridD = clamp(anchor.nextGridMs(takeoffMs) - takeoffMs, D_MIN, D_MAX);
  const gap = nextKickMs != null ? nextKickMs - takeoffMs : NaN;
  if (!(gap >= LANDING_MIN_GAP_MS && gap <= 2000)) return gridD;

  if (gap < D_MIN) return Math.min(gap, D_MAX);

  const kickMs = takeoffMs + gap;
  const nearestGridMs = anchor.anchorMs + Math.round((kickMs - anchor.anchorMs) / beat) * beat;
  if (Math.abs(kickMs - nearestGridMs) <= Math.max(70, beat * 0.18)) {
    return Math.min(Math.max(gap, LANDING_MIN_GAP_MS), D_MAX);
  }
  return gridD;
}

/**
 * How tall a jump of duration D stands, relative to a full jump: 1 for any
 * normal-length arc, shrinking quadratically below D_MIN so the double-step
 * hop between two back-to-back kicks is a quick LOW skip rather than a
 * full-height jump crammed into 220ms (which would read as a violent
 * teleport -- and quadratic keeps the landing velocity 2*Ha/(GAMMA*D)
 * scaling LINEARLY down with D, so short hops also land gently).
 */
export function shortHopHeightMul(D) {
  return D >= D_MIN ? 1 : (D / D_MIN) ** 2;
}

// Height tiers (§ jump feel): a jump's DURATION is tightly beat-quantized
// (scheduledJumpD always lands on the next real kick), but height used to
// be a raw, continuous function of each note's own MIDI velocity with zero
// smoothing between consecutive jumps -- two notes at vel 0.58 and 0.63
// produced two visibly different jumps back to back, even though the timing
// underneath was rock-solid. That asymmetry (disciplined rhythm, jittery
// height) is what reads as "random" rather than "on the beat": the ear says
// steady, the eye sees noise. Four tiers -- quiet/normal/strong/accent --
// give height the same discipline timing already has, while still letting
// a genuinely harder hit read as a bigger jump (never smaller: floors are
// ascending, so accent-boosted velocity can only round UP a tier, matching
// the "clearance only ever improves" guarantee at the call site).
const VEL_TIERS = [
  { floor: 0.00, value: 0.30 },
  { floor: 0.40, value: 0.55 },
  { floor: 0.65, value: 0.80 },
  { floor: 0.85, value: 1.00 },
];

/** Snaps a raw 0..1 velocity to the highest tier whose floor it clears. */
export function quantizeJumpVel(vel) {
  let out = VEL_TIERS[0].value;
  for (const tier of VEL_TIERS) {
    if (vel >= tier.floor) out = tier.value;
    else break;
  }
  return out;
}

/**
 * The first entry in the ascending `kickTimes` (forward-scanned from
 * `fromIdx`) far enough past `takeoffMs` to be a plausible landing target
 * -- or null if none qualifies. A kick closer than LANDING_MIN_GAP_MS is a
 * duplicate/layered onset (or one the airborne/retarget rules already
 * own), not a fresh landing; skip past it rather than giving up on
 * scheduling entirely. Shared so every replica that walks the same kick
 * list agrees on which kick a given takeoff should land on.
 */
export function nextLandingKickMs(kickTimes, takeoffMs, fromIdx = 0) {
  for (let i = fromIdx; i < kickTimes.length; i++) {
    if (kickTimes[i] - takeoffMs >= LANDING_MIN_GAP_MS) return kickTimes[i];
  }
  return null;
}

export class JumpController {
  constructor(paramBus, { hBase = H_BASE } = {}) {
    this.P = paramBus;
    this.hBase = hBase;

    this.state = 'GROUND'; // 'GROUND' | 'AIR'
    this.jumpStartMs = 0;
    this.D = 500;
    this.H = 100;
    this.y = 0; // px above ground, >=0
    this.lastLaunchVel = 0.7; // velocity of the kick that started the current/most recent jump

    this.lastKickMs = null;
    this.beatPeriodMs = 500;
    this.kickCount = 0;

    // Landing-on-the-next-kick (see scheduledJumpD/nextLandingKickMs above):
    // the full raw kick-time list (same one JumpPlanner/NoteChart replay),
    // set once via setKickTimes. _kickIdx is a monotonic cursor tracking
    // "where the CURRENT triggering kick sits in that list" -- advanced
    // every onKick/onPlayerTap in the same forward-only order those already
    // arrive in, so searching "the next kick after this one" is O(1)
    // amortized and always agrees with the offline replicas' own index walk.
    // Left empty by default: any caller that never wires this up (tests,
    // fixtures) gets exactly the old EMA-only behavior.
    this._kickTimes = [];
    this._kickIdx = 0;

    // The player's beat anchor (BeatAnchor.js), set once per step by
    // Simulation via setAnchor. Null (the default) reproduces today's
    // chart-only scheduling exactly -- see scheduledJumpD's anchor param.
    this._anchor = null;

    this.compress = null;      // {startMs, fromY, dur} — mid-air retarget in progress
    this._pendingLaunch = null;

    /** Set for exactly one sim step on landing; consumed by ComboSystem/ImpactFX. */
    this.pendingLanding = null;
    /** Set for one step when a kick is skipped (half-time) — routes to landing FX instead. */
    this.pendingGhostKick = null;
    /** Set for one step when an air jump fires — {y, index, isFlourish} for FX. */
    this.pendingAirJump = null;
  }

  get bpm() { return 60000 / this.beatPeriodMs; }

  /** Wire in (or clear, with null) the player's beat anchor. */
  setAnchor(anchor) {
    this._anchor = anchor || null;
  }

  /** The full raw kick-time list (sorted ascending, every RHYTHM kick --
   *  same source ObstacleSpawner/NoteChart feed JumpPlanner/replayTakeoff-
   *  Triggers), so landings can be scheduled onto whichever of them is
   *  next rather than only ever guessed from the beat-period EMA. */
  /** The chart's kick onsets, ascending. Read by the Sync pass, which
   *  measures the player's taps against them -- they are the ground truth
   *  the overlay already tells people to tap along with. */
  get kickTimes() { return this._kickTimes; }

  setKickTimes(kickTimes) {
    this._kickTimes = kickTimes || [];
    this._kickIdx = 0;
  }

  /** Advance the cursor to (at or just past) `tMs` in the kick-time list --
   *  called once per triggering kick, in the same forward-only order they
   *  arrive, so it always points at the CURRENT kick's own position. */
  _advanceKickCursor(tMs) {
    while (this._kickIdx < this._kickTimes.length && this._kickTimes[this._kickIdx] < tMs) this._kickIdx++;
  }

  /**
   * @param evt the RHYTHM/kick NoteEvent (evt.tMs is the exact musical
   *   onset; the dispatcher may not reach it until up to one sim step
   *   later)
   */
  onKick(evt) {
    // Everything below is anchored to evt.tMs, the exact onset time — NOT
    // the caller's discretized "now". Kick-quantized jumps land almost
    // exactly when the next kick arrives, so the gap between a kick's true
    // time and the ~8ms-later instant the fixed-step sim actually gets to
    // process it is not noise to ignore: feeding that jitter into the
    // beat-period EMA compounds a slowly-growing phase error into D every
    // cycle, and resolving state against the wrong instant can leave a
    // kick seeing stale AIR state and silently dropping its launch.
    const tMs = evt.tMs;
    this.update(tMs); // resolve any landing/compress transition due by tMs first
    this._updateBeatPeriod(tMs);
    this._advanceKickCursor(tMs);
    this.kickCount++;
    if (this.bpm > HIGH_BPM_HALFTIME && this.kickCount % 2 === 0) {
      this.pendingGhostKick = { vel: evt.vel };
      return;
    }
    this._launchOrRetarget(evt, tMs); // kicks stay inert mid-hang; only player taps force
  }

  /** Player-driven mode: kicks no longer launch jumps, but the inter-kick
   * EMA must keep flowing — it drives jump duration, the combo grace/break
   * windows, and the ensemble/strut timing. This is onKick minus the launch. */
  noteKickTiming(tMs) {
    this._updateBeatPeriod(tMs);
  }

  /** Forget the last kick so the next one sets no interval. Called after a
   * span of kicks was deliberately withheld from the EMA (a double-bass
   * roll): without this, the first kick after the span would feed the whole
   * gap in as one giant "beat". */
  resetKickBaseline() {
    this.lastKickMs = null;
  }

  /**
   * A player press. Same anchoring discipline as onKick (judge/launch at the
   * press's own DOM-captured audio-clock time, not the sim step that drains
   * it), same launch/retarget rules — but no EMA write (the beat period
   * stays chart-driven) and no halftime ghosting (a human already taps at
   * whatever rate a human can).
   * @param evt {{tMs:number, vel:number}} vel inherited from the matched
   *   kick when the press hit a chart note, or a neutral default when not.
   */
  onPlayerTap(evt) {
    const tMs = evt.tMs;
    this.update(tMs); // resolve any landing/compress transition due by tMs first
    this._advanceKickCursor(tMs);
    this._launchOrRetarget(evt, tMs, { forceTakeoff: true });
  }

  /**
   * Double jump: a tap before the character hits the ground relaunches the
   * arc from the CURRENT height — C0-continuous, no teleport. The new arc's
   * apex is the current height plus a boost, and the arc is entered at the
   * launch-phase point whose height equals where the character already is,
   * so y never snaps. The budget/sequence policy lives in AirJumpSequencer;
   * this only refuses when the character turns out to be grounded by tMs
   * (the caller then refunds and falls through to a normal ground launch).
   * @returns {boolean} true if the air jump fired
   */
  airJump(evt, boostMul = 1, meta = {}) {
    const tMs = evt.tMs;
    this.update(tMs); // the press may postdate the landing this step hasn't resolved yet
    if (this.state !== 'AIR') return false;

    const yNow = this.y;
    const extra = this.hBase * (0.5 + 0.6 * evt.vel) * boostMul * this.P.live.jumpHeight;
    const H2 = (yNow + extra) / (1 - W);
    // Launch-phase height is Ha*(1-(1-p)^2); invert for the p where it equals yNow.
    const p = 1 - Math.sqrt(Math.max(0, 1 - yNow / ((1 - W) * H2)));
    // Land ON the next audible kick, like every other launch now does --
    // this was the back-to-back-kicks lateness: jump on kick 1, double-jump
    // on kick 2, but the double jump's landing rode 0.9x the beat-period
    // EMA, so he came down somewhere musically arbitrary and the NEXT
    // kick's tap found him still airborne (and often unbudgeted), eating a
    // beat. The arc is entered mid-launch at phase p, so its landing sits
    // at tMs + D2*(1 - p*A); solving for the landing to hit the next kick's
    // gap gives D2 = gap/(1 - p*A). EMA fallback when no kick is in range.
    this._advanceKickCursor(tMs);
    const nextKickMs = nextLandingKickMs(this._kickTimes, tMs, this._kickIdx);
    const gap = nextKickMs != null ? nextKickMs - tMs : NaN;
    const D2 = clamp(
      gap >= LANDING_MIN_GAP_MS && gap <= 2000 ? gap / (1 - p * A) : 0.9 * this.beatPeriodMs,
      D_MIN, D_MAX,
    );
    this.compress = null;
    this._pendingLaunch = null;
    this.lastLaunchVel = evt.vel;
    this.state = 'AIR';
    this.jumpStartMs = tMs - p * A * D2;
    this.H = H2;
    this.D = D2;
    this.y = yNow;
    this.pendingAirJump = { y: yNow, index: meta.index ?? 0, isFlourish: !!meta.isFlourish };
    return true;
  }

  _updateBeatPeriod(nowMs) {
    if (this.lastKickMs != null) {
      const interval = nowMs - this.lastKickMs;
      if (interval > 120 && interval < 2000) {
        this.beatPeriodMs = this.beatPeriodMs * 0.7 + interval * 0.3;
      }
    }
    this.lastKickMs = nowMs;
  }

  _launchOrRetarget(evt, nowMs, { forceTakeoff = false } = {}) {
    const H = this.hBase * (0.6 + 0.8 * evt.vel) * this.P.live.jumpHeight;
    // Land ON the next audible kick when one falls in range (searched
    // fresh from the cursor _advanceKickCursor just placed at THIS kick's
    // own position -- see scheduledJumpD/nextLandingKickMs above), rather
    // than merely guessing from the beat-period EMA; the EMA only ever
    // happens to match the real next gap on perfectly steady, unsyncopated
    // stretches. A fresh ground launch takes off right now; a mid-air
    // retarget actually launches RETARGET_FALL_MS later (once the compress
    // lands), so the search's takeoff floor -- and D itself -- must be
    // anchored to THAT instant, not nowMs.

    // Landing-tie relaunch: now that landings are routinely scheduled to
    // fall EXACTLY on the next kick, that kick's own trigger arrives with
    // the arc a hair short of touching down (sim-step quantization, a
    // retarget's one-step-late relaunch) -- and used to read as "still
    // airborne, past the retarget window, ignore", swallowing the beat
    // entirely. A kick landing within LANDING_QUANT_EPS_MS of the scheduled
    // touchdown IS the touchdown: resolve the landing now and fall through
    // to a fresh on-beat launch. (Offline replicas mirror this via their
    // symmetric landMs - LANDING_QUANT_EPS_MS airborne test.)
    if (this.state === 'AIR' && !this.compress) {
      const remainingMs = this.jumpStartMs + this.D - nowMs;
      if (remainingMs > 0 && remainingMs <= LANDING_QUANT_EPS_MS) {
        const Ha = (1 - W) * this.H;
        this._land((2 * Ha) / (GAMMA * this.D));
      }
    }

    if (this.state === 'GROUND') {
      const nextKickMs = nextLandingKickMs(this._kickTimes, nowMs, this._kickIdx + 1);
      const D = scheduledJumpD(nowMs, nextKickMs, this.beatPeriodMs, this._anchor);
      this.lastLaunchVel = evt.vel;
      this._launch(nowMs, H * shortHopHeightMul(D), D);
      return;
    }

    const u = (nowMs - this.jumpStartMs) / this.D;
    if (u >= A + B) {
      const r = (u - A - B) / GAMMA;
      if (r < 0.3 && !this.compress && canRetarget(nowMs, this.jumpStartMs, this.D)) {
        const retargetLaunchMs = nowMs + RETARGET_FALL_MS;
        const nextKickMs = nextLandingKickMs(this._kickTimes, retargetLaunchMs, this._kickIdx + 1);
        const D = scheduledJumpD(retargetLaunchMs, nextKickMs, this.beatPeriodMs, this._anchor);
        this.compress = { startMs: nowMs, fromY: this.y, dur: RETARGET_FALL_MS };
        this._pendingLaunch = { H: H * shortHopHeightMul(D), D, vel: evt.vel };
        return;
      }
    }

    // Mid launch/hang (or late fall past the retarget window): raw kicks stay
    // inert — already committed, avoids impossible double-jumps from every
    // layered onset. Player/chart taps (forceTakeoff) cut the arc and
    // relaunch so a takeoff note is never silently dropped.
    //
    // CRITICAL: relaunch is C0-continuous from the CURRENT height — never
    // _land() then _launch() from y=0. The old land-and-relaunch snapped
    // Midio from the apex (or any mid-arc height) straight to the ground
    // for a frame, which read as a teleport-to-ground at the top of the
    // jump whenever a chart/player takeoff hit mid-hang after the air-jump
    // budget was spent (or any other forceTakeoff mid-arc).
    if (forceTakeoff && this.state === 'AIR') {
      this.compress = null;
      this._pendingLaunch = null;
      const yNow = Math.max(0, this.y);
      // Normal takeoff height, inflated only as much as needed so the
      // launch phase can pass through the height we're already at.
      const Htarget = H; // already includes vel * jumpHeight; short-hop applied below
      const nextKickMs = nextLandingKickMs(this._kickTimes, nowMs, this._kickIdx + 1);
      const gap = nextKickMs != null ? nextKickMs - nowMs : NaN;
      // Seed H from the target (or yNow if higher), invert launch phase for
      // the entry point p, then solve D so the arc still lands on the next
      // kick — same continuity math as airJump, without the double-jump boost.
      let H2 = Math.max(Htarget, yNow / (1 - W));
      let p = 1 - Math.sqrt(Math.max(0, 1 - yNow / ((1 - W) * H2)));
      let D;
      if (gap >= LANDING_MIN_GAP_MS && gap <= 2000) {
        // Near the ground (p≈0) keep short-hop D < D_MIN so back-to-back
        // chart notes still land on the next kick; mid-arc entries clamp
        // to [D_MIN, D_MAX] like airJump.
        const raw = gap / (1 - p * A);
        D = p < 0.05 ? Math.min(raw, D_MAX) : clamp(raw, D_MIN, D_MAX);
      } else {
        D = clamp(this.beatPeriodMs, D_MIN, D_MAX);
      }
      H2 = Math.max(Htarget * shortHopHeightMul(D), yNow / (1 - W));
      p = 1 - Math.sqrt(Math.max(0, 1 - yNow / ((1 - W) * H2)));
      this.lastLaunchVel = evt.vel;
      this.state = 'AIR';
      this.jumpStartMs = nowMs - p * A * D;
      this.H = H2;
      this.D = D;
      this.y = yNow;
    }
  }

  _launch(nowMs, H, D) {
    this.state = 'AIR';
    this.jumpStartMs = nowMs;
    this.H = H;
    this.D = D;
    this.compress = null;
  }

  /** Clear one-shot per-step event flags. Call at the START of each sim step,
   * before Conductor dispatch, so listeners downstream can observe this
   * step's landing/ghost-kick events after update() runs. */
  clearFrameFlags() {
    this.pendingLanding = null;
    this.pendingGhostKick = null;
    this.pendingAirJump = null;
  }

  update(nowMs) {
    if (this.compress) {
      const t = nowMs - this.compress.startMs;
      const r = clamp(t / this.compress.dur, 0, 1);
      this.y = this.compress.fromY * (1 - r * r);
      if (r >= 1) {
        const vLand = (2 * this.compress.fromY) / this.compress.dur;
        this._land(vLand);
        this.compress = null;
        if (this._pendingLaunch) {
          const { H, D, vel } = this._pendingLaunch;
          this._pendingLaunch = null;
          this.lastLaunchVel = vel;
          this._launch(nowMs, H, D);
        }
      }
      return;
    }

    if (this.state === 'AIR') {
      const u = (nowMs - this.jumpStartMs) / this.D;
      if (u >= 1) {
        const Ha = (1 - W) * this.H;
        const vLand = (2 * Ha) / (GAMMA * this.D);
        this._land(vLand);
      } else {
        this.y = jumpY(u, this.H);
      }
    }
  }

  _land(vLandPxMs) {
    this.state = 'GROUND';
    this.y = 0;
    this.pendingLanding = { vLandPxMs };
  }

  get airborne() { return this.state === 'AIR'; }

  /** True for the ~3 sim steps immediately before a predictable, kick-
   *  scheduled ground launch -- a brief lead window the renderer can use
   *  for an anticipation beat (eye-widen, brace) genuinely ahead of
   *  liftoff. A player TAP has no such lead time to give -- the tap IS
   *  the launch, and delaying it to manufacture one would cost input
   *  feel in a game scored on tap accuracy -- so this is only ever true
   *  ahead of a scheduled kick-launch, never a manual one; callers that
   *  want an anticipation beat on tap-launches instead key it off the
   *  first few steps of `airborne` right after `_wasAirborne` flips. */
  anticipatingLaunch(nowMs, leadMs = 25) {
    if (this.state !== 'GROUND' || !this._kickTimes.length) return false;
    const nextKickMs = nextLandingKickMs(this._kickTimes, nowMs, this._kickIdx);
    return nextKickMs != null && nextKickMs - nowMs > 0 && nextKickMs - nowMs <= leadMs;
  }
}
