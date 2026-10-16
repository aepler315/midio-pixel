// Look-ahead telegraphing / proximity posture (spec §2.2.3). Squash-and-stretch
// driven by anticipation phase a(t), snap-to-stretch on launch with a damped
// spring relax, and a ground-line glint that sweeps in toward the next
// scheduled takeoff (obstacles are purely ambient now -- nothing to avoid,
// so the glint no longer seeks them).
import { Role } from '../core/NoteEvent.js';
import { clamp } from '../utils/math.js';

const T_LOOK = 600; // ms
const GLINT_LEAD_PX = 90; // how far ahead of Midio the glint starts its sweep in

// Jump-timing juice: a deeper anticipation wind-up before takeoff, a
// snappier launch stretch, and a landing "stick" -- a hard compress right on
// touchdown that springs back, so every jump visibly winds up and sticks its
// landing on the beat. All render-only (pose deltas), physics untouched.
const CROUCH_DEPTH = 0.30;       // was 0.22 -- a deeper pre-jump wind-up
const LAUNCH_STRETCH_MS = 85;    // was 70
const LAUNCH_STRETCH_Y = 1.38, LAUNCH_STRETCH_X = 0.74; // was 1.30 / 0.80
const LAND_SQUASH_MS = 120;
const LAND_SQUASH_DEPTH = 0.26;
// Stability guards for the resting-pose spring's explicit Euler step (see
// its own comment below): a per-step size safely under 1/omega, and a gap
// beyond which the spring is treated as already settled rather than
// integrated at all.
const SPRING_STABLE_STEP_SEC = 0.02;
const SPRING_SETTLE_SEC = 0.3;

export class TelegraphScanner {
  constructor() {
    this.a = 0;
    this._wasAirborne = false;
    this._stretchStartMs = -Infinity;
    this._landStartMs = -Infinity;
    this._scaleYVel = 0;
    this._lastMs = 0;
    this.glintActive = false;
    this.glintScreenX = 0;
    this._chartIdx = 0; // monotonic cursor into noteChart.notes (playback is seek-free)
  }

  update(nowMs, conductor, midio, jump, impactFX, worldX, groundY, noteChart = null, particleMul = 1) {
    // rawDtSec is nowMs's own jump since last call -- and nowMs is the SIM
    // clock, which a seek moves by however far the player scrubbed,
    // arbitrarily far in either direction, in a single update() call. Fed
    // raw into the damped-spring relax below (explicit Euler integration,
    // 5 Hz/zeta 0.55) as its own integration step, a ~59-second gap measured
    // from one real seek turned midio.scaleY into 120 and scaleX into 1/120
    // in that one call -- a numerically exploded spring, rendered as Midio's
    // own mesh stretched thousands of px off toward a screen edge. See the
    // spring branch below for how rawDtSec is actually used safely; `dtSec`
    // (clamped the same way main.js's own frame loop clamps its real-time
    // delta) is what every OTHER consumer here (impactFX.sputter) gets.
    const rawDtSec = Math.max(0, (nowMs - this._lastMs) / 1000);
    const dtSec = Math.min(0.25, rawDtSec);
    this._lastMs = nowMs;

    // With a chart, the crouch telegraphs the next *judgeable* onset — a tap
    // or a hold start — which is exactly the "press now" cue the player
    // needs; a hold's interior ticks no longer crouch him (the slide owns
    // the pose there). Without one, legacy behavior: the next raw kick.
    let nextOnsetMs = null;
    if (noteChart) {
      const notes = noteChart.notes;
      while (this._chartIdx < notes.length && notes[this._chartIdx].tMs < nowMs) this._chartIdx++;
      const n = notes[this._chartIdx];
      if (n && n.tMs - nowMs <= T_LOOK) nextOnsetMs = n.tMs;
    } else {
      const window = conductor.peekWindow(nowMs, T_LOOK);
      for (const evt of window) {
        if (evt.role === Role.RHYTHM && evt.kick) { nextOnsetMs = evt.tMs; break; }
      }
    }
    const a = nextOnsetMs !== null ? clamp(1 - (nextOnsetMs - nowMs) / T_LOOK, 0, 1) : 0;
    this.a = a;

    const justLaunched = !this._wasAirborne && jump.airborne;
    const justLanded = this._wasAirborne && !jump.airborne;
    if (justLaunched) this._stretchStartMs = nowMs;
    if (justLanded) this._landStartMs = nowMs;
    this._wasAirborne = jump.airborne;

    const landAge = nowMs - this._landStartMs;
    if (jump.airborne && nowMs - this._stretchStartMs < LAUNCH_STRETCH_MS) {
      midio.scaleY = LAUNCH_STRETCH_Y; // snap-to-stretch on launch
      midio.scaleX = LAUNCH_STRETCH_X;
      this._scaleYVel = 0;
    } else if (!jump.airborne && landAge >= 0 && landAge < LAND_SQUASH_MS) {
      // Landing "stick": a hard compress on the beat, quadratically easing
      // back to neutral -- reads as sticking the landing right on the beat.
      const u = landAge / LAND_SQUASH_MS;
      const scaleY = 1 - LAND_SQUASH_DEPTH * (1 - u) * (1 - u);
      midio.scaleY = scaleY;
      midio.scaleX = 1 / scaleY;
      this._scaleYVel = 0;
    } else if (!jump.airborne && a > 0) {
      const scaleY = 1 - CROUCH_DEPTH * a * a * a;
      midio.scaleY = scaleY;
      midio.scaleX = 1 / scaleY;
      this._scaleYVel = 0;
    } else {
      // 5 Hz damped spring relax toward neutral (scaleY=1, scaleX=1/scaleY).
      // Explicit Euler on a spring this stiff (omega ~= 31.4 rad/s) is only
      // stable for a step well under 1/omega (~32ms) -- the general dtSec
      // clamp above (sized for main.js's real-frame-hitch case) is nowhere
      // near tight enough for THIS integrator specifically. If the real gap
      // (rawDtSec) is bigger than the spring's own ~58ms settling time
      // (1/(zeta*omega)), it has already physically relaxed to rest by now
      // regardless of what caused the gap (a seek, a real stall) -- snap
      // straight there instead of integrating a step that's no longer
      // physically meaningful. Otherwise, integrate with a step capped to
      // a size the spring can actually take without diverging.
      if (rawDtSec > SPRING_SETTLE_SEC) {
        midio.scaleY = 1;
        this._scaleYVel = 0;
      } else {
        const omega = 2 * Math.PI * 5, zeta = 0.55;
        const stepSec = Math.min(rawDtSec, SPRING_STABLE_STEP_SEC);
        const accel = omega * omega * (1 - midio.scaleY) - 2 * zeta * omega * this._scaleYVel;
        this._scaleYVel += accel * stepSec;
        midio.scaleY += this._scaleYVel * stepSec;
      }
      midio.scaleX = 1 / midio.scaleY;
    }

    midio.leanDeg = 6 * a;

    if (a > 0.8 && !jump.airborne) impactFX.sputter(worldX, groundY, dtSec, particleMul);

    // Ground-line glint sweeping in toward Midio, timed to arrive exactly at
    // the next scheduled takeoff (same anticipation phase `a` the crouch
    // above already uses -- one shared "press now" cue, not two).
    this.glintActive = nextOnsetMs !== null;
    if (this.glintActive) {
      this.glintScreenX = midio.screenX + GLINT_LEAD_PX * (1 - a);
    }
  }

  draw(ctx, groundY) {
    if (!this.glintActive) return;
    ctx.save();
    const g = ctx.createRadialGradient(this.glintScreenX, groundY, 0, this.glintScreenX, groundY, 18);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(this.glintScreenX, groundY, 18, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
