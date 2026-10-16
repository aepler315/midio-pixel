// Shared mechanics only. Worlds retain geometry, light sources and draw order.
import { drawTiledStrip } from './SilhouetteGenerator.js';
import { groundGlowLights } from '../render/LightField.js';

const STATIC_SHADE = Object.freeze({ geology: false, geometry: 'static' });

export function drawStaticStrip(mgr, ctx, canvas, strip, scrollX, yOff, key, alpha, terrainEnergy) {
  if (strip) {
    ctx.save();
    if (alpha < 0.999) ctx.globalAlpha = alpha;
    drawTiledStrip(ctx, strip, scrollX, canvas.width, canvas.height, yOff);
    ctx.restore();
  }
  mgr._drawRidgeVolume(ctx, canvas, strip, scrollX, yOff, key, alpha, terrainEnergy, 1, 1, STATIC_SHADE);
}

/**
 * Temporal weights for a particle crossfade. Names that differ split the
 * opening gain, so the two fields sum to the caller's alpha instead of
 * stacking a full outgoing field under a rising incoming one. A geographic
 * seam is for the ridges; particles stay a time blend with that density cap.
 * Matching names are one field at full strength.
 */
export function particleBlendAlphas(t, openingGain = 1, sameField = false, callerAlpha = 1) {
  const open = Number.isFinite(openingGain) ? openingGain : 1;
  const caller = Number.isFinite(callerAlpha) ? callerAlpha : 1;
  const scale = caller * open;
  if (sameField) return { outgoing: scale, incoming: 0 };
  const u = Math.min(1, Math.max(0, Number(t) || 0));
  return { outgoing: scale * (1 - u), incoming: scale * u };
}

export function drawParticleBlend(mgr, frame, multiplier = 1, lights) {
  const { ctx, A, B, t, worldX, originX, particleMul } = frame;
  const { from, to } = mgr.currentBlend || { from: A.name, to: B.name };
  const openA = mgr.openingGain;
  const unravel = mgr.unravel || 0;
  const color = mgr._rotated(mgr.lerpCache.get(A.celestial.haloColor, B.celestial.haloColor, t));
  const callerAlpha = Number.isFinite(ctx.globalAlpha) ? ctx.globalAlpha : 1;
  const same = to === from;
  const { outgoing, incoming } = particleBlendAlphas(t, openA, same, callerAlpha);
  const rimOn = mgr._perf ? mgr._perf.rimLightEnabled : true;
  const resolved = lights !== undefined
    ? lights
    : (rimOn
      ? [mgr.light, ...groundGlowLights(mgr.groundField ? mgr.groundField.activeGlowScreenLights(worldX, originX) : [], color)].filter(Boolean)
      : null);
  const drawField = (name, alpha) => {
    if (!(alpha > 0.001)) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    mgr.fields.get(name)?.draw(ctx, particleMul * multiplier, color, unravel, resolved);
    ctx.restore();
  };
  drawField(from, outgoing);
  if (!same && t > 0.02) drawField(to, incoming);
}

export function drawGroundBase(mgr, frame, tint) {
  const { ctx, canvas, groundView, worldX, originX, A, B, t } = frame;
  const groundCanvas = groundView ? groundView.stage : canvas;
  if (groundView) groundView.apply();
  mgr._drawGround(ctx, groundCanvas, worldX, originX, A, B, t, tint);
  mgr._drawTerrainFooting(ctx, groundCanvas, worldX, originX, A, B, t);
  return groundCanvas;
}
