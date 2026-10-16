// One song summary, with confidence, for every world to consume.
//
// Worlds, DNA, scoring and the chooser must not each invent a contradictory
// read of the same recording. buildSongProfile is the shared extraction:
// global features, section features, timed events, and provenance for every
// derived number. Missing information is an intentional fallback, not a
// confident recommendation.
//
// Ridge landmarks stay a phrase/terrain feature. Onset rate comes from
// detected timestamps when they exist. Pulse is not BPM. Adjacent sections
// are compared by energy, not by how many labels were minted.
import { clamp, clamp01, spread01 } from '../utils/math.js';
import { FLAT_WEIGHTS } from './bands.js';
import { extractRidgePortrait, lithologyFromShares } from '../world/RidgePortrait.js';
import { tonalEvidence } from './TonalEvidence.js';
import { Role } from '../core/NoteEvent.js';

export const PROFILE_VERSION = 2;

function freezeDeep(value) {
  if (!value || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function meanEnergy(curves, fromMs, toMs) {
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

function meanBand(curves, band, fromMs, toMs) {
  if (!curves || typeof curves.sample !== 'function') return 0;
  const lo = Math.max(0, fromMs || 0);
  const hi = Math.max(lo + 1, toMs || lo + 1);
  let sum = 0, n = 0;
  for (let t = lo; t < hi; t += 40) {
    const v = curves.sample(band, t);
    if (Number.isFinite(v)) { sum += v; n++; }
  }
  return n ? sum / n : 0;
}

function burstinessOf(times) {
  if (!Array.isArray(times) || times.length < 8) {
    return { value: 0, confidence: 0 };
  }
  const iois = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 0) iois.push(d);
  }
  if (iois.length < 4) return { value: 0, confidence: 0 };
  const mean = iois.reduce((a, b) => a + b, 0) / iois.length;
  if (!(mean > 1)) return { value: 0, confidence: 0 };
  let varSum = 0;
  for (const d of iois) varSum += (d - mean) ** 2;
  const cv = Math.sqrt(varSum / iois.length) / mean;
  return {
    value: clamp01((cv - 0.15) / 1.2),
    confidence: clamp01(times.length / 48),
  };
}

function interpretPulse({ bpm = 0, beatPeriodMs = 0, confidence = 0, freeTime = false, regularity = 0 } = {}) {
  const conf = clamp01(confidence);
  if (freeTime || !(bpm > 0) || conf < 0.2) {
    return {
      bpm: bpm || 0,
      beatPeriodMs: beatPeriodMs || 0,
      confidence: freeTime ? 0 : conf,
      regularity: clamp01(regularity),
      freeTime: true,
      interpretation: 'free',
      altBpm: null,
    };
  }
  let interpretation = 'straight';
  let altBpm = null;
  if (bpm >= 160 && conf < 0.85) {
    interpretation = 'double';
    altBpm = bpm / 2;
  } else if (bpm > 0 && bpm <= 70 && conf < 0.85) {
    interpretation = 'half';
    altBpm = bpm * 2;
  }
  return {
    bpm,
    beatPeriodMs: beatPeriodMs || (bpm > 0 ? 60000 / bpm : 0),
    confidence: conf,
    regularity: clamp01(regularity),
    freeTime: false,
    interpretation,
    altBpm,
  };
}

function sectionFeatures(structure, energyCurves, durationMs) {
  const bounds = Array.isArray(structure?.boundariesMs) ? structure.boundariesMs : null;
  if (!bounds || !bounds.length) return [];
  const starts = bounds.filter(t => Number.isFinite(t) && t >= 0 && t < durationMs);
  const endpoints = [...starts, durationMs];
  const labels = structure.labels || [];
  const conf = Number.isFinite(structure.confidence) ? clamp01(structure.confidence) : 0;
  const provenance = conf >= 0.45 ? 'detected' : conf > 0 ? 'inferred' : 'decorative';
  const out = [];
  for (let i = 0; i < endpoints.length - 1; i++) {
    const startMs = endpoints[i];
    const endMs = endpoints[i + 1];
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    // Song-relative mean, never min-max stretched inside this section.
    const energy = meanEnergy(energyCurves, startMs, endMs);
    const bass = meanBand(energyCurves, 0, startMs, endMs);
    const prev = out.length ? out[out.length - 1].energy : null;
    out.push({
      startMs,
      endMs,
      label: labels[i] ?? null,
      provenance,
      energy,
      bass,
      contrastToPrev: prev == null ? 0 : Math.abs(energy - prev),
    });
  }
  return out;
}

function adjacentContrast(sections, dyn) {
  if (!sections.length) {
    return { contrast: dyn, source: 'dynamics', confidence: 0.35 };
  }
  if (sections.length < 2) {
    return { contrast: dyn, source: 'dynamics', confidence: 0.4 };
  }
  let acc = 0, n = 0;
  for (const s of sections) {
    if (s.contrastToPrev > 0) { acc += s.contrastToPrev; n++; }
  }
  if (!n) return { contrast: dyn, source: 'dynamics', confidence: 0.4 };
  const measured = clamp01(acc / n * 1.6);
  return {
    contrast: clamp01(0.4 * dyn + 0.6 * measured),
    source: 'adjacent-energy',
    confidence: 0.7,
  };
}

function rhythmEvents(data) {
  const timeline = Array.isArray(data?.timeline) ? data.timeline : [];
  const fromTimeline = timeline
    .filter((e) => e && (e.role === Role.RHYTHM || e.channel === 9) && Number.isFinite(e.tMs))
    .sort((a, b) => a.tMs - b.tMs);
  if (fromTimeline.length >= 4) {
    return fromTimeline.map((e) => ({
      tMs: e.tMs,
      vel: Number.isFinite(e.vel) ? e.vel : 0.5,
      kick: !!e.kick,
    }));
  }
  const listed = data?.analysis?.rhythm?.onsets;
  if (Array.isArray(listed) && listed.length >= 4) {
    return listed
      .filter((e) => Number.isFinite(e?.tMs))
      .map((e) => ({ tMs: e.tMs, vel: e.vel ?? e.strength ?? 0.5, kick: !!e.kick }));
  }
  return [];
}

/**
 * Shared, versioned song profile. Pure. Deterministic for the same inputs.
 * The returned object is frozen.
 */
export function buildSongProfile(data = {}) {
  const durationMs = Math.max(0, Number(data.durationMs) || 0);
  const dur = Math.max(1, durationMs || 1);
  const bpm = Number.isFinite(data.bpm) ? data.bpm : 0;
  const analysis = data.analysis || null;
  const structure = data.structure || null;
  const energyCurves = data.energyCurves || null;
  const freeTime = !!data.freeTime;

  let centroid = 0.5, bass = 0.3, air = 0.1, spread = 0.5, litho = null;
  let dyn = 0.4, energyMean = 0.4, phrase = 0.3, landmarks = 4, trend = 0;
  let pulse = 0.5, rhythmWeight = 0;

  if (energyCurves && energyCurves.n >= 8) {
    const portrait = extractRidgePortrait(energyCurves, dur);
    if (portrait) {
      centroid = portrait.centroid01;
      bass = portrait.bassShare;
      air = portrait.airShare;
      spread = portrait.spread01;
      litho = portrait.lithology;
      dyn = portrait.dynamicRange;
      phrase = portrait.phraseStrength;
      landmarks = portrait.landmarks?.length ?? 4;
      const wave = portrait.energyWave;
      if (wave && wave.length) {
        let wMin = 1, wMax = 0;
        for (let i = 0; i < wave.length; i++) {
          const v = wave[i];
          if (v < wMin) wMin = v;
          if (v > wMax) wMax = v;
        }
        dyn = Math.max(dyn, clamp01(wMax - wMin));
        const third = Math.max(1, Math.floor(wave.length / 3));
        let a = 0, b = 0;
        for (let i = 0; i < third; i++) a += wave[i];
        for (let i = wave.length - third; i < wave.length; i++) b += wave[i];
        trend = clamp((b / third - a / third) * 2.5, -1, 1);
      }
    } else {
      litho = lithologyFromShares(null);
    }
    if (typeof energyCurves.calibration === 'function') {
      const cal = energyCurves.calibration(FLAT_WEIGHTS);
      dyn = clamp01((cal?.spread ?? 0.2) / 0.5);
      energyMean = clamp01(((cal?.lo ?? 0) + (cal?.hi ?? 0.4)) * 0.5);
    }
  }

  const perMin = landmarks / (dur / 60000);
  let onset = clamp01(perMin / 10);
  let onsetSource = 'landmarks';
  let onsetConfidence = 0.2;

  const events = rhythmEvents(data);
  const eventRateHz = events.length ? events.length / (dur / 1000) : 0;
  const burst = burstinessOf(events.map((e) => e.tMs));

  const rhythm = analysis?.rhythm;
  if (Number.isFinite(rhythm?.eventDensity)
    && Number.isFinite(rhythm?.pulseRegularity)
    && Number.isFinite(rhythm?.confidence)) {
    rhythmWeight = clamp01((rhythm.confidence - 0.25) / 0.5);
    onset = clamp01(onset * (1 - rhythmWeight) + clamp01(rhythm.eventDensity) * rhythmWeight);
    pulse = clamp01(0.5 * (1 - rhythmWeight) + clamp01(rhythm.pulseRegularity) * rhythmWeight);
    onsetSource = rhythmWeight > 0 ? 'onsets' : 'landmarks';
    onsetConfidence = clamp01(rhythm.confidence);
  } else if (events.length >= 4) {
    const density = clamp01(eventRateHz / 4);
    rhythmWeight = 0.55;
    onset = clamp01(onset * 0.45 + density * 0.55);
    pulse = 0.5;
    onsetSource = 'timeline';
    onsetConfidence = clamp01(events.length / 32);
  }

  if (Number.isFinite(analysis?.brightness)) {
    centroid = clamp01(0.55 * centroid + 0.45 * analysis.brightness);
  }
  if (Number.isFinite(analysis?.dynamicRange)) {
    dyn = clamp01(0.5 * dyn + 0.5 * analysis.dynamicRange);
  }

  const sections = sectionFeatures(structure, energyCurves, durationMs);
  const contrastRead = adjacentContrast(sections, dyn);
  const contrast = contrastRead.contrast;

  // A supplied BPM without recording analysis is authored transport (MIDI
  // or legacy generated fixtures). Missing recording confidence is unknown.
  const recording = !!analysis || (data.timeline || []).some(e => e.src === 'audio');
  const tempoConfidence = freeTime ? 0 : clamp01(data.confidence ?? rhythm?.confidence ?? (recording ? 0 : bpm > 0 ? 1 : 0));
  const tempoPhraseGroove = clamp01(1 - Math.abs((tempoConfidence * (bpm || 96) + (1 - tempoConfidence) * 96) - 96) / 70) * (0.55 + 0.45 * phrase);
  const groove = clamp01(tempoPhraseGroove + rhythmWeight * 0.35 * (pulse - tempoPhraseGroove));
  const tempoHeat = clamp01(((bpm || 100) - 72) / 90) * tempoConfidence;
  const warmth = clamp01(0.55 * bass + 0.45 * (1 - centroid));
  const texture = clamp01(0.5 * spread + 0.5 * air);
  const form = clamp01(landmarks / 10);
  const arc = dyn;
  const drive = spread01(clamp01(0.28 * arc + 0.18 * onset + 0.16 * contrast + 0.14 * energyMean + 0.24 * tempoHeat));

  const pulseInfo = interpretPulse({
    bpm,
    beatPeriodMs: data.beatPeriodMs,
    confidence: tempoConfidence,
    freeTime,
    regularity: pulse,
  });

  const timeline = Array.isArray(data.timeline) ? data.timeline : [];
  const tonal = tonalEvidence(data);
  const { tonic, mode, confidence: tonalConfidence, source: tonalSource } = tonal;

  const familySource = timeline.some((e) => Number.isFinite(e?.program) && e.program >= 0)
    ? 'gm-program'
    : 'spectral';

  const watch = {
    centroid, bass, air, spread, dyn, energyMean, phrase, landmarks,
    onset, pulse, contrast, groove, warmth, texture, form, arc, drive, bpm: bpm || 0,
    tempoHeat, litho, trend,
  };

  const tempoConf = pulseInfo.freeTime ? 0 : pulseInfo.confidence;
  const structureConf = Number.isFinite(structure?.confidence) ? clamp01(structure.confidence) : (sections.length ? 0.4 : 0);
  const overall = clamp01(0.34 * tempoConf + 0.28 * tonalConfidence + 0.22 * onsetConfidence + 0.16 * structureConf);

  const profile = {
    version: PROFILE_VERSION,
    durationMs,
    watch,
    pulse: pulseInfo,
    events: {
      onsets: events.slice(0, 1500),
      eventRateHz,
      burstiness: burst.value,
      burstinessConfidence: burst.confidence,
      landmarks,
      onsetSource,
    },
    sections,
    tonal: {
      tonic,
      mode,
      confidence: tonalConfidence,
      source: tonalSource,
      stereoWidth: Number.isFinite(analysis?.stereoWidth) ? analysis.stereoWidth : null,
    },
    family: {
      source: familySource,
      confidence: familySource === 'gm-program' ? 0.8 : 0.25,
    },
    contrast: contrastRead,
    confidence: {
      tempo: tempoConf,
      phase: freeTime ? 0 : clamp01(data.phaseConfidence ?? 0),
      downbeat: freeTime ? 0 : clamp01(data.downbeatConfidence ?? 0),
      meter: freeTime ? 0 : clamp01(data.meterConfidence ?? 0),
      key: tonalConfidence,
      structure: structureConf,
      onset: onsetConfidence,
      overall,
    },
  };

  return freezeDeep(profile);
}

/** JSON-safe snapshot for bundles. Typed arrays become plain arrays. */
export function snapshotSongProfile(profile) {
  return JSON.parse(JSON.stringify(profile, (_, value) => {
    if (ArrayBuffer.isView(value)) return Array.from(value);
    return value;
  }));
}

export function profileFromSnapshot(snap) {
  if (!validSongProfileSnapshot(snap)) return null;
  return freezeDeep(snap);
}

/** Cache snapshots are untrusted JSON. A matching version alone does not
 * establish that the profile can drive world selection or DNA safely. */
export function validSongProfileSnapshot(snap) {
  if (!snap || snap.version !== PROFILE_VERSION || !Number.isFinite(snap.durationMs) || snap.durationMs < 0) return false;
  const finiteTree = value => {
    if (typeof value === 'number') return Number.isFinite(value);
    if (!value || typeof value !== 'object') return true;
    return Object.values(value).every(finiteTree);
  };
  if (!finiteTree(snap)) return false;
  const numeric = (value, fields) => value && fields.every(k => Number.isFinite(value[k]));
  const unit = v => Number.isFinite(v) && v >= 0 && v <= 1;
  if (!numeric(snap.watch, ['centroid','bass','air','spread','dyn','energyMean','phrase','landmarks','onset','pulse','contrast','groove','warmth','texture','form','arc','drive','bpm','tempoHeat','trend'])) return false;
  if (!numeric(snap.pulse,['bpm','beatPeriodMs','confidence','regularity']) || typeof snap.pulse.freeTime !== 'boolean') return false;
  if (!snap.confidence || !['tempo','key','structure','onset','overall'].every(k => unit(snap.confidence[k]))) return false;
  if (['phase','downbeat','meter'].some(k => snap.confidence[k] != null && !unit(snap.confidence[k]))) return false;
  if (!snap.tonal || !unit(snap.tonal.confidence) || !['midi','audio-chroma','spectral-fallback'].includes(snap.tonal.source)) return false;
  if (snap.tonal.tonic !== null && (!Number.isInteger(snap.tonal.tonic) || snap.tonal.tonic < 0 || snap.tonal.tonic > 11)) return false;
  if (snap.tonal.mode !== null && !['major','minor'].includes(snap.tonal.mode)) return false;
  if (!numeric(snap.events,['eventRateHz','burstiness','burstinessConfidence','landmarks']) || !Array.isArray(snap.events.onsets)) return false;
  if (!snap.family || !unit(snap.family.confidence) || !numeric(snap.contrast,['contrast','confidence'])) return false;
  if (!Array.isArray(snap.sections)) return false;
  return snap.sections.every((section,i) => numeric(section,['startMs','endMs','energy','bass','contrastToPrev'])
    && section.startMs >= 0 && section.endMs > section.startMs && section.endMs <= snap.durationMs
    && (!i || section.startMs >= snap.sections[i-1].endMs)
    && ['detected','inferred','decorative'].includes(section.provenance));
}
