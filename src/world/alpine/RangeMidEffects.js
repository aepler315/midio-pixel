import { CanvasBuffers } from '../../render/CanvasResidency.js';
import { groundGlowLights } from '../../render/LightField.js';
import { particleBlendAlphas } from '../WorldDraw.js';

// ParticleField.draw only reads these properties. Copy each particle and its
// optional Bézier points so a delayed capture cannot observe simulation steps.
function snapshotField(field) {
  if (!field) return null;
  return { kind: field.kind, color: field.color, draw: field.draw,
    particles: field.particles.map(p => ({ ...p,
      ...(p.origin ? { origin: { ...p.origin } } : {}),
      ...(p.ctrl ? { ctrl: { ...p.ctrl } } : {}),
      ...(p.end ? { end: { ...p.end } } : {}),
    })) };
}

/** Freeze the Range's source-over particle fields and their lighting at the
 * completed frame, without advancing or sharing the simulation on replay. */
export function captureRangeParticles(manager, frame, { mandalaColor, worldX, originX }) {
  const { from, to } = manager.currentBlend || { from: frame.A.name, to: frame.B.name };
  const same = from === to, open = manager.openingGain, t = frame.t;
  const { outgoing, incoming } = particleBlendAlphas(t, open, same, manager._rangeSky?.decorativeAlpha ?? 1);
  const first = snapshotField(manager.fields.get(from));
  const second = same ? null : snapshotField(manager.fields.get(to));
  const weather = manager._activeWeatherIntensity > .01
    ? snapshotField(manager.weatherFields.get(manager.drawnWeatherKind())) : null;
  const intensity = manager._activeWeatherIntensity, mul = frame.particleMul, unravel = manager.unravel;
  const rim = manager._perf ? manager._perf.rimLightEnabled : true;
  const lights = rim ? [manager.light, ...groundGlowLights(
    manager.groundField ? manager.groundField.activeGlowScreenLights(worldX, originX) : [], mandalaColor,
  )].filter(Boolean).map(light => ({ ...light })) : null;
  return ({ ctx }) => {
    const draw = (field, alpha, density) => {
      if (!field || !(alpha > .001)) return;
      ctx.save(); ctx.globalAlpha = alpha;
      field.draw(ctx, density, mandalaColor, unravel, lights);
      ctx.restore();
    };
    draw(first, outgoing, mul);
    if (!same && t > .02) draw(second, incoming, mul);
    draw(weather, open, intensity * mul);
  };
}

/** Full-resolution mid-distance weather, clipped by the following terrain
 * partition. The painter is source-over, just like the original particle
 * pass; its scene transform stays in native-grid coordinates until replay. */
export class RangeMidEffects {
  constructor({ residency, buffers } = {}) {
    this.buffers = buffers || new CanvasBuffers({ ...(residency ? { residency } : {}), owner: 'range-mid-effects' });
    this.frame = null;
  }

  prepare(ctx, frame, paint, size, presentation) {
    this.frame = null;
    const matrix = ctx.getTransform?.();
    if (!matrix || !(size?.width > 0 && size?.height > 0) || !presentation?.prepareNearOcclusion?.(ctx)) return false;
    const target = this.buffers.ensure('layer', Math.round(size.width), Math.round(size.height));
    if (!target?.getContext('2d')) return false;
    this.frame = { frame, paint, presentation, width: target.width, height: target.height,
      matrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f] };
    return true;
  }

  reset() { this.frame = null; }

  draw(ctx, fit) {
    const f = this.frame;
    if (!f) return true;
    const mask = f.presentation.nearOcclusionMask;
    const name = ctx.canvas.width === f.width && ctx.canvas.height === f.height ? 'layer' : 'capture-layer';
    const target = this.buffers.ensure(name, ctx.canvas.width, ctx.canvas.height);
    if (!mask?.width || !target?.getContext('2d')) return false;
    const c = target.getContext('2d'), m = f.matrix, s = fit.scale;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, target.width, target.height);
    c.setTransform(s * m[0], s * m[1], s * m[2], s * m[3], fit.x + s * m[4], fit.y + s * m[5]);
    f.paint({ ...f.frame, ctx: c });
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1; c.globalCompositeOperation = 'destination-out';
    c.imageSmoothingEnabled = false;
    c.drawImage(mask, fit.x, fit.y, fit.width, fit.height);
    c.globalCompositeOperation = 'source-over';
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.beginPath(); ctx.rect(fit.x, fit.y, fit.width, fit.height); ctx.clip();
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(target, 0, 0);
    } finally { ctx.restore(); }
    return true;
  }

  dispose() { this.frame = null; this.buffers.dispose(); }
}
