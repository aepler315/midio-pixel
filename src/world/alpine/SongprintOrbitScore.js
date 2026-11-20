import { TITLE_CARD_HOLD_MS } from '../../core/OpeningTimeline.js';
import { summitPassages } from '../terrain/SongprintRail.js';
import { clamp01, smoothstep } from '../../utils/math.js';

const MIN_TRAVEL_MS = 9000;
const RETURN_RADIUS_MS = 3600;
const SAMPLE_MS = 250;
const MAX_SAMPLES = 4800;

function spacedReturns(songprint, admittedMs, throughMs) {
  const returns = [];
  for (const cue of summitPassages(songprint, admittedMs, throughMs)) {
    if (returns.every(other => Math.abs(cue.timeMs - other.timeMs) >= 2 * RETURN_RADIUS_MS)) returns.push(cue);
  }
  return returns.sort((a, b) => a.timeMs - b.timeMs);
}

function routeGuides(cues, startMs, span, progressAt) {
  const guides = [];
  for (const position of [.23, .5, .77]) {
    let best = null;
    for (const cue of cues) {
      const time01 = (cue.timeMs - startMs) / span;
      const progress01 = progressAt(cue.timeMs);
      if (Math.abs(time01 - position) > .135 || progress01 < .14 || progress01 > .88
        || progress01 - (guides.at(-1)?.progress01 ?? 0) < .16) continue;
      const score = cue.strength - 2.4 * Math.abs(time01 - position);
      if (!best || score > best.score) best = { timeMs: cue.timeMs, progress01, score };
    }
    if (best) guides.push(Object.freeze({ timeMs: best.timeMs, progress01: best.progress01 }));
  }
  return Object.freeze(guides);
}

/** The camera follows one song-clock route. Dynamics shape the pace over
 * several seconds, and trusted arrivals and returning passages give it
 * small pushes. The opening and cadence ease onto physical viewpoints. */
export function compileSongprintOrbitScore({ songprint, admittedMs, cadenceMs, finaleMs, read, pulse, inland = false }) {
  const startMs = Math.max(TITLE_CARD_HOLD_MS, admittedMs);
  const span = cadenceMs - startMs;
  if (span < MIN_TRAVEL_MS) return null;

  const introMs = Math.min(6000, .25 * span);
  const closerMs = Math.min(finaleMs, .3 * span);
  const fadeMs = Math.min(7200, .4 * span);
  const returns = spacedReturns(songprint, admittedMs, cadenceMs - closerMs);
  const steps = Math.min(MAX_SAMPLES, Math.ceil(span / SAMPLE_MS));
  const rates = new Float64Array(steps + 1);
  const distance = new Float64Array(steps + 1);
  let nextReturn = 0;
  for (let i = 1; i < steps; i++) {
    const t = startMs + i / steps * span;
    const activity = .25 * clamp01(read(t - 1500)) + .5 * clamp01(read(t)) + .25 * clamp01(read(t + 1500));
    while (returns[nextReturn]?.timeMs + RETURN_RADIUS_MS <= t) nextReturn++;
    const cue = returns[nextReturn];
    const refrain = cue ? cue.strength * smoothstep(RETURN_RADIUS_MS, 0, Math.abs(t - cue.timeMs)) : 0;
    const pace = .72 + .58 * activity + .4 * (pulse.paceAt(t) - 1) + .34 * refrain;
    rates[i] = pace * smoothstep(0, introMs, t - startMs) * smoothstep(0, closerMs, cadenceMs - t);
  }
  for (let i = 0; i < steps; i++) distance[i + 1] = distance[i] + .5 * (rates[i] + rates[i + 1]);
  const total = distance[steps];
  const progressAt = timeMs => {
    const x = steps * clamp01((timeMs - startMs) / span);
    const i = Math.min(steps - 1, Math.floor(x)), fraction = x - i;
    // Integrate the linear rate within the interval. Both progress and
    // its velocity stay continuous at the sample boundaries.
    const partial = fraction * (rates[i] + .5 * fraction * (rates[i + 1] - rates[i]));
    return clamp01((distance[i] + partial) / total);
  };
  const guides = inland ? routeGuides([...returns, ...(pulse.cues ?? [])], startMs, span, progressAt) : null;
  return Object.freeze({
    at(timeMs) {
      const gain = admittedMs > 0 ? smoothstep(startMs, startMs + fadeMs, timeMs) : 1;
      return { progress01: progressAt(timeMs), gain, ...(guides ? { guides, travelMs: span, timeMs } : {}) };
    },
  });
}
