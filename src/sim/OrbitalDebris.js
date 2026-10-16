// Gravitational shard debris orbiting Midasus: a genuine (softened)
// N-body system, not parametric orbits. Each shard feels Plummer-softened
// gravity toward her -- a = -G*M*d / (|d|^2 + eps^2)^(3/2) -- plus a tiny
// pairwise attraction that makes shards clump transiently, integrated
// with symplectic Euler (the energy-preserving choice for orbits). Since
// she darts between pitch targets with real acceleration, the debris
// trails and slingshots behind her the way physics says it must. Note
// onsets pulse her effective mass (orbits momentarily tighten) and fling
// a radial impulse; escapees are recaptured onto fresh circular orbits.
import { mulberry32 } from '../utils/math.js';

export const GM_BASE = 3.2e6; // px^3/s^2: ~2.5s orbital period at r=80px
export const SOFTEN2 = 25 * 25; // Plummer softening: no singular slingshots
const GM_PAIR = 2200;         // shard-shard attraction, deliberately faint
const DAMPING = 0.05;         // per-second velocity bleed, keeps orbits bound
const R_MAX = 420, R_MIN = 4;
const N = 13;

export class OrbitalDebris {
  constructor(seed = 1, { n = N, damping = DAMPING, pairGravity = true, recapture = true } = {}) {
    this.rand = mulberry32((seed ^ 0x0db175) >>> 0 || 1);
    this.damping = damping;
    this.pairGravity = pairGravity;
    this.recapture = recapture;
    this.shards = [];
    for (let i = 0; i < n; i++) this.shards.push(this._spawn(0, 0));
  }

  _spawn(ax, ay) {
    const r = 55 + this.rand() * 60;
    const ang = this.rand() * Math.PI * 2;
    const dir = this.rand() < 0.5 ? -1 : 1;
    const vCirc = Math.sqrt(GM_BASE / r);
    return {
      x: ax + Math.cos(ang) * r, y: ay + Math.sin(ang) * r,
      vx: -Math.sin(ang) * vCirc * dir, vy: Math.cos(ang) * vCirc * dir,
      size: 2.5 + this.rand() * 3.5,
      rot: this.rand() * Math.PI * 2,
      spin: (this.rand() * 2 - 1) * 4,
    };
  }

  /** Radial impulse away from the attractor -- fired on note onsets. */
  burst(strength) {
    this._burst = 60 + 140 * strength;
  }

  update(dtSec, attractor, massMul = 1) {
    const GM = GM_BASE * massMul;
    const shards = this.shards;
    const burst = this._burst || 0;
    this._burst = 0;

    for (const s of shards) {
      const dx = attractor.x - s.x, dy = attractor.y - s.y;
      const d2 = dx * dx + dy * dy;
      const inv = 1 / Math.pow(d2 + SOFTEN2, 1.5);
      let axAcc = GM * dx * inv, ayAcc = GM * dy * inv;

      if (this.pairGravity) {
        for (const o of shards) {
          if (o === s) continue;
          const px = o.x - s.x, py = o.y - s.y;
          const p2 = px * px + py * py + 400; // heavily softened: a suggestion, not a collision
          const pinv = 1 / Math.pow(p2, 1.5);
          axAcc += GM_PAIR * px * pinv;
          ayAcc += GM_PAIR * py * pinv;
        }
      }

      if (burst > 0 && d2 > 1) {
        const dInv = 1 / Math.sqrt(d2);
        s.vx -= dx * dInv * burst; // outward: away from the attractor
        s.vy -= dy * dInv * burst;
      }

      // Symplectic Euler: kick then drift -- orbits precess, never explode.
      s.vx = (s.vx + axAcc * dtSec) * (1 - this.damping * dtSec);
      s.vy = (s.vy + ayAcc * dtSec) * (1 - this.damping * dtSec);
      s.x += s.vx * dtSec;
      s.y += s.vy * dtSec;
      s.rot += s.spin * dtSec;

      if (this.recapture) {
        const rNow2 = (s.x - attractor.x) ** 2 + (s.y - attractor.y) ** 2;
        if (rNow2 > R_MAX * R_MAX || rNow2 < R_MIN * R_MIN) {
          Object.assign(s, this._spawn(attractor.x, attractor.y));
        }
      }
    }
  }

  draw(ctx, hue, rest = 0, mul = 1) {
    const sat = Math.round(85 - 40 * rest);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 1.3;
    const n = Math.min(this.shards.length, Math.max(0, Math.ceil(this.shards.length * mul)));
    for (let idx = 0; idx < n; idx++) {
      const s = this.shards[idx];
      ctx.strokeStyle = `hsla(${hue},${sat}%,68%,0.55)`;
      ctx.beginPath();
      for (let i = 0; i <= 3; i++) {
        const a = s.rot + (i % 3) * (Math.PI * 2 / 3);
        const px = s.x + Math.cos(a) * s.size;
        const py = s.y + Math.sin(a) * s.size;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}
