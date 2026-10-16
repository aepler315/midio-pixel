// Pure song-side roles for Teton Song Highway. Geometry and playback state
// belong to the planner/timeline, so these descriptors are stable on seeks.
import { Lane } from '../../core/Casting.js';
import { FLAT_WEIGHTS } from '../../audio/bands.js';

export const SECTION_ROLES = Object.freeze(['intro', 'verse', 'pre-chorus', 'chorus', 'post-chorus',
  'bridge', 'solo', 'interlude', 'breakdown', 'drop', 'outro']);
const ROLE_SET = new Set(SECTION_ROLES);
const RELIABLE = new Set(['detected', 'inferred', 'authored']);
const clamp01 = n => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
const quantile = (values, q) => {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort(), at = q * (sorted.length - 1);
  const lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
};

/** The lead source is Conductor.timeline's NoteEvent.lane === Lane.MIDIO.
 *  NoteEvent.js and Casting.js separate this from the generic MELODY role:
 *  MIDASUS owns clean melodies, while MIDIO owns synth/driven/horn leads.
 *  Count active onsets per second, rather than sustained frames or kicks. */
export function sectionLeadDensities(sections, noteEvents = []) {
  const counts = new Float64Array(sections.length);
  for (const event of noteEvents) {
    if (event.lane !== Lane.MIDIO || !(event.vel > 0) || !Number.isFinite(event.tMs)) continue;
    let lo = 0, hi = sections.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (sections[mid].startMs <= event.tMs) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (found >= 0 && event.tMs < sections[found].endMs) counts[found]++;
  }
  return sections.map((s, i) => counts[i] / Math.max(.001, (s.endMs - s.startMs) / 1000));
}

function energyScan(curves, duration) {
  if (typeof curves?.globalEnergy !== 'function') return { stops: [], slope: () => 0 };
  const rate = curves.rateHz > 0 ? curves.rateHz : 50, step = 1000 / rate;
  const n = Math.ceil(duration / step), energy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const value = curves.globalEnergy(i * step, FLAT_WEIGHTS);
    energy[i] = Number.isFinite(value) ? Math.max(0, value) : NaN;
  }
  const peak = quantile([...energy].filter(Number.isFinite), .95), threshold = .06 * peak;
  const stops = [];
  let start = null;
  for (let i = 0; i <= n; i++) {
    const time = Math.min(duration, i * step);
    const quiet = i < n && Number.isFinite(energy[i]) && (peak > 0 ? energy[i] < threshold : energy[i] === 0);
    if (quiet && start === null) start = time;
    if (!quiet && start !== null) {
      if (time - start >= 1500) stops.push({ startMs: start, endMs: time });
      start = null;
    }
  }
  const slope = section => {
    const a = Math.max(0, Math.ceil(section.startMs / step)), b = Math.min(n, Math.ceil(section.endMs / step));
    let count = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = a; i < b; i++) {
      if (!Number.isFinite(energy[i])) continue;
      const x = (i * step - section.startMs) / 1000, y = energy[i];
      count++; sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    const divisor = count * sxx - sx * sx;
    return divisor > 1e-12 ? (count * sxy - sx * sy) / divisor : 0;
  };
  return { stops, slope };
}

function lowBandShare(section, curves) {
  if (Number.isFinite(section.lowBandShare)) return clamp01(section.lowBandShare);
  if (typeof curves?.powerShares !== 'function') return null;
  let sum = 0, count = 0;
  for (let k = 0; k < 24; k++) {
    const shares = curves.powerShares(section.startMs + (k + .5) / 24 * (section.endMs - section.startMs));
    if (shares?.length >= 2 && shares.slice(0, 2).every(Number.isFinite)) { sum += shares[0] + shares[1]; count++; }
  }
  return count ? clamp01(sum / count) : null;
}

function cueRole(section, cues) {
  const matched = cues.filter(c => Number.isFinite(c.tMs) && c.tMs >= section.startMs && c.tMs < section.endMs);
  for (const cue of matched) {
    // Existing SECTION cue values are usually cut/fade transitions. Only
    // an explicit role or a recognized role name supplies a terrain role.
    const role = cue.role ?? (ROLE_SET.has(cue.kind) ? cue.kind : cue.kind === 'section' ? cue.value : null);
    if (ROLE_SET.has(role)) return role;
  }
  return null;
}

/** One descriptor per ordered BiomeManager section; does not mutate inputs. */
export function sectionRoles({ sections = [], energyCurves = null, durationMs = 0,
  conductorSchedule = [], noteEvents = [], leadDensities = null, hasLyrics = null } = {}) {
  if (!sections.length) return [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (!(Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs > s.startMs)
      || i && s.startMs < sections[i - 1].endMs) throw new Error('section roles need ordered, non-overlapping sections');
  }
  const duration = Math.max(durationMs || 0, sections.at(-1).endMs);
  const scan = energyScan(energyCurves, duration), count = sections.length;
  const energies = sections.map(s => clamp01(s.relEnergy01));
  const slopes = sections.map(s => Number.isFinite(s.energySlope) ? s.energySlope : scan.slope(s));
  const low = sections.map(s => lowBandShare(s, energyCurves));
  const densities = leadDensities?.length === count ? Array.from(leadDensities, n => Math.max(0, Number.isFinite(n) ? n : 0))
    : sectionLeadDensities(sections, noteEvents);
  const leadThreshold = quantile(densities, .6), leadHigh = densities.map(n => n > 0 && n >= leadThreshold);
  const lyrics = hasLyrics ?? sections.some(s => typeof s.lyricText === 'string' && s.lyricText.trim().length > 0);
  const medianDuration = quantile(sections.map(s => s.endMs - s.startMs), .5), labels = new Map();
  sections.forEach((s, i) => {
    if (!RELIABLE.has(s.provenance) || s.label === undefined || s.label === null) return;
    const entry = labels.get(s.label) || { label: s.label, indices: [], mean: 0, first: i };
    entry.indices.push(i); entry.mean += energies[i]; labels.set(s.label, entry);
  });
  for (const group of labels.values()) group.mean /= group.indices.length;
  const chorusGroup = [...labels.values()].filter(g => g.indices.length >= 2)
    .sort((a, b) => b.mean - a.mean || b.indices.length - a.indices.length || a.first - b.first)[0];
  const chorusLabel = chorusGroup?.label;
  const result = sections.map(() => ({ role: null, confidence: 0, finalChorus: false, stops: [] }));
  sections.forEach((s, i) => {
    const cue = cueRole(s, conductorSchedule);
    if (cue) { result[i].role = cue; result[i].confidence = 1; }
    else if (s.kindConfidence >= .5 && ['intro', 'verse', 'chorus', 'bridge', 'outro', 'instrumental'].includes(s.kind)) {
      result[i].role = s.kind === 'instrumental' ? leadHigh[i] && energies[i] >= .45 ? 'solo' : 'interlude' : s.kind;
      result[i].confidence = clamp01(s.kindConfidence);
    } else if (!RELIABLE.has(s.provenance)) {
      result[i].role = i === 0 ? 'intro' : i === count - 1 ? 'outro' : 'verse';
      result[i].confidence = .2;
    }
  });
  // Rule 2 discovers the form label; classification waits until the cut/drop
  // test. Compare drops with ordinary choruses, so a repeated EDM drop label
  // with no ordinary chorus remains eligible for both drops.
  const potentialDrop = sections.map((s, i) => i > 0 && !result[i].role && energies[i] >= .9
    && s.transition === 'cut' && slopes[i - 1] > 0 && low[i] !== null);
  const ordinary = (chorusGroup?.indices || []).filter(i => !potentialDrop[i] && (!result[i].role || result[i].role === 'chorus'));
  const ordinaryLow = ordinary.map(i => low[i]).filter(Number.isFinite);
  const otherLow = low.filter((n, i) => Number.isFinite(n) && !potentialDrop[i]);
  const baseline = ordinaryLow.length ? ordinaryLow : otherLow;
  const chorusLow = baseline.length ? baseline.reduce((a, b) => a + b, 0) / baseline.length : null;
  const chorusEnergy = ordinary.length ? ordinary.reduce((sum, i) => sum + energies[i], 0) / ordinary.length : null;
  let drops = 0;
  sections.forEach((s, i) => {
    if (potentialDrop[i] && drops < 4 && chorusLow !== null && low[i] >= chorusLow + .1
      && (s.label !== chorusLabel || chorusEnergy === null || energies[i] >= chorusEnergy + .1)) {
      result[i].role = 'drop'; result[i].confidence = .85; drops++;
    }
  });
  sections.forEach((s, i) => {
    if (!result[i].role && chorusGroup && s.label === chorusLabel) { result[i].role = 'chorus'; result[i].confidence = .75; }
  });
  const precedesChorus = new Map();
  sections.forEach((s, i) => {
    if (i + 1 < count && result[i + 1].role === 'chorus' && result[i].role !== 'chorus') precedesChorus.set(s.label, (precedesChorus.get(s.label) || 0) + 1);
  });
  sections.forEach((s, i) => {
    if (result[i].role) return;
    const previous = result[i - 1], next = result[i + 1], short = s.endMs - s.startMs <= .6 * medianDuration;
    let role = 'verse', confidence = .5;
    if (next && ['chorus', 'drop'].includes(next.role) && short && slopes[i] > 0
      || (precedesChorus.get(s.label) || 0) >= 2 && (short || slopes[i] > 0)) {
      role = 'pre-chorus'; confidence = .7;
    } else if (previous?.role === 'chorus' && short && Math.abs(energies[i] - energies[i - 1]) <= .15) {
      role = 'post-chorus'; confidence = .7;
    } else if (i === 0 && (energies[i] < .45 || (labels.get(s.label)?.indices.length || 0) <= 1)) {
      role = 'intro'; confidence = .6;
    } else if (i === count - 1 && (energies[i] < .6 || slopes[i] < 0)) {
      role = 'outro'; confidence = .6;
    } else if (i > 0 && i < count - 1 && energies[i] <= .3 && energies[i - 1] - energies[i] >= .35) {
      role = 'breakdown'; confidence = .8;
    } else if ((labels.get(s.label)?.indices.length || 0) === 1
      && (s.startMs / duration >= .45 && s.startMs / duration <= .85 || i > 0 && Math.abs(energies[i] - energies[i - 1]) >= .25)) {
      role = 'bridge'; confidence = .6;
    } else if (lyrics && !s.lyricText) {
      role = leadHigh[i] && energies[i] >= .5 ? 'solo' : 'interlude'; confidence = .6;
    } else if (!lyrics && leadHigh[i] && (labels.get(s.label)?.indices.length || 0) === 1 && energies[i] >= .55) {
      role = 'solo'; confidence = .6;
    }
    result[i].role = role; result[i].confidence = confidence;
  });
  const lastChorus = result.findLastIndex(s => s.role === 'chorus');
  if (lastChorus >= 0) result[lastChorus].finalChorus = true;
  sections.forEach((s, i) => {
    result[i].stops = scan.stops.filter(span => span.startMs < s.endMs && span.endMs > s.startMs)
      .map(span => ({ startMs: Math.max(s.startMs, span.startMs), endMs: Math.min(s.endMs, span.endMs) }));
  });
  return result;
}
