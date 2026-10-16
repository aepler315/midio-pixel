// Cymatic sky-dust: a constellation of particles living on an invisible
// Chladni plate spanning the upper sky. Real cymatics physics, simplified:
// sand on a vibrating plate random-walks with step size proportional to
// the local vibration amplitude |z| (it gets kicked around hardest at the
// antinodes) and so inevitably accumulates along the nodal lines where
// |z| ~ 0 -- the geometric figures sound traces on a plate. Here the
// plate's excitation follows track energy: loud sections keep the dust
// seething and formless, calm sections let it crystallize into a crisp
// figure. Every 8 bars the (m,n) mode re-rolls and the constellation
// visibly migrates into its new geometry.
import { chladni, chladniGrad } from '../render/oscillators.js';
import { mulberry32, clamp01 } from '../utils/math.js';
import { FLAT_WEIGHTS } from '../audio/bands.js';

// (m,n) mode pairs, m != n (m == n makes the figure identically zero).
const MODES = [[1, 2], [1, 3], [2, 3], [1, 4], [2, 5], [3, 4], [2, 7], [3, 5]];
const COUNT = 320;
const E_EMA_TAU = 0.35;
const GRAD_GAIN = 0.010;  // deterministic descent toward the nodal lines
const JITTER_GAIN = 0.10; // amplitude-scaled thermal kick away from them
const MODE_PERIOD_BARS = 8;

export class CymaticField {
  constructor(seed = 1) {
    this.rand = mulberry32((seed ^ 0xc9a71a) >>> 0 || 1);
    this.particles = [];
    for (let i = 0; i < COUNT; i++) this.particles.push({ u: this.rand(), v: this.rand() });
    this.modeIdx = Math.floor(this.rand() * MODES.length);
    this._barCount = 0;
    this.E = 0;
    this.intensity = 1; // dramaturgy budget multiplier
    this.modePool = null; // biome personality: allowed MODES indices, null = all
  }

  onBar() {
    this._barCount++;
    if (this._barCount % MODE_PERIOD_BARS === 0) {
      const pool = this.modePool && this.modePool.length
        ? this.modePool
        : MODES.map((_, i) => i);
      let next = pool[Math.floor(this.rand() * pool.length)];
      if (next === this.modeIdx) next = pool[(pool.indexOf(next) + 1) % pool.length];
      this.modeIdx = next;
    }
  }

  update(nowMs, dtSec, energyCurves, calmLevel = 0) {
    const eInstant = energyCurves ? clamp01(energyCurves.globalEnergy(nowMs, FLAT_WEIGHTS)) : 0.3;
    this.E += (1 - Math.exp(-dtSec / E_EMA_TAU)) * (eInstant - this.E);

    const [m, n] = MODES[this.modeIdx];
    // Loud: the plate rings hard and the dust seethes. Calm: agitation
    // drops and the figure sharpens -- calm sections get MORE structure.
    const agitation = (0.25 + 1.4 * this.E) * (1 - 0.35 * calmLevel);
    const rand = this.rand;

    for (const p of this.particles) {
      const z = chladni(p.u, p.v, m, n);
      const g = chladniGrad(p.u, p.v, m, n);
      const absZ = Math.abs(z);
      // Descend |z|^2 (deterministic settle) + |z|-scaled random walk (physical seethe).
      p.u += (-z * g.du * GRAD_GAIN + (rand() * 2 - 1) * absZ * agitation * JITTER_GAIN) * dtSec * 8;
      p.v += (-z * g.dv * GRAD_GAIN + (rand() * 2 - 1) * absZ * agitation * JITTER_GAIN) * dtSec * 8;
      // Reflect at the plate edges so dust never escapes or piles on a wall.
      if (p.u < 0.02) p.u = 0.04 - p.u; else if (p.u > 0.98) p.u = 1.96 - p.u;
      if (p.v < 0.02) p.v = 0.04 - p.v; else if (p.v > 0.98) p.v = 1.96 - p.v;
    }
  }

  /** Mean |z| across the dust -- 0 means fully settled onto the nodal figure. */
  meanAmplitude() {
    const [m, n] = MODES[this.modeIdx];
    let s = 0;
    for (const p of this.particles) s += Math.abs(chladni(p.u, p.v, m, n));
    return s / this.particles.length;
  }

  /** The plate spans the full width and the top ~55% of the sky. */
  draw(ctx, canvas, color) {
    const h = canvas.height * 0.55;
    const [m, n] = MODES[this.modeIdx];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = color;
    for (const p of this.particles) {
      const absZ = Math.abs(chladni(p.u, p.v, m, n));
      // Settled dust glows brightest -- the figure emerges as lines of light.
      ctx.globalAlpha = (0.06 + 0.36 * (1 - Math.min(1, absZ))) * this.intensity;
      ctx.fillRect(p.u * canvas.width, p.v * h, 1.8, 1.8);
    }
    ctx.restore();
  }
}
