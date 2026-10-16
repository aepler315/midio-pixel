// A spirograph "resonance mandala" hanging in the deep background around
// the celestial body: two counter-rotating hypotrochoid layers whose pen
// offset sweeps continuously (morphing the figure from near-circle to
// spiky rose and back), whose rotation rate breathes with global track
// energy, and whose radius pops on kicks. Additive and hard-clamped on
// alpha so it reads as faint resonant geometry, never as clutter.
import { hypotrochoid } from '../render/oscillators.js';
import { mulberry32, clamp01 } from '../utils/math.js';
import { FLAT_WEIGHTS } from '../audio/bands.js';

// Coprime (p,q) pairs only, so each curve closes exactly after theta=2*pi*q.
const PAIRS = [[5, 2], [7, 3], [8, 3], [9, 4], [10, 3], [11, 4], [7, 2], [9, 2]];

// One rosette per pitch class (Movement III, "The Key of the World"): each
// key owns a distinct hypotrochoid figure, all still coprime pairs.
export const ROSETTE_TABLE = [
  [5, 2], [7, 2], [8, 3], [9, 2], [7, 3], [10, 3],
  [11, 3], [9, 4], [11, 4], [13, 4], [10, 7], [12, 5],
];
const SEGMENTS_PER_TURN = 48;
const E_EMA_TAU = 0.25;
const PULSE_DECAY_SEC = 0.18;
const D_SWEEP_SEC = 17; // slow autonomous pen-offset sweep, so the figure always evolves
const MAX_ALPHA = 0.16;

export class Mandala {
  constructor(seed = 1) {
    const rand = mulberry32(seed >>> 0 || 1);
    const first = Math.floor(rand() * PAIRS.length);
    let second = Math.floor(rand() * PAIRS.length);
    if (second === first) second = (second + 3) % PAIRS.length;
    this.layers = [
      { pair: PAIRS[first], spin: 1, radiusFrac: 1.0, alpha: 0.10, rot: rand() * Math.PI * 2 },
      { pair: PAIRS[second], spin: -0.6, radiusFrac: 0.66, alpha: 0.07, rot: rand() * Math.PI * 2 },
    ];
    this.E = 0;
    this.pulse = 0;
    this.tSec = 0;
    this.intensity = 1; // dramaturgy budget multiplier
    this.rateMul = 1; // biome personality: rotation-rate multiplier
  }

  kick() { this.pulse = 1; }

  /** The Key of the World: re-seed both layers' hypotrochoid ratios from
   *  ROSETTE_TABLE, indexed by pitch class, fired on a confirmed key
   *  change. The second layer sits a fifth away from the first -- the
   *  mandala re-forms as a different figure, in tune with the new tonic. */
  reseed(pc) {
    const i = ((pc % 12) + 12) % 12;
    this.layers[0].pair = ROSETTE_TABLE[i];
    this.layers[1].pair = ROSETTE_TABLE[(i + 7) % 12];
  }

  update(nowMs, dtSec, energyCurves, calmLevel = 0) {
    this.tSec = nowMs / 1000;
    const eInstant = energyCurves ? clamp01(energyCurves.globalEnergy(nowMs, FLAT_WEIGHTS)) : 0.3;
    this.E += (1 - Math.exp(-dtSec / E_EMA_TAU)) * (eInstant - this.E);
    this.pulse *= Math.exp(-dtSec / PULSE_DECAY_SEC);

    const rate = (0.25 + 0.9 * this.E) * (1 - 0.45 * calmLevel) * this.rateMul;
    for (const layer of this.layers) layer.rot += layer.spin * rate * dtSec;
  }

  draw(ctx, cx, cy, baseRadius, color) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = color;

    const wobbleAmp = 0.05 * this.E;
    const scalePop = 1 + 0.12 * this.pulse;

    for (const layer of this.layers) {
      const [p, q] = layer.pair;
      // Pen offset sweeps 0.3..1.4 of the rolling radius: near-circle at
      // the low end, sharp overlapping petals at the high end.
      const dFrac = 0.3 + 0.55 * (1 + Math.sin((2 * Math.PI * this.tSec) / D_SWEEP_SEC + layer.rot * 0.1));
      const d = q * dFrac * (1 + 0.4 * this.E);
      const extent = (p - q) + d; // max radius of the raw curve in abstract units
      const scale = (baseRadius * layer.radiusFrac * scalePop) / extent;

      const steps = SEGMENTS_PER_TURN * q;
      const span = 2 * Math.PI * q; // exact closure period for coprime p,q
      ctx.globalAlpha = Math.min(MAX_ALPHA, layer.alpha * (0.55 + 0.45 * this.E) * (1 + 0.5 * this.pulse)) * this.intensity;
      ctx.lineWidth = 1.2 + this.pulse;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const theta = (i / steps) * span;
        const pt = hypotrochoid(theta, p, q, d);
        const wobble = 1 + wobbleAmp * Math.sin(6 * theta - 2.7 * this.tSec);
        const cos = Math.cos(layer.rot), sin = Math.sin(layer.rot);
        const x = cx + (pt.x * cos - pt.y * sin) * scale * wobble;
        const y = cy + (pt.x * sin + pt.y * cos) * scale * wobble;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}
