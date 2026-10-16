// High-energy sections are not one thing.
//
// A chorus that arrives by stacking drums and opening the spectrum is a
// clean energetic build. A chorus that arrives by holding a dark, unresolved
// swell is melancholic tension. Both read loud on EnergyCurves.globalEnergyNorm,
// which is why glow currently treats them the same and blows the frame out.
//
// This module answers two questions the rest of the app does not:
//   1. Is this section a high-energy build of this song?
//   2. If so, is the climb a tension swell or a clean drive?
//
// Inputs are the same objects SongProfile already has: energy curves,
// section bounds, onsets, the analysis fingerprint, and (when present) the
// rolling Krumhansl timeline. Nothing here invents a beat or a key.
//
// Glow taming follows the answer. Tension keeps the frame smoldering so the
// unresolved pressure can be seen. Clean drive still rises, but the bloom is
// held back during the climb so the arrival has somewhere to go.
import { clamp, clamp01 } from '../utils/math.js';

export const BUILD_KIND = Object.freeze({
  TENSION: 'melancholic-tension',
  DRIVE: 'clean-drive',
  MIXED: 'mixed',
  CALM: 'calm',
});

// Song-relative energy that counts as "loud for this track". Below the knee
// a section is just a section. At HIGH_FULL it is the loud part.
const HIGH_KNEE = 0.58;
const HIGH_FULL = 0.78;
// Last-third minus first-third energy that counts as a climb rather than a
// plateau that happens to be loud.
const RISE_KNEE = 0.05;
const RISE_FULL = 0.22;
// How far apart the two scores must be before a section is named one thing.
const KIND_MARGIN = 0.08;

const EMPTY_CLIMATE = Object.freeze({
  kind: BUILD_KIND.CALM,
  isHighEnergy: false,
  isBuild: false,
  energy01: 0,
  rise01: 0,
  brightness01: 0.5,
  brightnessDelta: 0,
  wash01: 0,
  punch01: 0,
  onsetRise01: 0,
  minor01: 0.5,
  roughness01: 0,
  tension01: 0,
  drive01: 0,
  glowTame01: 0,
  confidence: 0,
});

function meanNorm(curves, fromMs, toMs) {
  if (!curves || typeof curves.globalEnergyNorm !== 'function') return 0;
  const lo = Math.max(0, fromMs || 0);
  const hi = Math.max(lo + 1, toMs || lo + 1);
  let sum = 0, n = 0;
  for (let t = lo; t < hi; t += 40) {
    const v = curves.globalEnergyNorm(t);
    if (Number.isFinite(v)) { sum += v; n++; }
  }
  return n ? sum / n : 0;
}

function meanBands(curves, fromMs, toMs) {
  const shares = new Array(7).fill(0);
  if (!curves || typeof curves.sample !== 'function') return shares;
  const lo = Math.max(0, fromMs || 0);
  const hi = Math.max(lo + 1, toMs || lo + 1);
  let n = 0;
  for (let t = lo; t < hi; t += 40) {
    for (let b = 0; b < 7; b++) {
      const v = curves.sample(b, t);
      if (Number.isFinite(v)) shares[b] += v;
    }
    n++;
  }
  if (!n) return shares;
  for (let b = 0; b < 7; b++) shares[b] /= n;
  return shares;
}

function thirdWindows(startMs, endMs) {
  const span = Math.max(1, endMs - startMs);
  const w = span / 3;
  return {
    first: [startMs, startMs + w],
    last: [endMs - w, endMs],
    firstHalf: [startMs, startMs + span / 2],
    lastHalf: [startMs + span / 2, endMs],
  };
}

function brightnessOf(shares) {
  const dark = shares[0] + shares[1] + shares[2];
  const bright = shares[5] + shares[6];
  const den = dark + bright;
  if (den < 1e-9) return 0.5;
  return clamp01(bright / den);
}

function washOf(shares) {
  const mid = shares[2] + shares[3] + shares[4];
  const all = shares.reduce((a, b) => a + b, 0);
  if (all < 1e-9) return 0;
  return clamp01(mid / all);
}

function punchOf(shares, onsetHz) {
  const low = shares[0] + shares[1];
  const all = shares.reduce((a, b) => a + b, 0);
  const lowShare = all > 1e-9 ? low / all : 0;
  return clamp01(lowShare * clamp01(onsetHz / 3.2) * 1.6);
}

function onsetsIn(onsets, fromMs, toMs) {
  if (!Array.isArray(onsets) || !onsets.length) return [];
  return onsets.filter((o) => Number.isFinite(o?.tMs) && o.tMs >= fromMs && o.tMs < toMs);
}

function onsetHz(onsets, fromMs, toMs) {
  const span = Math.max(1, toMs - fromMs) / 1000;
  return onsetsIn(onsets, fromMs, toMs).length / span;
}

function kickShare(onsets, fromMs, toMs) {
  const hits = onsetsIn(onsets, fromMs, toMs);
  if (!hits.length) return 0;
  let kicks = 0;
  for (const o of hits) if (o.kick) kicks++;
  return kicks / hits.length;
}

function meanMajorness(timeline, fromMs, toMs, fallback) {
  if (Array.isArray(timeline) && timeline.length) {
    let sum = 0, w = 0;
    for (const row of timeline) {
      if (!Number.isFinite(row?.tMs) || row.tMs < fromMs || row.tMs > toMs) continue;
      const conf = Number.isFinite(row.confidence) ? clamp01(row.confidence) : 0.4;
      const maj = Number.isFinite(row.majorness)
        ? row.majorness
        : (row.mode === 'minor' ? -0.6 : row.mode === 'major' ? 0.6 : 0);
      sum += maj * conf;
      w += conf;
    }
    if (w > 1e-6) return { majorness: sum / w, weight: w };
  }
  if (Number.isFinite(fallback?.majorness)) {
    return { majorness: fallback.majorness, weight: clamp01(fallback.tonalConfidence ?? 0.3) };
  }
  if (fallback?.mode === 'minor') return { majorness: -0.55, weight: clamp01(fallback.tonalConfidence ?? 0.25) };
  if (fallback?.mode === 'major') return { majorness: 0.55, weight: clamp01(fallback.tonalConfidence ?? 0.25) };
  return { majorness: 0, weight: 0 };
}

function roughnessOf(timeline, fromMs, toMs) {
  if (!Array.isArray(timeline) || timeline.length < 2) return 0;
  const rows = timeline.filter((r) => Number.isFinite(r?.tMs) && r.tMs >= fromMs && r.tMs <= toMs);
  if (rows.length < 2) return 0;
  let flips = 0;
  let confSum = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].tonic !== rows[i - 1].tonic || rows[i].mode !== rows[i - 1].mode) flips++;
    confSum += Number.isFinite(rows[i].confidence) ? rows[i].confidence : 0.4;
  }
  const flipRate = flips / (rows.length - 1);
  const meanConf = confSum / (rows.length - 1);
  return clamp01(0.65 * flipRate + 0.35 * (1 - meanConf));
}

function highEnergy01(energy01) {
  return clamp01((energy01 - HIGH_KNEE) / (HIGH_FULL - HIGH_KNEE));
}

function rise01From(delta) {
  return clamp01((delta - RISE_KNEE) / (RISE_FULL - RISE_KNEE));
}

/**
 * Classify one section. Pure. Missing curves or a degenerate span return the
 * calm empty climate rather than inventing a build.
 */
export function classifyBuildSection({
  startMs, endMs, energy = null, relEnergy01 = null,
  energyCurves = null, onsets = null, analysis = null, tonalityTimeline = null,
} = {}) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { ...EMPTY_CLIMATE };
  }

  const energy01 = Number.isFinite(energy)
    ? clamp01(energy)
    : meanNorm(energyCurves, startMs, endMs);
  const windows = thirdWindows(startMs, endMs);
  const firstE = meanNorm(energyCurves, windows.first[0], windows.first[1]);
  const lastE = meanNorm(energyCurves, windows.last[0], windows.last[1]);
  const riseRaw = lastE - firstE;
  const rise01 = rise01From(riseRaw);

  const shares = meanBands(energyCurves, startMs, endMs);
  const firstShares = meanBands(energyCurves, windows.first[0], windows.first[1]);
  const lastShares = meanBands(energyCurves, windows.last[0], windows.last[1]);
  const brightness01 = brightnessOf(shares);
  const brightnessDelta = brightnessOf(lastShares) - brightnessOf(firstShares);
  const wash01 = washOf(shares);

  const hz = onsetHz(onsets, startMs, endMs);
  const hzFirst = onsetHz(onsets, windows.firstHalf[0], windows.firstHalf[1]);
  const hzLast = onsetHz(onsets, windows.lastHalf[0], windows.lastHalf[1]);
  const onsetRise01 = clamp01((hzLast - hzFirst) / 2.2);
  const punch01 = punchOf(shares, hz);
  const kicks = kickShare(onsets, startMs, endMs);

  const tonal = meanMajorness(tonalityTimeline, startMs, endMs, analysis);
  const minor01 = clamp01(0.5 - 0.5 * tonal.majorness);
  const roughness01 = roughnessOf(tonalityTimeline, startMs, endMs);

  const lastLoud = highEnergy01(lastE);
  const loud = Number.isFinite(relEnergy01)
    ? Math.max(highEnergy01(energy01), lastLoud, clamp01(relEnergy01))
    : Math.max(highEnergy01(energy01), lastLoud);
  // Last-third energy and a clear climb both count. A 60s swell that is
  // the loud part of the song must not classify calm just because its
  // section-wide mean sits near 0.5 after song-max normalization.
  const isHighEnergy = loud >= 0.35 || energy01 >= HIGH_KNEE || lastE >= HIGH_KNEE || rise01 >= 0.45;
  const isBuild = rise01 >= 0.2 || (isHighEnergy && riseRaw > 0);

  // Tension: energy climbs (or holds loud) while the spectrum stays or goes
  // dark, mid-band wash without new hits, minor climate, unstable key.
  // Mid-band wash is unresolved smear only when hits are not cutting
  // through. A kicky chorus still has guitar mids; that is not tension.
  const smear01 = wash01 * (1 - punch01);
  let tension01 = clamp01(
    0.26 * Math.max(rise01, isHighEnergy ? 0.35 : 0)
    + 0.20 * (1 - brightness01)
    + 0.14 * clamp01(-brightnessDelta * 2.2)
    + 0.14 * smear01
    + 0.12 * minor01
    + 0.08 * roughness01
    + 0.06 * (1 - punch01)
    - 0.16 * onsetRise01
    - 0.10 * kicks,
  );
  // Drive: energy climbs while the spectrum opens, hits arrive, major climate.
  let drive01 = clamp01(
    0.24 * Math.max(rise01, isHighEnergy ? 0.25 : 0)
    + 0.18 * brightness01
    + 0.14 * clamp01(brightnessDelta * 2.2)
    + 0.16 * punch01
    + 0.12 * onsetRise01
    + 0.10 * kicks
    + 0.08 * (1 - minor01)
    - 0.10 * smear01
    - 0.08 * roughness01,
  );

  if (!isHighEnergy) {
    tension01 *= 0.25;
    drive01 *= 0.25;
  }

  let kind = BUILD_KIND.CALM;
  if (isHighEnergy) {
    if (tension01 - drive01 >= KIND_MARGIN) kind = BUILD_KIND.TENSION;
    else if (drive01 - tension01 >= KIND_MARGIN) kind = BUILD_KIND.DRIVE;
    else kind = BUILD_KIND.MIXED;
  }

  const glowTame01 = glowTameFor({ kind, tension01, drive01, energy01, isHighEnergy, isBuild });
  const confidence = clamp01(
    0.35
    + 0.25 * (energyCurves ? 1 : 0)
    + 0.2 * tonal.weight
    + 0.2 * clamp01((onsets?.length || 0) / 24),
  );

  return {
    kind,
    isHighEnergy,
    isBuild,
    energy01,
    rise01,
    brightness01,
    brightnessDelta,
    wash01,
    punch01,
    onsetRise01,
    minor01,
    roughness01,
    tension01,
    drive01,
    glowTame01,
    confidence,
  };
}

export function glowTameFor({
  kind = BUILD_KIND.CALM, tension01 = 0, energy01 = 0,
  isHighEnergy = false,
} = {}) {
  if (!isHighEnergy && kind === BUILD_KIND.CALM) return 0;
  if (kind === BUILD_KIND.TENSION) {
    // Held-back smolder. The unresolved climb must not look like a drop.
    return clamp01(0.35 + 0.50 * tension01);
  }
  if (kind === BUILD_KIND.DRIVE) {
    // Modest lid so a clean lift does not clip the frame before the arrival.
    return clamp01(0.08 + 0.12 * highEnergy01(energy01));
  }
  if (kind === BUILD_KIND.MIXED) {
    return clamp01(0.20 + 0.25 * tension01);
  }
  return 0;
}

/** Multiplier for bloom / city-light / halo. Never reaches zero. */
export function glowMulFromTame(glowTame01, amount = 0.85) {
  return clamp(1 - amount * clamp01(glowTame01), 0.12, 1);
}

/**
 * Classify every section. `sections` may be SongProfile sections or
 * BiomeManager schedule rows; both have startMs/endMs and optionally energy
 * / relEnergy01 / meanEnergy.
 */
export function analyzeBuildCharacter({
  sections = [], energyCurves = null, onsets = null, analysis = null, tonalityTimeline = null,
} = {}) {
  if (!Array.isArray(sections) || !sections.length) return [];
  return sections.map((section) => classifyBuildSection({
    startMs: section.startMs,
    endMs: section.endMs,
    energy: section.energy ?? section.meanEnergy,
    relEnergy01: section.relEnergy01,
    energyCurves,
    onsets,
    analysis,
    tonalityTimeline,
  }));
}

export function attachBuildCharacter(sections, climates) {
  if (!Array.isArray(sections)) return sections;
  for (let i = 0; i < sections.length; i++) {
    const climate = climates?.[i] || EMPTY_CLIMATE;
    sections[i].build = climate;
    sections[i].buildKind = climate.kind;
    sections[i].tension01 = climate.tension01;
    sections[i].drive01 = climate.drive01;
    sections[i].glowTame01 = climate.glowTame01;
  }
  return sections;
}

const DEFAULT_SAMPLE = Object.freeze({
  kind: BUILD_KIND.CALM,
  tension01: 0,
  drive01: 0,
  glowTame01: 0,
  glowMul: 1,
});

/**
 * Climate at a moment. Looks up the section that contains tMs. Missing
 * profile or empty sections are calm (no taming).
 */
export function sampleBuildCharacter(source, tMs) {
  const sections = Array.isArray(source)
    ? source
    : (source?.sections || source?.buildCharacter || null);
  if (!Array.isArray(sections) || !sections.length) return DEFAULT_SAMPLE;
  const t = Number.isFinite(tMs) ? tMs : 0;
  let hit = sections[0];
  for (const s of sections) {
    if (t >= s.startMs && t < s.endMs) { hit = s; break; }
    if (t >= s.startMs) hit = s;
  }
  const climate = hit.build || hit;
  const glowTame01 = clamp01(climate.glowTame01);
  return {
    kind: climate.kind || climate.buildKind || BUILD_KIND.CALM,
    tension01: clamp01(climate.tension01),
    drive01: clamp01(climate.drive01),
    glowTame01,
    glowMul: glowMulFromTame(glowTame01),
  };
}
