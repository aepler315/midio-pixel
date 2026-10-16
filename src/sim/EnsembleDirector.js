// The ensemble as physics: the three characters are a trio of Kuramoto
// oscillators whose coupling constant is set by the music's vibe. Each
// character carries a phase (driving their bob/stomp/pulse timing) and a
// roam anchor wandering the stage. What the audience reads as "chemistry"
// is the honest dynamics of the critical coupling boundary:
//   happy + epic  -> K well above critical: they phase-lock and gather --
//                    three bodies moving as one instrument
//   sad           -> K near zero and the formation spreads: they drift
//                    apart across the whole stage, each in their own time
//   neutral/trivial -> K just below critical: they genuinely TRY to sync,
//                    almost lock, slip, clash, and drift -- the Kuramoto
//                    slip cycle, not a script
import { mulberry32, clamp, clamp01, lerp } from '../utils/math.js';
import { curl2 } from '../utils/fields.js';
import { FlourishGate } from './FlourishGate.js';
import { RingBuffer } from '../utils/RingBuffer.js';

const TWO_PI = Math.PI * 2;
// Distinct natural detunes (rad/s) so slip is visible and non-uniform.
// std ~ 0.64 -> critical coupling ~ 1.3 for this trio.
const DETUNES = [0.5, -0.72, 0.9];
const R_TAU = 1.5;
const SPREAD_TAU = 2.8;   // formation changes drift, never snap
const CENTROID_SPEED = 0.041; // rad/s of the roam ellipse -- slow
const PRESENCE_TAU = 1.5; // seconds for a presence weight to ease toward its target

// Transition tumble: a rare, brief 3D-ish turn (see MeshDrawer.applyTransform
// rotX/rotY) the whole trio shares on a scene-change beat, staggered like a
// wave so it reads as one choreographed move rather than three characters
// spinning independently. Deliberately sparse -- an accent, not a tic.
const TUMBLE_STAGGER_MS = 110;      // delay between Midio -> Broshi -> Midasus
const TUMBLE_PEAK = [0.56, 0.46, 0.64]; // per-character peak angle (rad)
const TUMBLE_CHANCE = 0.5;          // not every eligible transition tumbles
const TUMBLE_COOLDOWN_MIN_MS = 9000, TUMBLE_COOLDOWN_RANGE_MS = 9000;

// Disc spin (see discCue below): sparser than the tumble is loose, denser
// than the tumble is rare -- it's the trio's mid-tier punctuation. The floor
// is many times the 420ms move length, so a spin always resolves before
// anything can restart it.
const DISC_MIN_GAP_MS = 6000;
const DISC_CHANCE = 0.35;     // at rest: most eligible cues still pass
const DISC_CHANCE_HOT = 0.7;  // at full song-relative intensity

// Player beat-anchor (BeatAnchor.js): a tap anywhere marks a phase/period
// reference the trio pulls toward -- distinct, non-uniform per-character
// offsets so they land near, but never ON, the same instant (the whole
// point of "shouldn't sync to the same time as each other"). The pull is a
// RATE, not a snap, and stacks on top of the existing Kuramoto coupling
// above, so a low-K sad section still slips around the anchor instead of
// locking dead to it.
const ANCHOR_OFFSET = [0, 0.55, -0.42]; // rad, per character
// Must comfortably outrun each character's own natural DETUNE (max 0.9
// rad/s above) and the coupling force (up to ~K*R, K can reach ~3 at full
// happy+epic) -- otherwise those forces fight the offsets themselves and
// the "distinct per character" guarantee stops holding at some vibes.
const ANCHOR_PULL_RATE = 8; // rad/s per rad of phase error, scaled by confidence
const ANCHOR_MIN_CONFIDENCE = 0.05; // below this the anchor is treated as absent

// Shared build-up swell: HypeDirector.buildUp (a crescendo read, not just
// the rare drop-triggered surge) modulates a scale term every character
// reads off the SAME theta[i] this class already publishes -- so during a
// build-up they visibly swell together as one body when the vibe locks
// them in phase, and in a visible traveling wave when it doesn't, instead
// of three characters each pulsing to their own private clock.
const SWELL_GAIN = 0.38;

export class EnsembleDirector {
  constructor(seed = 1, { stageW = 1280, stageH = 720 } = {}) {
    const rand = mulberry32((seed ^ 0x3a7e) >>> 0 || 1);
    this.w = stageW;
    this.h = stageH;
    this.theta = [rand() * TWO_PI, rand() * TWO_PI, rand() * TWO_PI];
    this.r = 0;
    this.rSmooth = 0.5;
    this.spread = 220;
    this.K = 1;
    this._phi = rand() * TWO_PI;
    this._t = 0;
    // Wider default triangle so the trio doesn't spawn stacked.
    this.anchors = [
      { x: stageW * 0.28, y: 0 },
      { x: stageW * 0.12, y: 0 },
      { x: stageW * 0.48, y: stageH * 0.30 },
    ];
    // Presence weights: 1 = fully in the ensemble, 0 = off on an excursion.
    // An excursion director eases these toward 0/1 rather than snapping, so
    // "leaving the band" and "coming home" both read as physical transitions.
    this.weights = [1, 1, 1];
    this._targetWeights = [1, 1, 1];

    this._rand = rand; // kept for later stochastic cues (e.g. tumble)
    this._tumble = { active: false, startMs: -Infinity, durMs: 850, axis: 'y', dir: 1, cooldownUntilMs: 0 };
    // Disc-spin cue: the trio's shared "turn into a spinning disc" flourish.
    // It used to be triggered by ComboSystem.justClean directly inside Broshi
    // and Midasus, which -- the show being autoplay, so every landing is
    // clean -- meant a fresh 420ms spin every landing and neither of them
    // ever stopped rotating. It belongs here instead, next to the tumble,
    // because it is the same KIND of event: a rare trio-wide punctuation
    // that lands on something structural (a section change, a drop, a combo
    // milestone), never on the metronome of ordinary landings.
    this.discCue = false; // one-frame flag, cleared each update() like ComboSystem's
    /** Recent flourish decisions, hits AND misses, for the debug overlay. */
    this.moveLog = new RingBuffer(24);
    this._discGate = new FlourishGate({
      minGapMs: DISC_MIN_GAP_MS, chance: DISC_CHANCE, intensityChance: DISC_CHANCE_HOT,
      intensityScale: 0.5, rand,
    });
    this._tumbleX = [0, 0, 0];
    this._tumbleY = [0, 0, 0];
    this._buildUp = 0; // HypeDirector.buildUp, read by swell(i)
  }

  /** Ease this performer's presence weight toward w01 (0..1) over ~1.5s. */
  setPresence(i, w01) {
    this._targetWeights[i] = clamp01(w01);
  }

  /** Call on a scene-transition boundary. Only cut/shutter beats are
   *  eligible (fades are slow crossfades, not a snap moment), it's further
   *  gated by chance and a long cooldown, so the tumble stays a rare accent
   *  rather than a per-transition tic. */
  maybeTumble(nowMs, transitionStyle) {
    if (nowMs < this._tumble.cooldownUntilMs) return;
    if (transitionStyle !== 'cut' && transitionStyle !== 'shutter') return;
    if (this._rand() > TUMBLE_CHANCE) return;
    this._tumble.active = true;
    this._tumble.startMs = nowMs;
    this._tumble.durMs = 620 + this._rand() * 320;
    this._tumble.axis = this._rand() < 0.7 ? 'y' : 'x'; // mostly a turn, sometimes a tip
    this._tumble.dir = this._rand() < 0.5 ? 1 : -1;
    this._tumble.cooldownUntilMs = nowMs + TUMBLE_COOLDOWN_MIN_MS + this._rand() * TUMBLE_COOLDOWN_RANGE_MS;
  }

  /**
   * Offer the trio a reason to spin. Called on the things a flourish can
   * legitimately punctuate -- a section transition, a drop, a combo
   * milestone -- and NOT on ordinary landings, which under autoplay arrive
   * on every kick and are what made the disc spin continuous in the first
   * place. Raises `discCue` for one frame if the gate allows it.
   *
   * @param {number} nowMs
   * @param {string} reason  'section' | 'drop' | 'milestone' (debug log only)
   * @param {number} intensity song-relative energy 0..1: a calm passage
   *   spins rarely even when something structural happens.
   * @returns {boolean} whether the cue was raised
   */
  maybeDisc(nowMs, reason = 'section', intensity = 0) {
    // A drop or a milestone IS the punctuation -- it skips the probability
    // roll (never the hard floor). A plain section change still rolls.
    // 'cue' joins them: a conductor-track flourish (ConductorTrack.js) was
    // written deliberately, so rolling dice on whether to honor it would
    // make the schema unreliable to author against.
    const transition = reason === 'drop' || reason === 'milestone' || reason === 'cue';
    const fired = this._discGate.tryFire(nowMs, { intensity, transition });
    // Denials are logged too -- an over-firing move is only visible in the
    // debug readout if the attempts it made are recorded alongside the hits.
    this.moveLog.push({
      tMs: nowMs, who: 'trio', move: 'disc', reason,
      allowed: fired, why: fired ? this._discGate.lastReason : this._discGate.lastReason,
      intensity: Math.round(intensity * 100) / 100,
    });
    if (!fired) return false;
    this.discCue = true;
    this.lastDisc = { atMs: nowMs, reason };
    return true;
  }

  /** Current tumble angle for character i (radians), 0 outside a move. */
  rotX(i) { return this._tumbleX[i] || 0; }
  rotY(i) { return this._tumbleY[i] || 0; }

  _updateTumble(nowMs) {
    const tb = this._tumble;
    if (!tb.active) return;
    let allDone = true;
    for (let i = 0; i < 3; i++) {
      const uRaw = (nowMs - (tb.startMs + i * TUMBLE_STAGGER_MS)) / tb.durMs;
      const inWindow = uRaw >= 0 && uRaw <= 1;
      if (uRaw < 1) allDone = false;
      // Out-and-back pulse (0 at both ends) so the glyph always lands back
      // on its normal flat pose -- never left mid-tumble.
      const peak = inWindow ? tb.dir * TUMBLE_PEAK[i] * Math.sin(Math.PI * uRaw) : 0;
      this._tumbleY[i] = tb.axis === 'y' ? peak : 0;
      this._tumbleX[i] = tb.axis === 'x' ? peak : 0;
    }
    if (allDone) {
      tb.active = false;
      this._tumbleX[0] = this._tumbleX[1] = this._tumbleX[2] = 0;
      this._tumbleY[0] = this._tumbleY[1] = this._tumbleY[2] = 0;
    }
  }

  update(nowMs, dtSec, vibe, beatPeriodMs = 500, anchor = null, buildUp = 0) {
    // Clear last frame's cue here, at the TOP of the step: Simulation calls
    // update() before the maybeDisc() cue points, and the characters read
    // discCue after both -- so a cue raised this frame survives to be seen
    // exactly once.
    this.discCue = false;
    this._t += dtSec;
    this._buildUp = clamp01(buildUp);
    this._updateTumble(nowMs);
    const anchorConf = anchor ? clamp01(anchor.confidence) : 0;
    const anchorLive = anchorConf > ANCHOR_MIN_CONFIDENCE;
    // A confident anchor gradually pulls the ensemble's own natural
    // frequency toward the player's period too -- otherwise the phase pull
    // below fights a base rate still set by the chart's beat.
    const effectivePeriodMs = anchorLive ? lerp(beatPeriodMs || 500, anchor.periodMs, anchorConf) : (beatPeriodMs || 500);
    const omega0 = TWO_PI / Math.max(0.25, effectivePeriodMs / 1000);

    const wAlpha = 1 - Math.exp(-dtSec / PRESENCE_TAU);
    for (let i = 0; i < 3; i++) this.weights[i] += wAlpha * (this._targetWeights[i] - this.weights[i]);

    // Coupling from vibe: mood gates it, drive deepens it.
    const mood = clamp01(0.5 + 0.5 * vibe.valence);
    const drive = clamp01(vibe.epic);
    this.K = 0.15 + 2.9 * Math.pow(mood, 1.3) * (0.3 + 0.7 * drive);

    // Kuramoto, N=3, presence-weighted mean field: an absent performer
    // (weight -> 0) barely dents what "the group" is doing, and its own
    // phase equation's coupling term is scaled by that same weight, so it
    // free-runs on its natural detune instead of chasing a group it isn't
    // part of. The remaining duo's weighted R reverts to an honest N=2
    // Kuramoto field, so they can still fully lock without the absent third.
    let sc = 0, ss = 0, wsum = 0;
    for (let i = 0; i < 3; i++) {
      sc += this.weights[i] * Math.cos(this.theta[i]);
      ss += this.weights[i] * Math.sin(this.theta[i]);
      wsum += this.weights[i];
    }
    const R = wsum > 1e-6 ? Math.hypot(sc, ss) / wsum : 0;
    const psi = Math.atan2(ss, sc);
    for (let i = 0; i < 3; i++) {
      this.theta[i] += (omega0 + DETUNES[i] + this.weights[i] * this.K * R * Math.sin(psi - this.theta[i])) * dtSec;
      if (this.theta[i] > TWO_PI) this.theta[i] -= TWO_PI;
      else if (this.theta[i] < 0) this.theta[i] += TWO_PI;
    }
    // The anchor pull itself: each character eases toward basePhase +
    // its own offset, at a rate scaled by how confident the anchor is.
    if (anchorLive) {
      const pullRate = ANCHOR_PULL_RATE * anchorConf;
      const basePhase = anchor.phaseRad(nowMs);
      for (let i = 0; i < 3; i++) {
        const target = ((basePhase + ANCHOR_OFFSET[i]) % TWO_PI + TWO_PI) % TWO_PI;
        let err = target - this.theta[i];
        err = ((err + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI; // fold to [-PI, PI]
        this.theta[i] += pullRate * err * dtSec;
        if (this.theta[i] > TWO_PI) this.theta[i] -= TWO_PI;
        else if (this.theta[i] < 0) this.theta[i] += TWO_PI;
      }
    }

    this.r = R;
    this.rSmooth += (1 - Math.exp(-dtSec / R_TAU)) * (R - this.rSmooth);

    // Formation: desync and sadness both push them apart. Floor is higher
    // so even a locked "happy" ensemble still has room to breathe.
    const sadness = clamp01(-vibe.valence);
    const spreadTarget = lerp(230, 620, clamp01(0.7 * (1 - this.rSmooth) + 0.5 * sadness));
    this.spread += (1 - Math.exp(-dtSec / SPREAD_TAU)) * (spreadTarget - this.spread);

    // The formation's centroid roams the stage on a slow ellipse + curl drift.
    const flow = curl2(this._t * 0.05, 1.7, this._t * 0.03);
    const cx = this.w * (0.34 + 0.16 * Math.sin(this._t * CENTROID_SPEED * TWO_PI + this._phi) + 0.05 * clamp(flow.x, -1, 1));
    const formAng = this._t * 0.021 * TWO_PI * 0.3;

    // Role bias: Broshi RUNS POINT ahead of Midio, Midasus high-right, Midio
    // near center — equilateral alone let them collapse into one pile.
    //
    // Broshi was -0.42 (hanging back-left) and now leads by the same margin.
    // A companion who trails is a companion you watch over your shoulder;
    // one who runs ahead is pulling you along, which is the read wanted here
    // -- and it also puts him in open frame rather than pinned to the left
    // edge the camera is always driving away from.
    const roleBias = [
      { x: 0.05, y: 0 },
      { x: 0.42, y: 0.04 },
      { x: 0.52, y: -0.34 }, // pushed further from Midio (was 0.38/-0.28) -- they overlapped too much
    ];

    // Per-character anchors on a slowly rotating triangle + role bias.
    for (let i = 0; i < 3; i++) {
      const ang = formAng + (i * TWO_PI) / 3;
      const wob = curl2(this._t * 0.04 + i * 9.1, i * 3.7, this._t * 0.026);
      this.anchors[i].x = cx
        + Math.cos(ang) * this.spread * 0.55
        + roleBias[i].x * this.spread
        + clamp(wob.x, -1, 1) * 40;
      this.anchors[i].y = roleBias[i].y * this.spread + clamp(wob.y, -1, 1) * 30;
    }
    // Stage-safety clamps per character role.
    this.anchors[0].x = clamp(this.anchors[0].x, this.w * 0.14, this.w * 0.58); // Midio: gameplay window
    this.anchors[1].x = clamp(this.anchors[1].x, this.w * 0.18, this.w * 0.88); // Broshi: runs point, so his window is ahead of Midio's
    this.anchors[2].x = clamp(this.anchors[2].x, this.w * 0.34, this.w * 0.92); // Midasus: sky-right (floor raised from 0.22 -- kept her out of Midio's gameplay window)
    // Midasus: sky-high but never off the top edge -- a wide formation
    // spread could otherwise push her y negative (above the stage entirely).
    this.anchors[2].y = clamp(this.h * 0.28 - this.spread * 0.12 + this.anchors[2].y * 2, this.h * 0.05, this.h * 0.7);
  }

  phase(i) { return this.theta[i]; }

  /** Scale multiplier (>=1) for character i, driven by the shared build-up
   *  signal and that character's own place in the SAME Kuramoto phase this
   *  class already publishes -- beat-synced because theta[i] already is,
   *  and shared because all three read the same field: locked (happy+epic)
   *  they swell as one body, unlocked they swell in a visible traveling
   *  wave. 1 (no-op) whenever there's no build-up. */
  swell(i) {
    return 1 + SWELL_GAIN * this._buildUp * (0.5 + 0.5 * Math.cos(this.theta[i]));
  }
}
