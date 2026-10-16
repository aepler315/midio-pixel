// Gray-Scott reaction-diffusion breathing on the ground: two virtual
// chemicals U ("food") and V ("organism") on a coarse toroidal-in-x grid,
//   u' = Du*lap(u) - u*v^2 + F*(1-u)
//   v' = Dv*lap(v) + u*v^2 - (F+k)*v
// -- the classic Turing-pattern system whose (F,k) plane holds mitosing
// spots, coral stripes, and traveling waves. Track energy sweeps (F,k)
// between three known regimes, so calm sections grow slow dividing cells
// and loud sections shift the same living texture into restless waves.
// Every kick seeds a new V droplet: the beat literally inoculates growth
// sites. Simulated at 120 Hz on a 128x32 grid (a few hundred thousand
// flops/sec -- nothing), rendered as a soft additive glow clipped inside
// the ground slices.
import { mulberry32, lerp, clamp01 } from '../utils/math.js';
import { FLAT_WEIGHTS } from '../audio/bands.js';

const W = 128, H = 32;
const DU = 1.0, DV = 0.5, DT = 1.0; // Karl Sims' stable discretization
// (F, k) regime waypoints along the energy axis.
const REGIME_CALM = { F: 0.0367, k: 0.0649 }; // mitosis: slowly dividing spots
const REGIME_MID = { F: 0.0545, k: 0.0620 };  // coral growth: branching stripes
const REGIME_LOUD = { F: 0.0180, k: 0.0510 }; // pulsating waves
const E_EMA_TAU = 1.2; // regime shifts should be slow -- patterns need time to answer

export class ReactionDiffusion {
  constructor(seed = 1) {
    this.rand = mulberry32((seed ^ 0x6d2b79) >>> 0 || 1);
    this.u = new Float32Array(W * H).fill(1);
    this.v = new Float32Array(W * H);
    this._u2 = new Float32Array(W * H);
    this._v2 = new Float32Array(W * H);
    this.E = 0;
    this.intensity = 1; // dramaturgy budget multiplier
    this.bias = 0; // biome personality: shifts the regime sweep along the energy axis
    this.w = W;
    this.h = H;

    for (let i = 0; i < 6; i++) this.seedDroplet();
    for (let i = 0; i < 400; i++) this.step(REGIME_CALM.F, REGIME_CALM.k); // warm up so the song never starts blank

    this._canvas = null; // lazily created; Node tests never touch it
    this._imageData = null;
  }

  seedDroplet() {
    const cx = Math.floor(this.rand() * W);
    const cy = 2 + Math.floor(this.rand() * (H - 4));
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx * dx + dy * dy > 4) continue;
        const x = (cx + dx + W) % W;
        const y = Math.max(0, Math.min(H - 1, cy + dy));
        this.v[y * W + x] = 1;
        this.u[y * W + x] = 0.5;
      }
    }
  }

  /** One Gray-Scott iteration. Wraps in x (the ground scrolls), clamps in y. */
  step(F, k) {
    const { u, v, _u2: u2, _v2: v2 } = this;
    for (let y = 0; y < H; y++) {
      const yN = Math.max(0, y - 1) * W, yS = Math.min(H - 1, y + 1) * W, y0 = y * W;
      for (let x = 0; x < W; x++) {
        const xW = (x + W - 1) % W, xE = (x + 1) % W;
        const i = y0 + x;
        // 9-point Laplacian: adjacent 0.2, diagonal 0.05, center -1.
        const lapU = 0.2 * (u[y0 + xW] + u[y0 + xE] + u[yN + x] + u[yS + x])
                   + 0.05 * (u[yN + xW] + u[yN + xE] + u[yS + xW] + u[yS + xE])
                   - u[i];
        const lapV = 0.2 * (v[y0 + xW] + v[y0 + xE] + v[yN + x] + v[yS + x])
                   + 0.05 * (v[yN + xW] + v[yN + xE] + v[yS + xW] + v[yS + xE])
                   - v[i];
        const uvv = u[i] * v[i] * v[i];
        let nu = u[i] + (DU * lapU - uvv + F * (1 - u[i])) * DT;
        let nv = v[i] + (DV * lapV + uvv - (F + k) * v[i]) * DT;
        u2[i] = nu < 0 ? 0 : nu > 1 ? 1 : nu;
        v2[i] = nv < 0 ? 0 : nv > 1 ? 1 : nv;
      }
    }
    this.u = u2; this._u2 = u;
    this.v = v2; this._v2 = v;
  }

  update(nowMs, dtSec, energyCurves, calmLevel = 0) {
    const eInstant = energyCurves ? clamp01(energyCurves.globalEnergy(nowMs, FLAT_WEIGHTS)) : 0.3;
    this.E += (1 - Math.exp(-dtSec / E_EMA_TAU)) * (eInstant - this.E);

    // Sweep (F,k) piecewise-linearly: calm -> mid -> loud along the energy axis.
    const e = clamp01(this.E * (1 - 0.3 * calmLevel) + this.bias);
    const t = e < 0.5 ? e * 2 : (e - 0.5) * 2;
    const a = e < 0.5 ? REGIME_CALM : REGIME_MID;
    const b = e < 0.5 ? REGIME_MID : REGIME_LOUD;
    this.step(lerp(a.F, b.F, t), lerp(a.k, b.k, t));
  }

  onKick() { this.seedDroplet(); }

  /** V concentration -> soft white glow, stretched across the ground band. */
  draw(ctx, canvas, worldX, groundTopY) {
    if (!this._canvas) {
      this._canvas = document.createElement('canvas');
      this._canvas.width = W; this._canvas.height = H;
      this._cctx = this._canvas.getContext('2d');
      this._imageData = this._cctx.createImageData(W, H);
      const d = this._imageData.data;
      for (let i = 0; i < W * H; i++) { d[i * 4] = 255; d[i * 4 + 1] = 255; d[i * 4 + 2] = 255; }
    }
    const d = this._imageData.data;
    for (let i = 0; i < W * H; i++) {
      d[i * 4 + 3] = Math.min(255, Math.max(0, (this.v[i] - 0.12) * 620)) | 0;
    }
    this._cctx.putImageData(this._imageData, 0, 0);

    const bandH = canvas.height - groundTopY;
    const ox = ((worldX * 0.4) % canvas.width + canvas.width) % canvas.width;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.13 * this.intensity;
    ctx.drawImage(this._canvas, -ox, groundTopY, canvas.width, bandH);
    ctx.drawImage(this._canvas, canvas.width - ox, groundTopY, canvas.width, bandH);
    ctx.restore();
  }
}
