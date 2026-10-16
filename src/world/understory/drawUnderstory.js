import { drawStaticStrip, drawGroundBase, drawParticleBlend } from '../WorldDraw.js';
// Understory draw path. A dense forest floor where light filters through
// a living canopy. God rays and dappled light replace haze. The parallax
// layers are trunk columns and undergrowth, not ridges. Spores, pollen,
// and fireflies instead of weather.
import { CodaDirector } from '../../sim/CodaDirector.js';
import { ensureContrast } from '../../render/VisualStyle.js';
import { celestialYFracFor, celestialXFracFor, horizonFade } from '../DayNight.js';
import { capFlashAlpha, flashCompositeOp } from '../../ui/Accessibility.js';
import { sampleManagerMusic } from '../WorldMusic.js';
import { canopyGrowth, shaftOpen, sporeBurst, boundaryLift01 } from './Canopy.js';

const LAYER_RATIOS = { L2: 0.03, L3: 0.08, L4: 0.20, L5: 0.48 };
const Y_OFF = { L2: 8, L3: 18, L4: 38, L5: 66 };


export function drawUnderstoryWorld(mgr, frame) {
  const { ctx, canvas, worldX, A, B, t, dn, phenomenaFull, particleMul } = frame;
  const music = sampleManagerMusic(mgr, { energyCurves: mgr.energyCurves, worldRhythm: mgr.worldRhythm });
  const lift = boundaryLift01(mgr.sections?.[mgr._lastSectionIdx], mgr.sections?.[mgr._lastSectionIdx - 1]);
  const growth = canopyGrowth({ energy: music.energy, orogeny: mgr.orogenyGrowth ?? 0 });
  const open = shaftOpen({ growth, reveal: music.reveal, lift });

  mgr._drawSky(ctx, canvas, A, B, t, 0.7);

  // The policy forbids open-sky spectacle here. Gaps in the canopy are
  // light shafts, not an invitation for stars or meteors to erase the
  // interior forest read.

  // The sun filters through the canopy — never directly visible, but its
  // presence is felt through god rays and dappled light patches.
  const sunAlt = Math.max(dn.sunAlt ?? 0.4, 0.35);
  const celestialYFrac = celestialYFracFor(sunAlt);
  const celestialXFrac = celestialXFracFor(dn.sunAz01 ?? 0.5);
  // Veiled celestial: the canopy blocks direct view, so draw at reduced alpha.
  if (mgr._drawCelestial) {
    ctx.save();
    ctx.globalAlpha = 0.3;
    mgr._drawCelestial(ctx, canvas, A, B, t, celestialYFrac, horizonFade(sunAlt) * 0.4, celestialXFrac);
    ctx.restore();
  }

  // Canopy light shafts. Spread and brightness follow growth and earned
  // phrases, not elapsed time. Continuity sway is WorldMusic.current,
  // which is already zero under reduced flash. Gated the same way every
  // other heavy-post-fx layer in BiomeManager is.
  const heavyOk = !mgr._perf || mgr._perf.heavyPostFx;
  if (phenomenaFull && heavyOk) {
    const sway = mgr.reducedMotion ? 0 : music.current * canvas.width * 0.03;
    ctx.save();
    ctx.globalCompositeOperation = flashCompositeOp(mgr.reducedFlash);
    for (let i = 0; i < 3; i++) {
      const xBase = canvas.width * (0.15 + 0.3 * i) + sway * (i % 2 ? 1 : -1);
      ctx.globalAlpha = capFlashAlpha(0.04 + 0.14 * open, mgr.reducedFlash);
      ctx.beginPath();
      ctx.moveTo(xBase - 20, 0);
      ctx.lineTo(xBase + 40, 0);
      ctx.lineTo(xBase + 80, canvas.height * 0.8);
      ctx.lineTo(xBase - 10, canvas.height * 0.8);
      ctx.closePath();
      ctx.fillStyle = 'rgba(180, 220, 120, 0.15)';
      ctx.fill();
    }
    ctx.restore();
  }

  const { from, to } = mgr.currentBlend || { from: A.name, to: B.name };
  const skyHorizon = mgr._rotated(mgr.lerpCache.get(A.sky[2], B.sky[2], t));
  const tint = ensureContrast(mgr._rotated(mgr.lerpCache.get(A.silhouette, B.silhouette, t)), skyHorizon, 0.14);

  const unravel = mgr.unravel || 0;
  const scroll = (key) => worldX * CodaDirector.delaminateRatio(LAYER_RATIOS[key], unravel);

  const stripsA = mgr.stripsFor(from);
  const stripsB = mgr.stripsFor(to);

  // The strip bake is a single FLAT fill by design (SilhouetteGenerator: a
  // baked gradient sliced into independently-offset dance columns is a hard
  // seam at every column boundary), so a bare blit is a bare flat shape --
  // which is exactly what these ranges were. _drawRidgeVolume is the only
  // source of shading depth a range has in any world, and it was reachable
  // only from the classic alpine path; every kind with its own draw function
  // returned before it. Geology off: trunks and canopy are not sedimentary,
  // and snowcaps in a forest understory would be nonsense. The shading is
  // universal, the rock is not.
  const drawRange = (key) => {
    const yOff = Y_OFF[key] || 0;
    const sx = scroll(key);
    if (stripsA) {
      const a = to === from ? 1 : 1 - t;
      drawStaticStrip(mgr, ctx, canvas, stripsA[key], sx, yOff, key, a, A.terrainEnergy ?? 1);
    }
    if (to !== from && t > 0.02 && stripsB) {
      drawStaticStrip(mgr, ctx, canvas, stripsB[key], sx, yOff, key, t, B.terrainEnergy ?? 1);
    }
  };

  drawRange('L2');
  // Green haze between far layers — forest atmosphere. Growth thickens it.
  ctx.save();
  ctx.globalAlpha = 0.03 + 0.05 * growth;
  ctx.fillStyle = 'rgba(30, 60, 20, 0.5)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  drawRange('L3');
  mgr._drawSignature(frame, music);

  // Particles: pollen, spores, fireflies.
  drawParticleBlend(mgr, frame, 0.8);

  if (particleMul > 0) drawSpores(ctx, canvas, worldX, music, mgr.reducedFlash, particleMul);

  drawRange('L4');
  drawRange('L5');

  // Ground
  const groundCanvas = drawGroundBase(mgr, frame, tint);
  mgr._drawFlood(ctx, groundCanvas);
  mgr._drawTransitionOverlays(ctx, groundCanvas, B);
}

function drawSpores(ctx, canvas, worldX, music, reducedFlash, particleMul) {
  ctx.save();
  ctx.globalCompositeOperation = flashCompositeOp(reducedFlash);
  ctx.fillStyle = '#d8f0a8';
  for (let colony = 0; colony < 4; colony++) {
    const scroll = worldX * (0.05 + colony * 0.012);
    const x = ((canvas.width * (colony + 0.5) / 4 - scroll) % canvas.width + canvas.width) % canvas.width;
    const y = canvas.height * (0.38 + (colony % 3) * 0.12) + music.current * 6;
    const burst = sporeBurst(music.accent, music.group, colony);
    ctx.globalAlpha = capFlashAlpha(Math.min(1, particleMul) * (0.12 + burst * 0.55), reducedFlash);
    for (let dot = 0; dot < 3; dot++) {
      ctx.beginPath();
      ctx.arc(x + dot * 8, y + Math.sin(dot * 2 + colony) * 6, 1.4 + burst * 1.6 * music.motionScale, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// Broad masses are retained at every quality level; fine spores remain optional.
export function drawCanopy(mgr, { ctx, canvas, worldX, A }, music) {
  const w = canvas.width, h = canvas.height;
  const spacing = w / 4;
  const phase = ((worldX * 0.08) % spacing + spacing) % spacing;
  const sway = (mgr.reducedMotion || mgr.reducedFlash) ? 0 : music.current * 5;
  ctx.save();
  ctx.fillStyle = A.silhouette;
  for (let i = -1; i < 6; i++) {
    const x = i * spacing - phase;
    const treeIndex = i + Math.floor(worldX * 0.08 / spacing);
    const crownY = h * (0.07 + (treeIndex % 2 ? 0.04 : 0));
    // Roots, tapering trunk and two connected boughs.
    ctx.beginPath();
    ctx.moveTo(x - 38, h * 0.86);
    ctx.bezierCurveTo(x - 12, h * 0.66, x - 20, h * 0.35, x - 14 + sway, crownY);
    ctx.lineTo(x + 17 + sway, crownY);
    ctx.bezierCurveTo(x + 12, h * 0.38, x + 13, h * 0.69, x + 42, h * 0.86);
    ctx.closePath(); ctx.fill();
    ctx.lineWidth = 18;
    ctx.strokeStyle = A.silhouette;
    ctx.beginPath(); ctx.moveTo(x, h * 0.4);
    ctx.bezierCurveTo(x - 10, h * 0.26, x - spacing * 0.3, h * 0.15, x - spacing * 0.5, crownY);
    ctx.moveTo(x + 4, h * 0.32);
    ctx.bezierCurveTo(x + 38, h * 0.2, x + spacing * 0.38, h * 0.2, x + spacing * 0.55, crownY);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(x + sway, crownY - h * 0.04, spacing * 0.69, h * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();
    // A narrow lit edge supports the mass without turning the sky bright.
    ctx.strokeStyle = '#668a50'; ctx.lineWidth = 2;
    ctx.globalAlpha = 0.22 + music.bass * 0.12;
    ctx.beginPath(); ctx.moveTo(x + 17, h * 0.75);
    ctx.bezierCurveTo(x + 10, h * 0.5, x + 20, h * 0.28, x + 35, h * 0.2);
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  ctx.restore();
}
