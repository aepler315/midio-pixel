// One immutable, song-indexed arc. Full-song normalization sets pacing;
// gestures only read events at or before heard time. Never integrate on draw.
const unit = x => Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
export function narrativeEase(a, b, x) {
  const u = unit((x - a) / Math.max(1e-9, b - a));
  return u * u * (3 - 2 * u);
}
const INTERVALS = Object.freeze({
  relief: [0, .40], atmosphere: [.10, .60], materials: [.20, .75], features: [.25, .85],
  broshi: [.28, .72], midasus: [.35, .80], midio: [.42, .88],
  spaceAuthority: [.55, 1], skyDark: [.15, .90], traceResolution: [.78, 1],
});
const LANES = { midio: 'MIDIO', broshi: 'BROSHI', midasus: 'MIDASUS' };
const FALLBACK = { midio: 'BASS', broshi: 'MELODY', midasus: 'MELODY' };
const DEFAULT_CASTING = { midio: 'bass', broshi: 'melody', midasus: 'melody' };

function sourceIndex(events, id, casting) {
  const lane = casting[id]?.endsWith('-lane');
  const source = lane ? `lane:${LANES[id]}` : `role:${FALLBACK[id]}`;
  const notes = events.filter(e => lane ? e.lane === LANES[id] : e.role === FALLBACK[id]);
  const endPrefix = []; let end = 0;
  for (const e of notes) { end = Math.max(end, e.tMs + e.durMs + 120); endPrefix.push(end); }
  return timeMs => {
    let lo = 0, hi = notes.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (notes[m].tMs <= timeMs) lo = m + 1; else hi = m; }
    let activity = 0, pitchActivity = 0, pitch = 0;
    for (let i = lo - 1; i >= 0 && endPrefix[i] > timeMs; i--) {
      const e = notes[i], age = timeMs - e.tMs;
      const weight = unit(e.vel) * Math.min(1, age / 40) * unit((e.durMs + 120 - age) / 120);
      activity += weight;
      const confidence = e.pitchProvenance === 'synthetic' || !Number.isFinite(e.pitch) ? 0
        : e.src === 'midi' ? 1 : unit(e.pitchConfidence ?? .25) * (e.pitchProvenance === 'tracked' ? 1 : .25);
      const pw = weight * confidence;
      pitchActivity += pw; pitch += pw * unit((e.pitch - 36) / 60);
    }
    return Object.freeze({ source, activity: unit(activity), pitchActivity: unit(pitchActivity),
      pitch01: pitchActivity ? pitch / pitchActivity : .5 });
  };
}

export function compileRangeNarrative({ durationMs = 0, energyCurves = null, timeline = [],
  sections = [], barGrid = null, casting = DEFAULT_CASTING } = {}) {
  durationMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const stepMs = 1000 / Math.max(1, Math.min(100, energyCurves?.rateHz || 50));
  const n = Math.ceil(durationMs / stepMs);
  // Snapshot the analysis. Later lyric/structure refinement cannot retime a
  // departure already in progress; no references to mutable source curves.
  const events = timeline.filter(e => Number.isFinite(e.tMs) && e.tMs >= 0 && unit(e.vel) > 0)
    .map(e => ({ ...e, durMs: Math.max(90, Number.isFinite(e.durMs) ? e.durMs : 90) }))
    .sort((a, b) => a.tMs - b.tMs);
  const sources = Object.fromEntries(Object.keys(LANES).map(id => [id, sourceIndex(events, id, casting)]));
  const midiGate = events.some(e => e.src === 'midi') ? new Int32Array(n + 1) : null;
  if (midiGate) for (const e of events) {
    if (e.src !== 'midi') continue;
    midiGate[Math.min(n, Math.ceil(e.tMs / stepMs))]++;
    midiGate[Math.min(n, Math.ceil((e.tMs + e.durMs + 120) / stepMs))]--;
  }
  const raw = new Float64Array(n), energy = new Float64Array(n), bass = new Float64Array(n);
  const hasCurves = typeof energyCurves?.globalEnergy === 'function' || typeof energyCurves?.globalEnergyNorm === 'function';
  if (hasCurves) {
    for (let i = 0; i < n; i++) {
      const at = i * stepMs;
      const rms = energyCurves.rmsBands;
      raw[i] = rms ? Math.sqrt(rms.reduce((sum, a, band) => sum + (energyCurves.sampleRms?.(band, at) ?? a[Math.min(i, a.length - 1)] ?? 0) ** 2, 0) / rms.length)
        : Math.max(0, energyCurves.globalEnergy?.(at) ?? energyCurves.globalEnergyNorm(at));
      energy[i] = unit(energyCurves.globalEnergyNorm?.(at) ?? raw[i]);
      bass[i] = ((unit(energyCurves.sample?.(0, at)) + unit(energyCurves.sample?.(1, at))) / 2);
    }
  } else {
    const delta = new Float64Array(n + 1), bassDelta = new Float64Array(n + 1);
    for (const e of events) {
      const a = Math.min(n, Math.ceil(e.tMs / stepMs));
      const b = Math.min(n, Math.ceil((e.tMs + e.durMs + 120) / stepMs));
      delta[a] += unit(e.vel); delta[b] -= unit(e.vel);
      if (e.role === 'BASS' || e.lane === 'BROSHI') { bassDelta[a] += unit(e.vel); bassDelta[b] -= unit(e.vel); }
    }
    let v = 0, b = 0;
    for (let i = 0; i < n; i++) { v += delta[i]; b += bassDelta[i]; raw[i] = energy[i] = unit(v); bass[i] = unit(b); }
  }
  const sorted = Float64Array.from(raw).sort();
  const floor = sorted[Math.floor(n * .05)] || 0;
  // Physical RMS preserves a meaningful floor even when normalized bands
  // amplify room/encoding noise. Below -90 dBFS, put the gate above that
  // measured floor. Otherwise protect quiet music from later loud sections;
  // normalized activity alone has no calibrated dBFS silence authority.
  const silenceFloor = energyCurves?.rmsBands && floor < 3e-5
    ? Math.max(3e-5, floor * 1.5) : Math.max(1e-9, floor * .25);
  const q = new Float64Array(n + 1), u = new Float64Array(n + 1);
  const window = Math.max(1, Math.round(1200 / stepMs));
  let sumE = 0, sumB = 0, lastAudible = -Infinity, midiActive = 0;
  for (let i = 0; i < n; i++) {
    sumE += energy[i]; sumB += bass[i];
    if (i >= window) { sumE -= energy[i - window]; sumB -= bass[i - window]; }
    if (midiGate) midiActive += midiGate[i];
    if (midiGate ? midiActive > 0 : raw[i] > silenceFloor) lastAudible = i * stepMs;
    const gate = i * stepMs - lastAudible <= 250 ? 1 : 0;
    const span = Math.min(stepMs, durationMs - i * stepMs);
    q[i + 1] = q[i] + span * gate * (.35 + .45 * sumE / window + .20 * sumB / window);
    u[i + 1] = u[i] + span * gate;
  }
  const prefixAt = (array, at) => {
    if (at >= durationMs) return array[n];
    const index = Math.min(n, Math.max(0, at / stepMs));
    const i = Math.floor(index);
    const span = Math.min(stepMs, durationMs - i * stepMs);
    return array[i] + ((array[Math.min(n, i + 1)] || 0) - array[i]) * ((at - i * stepMs) / span);
  };
  const progressAt = at => q[n] > 0 && u[n] > 0 ? unit(.70 * prefixAt(q, at) / q[n] + .30 * prefixAt(u, at) / u[n]) : 0;
  const revealAt = at => narrativeEase(.03, .58, progressAt(at));
  const timeAt = r => {
    if (r <= 0) return 0;
    let a = 0, b = durationMs;
    for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (revealAt(m) < r) a = m; else b = m; }
    return b;
  };
  const completionMs = timeAt(1);
  const bars = Array.isArray(barGrid) ? barGrid : barGrid?.bars || [];
  const barTimes = bars.map(b => typeof b === 'number' ? b : b.ms ?? b.tMs ?? b.startMs).filter(Number.isFinite);
  const nearbyWindow = at => {
    for (let i = 1; i < barTimes.length; i++) if (barTimes[i] >= at) return Math.min(10000, barTimes[i] - barTimes[i - 1]);
    return 2000;
  };
  // Shared anchors have one position across every channel. Restrict each
  // nudge to its natural neighbours' midpoints, preserving global order
  // even when one detected boundary is near several anchors in a short clip.
  const anchors = [...new Set(Object.values(INTERVALS).flat())].sort((a, b) => a - b);
  const anchorTimes = anchors.map(timeAt);
  const snappedAnchors = new Map(anchors.map((r, i) => {
    const at = anchorTimes[i];
    if (r === 0 || r === 1 || !q[n]) return [r, at];
    const lower = (anchorTimes[i - 1] + at) / 2, upper = (at + anchorTimes[i + 1]) / 2;
    const boundary = sections.filter(s => s.provenance === 'detected' && (s.confidence ?? s.boundaryConfidence ?? 1) >= .5
      && s.startMs > lower && s.startMs < upper && s.startMs < completionMs
      && Math.abs(s.startMs - at) <= nearbyWindow(at))
      .sort((a, b) => Math.abs(a.startMs - at) - Math.abs(b.startMs - at))[0];
    return [r, boundary?.startMs ?? at];
  }));
  const milestones = {}, naturalTimes = {}, channelAnchors = {};
  for (const [channel, interval] of Object.entries(INTERVALS)) {
    naturalTimes[channel] = interval.map(timeAt);
    milestones[channel] = Object.freeze(interval.map(r => snappedAnchors.get(r)));
    if (milestones[channel][1] <= milestones[channel][0]) milestones[channel] = Object.freeze(interval.map(timeAt));
    channelAnchors[channel] = milestones[channel].map((at, i) => at === naturalTimes[channel][i] ? interval[i] : revealAt(at));
  }
  Object.freeze(milestones);
  return Object.freeze({ durationMs, milestones, silenceFloor,
    evidence: q[n] > 0 ? (hasCurves ? 'curves' : 'timed-notes') : 'none',
    sample(timeMs = 0) {
      const at = Number.isFinite(timeMs) ? Math.max(0, Math.min(durationMs, timeMs)) : 0;
      const revelation = revealAt(at), state = {};
      for (const channel of Object.keys(INTERVALS)) {
        // Nudge in accumulated revelation space, never wall time: every
        // channel shares the audible gate's exact silent plateaus.
        const anchors = channelAnchors[channel];
        state[channel] = q[n] > 0 ? narrativeEase(anchors[0], anchors[1], revelation) : 0;
      }
      const cast = {}, handoff = {}, sampledSources = {};
      for (const id of Object.keys(LANES)) {
        handoff[id] = state[id]; delete state[id];
        cast[id] = 1 - narrativeEase(.12, .85, handoff[id]);
        sampledSources[id] = sources[id](at);
      }
      return Object.freeze({ ...state, revelation, progress: progressAt(at), shortClip: durationMs < 30000,
        evidence: q[n] > 0 ? (hasCurves ? 'curves' : 'timed-notes') : 'none',
        cast: Object.freeze(cast), handoff: Object.freeze(handoff), sources: Object.freeze(sampledSources) });
    },
  });
}

export function narrativePressure(narrative, kick01 = 0, { reducedFlash = false, reducedMotion = false } = {}) {
  const dark = unit(narrative?.skyDark), pulse = reducedFlash ? 0 : unit(kick01);
  return { edgeAlpha: Math.min(.32, .24 * dark + .08 * dark * pulse),
    contraction: reducedMotion ? 0 : .04 * dark * pulse };
}

/** Causal source lookup survives retirement of the full-song reveal arc.
 * No full-song energy scan, waiting period, or performer handoff is needed. */
export function compileLandscapeSources({ durationMs = 0, timeline = [], casting = DEFAULT_CASTING } = {}) {
  const events = timeline.filter(e => Number.isFinite(e.tMs) && e.tMs >= 0 && unit(e.vel) > 0)
    .map(e => ({ ...e, durMs: Math.max(90, Number.isFinite(e.durMs) ? e.durMs : 90) }))
    .sort((a, b) => a.tMs - b.tMs);
  const sources = Object.fromEntries(Object.keys(LANES).map(id => [id, sourceIndex(events, id, casting)]));
  return Object.freeze({ durationMs, sample(timeMs = 0) {
    const at = Math.max(0, Number.isFinite(timeMs) ? timeMs : 0);
    return Object.freeze({ relief: 1, atmosphere: 1, materials: 1, features: 1,
      spaceAuthority: 1, skyDark: 1, traceResolution: 1, revelation: 1, progress: durationMs > 0 ? unit(at / durationMs) : 0,
      cast: Object.freeze({ midio: 0, broshi: 0, midasus: 0 }),
      handoff: Object.freeze({ midio: 1, broshi: 1, midasus: 1 }),
      sources: Object.freeze(Object.fromEntries(Object.entries(sources).map(([id, sample]) => [id, sample(at)]))) });
  } });
}
