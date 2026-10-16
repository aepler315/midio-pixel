// A ribbon of light tracing Thomas' cyclically symmetric attractor,
// RK4-integrated in 3D and projected onto the sky with a slow tumbling
// rotation. The attractor's damping parameter b is driven by track
// energy, which is a genuine bifurcation sweep: calm sections raise b
// toward ~0.32 (the trajectory relaxes into gentle, almost periodic
// orbits), loud sections drop it toward ~0.19 (fully chaotic tangles).
// The music doesn't just style this curve -- it moves the system across
// its own bifurcation diagram. Kicks jolt the state sideways, visibly
// kinking the ribbon on the beat.
import { thomasDeriv, rk4Step3 } from '../render/oscillators.js';
import { mulberry32, clamp01, lerp } from '../utils/math.js';
import { FLAT_WEIGHTS } from '../audio/bands.js';

const TRAIL_LEN = 420;
const E_EMA_TAU = 0.4;
const B_CALM = 0.32, B_CHAOS = 0.19;
const SUBSTEPS = 3;
const YAW_RATE = 0.11, PITCH_RATE = 0.05;

export class ChaosRibbon {
  constructor(seed = 1) {
    const rand = mulberry32((seed ^ 0x7e11a5) >>> 0 || 1);
    this.s = { x: 1.1 + rand() * 0.5, y: 0.3 - rand() * 0.5, z: -0.6 + rand() * 0.5 };
    this.rand = rand;
    this.trail = []; // projected 2D points, unscaled attractor units
    this.E = 0;
    this.intensity = 1; // dramaturgy budget multiplier
    this.yaw = rand() * Math.PI * 2;
    this.pitch = 0;
    this._jolt = 0;
  }

  kick() { this._jolt = 0.45; }

  update(nowMs, dtSec, energyCurves, calmLevel = 0) {
    const eInstant = energyCurves ? clamp01(energyCurves.globalEnergy(nowMs, FLAT_WEIGHTS)) : 0.3;
    this.E += (1 - Math.exp(-dtSec / E_EMA_TAU)) * (eInstant - this.E);

    // The bifurcation knob: energy sweeps b from near-periodic to chaotic.
    const b = lerp(B_CALM, B_CHAOS, this.E) + 0.02 * calmLevel;
    const speed = 2.2 * (0.5 + 1.3 * this.E); // attractor-time per real second

    if (this._jolt > 0) {
      this.s.x += (this.rand() * 2 - 1) * this._jolt;
      this.s.z += (this.rand() * 2 - 1) * this._jolt;
      this._jolt = 0;
    }

    const h = (speed * dtSec) / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) this.s = rk4Step3(thomasDeriv, this.s, h, b);

    // Thomas is bounded for the b range we use, but a NaN or an escape
    // (e.g. from an unlucky jolt) must never kill the ribbon.
    const { x, y, z } = this.s;
    if (!Number.isFinite(x + y + z) || Math.abs(x) + Math.abs(y) + Math.abs(z) > 40) {
      this.s = { x: 1.1, y: 0.3, z: -0.6 };
      this.trail.length = 0;
    }

    this.yaw += YAW_RATE * dtSec;
    this.pitch = 0.5 * Math.sin(PITCH_RATE * 2 * Math.PI * (nowMs / 1000) * 0.3);

    // Project: yaw about the vertical axis, then pitch about the horizontal.
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const rx = this.s.x * cy + this.s.z * sy;
    const rz = -this.s.x * sy + this.s.z * cy;
    const ry = this.s.y * cp - rz * sp;
    this.trail.push({ x: rx, y: ry });
    if (this.trail.length > TRAIL_LEN) this.trail.shift();
  }

  draw(ctx, cx, cy, scale, color) {
    const n = this.trail.length;
    if (n < 8) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.2;
    // Six alpha-stepped chunks: the ribbon fades in from its tail so the
    // head reads as the living tip of the trajectory.
    const CHUNKS = 6;
    for (let c = 0; c < CHUNKS; c++) {
      const i0 = Math.floor((c / CHUNKS) * (n - 1));
      const i1 = Math.floor(((c + 1) / CHUNKS) * (n - 1));
      ctx.globalAlpha = (0.05 + 0.30 * ((c + 1) / CHUNKS) * (0.5 + 0.5 * this.E)) * this.intensity;
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) {
        const p = this.trail[i];
        const px = cx + p.x * scale, py = cy + p.y * scale;
        if (i === i0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    // The head: a small bright bead.
    const head = this.trail[n - 1];
    ctx.globalAlpha = 0.7 * this.intensity;
    ctx.beginPath();
    ctx.arc(cx + head.x * scale, cy + head.y * scale, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
