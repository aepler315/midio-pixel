// City skyline from the same ridge portrait the alpine ranges use.
// Energy landmarks become named towers; spectral mass becomes bulk vs
// needle (bass = dense mid-rise fabric, treble = isolated spires with
// streets between). Rectangular with setbacks — a building, not a peak.
import { clamp, clamp01, lerp, mulberry32 } from '../../utils/math.js';
import { composeAlpinePeaks, seedPeaks, layerWeathering } from '../RidgePortrait.js';

const MARGIN = 0.12;

/**
 * Unit-height building at normalized half-width `d` (0 centre, 1 edge).
 * `setbackFrac` is where the first step-down starts (default 0.62, the
 * original fixed value); `taper` scales how much each step drops (1 = the
 * original 0.84/0.58 levels exactly). Both come from a song's shape grammar
 * (ShapeGrammar.deriveTerrainParams) so a spiky/vertical-stack-heavy song
 * gets a sharper, more pronounced setback and an organic/mound-heavy one a
 * gentler, later taper -- default params reproduce the original building
 * shape exactly.
 */
export function buildingProfile(d, setbackFrac = 0.62, taper = 1) {
  const t = Math.max(0, d);
  if (t >= 1) return 0;
  const cornice = clamp(setbackFrac + 0.20, setbackFrac + 0.05, 0.96);
  if (t < setbackFrac) return 1;
  if (t < cornice) return clamp01(1 - 0.16 * taper); // setback
  return clamp01(1 - 0.42 * taper);                  // cornice
}

function terraceHeight(portrait, layerKey) {
  const bass = portrait?.bassShare ?? 0.3;
  const air = portrait?.airShare ?? 0.1;
  const base = layerKey === 'L2' ? 0.14 : layerKey === 'L3' ? 0.11 : layerKey === 'L4' ? 0.08 : 0.04;
  return clamp(base + bass * 0.10 - air * 0.08, 0.03, 0.28);
}

/**
 * Height field of a tileable city skyline. Same `{x,h,w}` peaks the alpine
 * generator consumes, interpreted as buildings. Between them a terrace of
 * lower fabric — the altiplano reading, as blocks not saddles.
 */
export function cityHeightField(n, step, seed, width, portrait = null, layerKey = 'L2', terrainMods = null) {
  const widthMul = terrainMods?.cityWidthMul ?? 1;
  const cfg = {
    wBase: clamp((layerKey === 'L2' ? 56 : layerKey === 'L3' ? 48 : layerKey === 'L4' ? 40 : 28) * widthMul, 14, 100),
    wSpan: clamp((layerKey === 'L2' ? 44 : 32) * widthMul, 10, 70),
    peakMin: 5, peakSpan: 5, asym: 0.08,
    notch: 0.02, teeth: 0.01, bed: 0.08, apronGain: 0.12,
  };
  const peaks = (portrait && portrait.landmarks && portrait.landmarks.length)
    ? composeAlpinePeaks({ portrait, cfg, layerKey, seed, width })
    : seedPeaks(cfg, seed, width);
  const weather = portrait ? layerWeathering(portrait, cfg, layerKey) : { bed: cfg.bed };
  const terrace = terraceHeight(portrait, layerKey);
  const rand = mulberry32((seed ^ 0xb1d) >>> 0 || 1);
  const setbackFrac = terrainMods?.citySetbackFrac ?? 0.62;
  const taper = terrainMods?.cityTaperMul ?? 1;

  // Extra mid-rise fillers so the skyline is a city, not three towers.
  const extras = [];
  const baseWant = layerKey === 'L2' ? 8 : layerKey === 'L3' ? 9 : layerKey === 'L4' ? 6 : 4;
  const want = Math.round(clamp(baseWant * (terrainMods?.cityDensityMul ?? 1), 2, 16));
  let attempts = 0;
  while (extras.length < want && attempts < 40) {
    attempts++;
    const x = (MARGIN + rand() * (1 - 2 * MARGIN)) * width;
    if (peaks.some((p) => Math.abs(p.x - x) < p.w * 0.55)) continue;
    extras.push({
      x,
      h: 0.28 + rand() * 0.32,
      w: cfg.wBase * (0.45 + rand() * 0.4),
    });
  }

  const all = peaks.concat(extras);
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * step;
    let h = terrace + (weather.bed || 0) * 0.15;
    for (const p of all) {
      const half = Math.max(10, p.w * 0.5);
      const d = Math.abs(x - p.x) / half;
      if (d < 1) {
        const core = buildingProfile(d, setbackFrac, taper) * p.h;
        if (core > h) h = core;
      }
    }
    // Sparse antennae / water-tower nubs on the tallest — only near a
    // summit, one or two pixels of extra height so they read as furniture
    // not as alpine teeth.
    const u = width > 0 ? x / width : 0;
    const ant = (Math.sin(u * 40.7 + seed) * 0.5 + 0.5);
    if (h > 0.72 && ant > 0.82) h = Math.min(1, h + 0.06);
    heights[i] = clamp01(h);
  }
  return heights;
}

/**
 * Window occupancy 0..1 from the song's current energy and the city's
 * growth arc (orogeny, reused as "lights coming on across the night").
 */
export function windowOccupancy({ energy = 0.4, openingGain = 1, orogeny = 0.5, fever = 0 } = {}) {
  const base = 0.18 + 0.55 * clamp01(energy) + 0.22 * clamp01(orogeny);
  return clamp01(base * lerp(0.55, 1, clamp01(openingGain)) + 0.18 * clamp01(fever));
}

export function bakeWindowStrip(ridgeYs, { width, height, step, seed = 1, color = '#f0d090' }) {
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  if (!(canvas instanceof OffscreenCanvas) && canvas.width !== width) {
    canvas.width = width; canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  const rand = mulberry32((seed ^ 0x71) >>> 0 || 1);
  const COL = 8, ROW = 11;
  ctx.fillStyle = color;
  for (let i = 0; i < ridgeYs.length; i++) {
    const x0 = i * step;
    const top = ridgeYs[i];
    if (!(top < height - 8)) continue;
    for (let x = x0; x < x0 + step; x += COL) {
      for (let y = top + 8; y < height - 12; y += ROW) {
        if (rand() < 0.62) {
          ctx.globalAlpha = 0.55 + rand() * 0.45;
          ctx.fillRect(x + 1, y, 4, 5);
        }
      }
    }
  }
  ctx.globalAlpha = 1;
  canvas.ridgeYs = ridgeYs;
  return canvas;
}
