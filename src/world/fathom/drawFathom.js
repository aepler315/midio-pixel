import { drawStaticStrip, drawGroundBase, drawParticleBlend } from '../WorldDraw.js';
// The Fathom draw path. Underwater column: light descends, pressure climbs.
// No stars, no weather. Caustic ripples replace haze; depth darkening
// replaces aerial perspective. The "sky" is the water surface overhead.
import { CodaDirector } from '../../sim/CodaDirector.js';
import { ensureContrast } from '../../render/VisualStyle.js';
import { celestialYFracFor, celestialXFracFor, horizonFade } from '../DayNight.js';
import { sampleManagerMusic } from '../WorldMusic.js';
import { flashCompositeOp } from '../../ui/Accessibility.js';

const LAYER_RATIOS = { L2: 0.03, L3: 0.08, L4: 0.18, L5: 0.42 };
const Y_OFF = { L2: 10, L3: 22, L4: 44, L5: 70 };


export function drawFathomWorld(mgr, frame) {
  const { ctx, canvas, worldX, A, B, t, dn, phenomenaFull, particleMul } = frame;
  const music = sampleManagerMusic(mgr, { energyCurves: mgr.energyCurves, worldRhythm: mgr.worldRhythm });
  mgr._drawSky(ctx, canvas, A, B, t, 1, { astronomical: false });

  // Deliberately NOT wired here: BiomeManager's classic path draws
  // drawDeepSky/weaver/meteors (Midasus's sky-writing trail, ambient
  // constellations, reward-volley meteors) for the other newer world kinds,
  // but this file's own header already says "No stars... the sky is the
  // water surface overhead" -- adding them would contradict what this world
  // says about itself, not fill a gap.

  // The "celestial" is the sun seen through the surface — always veiled,
  // always high, shimmer-distorted by the water column.
  const sunAlt = Math.max(dn.sunAlt ?? 0.6, 0.55);
  const celestialYFrac = celestialYFracFor(sunAlt);
  const celestialXFrac = celestialXFracFor(dn.sunAz01 ?? 0.5);
  mgr._drawCelestial?.(ctx, canvas, A, B, t, celestialYFrac, horizonFade(sunAlt) * 0.6, celestialXFrac);

  drawWaterLight(ctx, canvas, music, mgr.reducedFlash, phenomenaFull);

  const { from, to } = mgr.currentBlend || { from: A.name, to: B.name };
  const skyHorizon = mgr._rotated(mgr.lerpCache.get(A.sky[2], B.sky[2], t));
  const tint = ensureContrast(mgr._rotated(mgr.lerpCache.get(A.silhouette, B.silhouette, t)), skyHorizon, 0.14);

  const unravel = mgr.unravel || 0;
  const scroll = (key) => worldX * CodaDirector.delaminateRatio(LAYER_RATIOS[key], unravel);

  const stripsA = mgr.stripsFor(from);
  const stripsB = mgr.stripsFor(to);

  // Depth is in the bake (WorldMaterial.layerColor mixes far layers toward
  // the water column) and in the live invert-aerial wash _drawRidgeVolume
  // paints for abyssal kinds. A second live tint here used to be computed
  // and then never applied.

  const drawRange = (key) => {
    const yOff = Y_OFF[key] || 0;
    const sx = scroll(key);
    // The strip bake is a single FLAT fill by design (SilhouetteGenerator: a
    // baked gradient sliced into independently-offset dance columns is a hard
    // seam at every column boundary), so a bare blit is a bare flat shape --
    // which is what these ranges were. _drawRidgeVolume is the only source of
    // shading depth a range has in ANY world, and it was reachable only from
    // the classic alpine path; every kind with its own draw function returned
    // before reaching it. Geology (snowcaps, sedimentary bedding) stays off
    // -- that half is alpine-specific. The shading half is not.
    if (stripsA) {
      const a = to === from ? 1 : 1 - t;
      drawStaticStrip(mgr, ctx, canvas, stripsA[key], sx, yOff, key, a, A.terrainEnergy ?? 1);
    }
    if (to !== from && t > 0.02 && stripsB) {
      drawStaticStrip(mgr, ctx, canvas, stripsB[key], sx, yOff, key, t, B.terrainEnergy ?? 1);
    }
  };

  drawRange('L2');
  drawRange('L3');
  if (particleMul > 0) drawLivingLight(ctx, canvas, worldX, music, mgr.reducedFlash, particleMul);

  // Particles: bubbles and spores drifting upward, lit by the same rim
  // light every other world's particle field gets. At HADAL depth the
  // silhouette sits against a near-black frame — ensureContrast() above
  // already lifts the tint, but a rim light from this bioluminescence
  // layer is the other half of that mitigation, and nothing wired it in.
  drawParticleBlend(mgr, frame, 0.7);

  drawRange('L4');
  drawRange('L5');

  // Ground
  const groundCanvas = drawGroundBase(mgr, frame, tint);
  mgr._drawFlood(ctx, groundCanvas);
  mgr._drawTransitionOverlays(ctx, groundCanvas, B);
}

function drawWaterLight(ctx, canvas, music, reducedFlash, full) {
  ctx.save();
  ctx.globalCompositeOperation = flashCompositeOp(reducedFlash);
  const count = full ? 5 : 3;
  const depth = canvas.height * 0.78;
  // Broad shafts breathe with sustained low frequencies. A slow opening
  // at a measured section boundary reveals more of the water column.
  const spread = 1 + music.reveal * music.motionScale * (reducedFlash ? 0.08 : 0.3);
  const gradient = ctx.createLinearGradient(0, 0, 0, depth);
  gradient.addColorStop(0, '#a4e7df');
  gradient.addColorStop(0.35, 'rgba(91,190,196,0.5)');
  gradient.addColorStop(1, 'rgba(28,98,136,0)');
  ctx.fillStyle = gradient;
  ctx.globalAlpha = music.waterLight;
  for (let i = 0; i < count; i++) {
    const x = canvas.width * (i + 0.5) / count;
    const width = canvas.width * (0.018 + (i % 2) * 0.009) * spread;
    const drift = music.current * canvas.width * 0.08;
    ctx.beginPath();
    ctx.moveTo(x - width, 0);
    ctx.lineTo(x + width, 0);
    ctx.lineTo(x + drift + width * 3, depth);
    ctx.lineTo(x + drift - width * 2, depth);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawLivingLight(ctx, canvas, worldX, music, reducedFlash, particleMul) {
  ctx.save();
  ctx.globalCompositeOperation = flashCompositeOp(reducedFlash);
  ctx.fillStyle = '#80efce';
  // Four small colonies at different depths. Only one answers a transient;
  // the water and the other colonies retain their quiet, slower movement.
  for (let group = 0; group < 4; group++) {
    const scroll = worldX * (0.04 + group * 0.015);
    const x = ((canvas.width * (group + 0.5) / 4 - scroll) % canvas.width + canvas.width) % canvas.width;
    const y = canvas.height * (0.33 + (group % 3) * 0.13) + music.current * 8;
    const accent = group === music.group ? music.accent : 0;
    ctx.globalAlpha = Math.min(1, particleMul) * (0.16 + accent * 0.5);
    for (let dot = 0; dot < 3; dot++) {
      ctx.beginPath();
      ctx.arc(x + dot * 9, y + Math.sin(dot * 2 + group) * 7, 1.5 + accent * music.motionScale, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
