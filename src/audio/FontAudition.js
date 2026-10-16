// Per-MIDI SoundFont audition: decides how well a given font renders the
// song that was just loaded. The MIDI is the volatile variable — the same
// font can be perfect for one file and dead silent for the next (missing
// programs, drum-kit-only banks, broken rootKeys) — so every judgment here
// is made per (MIDI, font) pair, never globally per font.
//
// Three pure stages (all Node-testable — no Web Audio here):
//
//   buildAuditionPlan(timelineData)        what to render + what to measure
//   analyzeAudition(rendered, plan)        rendered PCM -> raw metrics
//   scoreAudition(metrics)                 metrics -> verdict {disqualified?, score}
//
// The plan has two independent render sections:
//   - excerpt: a ~10 s slice of the real timeline chosen for maximum
//     track/role coverage. Judges the ensemble: silence, onset-spike-only
//     output, clipping, loudness, spectral liveliness.
//   - probes: one isolated loud/soft note pair per distinct
//     (role, program, channel) voice in the MIDI, at that voice's own median
//     pitch. Judges each track surgically: audibility, pitch register,
//     sustain behavior, velocity response, timbre. Probes are rendered as a
//     SEPARATE pass so they always start from true silence — a long-decay
//     pad in the excerpt can never bleed into and corrupt them.
//
// Hard disqualifiers (any one kills the font for this song):
//   silent    nothing audible at all
//   spikes    only onset-aligned transient spikes where sustained pitched
//             notes were scored (the percussion-only-font signature)
//   register  pitched content lands octaves away from what the MIDI asks
//   clipping  heavy digital clipping
//   error     the render itself failed
// Survivors get a 0–100 quality score from coverage, pitch accuracy,
// sustain quality, loudness, balance, velocity response, timbre
// distinctness, and liveliness, minus a clipping penalty.
import { Role } from '../core/NoteEvent.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
export const AUDITION = Object.freeze({
  EXCERPT_SEC: 10,
  EXCERPT_STEP_MS: 500,
  MAX_EXCERPT_EVENTS: 600,
  MAX_PROBE_GROUPS: 10,
  PROBE_NOTE_SEC: 0.45,
  PROBE_SLOT_SEC: 0.65,        // note + settle gap
  PROBE_LEAD_SEC: 0.25,        // silence before the first probe
  RENDER_TAIL_SEC: 0.8,
  SUSTAIN_MIN_DUR_MS: 350,     // a note this long should still be sounding mid-note
  AUDIBLE_DB: -55,             // absolute "you can hear this" floor
  EMERGE_DB: 8,                // must rise this far above the local floor
  SILENT_PEAK_DB: -60,
  SPIKE_CONCENTRATION: 0.80,   // energy share inside onset neighborhoods
  SPIKE_SUSTAIN_FRAC: 0.15,    // <15% of sustained notes audible => spikes-only
  REGISTER_ERR_OCT: 1.2,       // weighted-median |octave error| beyond this => DQ
  CLIP_RATIO_DQ: 0.06,
  MIN_SUSTAIN_TARGETS: 4,      // fewer scored sustains than this -> gate can't fire
});

export const REASON_LABEL = Object.freeze({
  silent: 'Silent for this song',
  spikes: 'Only percussive spikes',
  register: 'Wrong register (octaves off)',
  clipping: 'Clips / distorts',
  error: 'Render failed',
});

const midiHz = (pitch) => 440 * Math.pow(2, (pitch - 69) / 12);
const dB = (lin) => 20 * Math.log10(Math.max(lin, 1e-9));
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// ---------------------------------------------------------------------------
// 1. Plan
// ---------------------------------------------------------------------------

/**
 * @param {{timeline: Array, durationMs: number}} timelineData  midiToTimeline output
 * @returns {object|null} audition plan, or null when there is nothing to audition
 */
export function buildAuditionPlan(timelineData, opts = {}) {
  const cfg = { ...AUDITION, ...opts };
  const timeline = (timelineData?.timeline || []).filter((e) => e && e.pitch != null);
  const durationMs = timelineData?.durationMs || (timeline.length ? timeline[timeline.length - 1].tMs + 1000 : 0);
  if (timeline.length === 0) return null;

  const groups = buildProbeGroups(timeline, cfg.MAX_PROBE_GROUPS);
  const excerpt = pickExcerpt(timeline, durationMs, groups, cfg);
  const probeSection = buildProbeSection(groups, cfg);

  return { excerpt, probes: probeSection, groups };
}

/** Distinct (role, program, channel) voices, heaviest first. */
function buildProbeGroups(timeline, maxGroups) {
  const byKey = new Map();
  for (const e of timeline) {
    const key = `${e.role}|${e.program ?? -1}|${e.channel ?? 0}`;
    let g = byKey.get(key);
    if (!g) {
      g = { key, role: e.role, program: e.program ?? -1, channel: e.channel ?? 0, pitches: [], noteCount: 0 };
      byKey.set(key, g);
    }
    g.noteCount++;
    g.pitches.push(e.pitch);
  }
  const groups = [...byKey.values()].sort((a, b) => b.noteCount - a.noteCount).slice(0, maxGroups);
  for (const g of groups) {
    g.pitches.sort((a, b) => a - b);
    g.pitch = g.role === Role.RHYTHM
      ? modalValue(g.pitches)
      : g.pitches[g.pitches.length >> 1]; // median: probe the register the song actually uses
    g.pitched = g.role !== Role.RHYTHM;
    g.expectedHz = g.pitched ? midiHz(g.pitch) : 0;
    delete g.pitches;
  }
  return groups;
}

function modalValue(sorted) {
  let best = sorted[0], bestN = 0, cur = sorted[0], n = 0;
  for (const v of sorted) {
    if (v === cur) { n++; } else { cur = v; n = 1; }
    if (n > bestN) { bestN = n; best = cur; }
  }
  return best;
}

/**
 * Slide a window over the song and keep the one that covers the most probe
 * groups (all tracks represented), with note density and sustained pitched
 * notes as tiebreakers. Two-pointer sweep — O(n + steps).
 */
function pickExcerpt(timeline, durationMs, groups, cfg) {
  const winMs = Math.min(cfg.EXCERPT_SEC * 1000, durationMs);
  const groupIndex = new Map(groups.map((g, i) => [g.key, i]));
  const keyOf = (e) => `${e.role}|${e.program ?? -1}|${e.channel ?? 0}`;
  const isSustained = (e) => e.role !== Role.RHYTHM && e.durMs >= cfg.SUSTAIN_MIN_DUR_MS;

  let bestStart = 0;
  if (durationMs > winMs) {
    const counts = new Array(groups.length).fill(0);
    let sustained = 0, total = 0, lo = 0, hi = 0, bestScore = -1;
    const add = (e, sign) => {
      const gi = groupIndex.get(keyOf(e));
      if (gi !== undefined) counts[gi] += sign;
      if (isSustained(e)) sustained += sign;
      total += sign;
    };
    for (let start = 0; start <= durationMs - winMs; start += cfg.EXCERPT_STEP_MS) {
      while (hi < timeline.length && timeline[hi].tMs < start + winMs) add(timeline[hi++], +1);
      while (lo < hi && timeline[lo].tMs < start) add(timeline[lo++], -1);
      let present = 0;
      for (const c of counts) if (c > 0) present++;
      const score = present * 4 + Math.min(sustained, 12) * 0.25 + Math.min(total, 100) / 50;
      if (score > bestScore) { bestScore = score; bestStart = start; }
    }
  }

  let events = timeline.filter((e) => e.tMs >= bestStart && e.tMs < bestStart + winMs);
  events = thinEvents(events, keyOf, cfg.MAX_EXCERPT_EVENTS);

  const durSec = winMs / 1000;
  const shifted = events.map((e) => ({ ...e, tMs: e.tMs - bestStart }));
  // What the analyzer will check against the rendered PCM:
  const onsetsSec = shifted.map((e) => e.tMs / 1000);
  const sustainWindows = shifted
    .filter(isSustained)
    .map((e) => ({
      startSec: e.tMs / 1000 + 0.15,
      endSec: Math.min(e.tMs / 1000 + Math.min(e.durMs / 1000, 1.0), durSec + 0.5),
    }))
    .filter((w) => w.endSec - w.startSec >= 0.12);

  return {
    startMs: bestStart,
    durSec,
    renderDurationSec: durSec + cfg.RENDER_TAIL_SEC,
    events: shifted,
    onsetsSec,
    sustainWindows,
  };
}

/** Deterministic thinning: sparse voices keep every note, dense voices are
 *  subsampled evenly, so a 4000-note drum track can't crowd out a 40-note
 *  lead from the render budget. */
function thinEvents(events, keyOf, cap) {
  if (events.length <= cap) return events;
  const byKey = new Map();
  for (const e of events) {
    const k = keyOf(e);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }
  const nGroups = byKey.size;
  const out = [];
  for (const list of byKey.values()) {
    // A sparse voice is kept whole — thinning a 12-note lead line would
    // change what the excerpt IS. Only dense voices get subsampled.
    const budget = list.length <= 24
      ? list.length
      : Math.max(24, Math.floor(cap * (list.length / events.length)));
    if (list.length <= budget) { out.push(...list); continue; }
    const step = list.length / budget;
    for (let i = 0; i < budget; i++) out.push(list[Math.floor(i * step)]);
  }
  out.sort((a, b) => a.tMs - b.tMs);
  return out.length > cap + nGroups * 24 ? out.slice(0, cap + nGroups * 24) : out;
}

/** One isolated loud/soft note pair per probe group, in its own silence. */
function buildProbeSection(groups, cfg) {
  const events = [];
  const probes = [];
  let tSec = cfg.PROBE_LEAD_SEC;
  for (const g of groups) {
    const loudStartSec = tSec;
    const softStartSec = tSec + cfg.PROBE_SLOT_SEC;
    for (const [startSec, vel] of [[loudStartSec, 0.85], [softStartSec, 0.4]]) {
      events.push({
        tMs: startSec * 1000,
        durMs: cfg.PROBE_NOTE_SEC * 1000,
        pitch: g.pitch,
        vel,
        role: g.role,
        kick: false,
        src: 'midi',
        channel: g.channel,
        pan: 0,
        program: g.program,
      });
    }
    probes.push({
      key: g.key,
      role: g.role,
      program: g.program,
      channel: g.channel,
      weight: g.noteCount,
      pitched: g.pitched,
      pitch: g.pitch,
      expectedHz: g.expectedHz,
      loudStartSec,
      softStartSec,
      noteDurSec: cfg.PROBE_NOTE_SEC,
    });
    tSec += cfg.PROBE_SLOT_SEC * 2;
  }
  return {
    events,
    probes,
    durSec: tSec,
    renderDurationSec: tSec + cfg.RENDER_TAIL_SEC,
  };
}

// ---------------------------------------------------------------------------
// 2. Analysis (pure DSP on rendered mono PCM)
// ---------------------------------------------------------------------------

/**
 * @param {{excerptData: Float32Array, probeData: Float32Array, sampleRate: number}} rendered
 * @param {object} plan  from buildAuditionPlan
 * @returns {object} metrics for scoreAudition
 */
export function analyzeAudition(rendered, plan) {
  const { excerptData, probeData, sampleRate } = rendered;

  const excerpt = analyzeExcerpt(excerptData, sampleRate, plan.excerpt);
  const probes = analyzeProbes(probeData, sampleRate, plan.probes);

  return { sampleRate, excerpt, probes };
}

function analyzeExcerpt(data, sr, excerptPlan) {
  const prefix = energyPrefix(data);
  const totalEnergy = prefix[data.length];
  let nonFinite = 0, clipped = 0, peak = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) { nonFinite++; continue; }
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a > 0.99) clipped++;
  }

  // Windowed RMS envelope for floor/activity measures.
  const win = Math.round(sr * 0.023), hop = win >> 1;
  const envDb = [];
  for (let s = 0; s + win <= data.length; s += hop) {
    envDb.push(dB(Math.sqrt((prefix[s + win] - prefix[s]) / win)));
  }
  const sortedEnv = [...envDb].sort((a, b) => a - b);
  const floorDb = percentileSorted(sortedEnv, 0.10);
  const peakEnvDb = sortedEnv.length ? sortedEnv[sortedEnv.length - 1] : -180;
  // ABSOLUTE threshold, deliberately not floor-relative: a dense MIDI can
  // render as a continuous wall of sound where the 10th-percentile "floor"
  // IS the signal — floor-relative audibility would read a loud, healthy
  // render as silent. Floor-relative emergence only makes sense against the
  // probe render, whose gaps are true silence.
  const audibleThreshold = AUDITION.AUDIBLE_DB;
  let active = 0, activeEnergy = 0, activeSamples = 0;
  for (let i = 0, s = 0; i < envDb.length; i++, s += hop) {
    if (envDb[i] > audibleThreshold) {
      active++;
      activeEnergy += prefix[Math.min(s + win, data.length)] - prefix[s];
      activeSamples += win;
    }
  }
  const audibleFrac = envDb.length ? active / envDb.length : 0;
  const activeRmsDb = activeSamples ? dB(Math.sqrt(activeEnergy / activeSamples)) : -180;

  // Energy concentration inside onset neighborhoods ([-30ms, +90ms] around
  // each scheduled note start, unioned). Near 1.0 = everything the font
  // produced is attack transients — the "beat-aligned spikes" signature.
  const intervals = mergeIntervals(
    excerptPlan.onsetsSec.map((t) => [
      Math.max(0, Math.round((t - 0.03) * sr)),
      Math.min(data.length, Math.round((t + 0.09) * sr)),
    ]),
  );
  let onsetEnergy = 0;
  for (const [a, b] of intervals) onsetEnergy += prefix[b] - prefix[a];
  const onsetConcentration = totalEnergy > 0 ? onsetEnergy / totalEnergy : 0;

  // Which scored sustained notes are actually still sounding mid-note?
  // Judged by the 30th-percentile FRAME level inside the window, not the
  // window's total RMS: an overlapping drum hit is loud but brief, so it
  // lifts only a few frames — a genuine sustain keeps (nearly) every frame
  // up. Whole-window RMS would let a click-only render pass on drum bleed.
  // Same absolute threshold as above (and same rationale).
  const threshold = AUDITION.AUDIBLE_DB;
  let sustainAudible = 0, sustainTargets = 0;
  for (const w of excerptPlan.sustainWindows) {
    const f0 = Math.max(0, Math.ceil((w.startSec * sr) / hop));
    const f1 = Math.min(envDb.length, Math.floor((w.endSec * sr - win) / hop) + 1);
    if (f1 - f0 < 4) continue; // too short to judge
    sustainTargets++;
    const frames = envDb.slice(f0, f1).sort((a, b) => a - b);
    if (percentileSorted(frames, 0.30) > threshold) sustainAudible++;
  }

  const flux = spectralFluxMean(data, sr);

  return {
    nonFinite,
    peakDb: dB(peak),
    peakEnvDb,
    clipRatio: data.length ? clipped / data.length : 0,
    floorDb,
    audibleFrac,
    activeRmsDb,
    onsetConcentration,
    sustainTargets,
    sustainAudibleFrac: sustainTargets ? sustainAudible / sustainTargets : 1,
    flux,
  };
}

function analyzeProbes(data, sr, probePlan) {
  const prefix = energyPrefix(data);
  const rms = (aSec, bSec) => {
    const a = Math.max(0, Math.round(aSec * sr));
    const b = Math.min(data.length, Math.round(bSec * sr));
    return b - a > 0 ? Math.sqrt((prefix[b] - prefix[a]) / (b - a)) : 0;
  };

  const results = [];
  for (const p of probePlan.probes) {
    const note = (startSec) => {
      const preDb = dB(rms(startSec - 0.18, startSec - 0.03)); // local floor: the gap before the note
      const onsetDb = dB(rms(startSec, startSec + 0.10));
      const earlyDb = dB(rms(startSec + 0.12, startSec + 0.24));
      const lateDb = dB(rms(startSec + 0.30, startSec + 0.42));
      const sustainDb = dB(rms(startSec + 0.12, startSec + 0.42));
      const emerged = (x) => x > Math.max(AUDITION.AUDIBLE_DB, preDb + AUDITION.EMERGE_DB);
      return {
        preDb, onsetDb, sustainDb,
        onsetAudible: emerged(onsetDb),
        sustainAudible: emerged(sustainDb),
        holdDb: lateDb - earlyDb, // ~0 sustained · very negative = decayed to a click
      };
    };
    const loud = note(p.loudStartSec);
    const soft = note(p.softStartSec);

    let f0 = 0, clarity = 0, pitchErrOct = null, centroidHz = 0;
    if (loud.onsetAudible || loud.sustainAudible) {
      const start = Math.round((p.loudStartSec + 0.10) * sr);
      const len = Math.min(Math.round(0.34 * sr), data.length - start);
      if (len > 512) {
        const pitch = estimatePitch(data, start, len, sr);
        f0 = pitch.f0; clarity = pitch.clarity;
        if (p.pitched && f0 > 0 && clarity >= 0.5) {
          pitchErrOct = Math.log2(f0 / p.expectedHz);
        }
        centroidHz = spectralCentroid(data, start, len, sr);
      }
    }

    results.push({
      key: p.key,
      role: p.role,
      program: p.program,
      weight: p.weight,
      pitched: p.pitched,
      expectedHz: p.expectedHz,
      loud, soft,
      audible: loud.onsetAudible || loud.sustainAudible,
      f0, clarity, pitchErrOct, centroidHz,
      velRespDb: (loud.sustainAudible && (soft.sustainDb > -90)) ? loud.sustainDb - soft.sustainDb : null,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// 3. Scoring
// ---------------------------------------------------------------------------

/**
 * @returns {{disqualified: string|null, reason: string|null, score: number, parts: object}}
 *   disqualified is one of REASON_LABEL's keys, or null for a ranked font.
 *   score is 0 for disqualified fonts, else 1–100.
 */
export function scoreAudition(metrics) {
  const ex = metrics.excerpt;
  const probes = metrics.probes || [];
  const out = (disqualified, score = 0, parts = {}) => ({
    disqualified,
    reason: disqualified ? REASON_LABEL[disqualified] : null,
    score: Math.round(score),
    parts,
  });

  // --- Hard gates, cheapest suspicion first ---
  if (ex.nonFinite > 0) return out('error');
  if (ex.peakEnvDb < AUDITION.SILENT_PEAK_DB || ex.audibleFrac < 0.02) return out('silent');

  // Percussion-only signature: the sustained pitched notes we scored are not
  // sounding, and what energy exists is packed into onset neighborhoods.
  if (ex.sustainTargets >= AUDITION.MIN_SUSTAIN_TARGETS
      && ex.sustainAudibleFrac < AUDITION.SPIKE_SUSTAIN_FRAC
      && ex.onsetConcentration > AUDITION.SPIKE_CONCENTRATION) {
    return out('spikes');
  }
  // Probe backstop for the same failure: several pitched voices probed in
  // isolation, none sustains, but rhythm probes bang away happily.
  const pitchedProbes = probes.filter((p) => p.pitched);
  const rhythmProbes = probes.filter((p) => !p.pitched);
  if (pitchedProbes.length >= 2
      && pitchedProbes.every((p) => !p.loud.sustainAudible)
      && rhythmProbes.some((p) => p.audible)) {
    return out('spikes');
  }

  // Register gate: pitched content lands octaves from where the MIDI put it.
  const voiced = pitchedProbes.filter((p) => p.pitchErrOct !== null);
  const medianErr = weightedMedian(voiced.map((p) => ({ v: p.pitchErrOct, w: p.weight })));
  if (voiced.length >= Math.min(2, pitchedProbes.length) && voiced.length > 0
      && Math.abs(medianErr) > AUDITION.REGISTER_ERR_OCT) {
    return out('register');
  }

  if (ex.clipRatio > AUDITION.CLIP_RATIO_DQ) return out('clipping');

  // --- Quality score ---
  const wsum = (list, f) => {
    let w = 0, acc = 0;
    for (const p of list) { w += p.weight; acc += f(p) * p.weight; }
    return w > 0 ? acc / w : null;
  };

  // Coverage: does each voice of THIS midi make an appropriate sound at all?
  const coverage = wsum(probes, (p) => (p.audible ? 1 : 0)) ?? 0;

  // Pitch accuracy: voiced probes score by octave error; a probe that is
  // audible but unpitchable where pitch was expected (drum sample on a
  // melody track) counts as a full error.
  const pitchAcc = pitchedProbes.length === 0 ? 1 : (wsum(pitchedProbes, (p) => {
    if (p.pitchErrOct !== null) return 1 - clamp01(Math.abs(p.pitchErrOct) / 1.0);
    return p.audible ? 0.25 : 0; // audible-unpitched ≈ wrong; inaudible already hits coverage
  }) ?? 0);

  // Sustain quality: pitched notes should still be alive mid-note, not
  // decayed clicks. holdDb ≥ -18 full credit, ≤ -35 none.
  const sustainers = pitchedProbes.filter((p) => p.loud.sustainAudible);
  const sustainQ = sustainers.length
    ? wsum(sustainers, (p) => clamp01((p.loud.holdDb + 35) / 17))
    : (pitchedProbes.length ? 0 : 0.6);

  // Loudness: full credit −26…−12 dBFS, fading to none at −45 / −3.
  const L = ex.activeRmsDb;
  const loudness = L <= -45 || L >= -3 ? 0
    : L < -26 ? clamp01((L + 45) / 19)
    : L > -12 ? clamp01((-3 - L) / 9)
    : 1;

  // Balance: audible voices should sit within a sane level spread.
  const levels = probes.filter((p) => p.loud.sustainAudible || p.loud.onsetAudible)
    .map((p) => Math.max(p.loud.sustainDb, p.loud.onsetDb));
  let balance = 0.7;
  if (levels.length >= 2) {
    const spread = Math.max(...levels) - Math.min(...levels);
    balance = spread <= 10 ? 1 : spread >= 30 ? 0 : (30 - spread) / 20;
  }

  // Velocity response: loud vs soft probe should differ by a musical amount.
  const vels = probes.filter((p) => p.velRespDb !== null);
  const velocity = vels.length
    ? wsum(vels, (p) => {
      const r = p.velRespDb;
      if (r <= 0) return 0;
      if (r < 3) return r / 3;
      if (r <= 26) return 1;
      return clamp01((38 - r) / 12);
    })
    : 0.5;

  // Timbre distinctness: different programs should not all collapse into the
  // same fallback piano. Mean pairwise centroid distance in octaves.
  const timbres = [];
  const seenPrograms = new Set();
  for (const p of pitchedProbes) {
    if (p.centroidHz > 0 && p.audible && !seenPrograms.has(p.program)) {
      seenPrograms.add(p.program);
      timbres.push(p.centroidHz);
    }
  }
  let distinct = 0.6;
  if (timbres.length >= 2) {
    let sum = 0, n = 0;
    for (let i = 0; i < timbres.length; i++) {
      for (let j = i + 1; j < timbres.length; j++) {
        sum += Math.abs(Math.log2(timbres[i] / timbres[j]));
        n++;
      }
    }
    distinct = clamp01((sum / n) / 0.5);
  }

  // Liveliness: spectral motion of the real excerpt (static single-cycle
  // loops read near zero; sampled ensembles breathe).
  const liveliness = clamp01(ex.flux / 0.20);

  const clipPenalty = 15 * clamp01(ex.clipRatio / AUDITION.CLIP_RATIO_DQ);

  const parts = { coverage, pitchAcc, sustainQ, loudness, balance, velocity, distinct, liveliness, clipPenalty };
  const score = Math.max(1,
    32 * coverage
    + 15 * pitchAcc
    + 10 * sustainQ
    + 10 * loudness
    + 8 * balance
    + 7 * velocity
    + 6 * distinct
    + 12 * liveliness
    - clipPenalty);

  return out(null, score, parts);
}

// ---------------------------------------------------------------------------
// DSP primitives (self-contained, no deps)
// ---------------------------------------------------------------------------

function energyPrefix(data) {
  const p = new Float64Array(data.length + 1);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    p[i + 1] = p[i] + (Number.isFinite(v) ? v * v : 0);
  }
  return p;
}

function percentileSorted(sorted, q) {
  if (!sorted.length) return -180;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  intervals.sort((a, b) => a[0] - b[0]);
  const out = [intervals[0].slice()];
  for (const [a, b] of intervals.slice(1)) {
    const last = out[out.length - 1];
    if (a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function weightedMedian(items) {
  if (!items.length) return 0;
  const sorted = [...items].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((s, x) => s + x.w, 0);
  let acc = 0;
  for (const x of sorted) {
    acc += x.w;
    if (acc >= total / 2) return x.v;
  }
  return sorted[sorted.length - 1].v;
}

/**
 * McLeod-style normalized autocorrelation pitch estimate over
 * data[start..start+len). Picks the first (shortest-lag) local maximum within
 * 90% of the global peak to resist octave-down errors; parabolic refinement.
 * @returns {{f0: number, clarity: number}} f0=0 when nothing periodic found.
 */
export function estimatePitch(data, start, len, sr, fMin = 26, fMax = 2500) {
  const n = Math.min(len, Math.round(sr * 0.19));
  const maxLag = Math.min(Math.floor(sr / fMin), n - 2);
  const minLag = Math.max(2, Math.floor(sr / fMax));
  if (maxLag <= minLag) return { f0: 0, clarity: 0 };

  const nsdf = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let r = 0, m = 0;
    for (let i = start, e = start + n - lag; i < e; i++) {
      const a = data[i], b = data[i + lag];
      r += a * b;
      m += a * a + b * b;
    }
    nsdf[lag] = m > 0 ? (2 * r) / m : 0;
  }

  let globalMax = 0;
  for (let lag = minLag; lag <= maxLag; lag++) if (nsdf[lag] > globalMax) globalMax = nsdf[lag];
  if (globalMax < 0.4) return { f0: 0, clarity: globalMax };

  let pick = -1;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (nsdf[lag] >= nsdf[lag - 1] && nsdf[lag] >= nsdf[lag + 1] && nsdf[lag] >= 0.9 * globalMax) {
      pick = lag;
      break;
    }
  }
  if (pick < 0) return { f0: 0, clarity: globalMax };

  // Parabolic interpolation around the peak
  const y0 = nsdf[pick - 1], y1 = nsdf[pick], y2 = nsdf[pick + 1];
  const denom = y0 - 2 * y1 + y2;
  const delta = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
  const lag = pick + Math.max(-0.5, Math.min(0.5, delta));
  return { f0: sr / lag, clarity: y1 };
}

/** Magnitude-weighted mean frequency over a Hann-windowed 2048-pt FFT. */
export function spectralCentroid(data, start, len, sr) {
  const N = 2048;
  if (len < N) return 0;
  const { re, im } = fftFrame(data, start, N);
  let num = 0, den = 0;
  for (let k = 1; k < N / 2; k++) {
    const mag = Math.hypot(re[k], im[k]);
    num += (k * sr / N) * mag;
    den += mag;
  }
  return den > 0 ? num / den : 0;
}

/**
 * Mean half-wave-rectified spectral flux, normalized per-frame by spectrum
 * energy, over frames that carry signal. ~0 for frozen loops, grows with
 * real timbral motion. 1024-pt frames, 512 hop.
 */
export function spectralFluxMean(data, sr) {
  const N = 1024, hop = 512;
  if (data.length < N * 2) return 0;
  let prev = null, sum = 0, frames = 0;
  for (let s = 0; s + N <= data.length; s += hop) {
    const { re, im } = fftFrame(data, s, N);
    const mag = new Float32Array(N / 2);
    let total = 0;
    for (let k = 1; k < N / 2; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      total += mag[k];
    }
    if (prev && total > 1e-4) {
      let fluxNum = 0;
      for (let k = 1; k < N / 2; k++) {
        const d = mag[k] - prev[k];
        if (d > 0) fluxNum += d;
      }
      sum += fluxNum / total;
      frames++;
    }
    if (total > 1e-4) prev = mag;
  }
  return frames ? sum / frames : 0;
}

const hannCache = new Map();
function hann(N) {
  let w = hannCache.get(N);
  if (!w) {
    w = new Float32Array(N);
    for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    hannCache.set(N, w);
  }
  return w;
}

function fftFrame(data, start, N) {
  const w = hann(N);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = (data[start + i] || 0) * w[i];
  fft(re, im);
  return { re, im };
}

/** In-place iterative radix-2 FFT. N must be a power of two. */
export function fft(re, im) {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = -2 * Math.PI / size;
    for (let i = 0; i < N; i += size) {
      for (let k = 0; k < half; k++) {
        const ang = step * k;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        const j = i + k, l = i + k + half;
        const tr = re[l] * wr - im[l] * wi;
        const ti = re[l] * wi + im[l] * wr;
        re[l] = re[j] - tr; im[l] = im[j] - ti;
        re[j] += tr; im[j] += ti;
      }
    }
  }
}
