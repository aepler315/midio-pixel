import { drawStaticStrip, drawGroundBase, drawParticleBlend } from '../WorldDraw.js';
// Redline draw path. A desert highway that only exists at speed.
// Flat horizon, heat shimmer, neon signage. The parallax layers are
// road infrastructure — gantries, guardrails, billboards — not mountains.
import { CodaDirector } from '../../sim/CodaDirector.js';
import { ensureContrast, styleDials } from '../../render/VisualStyle.js';
import { celestialYFracFor, celestialXFracFor, horizonFade } from '../DayNight.js';
import { capFlashAlpha, flashCompositeOp } from '../../ui/Accessibility.js';
import { hexToRgb } from '../../utils/color.js';
import { sampleManagerMusic } from '../WorldMusic.js';
import { cruiseTravel, phrasePassage, signageAlpha, boundaryLift01 } from './Cruise.js';
import { identityAllows, constellationsAllowed } from '../WorldIdentity.js';

const LAYER_RATIOS = { L2: 0.06, L3: 0.14, L4: 0.32, L5: 0.70 };
const Y_OFF = { L2: 4, L3: 14, L4: 34, L5: 64 };


export function drawRedlineWorld(mgr, frame) {
  const { ctx, canvas, worldX, A, B, t, dn, phenomenaFull, skyVoyage } = frame;
  const identity = mgr.world;
  const music = sampleManagerMusic(mgr, { energyCurves: mgr.energyCurves, worldRhythm: mgr.worldRhythm });
  const lift = boundaryLift01(mgr.sections?.[mgr._lastSectionIdx], mgr.sections?.[mgr._lastSectionIdx - 1]);
  const passage = phrasePassage({ nowMs: mgr.tSec * 1000, section: mgr.sections?.[mgr._lastSectionIdx], lift });

  mgr._drawSky(ctx, canvas, A, B, t, 0.6);

  // Deep-sky layer ported in from BiomeManager's classic path -- a desert
  // highway at night gets the same open, star-heavy sky as the alpine
  // biomes: Midasus's sky-writing trail, the ambient constellations, and
  // reward-volley meteors. Missing here only because Redline got its own
  // draw function without carrying these calls along.
  if (identityAllows(identity, 'deepSky')) mgr.drawDeepSky(ctx, skyVoyage, canvas);
  const skyA = styleDials(mgr.visualStyle).skyWireAlpha ?? 1;
  if (constellationsAllowed(identity, mgr._perf) && skyA > 0.02) {
    const nightAlphaMul = (1 + 1.2 * 0.6) * Math.max(0.25, skyA);
    mgr.weaver.draw(ctx, canvas, mgr.reducedFlash, nightAlphaMul);
  }
  if (identityAllows(identity, 'meteors') && phenomenaFull) mgr.meteors.draw(ctx, canvas, mgr.reducedFlash);

  // Big sun or moon — always a dominant presence on the horizon.
  const sunUp = (dn.sunAlt ?? 0) > 0.01;
  const celestialAlt = sunUp ? Math.max(dn.sunAlt, 0.15) : Math.max(dn.moonAlt, 0.25);
  const celestialYFrac = celestialYFracFor(celestialAlt);
  const celestialXFrac = celestialXFracFor(sunUp ? (dn.sunAz01 ?? 0.5) : (dn.moonAz01 ?? 0.65));
  if (sunUp) {
    mgr._drawCelestial?.(ctx, canvas, A, B, t, celestialYFrac, horizonFade(celestialAlt), celestialXFrac);
  } else {
    mgr._drawMoon(
      ctx, canvas, celestialYFrac, horizonFade(celestialAlt),
      0, celestialXFrac,
      0.5, 1.1, mgr._moonPhase01?.() ?? 0.55,
    );
  }

  const { from, to } = mgr.currentBlend || { from: A.name, to: B.name };
  const skyHorizon = mgr._rotated(mgr.lerpCache.get(A.sky[2], B.sky[2], t));
  const tint = ensureContrast(mgr._rotated(mgr.lerpCache.get(A.silhouette, B.silhouette, t)), skyHorizon, 0.16);

  const unravel = mgr.unravel || 0;
  const scroll = (key) => worldX * CodaDirector.delaminateRatio(LAYER_RATIOS[key], unravel);

  const stripsA = mgr.stripsFor(from);
  const stripsB = mgr.stripsFor(to);

  // Heat shimmer: energy sets how much of the band is visible; the phase
  // stays clock-driven so a dense mix does not strobe the horizon.
  const shimmerPhase = (mgr.tSec || 0) * 1.4;
  ctx.save();
  ctx.globalAlpha = capFlashAlpha(0.03 + 0.08 * music.energy + 0.05 * passage.horizon, mgr.reducedFlash);
  const hg = ctx.createLinearGradient(0, canvas.height * 0.55, 0, canvas.height * 0.75);
  hg.addColorStop(0, 'rgba(255, 200, 100, 0)');
  hg.addColorStop(0.5, `rgba(255, 180, 80, ${0.06 + 0.04 * Math.sin(shimmerPhase * 3)})`);
  hg.addColorStop(1, 'rgba(255, 200, 100, 0)');
  ctx.fillStyle = hg;
  ctx.fillRect(0, canvas.height * 0.55, canvas.width, canvas.height * 0.2);
  ctx.restore();

  if (passage.tunnel > 0.01) drawTunnelMouth(ctx, canvas, passage.tunnel, mgr.reducedFlash);

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

  // Neon edge glow between layers — road reflectors and signage. Energy
  // sets the idle, one gantry catches the accent, an earned horizon
  // wash lifts the whole band.
  const edgeColor = A.edgeLight || B.edgeLight || null;
  if (edgeColor && phenomenaFull) {
    const { r, g, b } = hexToRgb(edgeColor);
    ctx.save();
    ctx.globalCompositeOperation = flashCompositeOp(mgr.reducedFlash);
    ctx.globalAlpha = capFlashAlpha(signageAlpha(music.energy, music.accent, true) * 0.55 + 0.2 * passage.horizon, mgr.reducedFlash);
    const ng = ctx.createLinearGradient(0, canvas.height * 0.62, 0, canvas.height * 0.68);
    ng.addColorStop(0, `rgba(${r},${g},${b},0)`);
    ng.addColorStop(0.5, `rgba(${r},${g},${b},0.18)`);
    ng.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = ng;
    ctx.fillRect(0, canvas.height * 0.62, canvas.width, canvas.height * 0.06);
    ctx.restore();
  }

  if (passage.horizon > 0.01) drawHorizonWash(ctx, canvas, passage.horizon, mgr.reducedFlash);

  // Particles: wind streaks, digital rain, flaresparks.
  drawParticleBlend(mgr, frame, 1);

  drawRange('L4');
  drawRange('L5');

  // Ground
  const groundCanvas = drawGroundBase(mgr, frame, tint);
  mgr._drawSignature(frame, music);
  drawReflectors(ctx, groundCanvas, worldX, mgr, music);
  mgr._drawFlood(ctx, groundCanvas);
  mgr._drawTransitionOverlays(ctx, groundCanvas, B);
}

function drawTunnelMouth(ctx, canvas, cover, reducedFlash) {
  ctx.save();
  ctx.globalAlpha = capFlashAlpha(0.55 * cover, reducedFlash);
  ctx.fillStyle = '#05060a';
  const w = canvas.width * 0.22 * cover;
  ctx.fillRect(0, 0, w, canvas.height);
  ctx.fillRect(canvas.width - w, 0, w, canvas.height);
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height * 0.42);
  g.addColorStop(0, 'rgba(5,6,10,0.85)');
  g.addColorStop(1, 'rgba(5,6,10,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height * 0.42);
  ctx.restore();
}

function drawHorizonWash(ctx, canvas, wash, reducedFlash) {
  ctx.save();
  ctx.globalCompositeOperation = flashCompositeOp(reducedFlash);
  ctx.globalAlpha = capFlashAlpha(0.22 * wash, reducedFlash);
  const g = ctx.createLinearGradient(0, canvas.height * 0.48, 0, canvas.height * 0.66);
  g.addColorStop(0, 'rgba(255, 210, 140, 0)');
  g.addColorStop(0.5, 'rgba(255, 190, 110, 0.35)');
  g.addColorStop(1, 'rgba(255, 210, 140, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, canvas.height * 0.48, canvas.width, canvas.height * 0.18);
  ctx.restore();
}

function drawReflectors(ctx, canvas, worldX, mgr, music) {
  const spacing = 90;
  const phase = ((worldX * 0.8) % spacing + spacing) % spacing;
  ctx.save();
  ctx.globalCompositeOperation = flashCompositeOp(mgr.reducedFlash);
  let i = 0;
  for (let x = -phase; x < canvas.width + 10; x += spacing, i++) {
    const gy = mgr.groundField ? mgr.groundField.heightAt(worldX + x) : mgr.groundY;
    const hit = i % 4 === music.group;
    ctx.globalAlpha = capFlashAlpha(signageAlpha(music.energy, music.accent, hit), mgr.reducedFlash);
    ctx.fillStyle = i % 2 ? '#ff7a4a' : '#ffe08a';
    ctx.fillRect(x, gy - 14, 3, 8);
    ctx.fillRect(x, gy - 4, 3, 3);
  }
  ctx.restore();
}

export function drawRoad(mgr, frame, music) {
  const { ctx, worldX } = frame;
  const canvas = frame.groundView ? frame.groundView.stage : frame.canvas;
  const w = canvas.width, h = canvas.height;
  const gy = mgr.groundField ? mgr.groundField.heightAt(worldX) : mgr.groundY;
  const vx = w * 0.62, vy = gy - h * 0.20;
  const bottom = h;
  ctx.save();
  ctx.fillStyle = '#151923';
  ctx.beginPath(); ctx.moveTo(vx - 5, vy); ctx.lineTo(vx + 5, vy);
  ctx.lineTo(w * 2.2, bottom); ctx.lineTo(w * -1.2, bottom); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#987c68'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(vx - 5, vy); ctx.lineTo(w * -1.2, bottom);
  ctx.moveTo(vx + 5, vy); ctx.lineTo(w * 2.2, bottom); ctx.stroke();
  const travel = cruiseTravel(mgr.tSec, mgr.energyCurves, mgr.reducedFlash, mgr.world?.response, mgr.reducedMotion);
  const phase = ((travel % 90) + 90) % 90 / 90;
  ctx.fillStyle = '#c8b58a';
  for (let lane = 0; lane < 2; lane++) {
    for (let i = 0; i < 10; i++) {
      const near = ((i + phase) / 10) ** 2;
      const far = Math.max(0, (i + phase - 0.35) / 10) ** 2;
      const dx = (lane ? 0.52 : -0.68) * w;
      ctx.beginPath(); ctx.moveTo(vx + dx * far, vy + (bottom - vy) * far);
      ctx.lineTo(vx + dx * near, vy + (bottom - vy) * near);
      ctx.lineTo(vx + dx * near + 2 + near * 3, vy + (bottom - vy) * near);
      ctx.lineTo(vx + dx * far + 1, vy + (bottom - vy) * far); ctx.closePath(); ctx.fill();
    }
  }
  ctx.strokeStyle = frame.A.edgeLight || '#dc9362';
  ctx.globalAlpha = capFlashAlpha(0.22 + music.energy * 0.22, mgr.reducedFlash);
  for (let side = -1; side <= 1; side += 2) {
    ctx.beginPath(); ctx.moveTo(vx, vy - 8);
    ctx.lineTo(vx + side * w * 1.65, bottom - 12); ctx.stroke();
  }
  ctx.restore();
}
