// A starling murmuration in the mid-sky: Reynolds' three boid rules --
// separation (don't crowd), alignment (match neighbors' heading), and
// cohesion (drift toward the local center) -- plus a curl-noise steering
// term so the flock's wander stays organic rather than orbital. Heavy
// kicks startle the flock apart from its own center; it re-forms on its
// own because cohesion never sleeps. Calm sections slow the whole flock
// into lazy glides. O(N^2) neighbor checks at N=60 is nothing.
import { mulberry32, clamp01 } from '../utils/math.js';
import { curl2 } from '../utils/fields.js';
import { FLAT_WEIGHTS } from '../audio/bands.js';

const N = 60;
const R_NEIGHBOR = 60, R_SEPARATION = 17;
const W_SEP = 60, W_ALI = 1.4, W_COH = 0.9, W_NOISE = 30;
// Weak global centering: keeps sixty boids one flock instead of a dilute
// gas (at this density most boids would otherwise have no neighbors at
// all), and guarantees the flock re-forms after every startle.
const W_GLOBAL = 0.55;
const W_WIND = 0.5; // wind-assist: nudged, never overridden -- the flock still flies itself
const PANIC_DECAY_SEC = 0.8; // startle grants a brief overspeed allowance
const E_EMA_TAU = 0.4;

/**
 * How calm reshapes the curl-noise wander term the flock steers by, pure
 * so the mechanism is directly testable independent of the full N-boid
 * emergent system (whose flocking/centering forces make behavioral
 * statistics like path length noisy and hard to pin a bound on). Calm
 * doesn't just cap top speed (that already existed) -- it samples the SAME
 * noise field at a lower spatial frequency and slower time rate, which by
 * construction widens the field's correlation length: nearby boids' steering
 * agrees over a much larger area, so cohesion carries the whole flock
 * through broad arcs instead of each boid making small, locally-independent
 * corrections. Gain rises too, so the sweep has real reach rather than
 * reading as merely "the same wander, throttled."
 */
export function calmNoiseParams(calmLevel) {
  const c = clamp01(calmLevel);
  return {
    spatialScale: 1 - 0.55 * c, // lower -> larger-scale, more correlated swirls
    temporalScale: 1 - 0.4 * c, // lower -> the field evolves more slowly
    gainMul: 1 + 0.6 * c,       // higher -> the sweep reaches farther
  };
}

export class Murmuration {
  constructor(canvasWidth, canvasHeight, seed = 1, { n = N, noiseGain = W_NOISE } = {}) {
    this.w = canvasWidth;
    this.h = canvasHeight;
    this.rand = mulberry32((seed ^ 0xb14d5) >>> 0 || 1);
    this.noiseGain = noiseGain;
    this.boids = [];
    for (let i = 0; i < n; i++) {
      const ang = this.rand() * Math.PI * 2;
      this.boids.push({
        x: this.rand() * canvasWidth,
        y: (0.08 + this.rand() * 0.4) * canvasHeight,
        vx: Math.cos(ang) * 55, vy: Math.sin(ang) * 55,
        phase: this.rand() * Math.PI * 2, // wing-flap offset
      });
    }
    this.E = 0;
    this.intensity = 1;
    this._startle = 0;
    this._panic = 0;
  }

  startle(vel = 0.8) { this._startle = 140 + 160 * vel; this._panic = 1; }

  /** Shortest x-delta on the wrapped strip (period w+40). */
  _wrapDx(dx) {
    const period = this.w + 40;
    return dx - Math.round(dx / period) * period;
  }

  /** Flock centroid, x as a circular mean so the wrap seam can't split it. */
  _centroid() {
    const period = this.w + 40;
    let sx = 0, sy = 0, cy = 0;
    for (const b of this.boids) {
      const ang = (b.x / period) * Math.PI * 2;
      sx += Math.cos(ang); sy += Math.sin(ang);
      cy += b.y;
    }
    const ang = Math.atan2(sy, sx);
    return {
      x: ((ang / (Math.PI * 2)) * period + period) % period,
      y: cy / this.boids.length,
    };
  }

  update(nowMs, dtSec, energyCurves, calmLevel = 0, wind = null) {
    const eInstant = energyCurves ? clamp01(energyCurves.globalEnergy(nowMs, FLAT_WEIGHTS)) : 0.3;
    this.E += (1 - Math.exp(-dtSec / E_EMA_TAU)) * (eInstant - this.E);

    this._panic = Math.max(0, this._panic - dtSec / PANIC_DECAY_SEC);
    const maxSpeed = Math.max(38, (62 + 95 * this.E) * (1 - 0.35 * calmLevel)) * (1 + 1.4 * this._panic);
    const minSpeed = 26;
    const tSec = nowMs / 1000;
    const startle = this._startle;
    this._startle = 0;

    const { x: cxAll, y: cyAll } = this._centroid();

    for (const b of this.boids) {
      let sepX = 0, sepY = 0, aliX = 0, aliY = 0, cohX = 0, cohY = 0, count = 0;
      for (const o of this.boids) {
        if (o === b) continue;
        const dx = o.x - b.x, dy = o.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > R_NEIGHBOR * R_NEIGHBOR) continue;
        count++;
        aliX += o.vx; aliY += o.vy;
        cohX += dx; cohY += dy;
        if (d2 < R_SEPARATION * R_SEPARATION && d2 > 1e-6) {
          const inv = 1 / Math.sqrt(d2);
          sepX -= dx * inv; sepY -= dy * inv;
        }
      }
      let ax = sepX * W_SEP, ay = sepY * W_SEP;
      if (count > 0) {
        ax += (aliX / count - b.vx) * W_ALI;
        ay += (aliY / count - b.vy) * W_ALI;
        ax += (cohX / count) * W_COH;
        ay += (cohY / count) * W_COH;
      }
      const { spatialScale, temporalScale, gainMul } = calmNoiseParams(calmLevel);
      const flow = curl2(b.x * 0.0028 * spatialScale, b.y * 0.0028 * spatialScale, tSec * 0.08 * temporalScale);
      ax += flow.x * this.noiseGain * gainMul;
      ay += flow.y * this.noiseGain * gainMul;
      ax += this._wrapDx(cxAll - b.x) * W_GLOBAL;
      ay += (cyAll - b.y) * W_GLOBAL;
      if (wind) { ax += wind.x * W_WIND; ay += wind.y * W_WIND; }

      if (startle > 0) {
        const dx = this._wrapDx(b.x - cxAll), dy = b.y - cyAll;
        const d = Math.hypot(dx, dy) || 1;
        b.vx += (dx / d) * startle;
        b.vy += (dy / d) * startle;
      }

      b.vx += ax * dtSec;
      b.vy += ay * dtSec;

      const sp = Math.hypot(b.vx, b.vy) || 1e-6;
      const clamped = Math.max(minSpeed, Math.min(maxSpeed, sp));
      b.vx *= clamped / sp;
      b.vy *= clamped / sp;

      b.x += b.vx * dtSec;
      b.y += b.vy * dtSec;

      // Wrap horizontally; reflect softly off the vertical flight band.
      if (b.x < -20) b.x += this.w + 40; else if (b.x > this.w + 20) b.x -= this.w + 40;
      if (b.y < 0.03 * this.h) { b.y = 0.03 * this.h; b.vy = Math.abs(b.vy); }
      else if (b.y > 0.58 * this.h) { b.y = 0.58 * this.h; b.vy = -Math.abs(b.vy); }
    }
  }

  /** Mean distance from the flock's center (wrap-aware) -- for tests and tuning. */
  spread() {
    const { x: cx, y: cy } = this._centroid();
    let s = 0;
    for (const b of this.boids) s += Math.hypot(this._wrapDx(b.x - cx), b.y - cy);
    return s / this.boids.length;
  }

  /** Heading order parameter in [0,1] -- 1 means everyone flies the same way. */
  headingOrder() {
    let sx = 0, sy = 0;
    for (const b of this.boids) {
      const sp = Math.hypot(b.vx, b.vy) || 1e-6;
      sx += b.vx / sp; sy += b.vy / sp;
    }
    return Math.hypot(sx, sy) / this.boids.length;
  }

  draw(ctx, nowMs, color, mul = 1) {
    const tSec = nowMs / 1000;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = 0.55 * this.intensity;
    ctx.beginPath();
    const n = Math.min(this.boids.length, Math.max(0, Math.ceil(this.boids.length * mul)));
    for (let idx = 0; idx < n; idx++) {
      const b = this.boids[idx];
      const heading = Math.atan2(b.vy, b.vx);
      const flap = 0.55 + 0.4 * Math.sin(tSec * 16 + b.phase); // wing half-angle
      const len = 4.6;
      for (const side of [-1, 1]) {
        const a = heading + Math.PI - side * flap; // wings sweep back from the nose
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x + Math.cos(a) * len, b.y + Math.sin(a) * len);
      }
    }
    ctx.stroke();
    ctx.restore();
  }
}
