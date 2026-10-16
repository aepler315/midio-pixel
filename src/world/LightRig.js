// Concert light beams (The Light Show, pass 3): volumetric-looking beams
// anchored at the celestial body. Calm sections get one soft, slow "god
// ray"; hot sections fan into 3-5 beat-locked sweeping spotlights; every
// drop snaps the whole rig onto Midio for a moment before fanning back out.
// The classic cheap Canvas-2D fake-volumetric trick: a soft wide tapered
// gradient triangle under a bright narrow one.
import { clamp01, lerp, mulberry32 } from '../utils/math.js';
import { capFlashAlpha } from '../ui/Accessibility.js';
import { hexToRgb } from '../utils/color.js';

const MAX_BEAMS = 5;
const FAN_GAP_RAD = 0.17;        // ~9.7deg spacing between adjacent beam centers at rest
const BASE_THETA_RAD = 0.30;     // ~17deg tilt from straight-down, biased toward Midio's lane
const HALF_ANGLE_CALM = 0.115;   // ~6.6deg cone half-angle: wide, soft, one diffuse god-ray
const HALF_ANGLE_HOT = 0.05;     // ~2.9deg: narrow enough that beams read as distinct fingers
const SWAY_AMP_RAD = 0.09;       // ~5deg sway for the lone calm beam
const SWEEP_AMP_HOT = 0.5;       // ~29deg half-swing per beam at full heat
const CALM_OMEGA = (2 * Math.PI) / 9; // one full sway every 9s -- slow, tempo-independent drift
const HOT_SWEEP_DIV = 2;         // at full heat, one full sweep every 2 beat-intervals
const HEAT_TAU = 1.4;            // seconds; calm<->hot breathes across a phrase, never pops
const PRESENCE_TAU = 0.55;       // seconds; beams 4-5 fade in/out rather than popping
const SNAP_ATTACK_MS = 90;
const SNAP_RELEASE_MS = 320;
const SNAP_FOCUS = 0.45;         // fraction the cone narrows at full snap
const SNAP_BOOST = 2.4;          // alpha multiplier at full snap (routed through capFlashAlpha)
const BEAM_LEN_MUL = 1.25;       // x canvas.height
const ALPHA_BODY = 0.10;
const ALPHA_CORE = 0.26;

/** Drop-snap convergence envelope: linear snap-in, exponential fan-back-out.
 *  0 for any non-finite/negative age (also correctly 0 before the first
 *  trigger(), since ageMs is then +Infinity). */
export function snapEnvelope(ageMs) {
  if (!(ageMs >= 0)) return 0;
  if (ageMs < SNAP_ATTACK_MS) return ageMs / SNAP_ATTACK_MS;
  return Math.exp(-(ageMs - SNAP_ATTACK_MS) / SNAP_RELEASE_MS);
}

/** Sweep angular rate: a slow tempo-independent drift when calm, blending
 *  toward a beat-locked rate (one full sweep every HOT_SWEEP_DIV beats) as
 *  heat rises -- the same "read _beatMs" trick KuramotoSwarm uses. */
export function sweepOmega(beatMs, heat) {
  const omega0 = (2 * Math.PI) / Math.max(0.15, (beatMs || 500) / 1000);
  const hotOmega = omega0 / HOT_SWEEP_DIV;
  return lerp(CALM_OMEGA, hotOmega, clamp01(heat));
}

/** One beam's angle from straight-down: its fan position plus a bounded sway/sweep. */
export function beamAngle(baseTheta, spreadOffset, sweepAmp, ampMul, sweepPhase, phaseOffset) {
  return baseTheta + spreadOffset + sweepAmp * ampMul * Math.sin(sweepPhase + phaseOffset);
}

/** Triangle points for one beam: tip at the anchor, two edges `length` away
 *  at theta +/- halfAngle. theta=0 is straight down. */
export function beamTrianglePoints(cx, cy, theta, halfAngle, length) {
  const edge = (a) => ({ x: cx - Math.sin(a) * length, y: cy + Math.cos(a) * length });
  return { tip: { x: cx, y: cy }, left: edge(theta - halfAngle), right: edge(theta + halfAngle) };
}

/** A beam pass's alpha: scaled by presence/budget, boosted on a drop-snap,
 *  and always capped through the accessibility flash limiter -- this is
 *  what makes the snap's brightness spike respect reduced-flash. */
export function beamAlpha(baseAlpha, presence, budget, snap, reducedFlash) {
  const raw = baseAlpha * presence * (0.4 + 0.6 * clamp01(budget)) * (1 + (SNAP_BOOST - 1) * clamp01(snap));
  return capFlashAlpha(raw, reducedFlash);
}

export class LightRig {
  constructor(seed = 1) {
    this.rand = mulberry32((seed ^ 0x7a17c) >>> 0 || 1);
    // Each instance settles on its own "how big is the rig" personality.
    this.hotBeamCount = 3 + Math.floor(this.rand() * 3); // 3, 4, or 5
    this.beams = Array.from({ length: MAX_BEAMS }, (_, i) => ({
      spreadOffset: (i - (MAX_BEAMS - 1) / 2) * FAN_GAP_RAD,
      phaseOffset: this.rand() * Math.PI * 2,
      ampMul: 0.8 + 0.4 * this.rand(),
      presence: i === 0 ? 1 : 0, // beam 0 (the god ray) starts present; others fade in as heat rises
    }));
    this.heat = 0;
    this.sweepPhase = 0;
    this._snapStartMs = -Infinity;
    this.targetX = 0;
    this.targetY = 0;
    this.snap = 0;
    this.budget = 1;
  }

  update(nowMs, dtSec, beatMs, calmLevel, budget, fever = 0) {
    this.budget = budget;
    // Fever pushes the rig hot even through a calm section -- a player on
    // a streak earns the light show regardless of what the song is doing.
    const heatTarget = clamp01(1 - calmLevel + 0.5 * fever);
    this.heat += (1 - Math.exp(-dtSec / HEAT_TAU)) * (heatTarget - this.heat);

    const effOmega = sweepOmega(beatMs, this.heat);
    this.sweepPhase += effOmega * dtSec;

    const activeTarget = 1 + this.heat * (this.hotBeamCount - 1);
    for (let i = 0; i < this.beams.length; i++) {
      const b = this.beams[i];
      const presenceTarget = clamp01(activeTarget - i);
      b.presence += (1 - Math.exp(-dtSec / PRESENCE_TAU)) * (presenceTarget - b.presence);
    }

    this.snap = snapEnvelope(nowMs - this._snapStartMs);
  }

  /** Drops snap every beam toward (targetX, targetY) -- typically Midio's
   *  screen position -- for a moment before fanning back out. Safe to call
   *  redundantly; just restarts the envelope from age 0. */
  trigger(nowMs, targetX, targetY) {
    this._snapStartMs = nowMs;
    this.targetX = targetX;
    this.targetY = targetY;
  }

  draw(ctx, canvas, cx, cy, haloColor, particleMul, reducedFlash, presentation = 1) {
    const { r, g, b } = hexToRgb(haloColor);
    const rgb = `${r},${g},${b}`;
    const halfAngleBase = lerp(HALF_ANGLE_CALM, HALF_ANGLE_HOT, this.heat);
    const sweepAmp = lerp(SWAY_AMP_RAD, SWEEP_AMP_HOT, this.heat);
    const targetTheta = Math.atan2(-(this.targetX - cx), this.targetY - cy);
    const drawnBeams = Math.max(1, Math.round(this.hotBeamCount * clamp01(particleMul)));
    const drawCore = particleMul >= 1;
    const len = canvas.height * BEAM_LEN_MUL;

    const inherited = Number.isFinite(ctx.globalAlpha) ? ctx.globalAlpha : 1;
    const present = Number.isFinite(presentation) ? Math.min(1, Math.max(0, presentation)) : 1;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = inherited * present;
    for (let i = 0; i < drawnBeams; i++) {
      const beam = this.beams[i];
      if (beam.presence <= 0.01) continue;
      const fanTheta = beamAngle(BASE_THETA_RAD, beam.spreadOffset, sweepAmp, beam.ampMul, this.sweepPhase, beam.phaseOffset);
      const theta = lerp(fanTheta, targetTheta, this.snap);
      const halfAngle = halfAngleBase * (1 - SNAP_FOCUS * this.snap);
      const { tip, left, right } = beamTrianglePoints(cx, cy, theta, halfAngle, len);

      const bodyAlpha = beamAlpha(ALPHA_BODY, beam.presence, this.budget, this.snap, reducedFlash);
      const grad = ctx.createLinearGradient(tip.x, tip.y, (left.x + right.x) / 2, (left.y + right.y) / 2);
      grad.addColorStop(0, `rgba(${rgb},${bodyAlpha})`);
      grad.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.moveTo(tip.x, tip.y); ctx.lineTo(left.x, left.y); ctx.lineTo(right.x, right.y); ctx.closePath(); ctx.fill();

      if (drawCore) {
        const coreAlpha = beamAlpha(ALPHA_CORE, beam.presence, this.budget, this.snap, reducedFlash);
        const { left: cl, right: cr } = beamTrianglePoints(cx, cy, theta, halfAngle * 0.35, len);
        const coreGrad = ctx.createLinearGradient(tip.x, tip.y, (cl.x + cr.x) / 2, (cl.y + cr.y) / 2);
        coreGrad.addColorStop(0, `rgba(${rgb},${coreAlpha})`);
        coreGrad.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = coreGrad;
        ctx.beginPath(); ctx.moveTo(tip.x, tip.y); ctx.lineTo(cl.x, cl.y); ctx.lineTo(cr.x, cr.y); ctx.closePath(); ctx.fill();
      }
    }
    ctx.restore();
  }
}
