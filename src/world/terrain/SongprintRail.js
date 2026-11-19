// A time adjustment on the existing measured rail. Each independent turn
// meets its summit cue and rejoins the ordinary pace with zero change in
// velocity at either end. It cannot reverse or leave the surveyed route.
import { OPENING_ZOOM_START_MS, OPENING_ZOOM_MS } from '../../core/OpeningTimeline.js';

export const SUMMIT_LEAD_MS = 6000;
const APPROACH_MS = 45000;
const MIN_CORRECTION = .025;
const MAX_CORRECTION = .18;
const MAX_RATE_CHANGE = .75;
const smooth = x => x * x * (3 - 2 * x);

export function summitPassages(songprint, admittedMs, throughMs) {
  const openingEnd = OPENING_ZOOM_START_MS + OPENING_ZOOM_MS;
  return (songprint?.passages ?? []).filter(cue => cue.strength >= .4
    && cue.landmark01 >= 0 && cue.landmark01 <= 1
    && cue.timeMs >= Math.max(openingEnd, admittedMs) + SUMMIT_LEAD_MS
    && cue.timeMs <= throughMs - 2000)
    .sort((a, b) => b.strength - a.strength || a.timeMs - b.timeMs);
}

export function summitLandmarkIndex(cue, count) {
  return Math.min(count - 1, Math.floor(cue.landmark01 * count));
}

function makeStop(cue, target, progressAt, startMs, endMs) {
  const at = progressAt(cue.timeMs);
  const left = progressAt(Math.max(startMs, cue.timeMs - APPROACH_MS));
  const right = progressAt(Math.min(endMs, cue.timeMs + APPROACH_MS));
  const change = target - at;
  const width = Math.max(.05, 1.5 * Math.abs(change) / MAX_RATE_CHANGE);
  if (Math.abs(change) < MIN_CORRECTION || Math.abs(change) > MAX_CORRECTION
    || at - width < left || at + width > right) return null;
  return { timeMs: cue.timeMs, target, start: at - width, at, end: at + width };
}

function disjoint(stop, stops) {
  return !stops.some(other => stop.start < other.end && stop.end > other.start);
}

export function planSummitRail(stations, passages, progressAt, startMs, endMs) {
  const stops = [];
  for (const cue of passages) {
    if (cue.timeMs < startMs + SUMMIT_LEAD_MS || cue.timeMs >= endMs) continue;
    const choices = stations[summitLandmarkIndex(cue, stations.length)];
    if (!choices?.length) continue;
    const current = progressAt(cue.timeMs);
    // The closest tested frame estimates whether the ordinary camera
    // already sees the summit. Keep that move unless the new angle improves it.
    const ordinary = choices.reduce((best, station) =>
      Math.abs(station.progress01 - current) < Math.abs(best.progress01 - current) ? station : best);
    const baselineScore = Math.abs(ordinary.progress01 - current) <= .025 ? ordinary.score : 0;
    let best = null;
    for (const station of choices) {
      const stop = makeStop(cue, station.progress01, progressAt, startMs, endMs);
      if (!stop || !disjoint(stop, stops)) continue;
      const value = station.score - Math.abs(station.progress01 - current);
      if (value > baselineScore + .08 && (!best || value > best.value)) best = { stop, value };
    }
    if (best) stops.push(best.stop);
  }
  return stops.sort((a, b) => a.at - b.at);
}

export function refitSummitRail(stops, progressAt, startMs, endMs) {
  const refitted = [];
  for (const stop of stops) {
    const next = makeStop(stop, stop.target, progressAt, startMs, endMs);
    if (next && disjoint(next, refitted)) refitted.push(next);
  }
  return refitted;
}

export function summitRailProgress(progress, stops) {
  const stop = stops?.find(candidate => progress >= candidate.start && progress <= candidate.end);
  if (!stop) return progress;
  const phase = progress <= stop.at
    ? (progress - stop.start) / (stop.at - stop.start)
    : (stop.end - progress) / (stop.end - stop.at);
  return progress + (stop.target - stop.at) * smooth(phase);
}

export function validSummitStops(stops, startMs, endMs) {
  return Array.isArray(stops) && stops.every((stop, i) => stop
    && Number.isFinite(stop.timeMs) && stop.timeMs >= startMs && stop.timeMs <= endMs
    && Number.isFinite(stop.start) && Number.isFinite(stop.at) && Number.isFinite(stop.end) && Number.isFinite(stop.target)
    && stop.start >= 0 && stop.end <= 1 && stop.start < stop.at && stop.at < stop.end
    && Math.abs(stop.target - stop.at) <= MAX_CORRECTION + 1e-12
    && 1.5 * Math.abs(stop.target - stop.at) <= MAX_RATE_CHANGE * Math.min(stop.at - stop.start, stop.end - stop.at) + 1e-12
    && (i === 0 || stops[i - 1].end <= stop.start));
}
