// Musical controls shared by every painterly world draw path.
// Rhythm comes from the conductor subscription; never invent a beat from BPM.
// Sampling is causal and stateless, so rendering cannot advance the music.
import { clamp01, lerp } from '../utils/math.js';

const unit = (value) => Number.isFinite(value) ? clamp01(value) : 0;

// How big a step up in section energy counts. Below the knee a boundary is a
// continuation and gets nothing; at LIFT_FULL it is the whole move.
const LIFT_KNEE = 0.05;
const LIFT_FULL = 0.22;
// A lift into a section that is quiet FOR THIS SONG is still only a lift
// into a quiet section. This is the floor such a boundary keeps.
const REL_FLOOR = 0.45;

export function sampleWorldMusic({ nowMs = 0, energyCurves = null, rhythm = null, section = null, reducedFlash = false, reducedMotion = false, response = null, glowTame01 = 0 } = {}) {
  nowMs = Number.isFinite(nowMs) ? Math.max(0, nowMs) : 0;
  const windowMs = Number.isFinite(response?.smoothingMs) ? response.smoothingMs : 1200;
  const n = Math.max(8, Math.round(windowMs / 20));
  // Average the trailing window at 20ms spacing (the audio curves' normal
  // frame size). Sparse taps can align with rapid drums and turn every tap
  // into the same peak, defeating the slow-pressure envelope. Fixed samples
  // also make 30/60fps and paused renders agree. n=60 is the historical
  // 1.2s window; tests that omit `response` keep that exact read.
  let bass = 0, energy = 0;
  const denomBass = n * 2;
  for (let i = 0; i < n; i++) {
    const at = nowMs - (i + 0.5) * 20;
    if (at < 0) continue;
    bass += (unit(energyCurves?.sample?.(0, at)) + unit(energyCurves?.sample?.(1, at))) / denomBass;
    energy += unit(energyCurves?.globalEnergyNorm?.(at)) / n;
  }
  const accentWindow = Number.isFinite(response?.accentWindowMs) ? response.accentWindowMs : 800;
  const accentDecay = Number.isFinite(response?.accentDecayMs) ? response.accentDecayMs : 150;
  const accentGain = Number.isFinite(response?.accentGain) ? response.accentGain : 1;
  const age = nowMs - (rhythm?.tMs ?? -Infinity);
  const accent = age >= 0 && age < accentWindow
    ? unit(rhythm.vel) * Math.exp(-age / accentDecay) * accentGain * (reducedFlash ? 0.25 : 1) : 0;
  const macroMs = Number.isFinite(response?.macroMs) ? response.macroMs : 8000;
  const ambientScale = Number.isFinite(response?.ambientScale) ? response.ambientScale : 1;
  const cityFloor = response && Number.isFinite(response.cityLightFloor) ? response.cityLightFloor : 0.18;
  const waterFloor = response && Number.isFinite(response.waterLightFloor) ? response.waterLightFloor : 0.12;
  const tame = clamp01(Number.isFinite(glowTame01) ? glowTame01 : (section?.glowTame01 ?? 0));
  const energyGlow = energy * (1 - 0.70 * tame);
  // Open over four seconds at an evidence-backed boundary. Pacing-only
  // cuts are visual scheduling, not evidence of a musical phrase.
  const elapsed = nowMs - (section?.startMs ?? 0);
  const span = Math.min(4000, (section?.endMs ?? 0) - (section?.startMs ?? 0));
  const trust = section?.provenance === 'detected' ? 1 : section?.provenance === 'inferred' ? 0.5 : 0;
  const reveal = section?.startMs > 0 && elapsed > 0 && elapsed < span
    ? Math.sin(Math.PI * elapsed / span) ** 2 * trust : 0;
  return {
    bass, energy, accent, reveal,
    glowTame: tame,
    group: rhythm && Number.isFinite(rhythm.tMs) ? Math.abs(Math.round(rhythm.tMs * 0.013)) % 4 : 0,
    // Spatial consumers use motionScale; light retains the raw evidence above.
    motionScale: reducedMotion ? 0 : 1,
    current: reducedFlash || reducedMotion ? 0 : Math.sin(nowMs / macroMs) * (0.35 + 0.35 * bass) * ambientScale,
    cityLight: cityFloor + 0.45 * energyGlow * ambientScale,
    waterLight: waterFloor + 0.22 * bass * ambientScale,
  };
}

/** Draw paths share this so a world's response config actually reaches the sample. */
export function sampleManagerMusic(mgr, extra = {}) {
  const section = mgr?.sections?.[mgr._lastSectionIdx];
  return sampleWorldMusic({
    nowMs: (mgr?.tSec ?? 0) * 1000,
    energyCurves: mgr?.energyCurves,
    rhythm: mgr?.worldRhythm,
    section,
    reducedFlash: !!mgr?.reducedFlash,
    reducedMotion: !!mgr?.reducedMotion,
    response: mgr?.world?.response,
    glowTame01: extra.glowTame01 ?? section?.glowTame01 ?? mgr?.buildGlowTame ?? 0,
    ...extra,
  });
}

/**
 * How much of a bloom / pour / horizon this boundary has earned, 0..1.
 *
 * Two questions, both answered by numbers the section pass already stored.
 * How much of a step up is it (`meanEnergy` against the section we came from),
 * and how high does the arriving section sit in the song as a whole
 * (`relEnergy01`)? The first is what makes a boundary an event; the second is
 * what keeps a verse that happens to follow the quietest bar in the song from
 * getting the chorus's treatment.
 *
 * Provenance is deliberately NOT checked here -- `sampleWorldMusic`'s `reveal`
 * already zeroes decorative cuts and halves inferred ones, and doing it twice
 * would square the weighting.
 */
export function boundaryLift01(section, prevSection) {
  if (!section || !prevSection) return 0;
  // Below the knee this goes negative and clamps to zero on its own, which is
  // the whole gate -- a continuation or a fall into a quieter section earns
  // nothing without a separate branch saying so.
  const step = (section.meanEnergy ?? 0) - (prevSection.meanEnergy ?? 0);
  const size = clamp01((step - LIFT_KNEE) / (LIFT_FULL - LIFT_KNEE));
  const standing = lerp(REL_FLOOR, 1, clamp01(section.relEnergy01 ?? 0.5));
  return clamp01(size * standing);
}
