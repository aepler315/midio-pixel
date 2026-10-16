import { drawStaticStrip, drawGroundBase, drawParticleBlend } from '../WorldDraw.js';
// The Foundry draw path. Industrial: smokestacks, pour glow, molten
// rivers of light. Haze is smoke, not atmosphere. The edge-light on
// every layer is furnace glow bleeding through silhouette gaps.
import { CodaDirector } from '../../sim/CodaDirector.js';
import { ensureContrast } from '../../render/VisualStyle.js';
import { celestialYFracFor, celestialXFracFor, horizonFade } from '../DayNight.js';
import { capFlashAlpha, flashCompositeOp } from '../../ui/Accessibility.js';
import { hexToRgb } from '../../utils/color.js';
import { sampleManagerMusic } from '../WorldMusic.js';
import { furnaceHeat, pourGlow, operationIndex, machineStroke, millActivity, boundaryLift01 } from './Furnace.js';

const LAYER_RATIOS = { L2: 0.05, L3: 0.12, L4: 0.26, L5: 0.58 };
const Y_OFF = { L2: 2, L3: 14, L4: 36, L5: 66 };


export function drawFoundryWorld(mgr, frame) {
  const { ctx, canvas, worldX, A, B, t, dn } = frame;
  const music = sampleManagerMusic(mgr, { energyCurves: mgr.energyCurves, worldRhythm: mgr.worldRhythm });
  const heat = furnaceHeat(music.energy);
  const lift = boundaryLift01(mgr.sections?.[mgr._lastSectionIdx], mgr.sections?.[mgr._lastSectionIdx - 1]);
  const pour = pourGlow({ heat, reveal: music.reveal, lift, reducedFlash: mgr.reducedFlash });
  const operation = operationIndex(mgr._lastSectionIdx);

  mgr._drawSky(ctx, canvas, A, B, t, 0.85);

  // Foundry is smoke and furnace glow, not a star field. Deep-sky writing,
  // constellations and meteors belong to open-air worlds.

  // Celestial body — often veiled behind smoke, small in the hot palettes.
  const sunUp = (dn.sunAlt ?? 0) > 0.01;
  // Keep the authored night moon floor; a rising sun uses its real altitude.
  const activeAlt = sunUp ? dn.sunAlt : Math.max(dn.moonAlt, 0.30);
  const celestialYFrac = celestialYFracFor(activeAlt);
  const celestialXFrac = celestialXFracFor((sunUp ? dn.sunAz01 : dn.moonAz01) ?? 0.60);
  const visibility = horizonFade(activeAlt) * 0.5;
  if (sunUp) {
    mgr._drawCelestial?.(ctx, canvas, A, B, t, celestialYFrac, visibility, celestialXFrac);
  } else {
    mgr._drawMoon(
      ctx, canvas, celestialYFrac, visibility,
      0, celestialXFrac,
      0.5, 1.0, mgr._moonPhase01?.() ?? 0.45,
    );
  }

  const { from, to } = mgr.currentBlend || { from: A.name, to: B.name };
  const skyHorizon = mgr._rotated(mgr.lerpCache.get(A.sky[2], B.sky[2], t));
  const tint = ensureContrast(mgr._rotated(mgr.lerpCache.get(A.silhouette, B.silhouette, t)), skyHorizon, 0.18);

  const unravel = mgr.unravel || 0;
  const scroll = (key) => worldX * CodaDirector.delaminateRatio(LAYER_RATIOS[key], unravel);

  const stripsA = mgr.stripsFor(from);
  const stripsB = mgr.stripsFor(to);

  // Furnace glow: a warm uplight from below the horizon. Sustained heat
  // is the idle; an earned pour is the event. A single energy sample
  // used to alias rapid drums into a full-frame flash -- that is gone.
  const edgeColor = A.edgeLight || B.edgeLight || null;
  if (edgeColor) {
    const { r, g, b } = hexToRgb(edgeColor);
    ctx.save();
    ctx.globalCompositeOperation = flashCompositeOp(mgr.reducedFlash);
    ctx.globalAlpha = capFlashAlpha(0.05 + 0.18 * pour, mgr.reducedFlash);
    const fg = ctx.createLinearGradient(0, canvas.height, 0, canvas.height * 0.5);
    fg.addColorStop(0, `rgba(${r},${g},${b},${0.10 + 0.16 * pour})`);
    fg.addColorStop(0.4, `rgba(${r},${g},${b},0.04)`);
    fg.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = fg;
    ctx.fillRect(0, canvas.height * 0.5, canvas.width, canvas.height * 0.5);
    ctx.restore();
  }

  // Smoke haze between layers instead of atmospheric haze. Heat thickens
  // it; a pour does not, because steam is not the event -- the light is.
  const drawSmoke = (yFrac) => {
    ctx.save();
    ctx.globalAlpha = 0.04 + 0.06 * heat;
    const sg = ctx.createLinearGradient(0, canvas.height * yFrac, 0, canvas.height * (yFrac + 0.08));
    sg.addColorStop(0, 'rgba(40, 30, 20, 0)');
    sg.addColorStop(0.5, 'rgba(40, 30, 20, 0.08)');
    sg.addColorStop(1, 'rgba(40, 30, 20, 0)');
    ctx.fillStyle = sg;
    ctx.fillRect(0, canvas.height * yFrac, canvas.width, canvas.height * 0.08);
    ctx.restore();
  };

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
  drawSmoke(0.42);
  drawRange('L3');
  drawSmoke(0.52);

  // Particles: embers, sparks, fog.
  drawParticleBlend(mgr, frame, 1.2);

  drawRange('L4');
  drawSmoke(0.62);
  drawRange('L5');

  // Ground
  const groundCanvas = drawGroundBase(mgr, frame, tint);
  // Assemblies share the fixed ground transform, so camera pull-back cannot
  // bury furnace mouths under the independently aligned ground pass.
  mgr._drawSignature(frame, music);
  drawMills(ctx, groundCanvas, worldX, mgr, music, heat, pour, operation);
  mgr._drawFlood(ctx, groundCanvas);
  mgr._drawTransitionOverlays(ctx, groundCanvas, B);
}

function drawMills(ctx, canvas, worldX, mgr, music, heat, pour, operation) {
  const gy = mgr.groundField ? mgr.groundField.heightAt(worldX) : mgr.groundY;
  ctx.save();
  ctx.globalCompositeOperation = flashCompositeOp(mgr.reducedFlash);
  for (let mill = 0; mill < 4; mill++) {
    const x = canvas.width * (0.16 + mill * 0.22);
    const awake = millActivity(heat, operation, mill);
    const stroke = machineStroke({
      accent: music.accent, group: music.group, operation, machine: mill,
    });
    const drop = mgr.reducedFlash || mgr.reducedMotion ? 0 : stroke * 16;
    ctx.globalAlpha = capFlashAlpha(0.18 + 0.55 * awake, mgr.reducedFlash);
    ctx.fillStyle = mill === operation ? '#c06028' : '#6a4030';
    ctx.fillRect(x - 7, gy - 36, 14, 36);
    ctx.fillStyle = mill === operation ? '#ffb060' : '#8a6050';
    ctx.globalAlpha = capFlashAlpha(0.22 + 0.7 * stroke + 0.2 * pour, mgr.reducedFlash);
    ctx.fillRect(x - 3, gy - 52 + drop, 6, 22);
    ctx.beginPath();
    ctx.arc(x, gy - 54 + drop, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawMachinery(mgr, frame, music) {
  const { ctx, A, worldX } = frame;
  const canvas = frame.groundView ? frame.groundView.stage : frame.canvas;
  const w = canvas.width, h = canvas.height;
  const floor = (mgr.groundField ? mgr.groundField.heightAt(worldX) : mgr.groundY) - 4;
  const heat = furnaceHeat(music.energy);
  const lift = boundaryLift01(mgr.sections?.[mgr._lastSectionIdx], mgr.sections?.[mgr._lastSectionIdx - 1]);
  const pour = pourGlow({ heat, reveal: music.reveal, lift, reducedFlash: mgr.reducedFlash });
  const operation = operationIndex(mgr._lastSectionIdx);
  ctx.save();
  for (let machine = 0; machine < 3; machine++) {
    const x = w * (0.22 + machine * 0.29), half = w * 0.075, top = floor - h * (0.31 + machine % 2 * 0.05);
    const stroke = machineStroke({ accent: music.accent, group: music.group, operation, machine });
    const drop = mgr.reducedFlash || mgr.reducedMotion ? 0 : stroke * h * 0.035;
    ctx.fillStyle = A.silhouette;
    ctx.beginPath(); ctx.rect(x - half, top, half * 2, 15);
    ctx.rect(x - half, top, 13, floor - top); ctx.rect(x + half - 13, top, 13, floor - top);
    ctx.rect(x - half * 0.7, floor - 24, half * 1.4, 24); ctx.fill();
    ctx.strokeStyle = '#665448'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x - half, floor); ctx.lineTo(x + half, top);
    ctx.moveTo(x + half, floor); ctx.lineTo(x - half, top); ctx.stroke();
    // Visible ram, piston head and furnace mouth form one assembly.
    ctx.fillStyle = '#766759'; ctx.fillRect(x - 5, top + 15, 10, h * 0.12 + drop);
    ctx.fillRect(x - 25, top + h * 0.12 + drop, 50, 14);
    ctx.fillStyle = '#e68139';
    ctx.globalAlpha = capFlashAlpha(0.28 + heat * 0.32, mgr.reducedFlash);
    ctx.fillRect(x - half * 0.48, floor - 22, half * 0.96, 18);
    ctx.globalAlpha = capFlashAlpha(0.12 + pour * 0.4, mgr.reducedFlash);
    ctx.beginPath(); ctx.moveTo(x + half * 0.46, floor - 21);
    ctx.lineTo(x + half * 0.62, floor - 21); ctx.lineTo(x + half * 0.88, floor + 10);
    ctx.lineTo(x + half * 0.72, floor + 10); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}
