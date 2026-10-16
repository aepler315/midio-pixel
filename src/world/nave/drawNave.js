import { drawStaticStrip, drawGroundBase, drawParticleBlend } from '../WorldDraw.js';
// The Nave draw path. A cathedral interior that rebuilds itself every
// chorus. The parallax layers are vaulted bays and buttresses, not
// mountains. Stained glass color spill (edgeLight) and god rays replace
// aerial perspective. The "sky" is the vault ceiling.
import { CodaDirector } from '../../sim/CodaDirector.js';
import { ensureContrast } from '../../render/VisualStyle.js';
import { celestialYFracFor, celestialXFracFor } from '../DayNight.js';
import { capFlashAlpha, flashCompositeOp } from '../../ui/Accessibility.js';
import { hexToRgb } from '../../utils/color.js';
import { sampleManagerMusic } from '../WorldMusic.js';
import { motifTrust, bayLit, bayAlpha, boundaryLift01 } from './Resonance.js';

const LAYER_RATIOS = { L2: 0.03, L3: 0.08, L4: 0.18, L5: 0.44 };
const Y_OFF = { L2: 6, L3: 16, L4: 36, L5: 66 };


export function drawNaveWorld(mgr, frame) {
  const { ctx, canvas, worldX, A, B, t, phenomenaFull } = frame;
  const section = mgr.sections?.[mgr._lastSectionIdx];
  const music = sampleManagerMusic(mgr, { section, energyCurves: mgr.energyCurves, worldRhythm: mgr.worldRhythm });
  const lift = boundaryLift01(section, mgr.sections?.[mgr._lastSectionIdx - 1]);
  const trust = motifTrust(section);

  mgr._drawSky(ctx, canvas, A, B, t, 0.8, { astronomical: false });

  // Deliberately NOT wired here: BiomeManager's classic path draws
  // drawDeepSky/weaver/meteors (Midasus's sky-writing trail, ambient
  // constellations, reward-volley meteors) for the other newer world kinds,
  // but this file's own header says the "sky" here is an interior vault
  // ceiling, not open air -- open-sky constellations sailing across a
  // cathedral roof would contradict the space, not fill a gap in it.

  // The rose window: a stained-glass celestial, always visible. Use the
  // existing celestial renderer at moderate scale.
  const celestialAlt = 0.65;
  const celestialYFrac = celestialYFracFor(celestialAlt);
  const celestialXFrac = celestialXFracFor(0.5);
  mgr._drawCelestial?.(ctx, canvas, A, B, t, celestialYFrac, 1.0, celestialXFrac);

  // Stained glass color spill. Bass is the resonance of the interior
  // (1.2s average, never a single bin). Returning labels light the same
  // bays; decorative cuts keep every bay equal so we do not invent a chorus.
  const edgeColor = A.edgeLight || B.edgeLight || null;
  if (edgeColor && phenomenaFull) {
    const { r, g, b } = hexToRgb(edgeColor);
    ctx.save();
    ctx.globalCompositeOperation = flashCompositeOp(mgr.reducedFlash);
    for (let i = 0; i < 4; i++) {
      const lit = bayLit(section?.label, i);
      const alpha = bayAlpha({ trust, lit, bass: music.bass, reveal: music.reveal * lift });
      const xBase = canvas.width * (0.1 + 0.25 * i);
      ctx.globalAlpha = capFlashAlpha(alpha, mgr.reducedFlash);
      const sg = ctx.createLinearGradient(xBase, 0, xBase + 60, canvas.height * 0.7);
      sg.addColorStop(0, `rgba(${r},${g},${b},0.14)`);
      sg.addColorStop(0.5, `rgba(${r},${g},${b},0.05)`);
      sg.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = sg;
      ctx.fillRect(xBase - 10, 0, 80, canvas.height * 0.7);
    }
    ctx.restore();
  }

  const { from, to } = mgr.currentBlend || { from: A.name, to: B.name };
  const skyHorizon = mgr._rotated(mgr.lerpCache.get(A.sky[2], B.sky[2], t));
  const tint = ensureContrast(mgr._rotated(mgr.lerpCache.get(A.silhouette, B.silhouette, t)), skyHorizon, 0.16);

  const unravel = mgr.unravel || 0;
  const scroll = (key) => worldX * CodaDirector.delaminateRatio(LAYER_RATIOS[key], unravel);

  const stripsA = mgr.stripsFor(from);
  const stripsB = mgr.stripsFor(to);

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
  mgr._drawSignature(frame, music);

  // Particles: sunshine motes, censer smoke.
  drawParticleBlend(mgr, frame, 0.7);

  drawRange('L4');
  drawRange('L5');

  // Ground
  const groundCanvas = drawGroundBase(mgr, frame, tint);
  mgr._drawFlood(ctx, groundCanvas);
  mgr._drawTransitionOverlays(ctx, groundCanvas, B);
}

export function drawVault(mgr, { ctx, canvas, A }, music) {
  const w = canvas.width, h = canvas.height, cx = w * 0.55, cy = h * 0.27;
  const section = mgr.sections?.[mgr._lastSectionIdx];
  ctx.save();
  ctx.strokeStyle = A.silhouette;
  // Perspective bays connect piers to pointed vaults, instead of a skyline.
  for (let bay = 0; bay < 3; bay++) {
    const span = w * (0.19 + bay * 0.12), top = h * (0.09 - bay * 0.045);
    ctx.lineWidth = 10 + bay * 6;
    ctx.beginPath(); ctx.moveTo(cx - span, h * 0.83); ctx.lineTo(cx - span, h * 0.4);
    ctx.bezierCurveTo(cx - span, h * 0.22, cx - span * 0.45, top + h * 0.03, cx, top);
    ctx.bezierCurveTo(cx + span * 0.45, top + h * 0.03, cx + span, h * 0.22, cx + span, h * 0.4);
    ctx.lineTo(cx + span, h * 0.83); ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = A.edgeLight || '#95879f';
    ctx.globalAlpha = capFlashAlpha(0.25 + 0.2 * bayAlpha({ trust: motifTrust(section), lit: bayLit(section?.label, bay), bass: music.bass, reveal: music.reveal }), mgr.reducedFlash);
    ctx.stroke(); ctx.globalAlpha = 1; ctx.strokeStyle = A.silhouette;
  }
  const radius = h * 0.105;
  ctx.fillStyle = '#11121e'; ctx.beginPath(); ctx.arc(cx, cy, radius * 1.12, 0, Math.PI * 2); ctx.fill();
  const colors = [A.celestial.color, A.edgeLight || '#bc8773', '#748abd', '#c3a675'];
  for (let pane = 0; pane < 12; pane++) {
    const angle = pane * Math.PI / 6;
    ctx.fillStyle = colors[pane % colors.length];
    ctx.globalAlpha = capFlashAlpha(0.46 + music.bass * 0.2 + music.reveal * 0.16, mgr.reducedFlash);
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, angle + 0.025, angle + Math.PI / 6 - 0.025);
    ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.strokeStyle = '#52485e'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, radius * 0.28, 0, Math.PI * 2); ctx.stroke();
  // Glass illumination has an architectural origin even on the lowest rung.
  ctx.globalAlpha = capFlashAlpha(0.055 + music.bass * 0.045, mgr.reducedFlash);
  ctx.fillStyle = A.edgeLight || '#b0a0e0';
  ctx.beginPath(); ctx.moveTo(cx - radius * 0.4, cy + radius);
  ctx.lineTo(cx + radius * 0.4, cy + radius); ctx.lineTo(cx + w * 0.17, h * 0.81);
  ctx.lineTo(cx - w * 0.11, h * 0.81); ctx.closePath(); ctx.fill();
  ctx.restore();
}
