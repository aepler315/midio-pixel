import { drawStaticStrip, drawParticleBlend } from '../WorldDraw.js';
// After Hours draw path. BiomeManager.draw() hands off here for city worlds.
//
// Translated from alpine: ridge portrait → skyline, parallax, haze, rain,
// ground field (street breathing with bass), section transitions, film
// finish (caller), characters (caller), window occupancy as orogeny.
//
// Scrapped: mountain dance / GeoCrest / orogeny-as-growth / ocean /
// spectrum massif / horizon EQ / mandala / cymatics / chaos ribbon /
// space ridge / connector hills / far vignettes / sun / aurora / canopy.
import { drawTiledStrip } from '../SilhouetteGenerator.js';
import { windowOccupancy } from './CitySilhouette.js';
import { boundaryLift01, cityGlow, windowGlowAlpha } from './CityGlow.js';
import { CodaDirector } from '../../sim/CodaDirector.js';
import { capFlashAlpha, flashCompositeOp } from '../../ui/Accessibility.js';
import { sampleManagerMusic } from '../WorldMusic.js';
import { hexToRgb } from '../../utils/color.js';
import { groundGlowLights } from '../../render/LightField.js';
import { ensureContrast, styleDials } from '../../render/VisualStyle.js';
import { celestialYFracFor, celestialXFracFor, horizonFade } from '../DayNight.js';
import { identityAllows, constellationsAllowed } from '../WorldIdentity.js';

const LAYER_RATIOS = { L2: 0.10, L3: 0.18, L4: 0.30, L5: 0.65 };
const AERIAL_PULL = { L2: 0.50, L3: 0.32, L4: 0.14, L5: 0 };
const NIGHT_SKY = '#05060c';
const Y_OFF = { L2: -18, L3: 8, L4: 36, L5: 72 };

function layerTint(mgr, tint, skyHorizon, layerKey) {
  const pull = AERIAL_PULL[layerKey] || 0;
  return pull > 0.001 ? mgr.lerpCache.get(tint, skyHorizon, pull) : tint;
}


function blitWindows(ctx, canvas, strip, scrollX, yOff, glow, music, reducedFlash, blendAlpha = 1) {
  if (!strip?.windows || glow < 0.02) return;
  ctx.save();
  ctx.globalCompositeOperation = flashCompositeOp(reducedFlash);
  ctx.globalAlpha = blendAlpha * capFlashAlpha(windowGlowAlpha(glow), reducedFlash);
  drawTiledStrip(ctx, strip.windows, scrollX, canvas.width, canvas.height, yOff);
  if (music.accent > 0.005) {
    // One district catches the percussion. Clip the already baked windows
    // so accents never paint bars across the sky or relight every building.
    const districtW = strip.width / 4;
    const phase = ((scrollX % strip.width) + strip.width) % strip.width;
    ctx.beginPath();
    for (let tile = -phase - strip.width; tile < canvas.width; tile += strip.width) {
      ctx.rect(tile + music.group * districtW, 0, districtW * 0.72, canvas.height);
    }
    ctx.clip();
    ctx.globalAlpha = blendAlpha * capFlashAlpha(0.55 * music.accent, reducedFlash);
    drawTiledStrip(ctx, strip.windows, scrollX, canvas.width, canvas.height, yOff);
  }
  ctx.restore();
}

export function drawCityWorld(mgr, frame) {
  const { ctx, canvas, worldX, originX, A, B, t, dn, phenomenaFull, particleMul, groundView, skyVoyage } = frame;
  const identity = mgr.world;
  const music = sampleManagerMusic(mgr, { energyCurves: mgr.energyCurves, worldRhythm: mgr.worldRhythm });
  const night = 1;
  mgr._drawSky(ctx, canvas, A, B, t, night);

  // Deep-sky layer ported in from BiomeManager's classic path (see its
  // `draw()`) -- a night skyline still shows Midasus's sky-writing trail,
  // the ambient per-note constellations, and reward-volley meteors above
  // it. Not in this file's own "scrapped" list up top, so its absence here
  // was a gap from the city split, not a deliberate style choice.
  if (identityAllows(identity, 'deepSky')) mgr.drawDeepSky(ctx, skyVoyage, canvas);
  const skyA = styleDials(mgr.visualStyle).skyWireAlpha ?? 1;
  if (constellationsAllowed(identity, mgr._perf) && skyA > 0.02) {
    const nightAlphaMul = (1 + 1.2 * night) * Math.max(0.25, skyA);
    mgr.weaver.draw(ctx, canvas, mgr.reducedFlash, nightAlphaMul);
  }
  if (identityAllows(identity, 'meteors') && phenomenaFull) mgr.meteors.draw(ctx, canvas, mgr.reducedFlash);

  const moonAlt = Math.max(dn.moonAlt, 0.35);
  const celestialYFrac = celestialYFracFor(moonAlt);
  const celestialXFrac = celestialXFracFor(dn.moonAz01 ?? 0.72);
  mgr._drawMoon(
    ctx, canvas, celestialYFrac, horizonFade(moonAlt),
    0,
    celestialXFrac,
    0.5, 1.15, mgr._moonPhase01?.() ?? 0.6,
  );

  const { from, to } = mgr.currentBlend || { from: A.name, to: B.name };
  const skyHorizon = mgr._rotated(mgr.lerpCache.get(A.sky[2], B.sky[2], t));
  const skyHorizonNight = mgr.lerpCache.get(skyHorizon, NIGHT_SKY, 0.35);
  const tint = ensureContrast(mgr._rotated(mgr.lerpCache.get(A.silhouette, B.silhouette, t)), skyHorizonNight, 0.16);

  const unravel = mgr.unravel || 0;
  const scroll = (key) => worldX * CodaDirector.delaminateRatio(LAYER_RATIOS[key], unravel);

  // How awake the city is -- the slow, drifting number. On its own it never
  // rests, so it is only the baseline here; CityGlow decides what the skyline
  // actually does with it.
  const occ = windowOccupancy({
    energy: music.energy,
    openingGain: mgr.openingGain ?? 1,
    orogeny: mgr.orogenyGrowth ?? 0.5,
    fever: mgr.fever ?? 0,
  });
  const sectionIdx = mgr._lastSectionIdx;
  const glow = cityGlow({
    occupancy: occ,
    tSec: mgr.tSec,
    reveal: music.reveal,
    lift: boundaryLift01(mgr.sections?.[sectionIdx], mgr.sections?.[sectionIdx - 1]),
    reducedFlash: mgr.reducedFlash,
  });

  const stripsA = mgr.stripsFor(from);
  const stripsB = mgr.stripsFor(to);
  const hazeLayers = mgr._perf ? mgr._perf.hazeLayers : 3;
  const arc = { hazeWarm: 0.15 };

  const drawRange = (key) => {
    const yOff = Y_OFF[key] || 0;
    const sx = scroll(key);
    const lt = layerTint(mgr, tint, skyHorizonNight, key);
    ctx.save();
    ctx.fillStyle = lt; // unused; strips are pre-tinted. keep transform clean.
    ctx.restore();
    // Shading goes BETWEEN the silhouette and its windows, not after both:
    // the windows are self-lit, and a shade pass over them would darken the
    // one thing in a skyline that is supposed to be its own light source.
    //
    // The strip bake is a single FLAT fill by design (SilhouetteGenerator: a
    // baked gradient sliced into independently-offset dance columns is a hard
    // seam at every column boundary), so a bare blit is a bare flat shape.
    // _drawRidgeVolume is the only source of shading depth a range has in ANY
    // world, and it was reachable only from the classic alpine path; every
    // kind with its own draw function returned before reaching it. Geology
    // (snowcaps, sedimentary bedding) stays off -- a skyline is not
    // sedimentary. The shading half is universal.
    if (stripsA) {
      const a = to === from ? 1 : 1 - t;
      drawStaticStrip(mgr, ctx, canvas, stripsA[key], sx, yOff, key, a, A.terrainEnergy ?? 1);
      blitWindows(ctx, canvas, stripsA[key], sx, yOff, glow, music, mgr.reducedFlash, a);
    }
    if (to !== from && t > 0.02 && stripsB) {
      drawStaticStrip(mgr, ctx, canvas, stripsB[key], sx, yOff, key, t, B.terrainEnergy ?? 1);
      blitWindows(ctx, canvas, stripsB[key], sx, yOff, glow, music, mgr.reducedFlash, t);
    }
  };

  drawRange('L2');
  if (hazeLayers >= 3) mgr._drawHaze(ctx, canvas, 'L2', A, B, t, arc);
  drawRange('L3');
  mgr._drawHaze(ctx, canvas, 'L3', A, B, t, arc);

  const rimOn = mgr._perf ? mgr._perf.rimLightEnabled : true;
  const mandalaColor = mgr._rotated(mgr.lerpCache.get(A.celestial.haloColor, B.celestial.haloColor, t));
  const particleLights = rimOn
    ? [mgr.light, ...groundGlowLights(mgr.groundField ? mgr.groundField.activeGlowScreenLights(worldX, originX) : [], mandalaColor)].filter(Boolean)
    : null;
  drawParticleBlend(mgr, frame, 1, particleLights);
  if (mgr._activeWeatherIntensity > 0.01) {
    const weatherField = mgr.weatherFields.get(mgr.weatherState?.kind);
    if (weatherField) weatherField.draw(ctx, mgr._activeWeatherIntensity * particleMul, mandalaColor, unravel, particleLights);
  }

  mgr._drawFogBanks(ctx, canvas);

  drawRange('L4');
  if (hazeLayers >= 3) mgr._drawHaze(ctx, canvas, 'L4', A, B, t, arc);
  drawRange('L5');

  const groundCanvas = groundView ? groundView.stage : canvas;
  if (groundView) groundView.apply();
  mgr._drawGround(ctx, groundCanvas, worldX, originX, A, B, t, tint);
  drawWetSheen(ctx, groundCanvas, glow);
  mgr._drawTerrainFooting(ctx, groundCanvas, worldX, originX, A, B, t);
  drawStreetLamps(ctx, groundCanvas, worldX, mgr, glow, mandalaColor);
  drawTraffic(ctx, groundCanvas, worldX, originX, mgr, music);
  mgr._drawFlood(ctx, groundCanvas);
  mgr._drawTransitionOverlays(ctx, groundCanvas, B);
}

function drawTraffic(ctx, canvas, worldX, originX, mgr, music) {
  ctx.save();
  ctx.globalCompositeOperation = flashCompositeOp(mgr.reducedFlash);
  // Fixed density; fast songs brighten one pair of lights instead of
  // spawning more cars or accelerating the street on every drum hit.
  const spacing = canvas.width / 4;
  const travel = (mgr.reducedMotion || mgr.reducedFlash) ? 0 : mgr.tSec * 24;
  for (let i = 0; i < 6; i++) {
    const x = ((i * spacing + travel - worldX * 0.12) % (canvas.width + spacing)
      + canvas.width + spacing) % (canvas.width + spacing) - spacing / 2;
    const gy = mgr.groundField ? mgr.groundField.heightAt(worldX + x - originX) : mgr.groundY;
    const y = gy + 9 + (i % 2) * 12;
    const glow = music.cityLight + (i % 4 === music.group ? music.accent * 0.25 : 0);
    ctx.globalAlpha = capFlashAlpha(glow, mgr.reducedFlash);
    ctx.fillStyle = i % 2 ? '#ee856b' : '#f9dfa0';
    ctx.fillRect(x, y, 4, 2);
    ctx.fillRect(x + 7, y, 4, 2);
    ctx.globalAlpha *= 0.18;
    ctx.fillRect(x - 2, y + 5, 16, 2);
    ctx.fillRect(x + 1, y + 9, 10, 1);
  }
  ctx.restore();
}

function drawWetSheen(ctx, canvas, glow) {
  ctx.save();
  const gy = canvas.height * 0.72;
  const g = ctx.createLinearGradient(0, gy, 0, canvas.height);
  g.addColorStop(0, 'rgba(180, 200, 220, 0)');
  g.addColorStop(0.15, `rgba(160, 180, 200, ${0.04 + 0.06 * glow})`);
  g.addColorStop(1, 'rgba(20, 24, 32, 0.18)');
  ctx.fillStyle = g;
  ctx.fillRect(0, gy, canvas.width, canvas.height - gy);
  ctx.restore();
}

function drawStreetLamps(ctx, canvas, worldX, mgr, glow, halo) {
  const gy = mgr.groundField ? mgr.groundField.heightAt(worldX) : mgr.groundY;
  const spacing = 220;
  const phase = ((worldX * 0.65) % spacing + spacing) % spacing;
  const { r, g, b } = hexToRgb(halo || '#e0b060');
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let x = -phase; x < canvas.width + 40; x += spacing) {
    const px = x;
    const lampGlow = 0.07 + 0.16 * glow;
    const rad = ctx.createRadialGradient(px, gy - 36, 2, px, gy - 8, 70);
    rad.addColorStop(0, `rgba(${r},${g},${b},${lampGlow})`);
    rad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = rad;
    ctx.beginPath();
    ctx.arc(px, gy - 20, 70, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(${r},${g},${b},${0.30 + 0.5 * glow})`;
    ctx.fillRect(px - 1.5, gy - 52, 3, 40);
    ctx.beginPath();
    ctx.arc(px, gy - 54, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
