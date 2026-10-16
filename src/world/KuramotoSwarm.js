// A swarm of Kuramoto phase oscillators rendered as drifting motes: the
// canonical mathematics of spontaneous synchronization (fireflies flashing
// in unison, audiences falling into rhythmic applause). Each mote carries
// a phase theta_i and a slightly detuned natural frequency; the mean-field
// form couples every oscillator to the swarm's own order parameter
//   R*e^(i*psi) = (1/N) * sum(e^(i*theta_j))
//   dtheta_i/dt = omega_i + K*R*sin(psi - theta_i)
// which is O(N) instead of O(N^2). The coupling constant K follows track
// energy, so quiet sections twinkle incoherently and loud sections pull
// the whole swarm into phase-locked unison -- and kicks nudge every phase
// toward zero, entraining the unison flash to the actual beat. The game's
// entire premise (a world that synchronizes to the music), stated as a
// differential equation.
import { mulberry32, clamp01 } from '../utils/math.js';
import { FLAT_WEIGHTS } from '../audio/bands.js';

const N = 48;
const E_EMA_TAU = 0.35;
const K_MAX = 6; // coupling at full energy, comfortably past the sync threshold
const OMEGA_JITTER = 1.2; // rad/s spread of natural frequencies
const TWO_PI = Math.PI * 2;

/**
 * How calm reshapes each mote's positional wander around its anchor (draw()
 * only -- phase coupling K already reacts to calm). Calm used to leave this
 * untouched entirely: motes always traced the same small, quick Lissajous
 * wobble regardless of section energy. Widening the orbit and slowing its
 * rate (same radius+rate lerp Midasus's own orbit uses) makes a calm
 * section's swarm drift in broad, lazy loops instead of a tight, busy
 * shimmer that's merely dimmer/less synced. Pure so it's directly testable.
 */
export function calmWanderParams(calmLevel) {
  const c = clamp01(calmLevel);
  return {
    ampMul: 1 + 1.8 * c,  // wider orbit
    rateMul: 1 - 0.5 * c, // slower sweep
  };
}

export class KuramotoSwarm {
  constructor(seed = 1) {
    this.rand = mulberry32((seed ^ 0x51f15e) >>> 0 || 1);
    this.oscillators = [];
    for (let i = 0; i < N; i++) {
      this.oscillators.push({
        theta: this.rand() * TWO_PI,
        detune: (this.rand() * 2 - 1) * OMEGA_JITTER,
        // Wander anchors: a loose band across the mid-sky.
        ax: this.rand(), ay: 0.18 + this.rand() * 0.35,
        phase: this.rand() * TWO_PI,
        omega2: 0.3 + this.rand() * 0.5,
      });
    }
    this.E = 0;
    this.r = 0; // live order parameter, 0 = incoherent, 1 = perfect unison
    this.intensity = 1; // dramaturgy budget multiplier
    this._kickPull = 0;

    // Biome personality: the vertical band the swarm drifts toward.
    this._bandLo = 0.18;
    this._bandHi = 0.53;
    for (const o of this.oscillators) o.bandFrac = (o.ay - 0.18) / 0.35;
  }

  setBand(lo, hi) { this._bandLo = lo; this._bandHi = hi; }

  kick(vel = 0.8) {
    this._kickPull = 0.22 + 0.33 * vel;
  }

  update(nowMs, dtSec, energyCurves, beatPeriodMs = 500, calmLevel = 0) {
    this._tSec = nowMs / 1000;
    this._calmLevel = calmLevel; // draw() reads this for the wander orbit shape
    const eInstant = energyCurves ? clamp01(energyCurves.globalEnergy(nowMs, FLAT_WEIGHTS)) : 0.3;
    this.E += (1 - Math.exp(-dtSec / E_EMA_TAU)) * (eInstant - this.E);

    const K = K_MAX * this.E * (1 - 0.4 * calmLevel);
    const omega0 = TWO_PI / Math.max(0.2, beatPeriodMs / 1000); // one flash per beat when locked

    // Mean field: one pass for R and psi, one pass to advance phases.
    let sumCos = 0, sumSin = 0;
    for (const o of this.oscillators) { sumCos += Math.cos(o.theta); sumSin += Math.sin(o.theta); }
    const R = Math.hypot(sumCos, sumSin) / this.oscillators.length;
    const psi = Math.atan2(sumSin, sumCos);
    this.r = R;

    const pull = this._kickPull;
    this._kickPull = 0;
    const bandBlend = 1 - Math.exp(-dtSec / 2); // ~2s migration when the band moves
    for (const o of this.oscillators) {
      o.theta += (omega0 + o.detune + K * R * Math.sin(psi - o.theta)) * dtSec;
      if (pull > 0) o.theta += pull * Math.sin(-o.theta); // entrain the flash to the kick
      if (o.theta > TWO_PI) o.theta -= TWO_PI;
      else if (o.theta < 0) o.theta += TWO_PI;
      o.ay += (this._bandLo + o.bandFrac * (this._bandHi - this._bandLo) - o.ay) * bandBlend;
    }
  }

  draw(ctx, canvas, color) {
    const t = this._tSec || 0;
    const { ampMul, rateMul } = calmWanderParams(this._calmLevel || 0);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = color;
    const unison = this.r > 0.75 ? (this.r - 0.75) * 4 : 0; // extra halo once truly locked
    for (const o of this.oscillators) {
      const bright = Math.max(0, Math.cos(o.theta)) ** 3; // flash at theta = 0
      if (bright < 0.03) continue;
      const x = (o.ax + 0.06 * ampMul * Math.sin(o.omega2 * rateMul * t + o.phase)) * canvas.width;
      const y = (o.ay + 0.04 * ampMul * Math.sin(o.omega2 * rateMul * 0.7 * t + o.phase * 1.7)) * canvas.height;
      ctx.globalAlpha = 0.45 * bright * this.intensity;
      ctx.beginPath();
      ctx.arc(x, y, 1.6 + 1.4 * bright + 2 * unison * bright, 0, TWO_PI);
      ctx.fill();
    }
    ctx.restore();
  }
}
