import { drawStaticStrip, drawGroundBase, drawParticleBlend } from '../WorldDraw.js';
// Far Side draw path. An airless body: no haze, no aerial perspective,
// no weather, no atmosphere effects. Distance carried by parallax rate
// and contrast only. The sky is black and full of stars at noon.
// The primary (a gas giant) occupies a quarter of the frame.
import { CodaDirector } from '../../sim/CodaDirector.js';
import { ensureContrast, styleDials } from '../../render/VisualStyle.js';
import { celestialYFracFor, celestialXFracFor, horizonFade } from '../DayNight.js';
import { capFlashAlpha, flashCompositeOp } from '../../ui/Accessibility.js';
import { hexToRgb, hexLerp } from '../../utils/color.js';
import { sampleManagerMusic } from '../WorldMusic.js';
import { terminatorContrast, illumination, surfaceTrace, boundaryLift01 } from './Vacuum.js';
import { identityAllows, constellationsAllowed } from '../WorldIdentity.js';

const LAYER_RATIOS = { L2: 0.04, L3: 0.10, L4: 0.22, L5: 0.50 };
const Y_OFF = { L2: 6, L3: 18, L4: 40, L5: 68 };


// The hero object: a genuinely large, banded, ringed primary — not the
// generic moon renderer at a bigger number. "Airless, no haze, no weather"
// makes this the one thing in the frame that has to read as unmistakably
// alien at a glance; everything else here is the same shared ridge terrain
// every other world uses. Reuses mgr's existing celestial-approach math
// (so it rises/grows across the song exactly like every other body does)
// but draws its own disc, bands, and ring instead of calling _drawMoon.
function drawPrimary(mgr, ctx, canvas, cyFrac, cxFrac, alpha, color, haloColor, baseRadius, illum) {
  if (alpha <= 0.02) return;
  const app = mgr._celestialApproachAt(canvas, canvas.width * cxFrac, canvas.height * cyFrac);
  const cx = app.x, cy = app.y;
  const R = Math.max(60, baseRadius * 2.6) * app.scale;

  ctx.save();
  ctx.globalAlpha = alpha;

  // No atmospheric halo. This is vacuum — a glow around the primary was
  // the one air-cue this world is not allowed. The disc, bands, and ring
  // carry the planet.

  // Faint ring, drawn behind the disc so the near edge of the disc occludes it.
  const { r: rr, g: rg, b: rb } = hexToRgb(haloColor);
  ctx.save();
  ctx.strokeStyle = `rgba(${rr},${rg},${rb},${0.22 + 0.18 * illum})`;
  ctx.lineWidth = Math.max(1, R * 0.05);
  ctx.beginPath();
  ctx.ellipse(cx, cy, R * 1.55, R * 0.34, -0.28, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Disc with limb darkening: lit color toward the light side, the base
  // color darkening toward the far edge — reads as a sphere, not a disc.
  const lit = hexLerp(color, '#ffffff', 0.18 + 0.16 * illum);
  const dark = hexLerp(color, '#000000', 0.45);
  const disc = ctx.createRadialGradient(cx - R * 0.32, cy - R * 0.32, R * 0.08, cx, cy, R);
  disc.addColorStop(0, lit);
  disc.addColorStop(0.65, color);
  disc.addColorStop(1, dark);
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fill();

  // Cloud bands, clipped to the disc.
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  const bandCount = 6;
  for (let i = 0; i < bandCount; i++) {
    const bandY = cy - R + (i / bandCount) * 2 * R;
    const bandH = (2 * R) / bandCount;
    const shade = i % 2 === 0 ? hexLerp(color, '#ffffff', 0.08) : hexLerp(color, '#000000', 0.18);
    ctx.globalAlpha = alpha * 0.55;
    ctx.fillStyle = shade;
    ctx.fillRect(cx - R, bandY, R * 2, bandH);
  }
  ctx.restore();

  ctx.restore();
}

export function drawFarsideWorld(mgr, frame) {
  const { ctx, canvas, worldX, A, B, t, dn, phenomenaFull, skyVoyage } = frame;
  const identity = mgr.world;
  const music = sampleManagerMusic(mgr, { energyCurves: mgr.energyCurves, worldRhythm: mgr.worldRhythm });
  const lift = boundaryLift01(mgr.sections?.[mgr._lastSectionIdx], mgr.sections?.[mgr._lastSectionIdx - 1]);
  const illum = illumination({ energy: music.energy, reveal: music.reveal, lift });
  const contrast = terminatorContrast(music.energy);

  // Render the real shared catalogue without atmospheric scintillation,
  // extinction or reddening. Night visibility still respects openingGain.
  mgr._drawSky(ctx, canvas, A, B, t, 1, { atmosphere: false });

  // Deep-sky layer ported in from BiomeManager's classic path -- an airless
  // sky "full of stars" is exactly where Midasus's sky-writing trail, the
  // ambient per-note constellations, and reward-volley meteors belong most.
  // This never rendered here before: the classic path's calls were left
  // behind when Far Side got its own draw function.
  if (identityAllows(identity, 'deepSky')) mgr.drawDeepSky(ctx, skyVoyage, canvas);
  const skyA = styleDials(mgr.visualStyle).skyWireAlpha ?? 1;
  if (constellationsAllowed(identity, mgr._perf) && skyA > 0.02) {
    const nightAlphaMul = (1 + 1.2 * 1) * Math.max(0.25, skyA);
    mgr.weaver.draw(ctx, canvas, mgr.reducedFlash, nightAlphaMul);
  }
  if (identityAllows(identity, 'meteors') && phenomenaFull) mgr.meteors.draw(ctx, canvas, mgr.reducedFlash);

  // The primary: a large, banded, ringed gas giant — the hero object this
  // world's whole "airless, less-is-more" premise stands or falls on.
  const moonAlt = Math.max(dn.moonAlt, 0.55);
  const celestialYFrac = celestialYFracFor(moonAlt);
  const celestialXFrac = celestialXFracFor(dn.moonAz01 ?? 0.65);
  const primaryC = mgr._rotated ? mgr._rotated(A.celestial.color) : A.celestial.color;
  const primaryHalo = mgr._rotated ? mgr._rotated(A.celestial.haloColor) : A.celestial.haloColor;
  drawPrimary(
    mgr, ctx, canvas, celestialYFrac, celestialXFrac, horizonFade(moonAlt),
    primaryC, primaryHalo, A.celestial.radius || 120, illum,
  );

  const { from, to } = mgr.currentBlend || { from: A.name, to: B.name };
  const skyHorizon = mgr._rotated(mgr.lerpCache.get(A.sky[2], B.sky[2], t));
  // No aerial perspective: tint is the raw silhouette color with no sky pull.
  const tint = ensureContrast(mgr._rotated(mgr.lerpCache.get(A.silhouette, B.silhouette, t)), skyHorizon, 0.18);

  const unravel = mgr.unravel || 0;
  const scroll = (key) => worldX * CodaDirector.delaminateRatio(LAYER_RATIOS[key], unravel);

  const stripsA = mgr.stripsFor(from);
  const stripsB = mgr.stripsFor(to);

  // Hard terminator: position still walks the song (the slow form sweep),
  // contrast follows sustained energy so a dense mix cannot strobe the
  // limb. Isolated hits do not move it.
  const terminatorPhase = (mgr.tSec || 0) / Math.max(1, (mgr.durationMs || 180000) / 1000);
  const terminatorX = canvas.width * (0.2 + 0.6 * terminatorPhase);
  ctx.save();
  const tg = ctx.createLinearGradient(terminatorX - 80, 0, terminatorX + 80, 0);
  tg.addColorStop(0, 'rgba(0,0,0,0)');
  tg.addColorStop(0.5, `rgba(0,0,0,${contrast * 0.4})`);
  tg.addColorStop(1, `rgba(0,0,0,${contrast})`);
  ctx.fillStyle = tg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

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
  // No haze between layers — vacuum.
  drawRange('L3');

  // Particles — sparse regolith dust, no secondary lights (no atmosphere
  // to scatter them). A time blend, weights summing to the opening gain.
  drawParticleBlend(mgr, frame, 0.6, null);

  drawRange('L4');
  // No haze, no connector hills, no fog banks.
  drawRange('L5');

  // Ground
  const groundCanvas = drawGroundBase(mgr, frame, tint);
  drawSurfaceTraces(ctx, groundCanvas, worldX, mgr, music);
  mgr._drawFlood(ctx, groundCanvas);
  mgr._drawTransitionOverlays(ctx, groundCanvas, B);
}

function drawSurfaceTraces(ctx, canvas, worldX, mgr, music) {
  const gy = mgr.groundField ? mgr.groundField.heightAt(worldX) : mgr.groundY;
  const mark = surfaceTrace(music.accent, music.energy);
  ctx.save();
  ctx.globalCompositeOperation = flashCompositeOp(mgr.reducedFlash);
  ctx.fillStyle = '#d8dce8';
  for (let i = 0; i < 4; i++) {
    const x = canvas.width * (0.18 + i * 0.21);
    const hit = i === music.group ? mark : 0;
    ctx.globalAlpha = capFlashAlpha(0.08 + 0.55 * hit, mgr.reducedFlash);
    ctx.beginPath();
    ctx.arc(x, gy - 6, 3 + hit * 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
