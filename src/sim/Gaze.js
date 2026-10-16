// Gaze: what Midio is looking at. Nothing on screen used to look at
// anything -- his eye was a static hexagram sigil, no different mid-jump
// than at rest. This picks a target every step (the incoming obstacle,
// Midasus, or the celestial, in that priority order -- an immediate
// physical threat always wins over ambient looking-around) and eases a
// 2D look-direction toward it, plus two short overlays: a startled
// "flinch" on a musical drop (pulls the look back to centered -- snapped
// to attention rather than continuing to track whatever it was on), and
// an anticipation/settle openness term around jumps and landings.
import { clamp, clamp01 } from '../utils/math.js';

const NOTICE_WORLD_PX = 600;   // an obstacle must be at least this close (world px) to earn a look
const TARGET_TAU_SEC = 0.15;   // how fast the look direction eases toward a new target
const DROP_FLINCH_MS = 350;    // how long the startle overlay holds after hype.dropAtMs
const ANTICIPATE_LEAD_MS = 25; // ~3 sim steps -- matches JumpController.anticipatingLaunch's own default
const RISE_TAU_SEC = 0.05;     // fast attack for flinch/anticipation
const DECAY_TAU_SEC = 0.2;     // slower release back to neutral

export class GazeDirector {
  constructor() {
    this.mode = null;   // 'obstacle' | 'voyage' | 'celestial' | null
    this._dirX = 0;      // eased look direction, screen-space unit-ish vector
    this._dirY = 0;
    this.flinch = 0;     // 0..1, the drop's startle overlay
    this.anticipation = 0; // 0..1, brief eye-widen before a jump
    this.settle = 0;     // 0..1, decays from 1 right after a landing
    this._wasAirborne = false;
  }

  update(sim, dtSec, nowMs) {
    // 1) Pick a raw target in screen space, in priority order: a nearby
    // obstacle (gameplay-critical, always wins), else Midasus when she's
    // this step's dramatic subject (per FocusDirector -- what has focus
    // is what he's looking at too), else the celestial as the ambient
    // default so there's always something to look at.
    let tx = null, ty = null, mode = null;
    const nearestObs = sim.obstacles ? sim.obstacles.nearestAhead(sim.worldX) : null;
    if (nearestObs && (nearestObs.wx - sim.worldX) <= NOTICE_WORLD_PX) {
      tx = nearestObs.wx - sim.worldX + sim.midio.screenX;
      ty = sim.midio.groundY - nearestObs.height / 2;
      mode = 'obstacle';
    } else if (sim.focus && sim.focus.subject === 'voyage' && sim.midasus) {
      tx = sim.midasus.p.x;
      ty = sim.midasus.p.y;
      mode = 'voyage';
    } else {
      const light = sim.biomes && sim.biomes.currentLight ? sim.biomes.currentLight() : null;
      if (light) { tx = light.x; ty = light.y; mode = 'celestial'; }
    }
    this.mode = mode;

    // 2) Ease the look direction toward that target, relative to Midio's
    // own screen position (roughly eye height, not his feet).
    let dx = 0, dy = 0;
    if (tx != null) {
      dx = tx - sim.midio.screenX;
      dy = ty - (sim.midio.groundY - 40);
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
    }
    const dirAlpha = 1 - Math.exp(-dtSec / TARGET_TAU_SEC);
    this._dirX += dirAlpha * (dx - this._dirX);
    this._dirY += dirAlpha * (dy - this._dirY);

    // 3) Drop flinch: a musical drop has no screen position to look AT,
    // so instead of tracking it, the look snaps back toward centered for
    // a beat -- startled, not staring at empty air.
    const sinceDrop = sim.hype ? nowMs - sim.hype.dropAtMs : Infinity;
    const flinchTarget = sinceDrop >= 0 && sinceDrop <= DROP_FLINCH_MS ? 1 : 0;
    this.flinch = ease(this.flinch, flinchTarget, dtSec);

    // 4) Anticipation: kick-scheduled launches get a genuine lead window
    // (JumpController already knows the next kick time); a player TAP has
    // no lead to give without adding input latency, so it gets the same
    // beat rendered across the first few airborne frames instead.
    const jump = sim.jump;
    const justLaunched = !!(jump && !this._wasAirborne && jump.airborne);
    if (jump) this._wasAirborne = jump.airborne;
    const kickAnticipating = !!(jump && jump.anticipatingLaunch(nowMs, ANTICIPATE_LEAD_MS));
    this.anticipation = ease(this.anticipation, (kickAnticipating || justLaunched) ? 1 : 0, dtSec);

    // 5) Settle: a brief narrowing right after landing, releasing back to
    // neutral -- the "just braced for that" beat.
    if (jump && jump.pendingLanding) this.settle = 1;
    else this.settle = clamp01(this.settle - dtSec / DECAY_TAU_SEC);
  }

  /** Local-space iris offset from the eye's hub, scaled to maxPx. The
   *  flinch overlay pulls this toward centered rather than replacing it,
   *  so a startle mid-track reads as "snapped to attention," not a
   *  target swap. */
  irisOffset(maxPx) {
    const k = 1 - this.flinch;
    return { x: this._dirX * k * maxPx, y: this._dirY * k * maxPx };
  }

  /** Multiplicative eye-openness: wider on anticipation and flinch,
   *  slightly narrowed easing back to neutral after a landing. Composes
   *  with blink (both scale the same offset-from-hub term) rather than
   *  being a separate visual channel. */
  get openness() {
    return clamp(1 + 0.5 * this.anticipation + 0.3 * this.flinch - 0.25 * this.settle, 0.4, 1.5);
  }
}

function ease(current, target, dtSec) {
  const tau = target > current ? RISE_TAU_SEC : DECAY_TAU_SEC;
  return current + (1 - Math.exp(-dtSec / tau)) * (target - current);
}
