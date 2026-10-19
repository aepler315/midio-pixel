// A song's phrase, camera and weather decisions share one heard-time score.
// Nothing here advances on draw, dispatches notes or owns graphics resources.
import { rangeCameraMoveAt } from './RangeCamera.js';

const unit = x => Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
const ease = x => { const t = unit(x); return t * t * (3 - 2 * t); };
const mean = (read, start, end) => {
  let sum = 0, count = 0;
  for (let t = start; t < end; t += 250) { sum += unit(read(t)); count++; }
  return sum / Math.max(1, count);
};

export function compileLandscapeScore({ energyCurves, sections = [], timeline = [], durationMs = 0,
  seed = 0, previous = null, committedThroughMs = -1 } = {}) {
  const duration = Math.max(0, Number(durationMs) || 0);
  const read = energyCurves?.globalEnergyNorm?.bind(energyCurves) || energyCurves?.globalEnergy?.bind(energyCurves) || (() => 0);
  const trusted = sections.filter(s => s.provenance !== 'decorative' && s.confidence !== 0
    && Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs > s.startMs);
  const phrases = Object.freeze(trusted.map((s, i) => Object.freeze({
    startMs: Math.max(0, s.startMs), endMs: Math.min(duration, s.endMs),
    motifId: String(s.motifId ?? s.label ?? s.role ?? `phrase:${i}`),
    role: s.role || s.kind || null, relEnergy01: mean(read, s.startMs, Math.min(duration, s.endMs)),
  })));
  let low = 1, high = 0;
  for (let t = 0; t < duration; t += 500) { const e = unit(read(t)); low = Math.min(low, e); high = Math.max(high, e); }
  const attacks = timeline.filter(e => Number.isFinite(e.tMs) && (e.role === 'RHYTHM' || e.channel === 9)
    && [35, 36, 38, 40, 49, 52, 55, 57].includes(e.pitch) && unit(e.vel ?? e.velocity) >= .45);
  const dynamic = high - low >= .12 || attacks.length >= Math.max(4, duration / 15000);
  let candidates = phrases.map(p => ({ startMs: Math.max(8000, p.startMs), endMs: p.endMs, energy01: p.relEnergy01 }));
  if (!phrases.length && dynamic) {
    candidates = [];
    let start = null;
    for (let t = 8000; t <= duration; t += 250) {
      const active = t < duration && unit(read(t)) >= .55;
      if (active && start == null) start = t;
      if (!active && start != null) {
        candidates.push({ startMs: start, endMs: Math.min(t, duration), energy01: mean(read, start, t) });
        start = null;
      }
    }
    if (start != null) candidates.push({ startMs: start, endMs: duration,
      energy01: mean(read, start, duration) });
  }
  const audible = episode => {
    if (!energyCurves?.rmsBands || typeof energyCurves.sampleRms !== 'function') return true;
    let power = 0, n = 0;
    for (let t = episode.startMs; t < episode.endMs; t += 1000) {
      for (let band = 0; band < energyCurves.rmsBands.length; band++) { power += (energyCurves.sampleRms(band, t) || 0) ** 2; n++; }
    }
    return power / Math.max(1, n) >= .000009;
  };
  const episodes = [];
  for (const c of candidates.filter(c => dynamic && c.energy01 >= .55 && c.endMs - c.startMs >= 3000 && audible(c))) {
    const last = episodes.at(-1);
    if (last && c.startMs - last.endMs < 8000) {
      last.endMs = Math.max(last.endMs, c.endMs); last.energy01 = Math.max(last.energy01, c.energy01);
    } else episodes.push({ ...c });
  }
  // Keep the phrase and weather already underway when full analysis arrives.
  // Future banks get their full six-second build, never an instantaneous deck.
  const activePhrase = previous?.phrases.find(p => p.startMs <= committedThroughMs && p.endMs > committedThroughMs);
  const activeWeather = previous?.episodes.find(e => e.startMs - 6000 <= committedThroughMs && e.endMs + 4000 > committedThroughMs);
  const freezeThroughMs = previous ? Math.max(committedThroughMs, activePhrase?.endMs || 0, activeWeather?.endMs || 0) : -1;
  const strikesFor = episode => {
    const attacks = timeline.filter(e => (e.role === 'RHYTHM' || e.channel === 9)
      && [35, 36, 38, 40, 49, 52, 55, 57].includes(e.pitch)
      && Number.isFinite(e.tMs) && e.tMs >= episode.startMs && e.tMs < episode.endMs)
      .map(e => ({ tMs: e.tMs, amp: unit(e.vel ?? e.velocity ?? .8) ** 2 * (.65 + .35 * unit(read(e.tMs))) }))
      .sort((a, b) => a.tMs - b.tMs);
    const peak = Math.max(0, ...attacks.map(e => e.amp)), strikes = [];
    for (const strike of attacks) {
      if (!(strike.amp > 0) || strike.amp < peak * .25) continue;
      const last = strikes.at(-1);
      if (!last || strike.tMs - last.tMs >= 700) strikes.push(strike);
      else if (strike.tMs === last.tMs && strike.amp > last.amp) strikes[strikes.length - 1] = strike;
    }
    return Object.freeze(strikes.map(s => Object.freeze(s)));
  };
  const protectedEpisodes = previous ? previous.episodes.filter(e => e.startMs - 6000 <= freezeThroughMs) : [];
  const weather = Object.freeze([...protectedEpisodes, ...episodes.filter(e => !previous || e.startMs - 6000 > freezeThroughMs)]
    .sort((a, b) => a.startMs - b.startMs).map(e => Object.freeze({ ...e, strikes: e.strikes || strikesFor(e) })));
  const stateAt = (timeMs, options = {}) => {
    const t = Math.max(0, Number(timeMs) || 0);
    if (previous && t <= freezeThroughMs) return previous.at(t, options);
    const phrase = phrases.find(p => t >= p.startMs && t < p.endMs);
    const energy01 = unit(read(t));
    const camera = { ...rangeCameraMoveAt({ timeMs: t, sections: phrases, durationMs: duration, seed,
      reducedMotion: !!options.reducedMotion, preview: !!options.preview }) };
    if (previous && t < freezeThroughMs + 6000) {
      const old = previous.at(t, options).camera, k = ease((t - freezeThroughMs) / 6000);
      for (const key of ['dolly', 'yaw', 'crane', 'truck']) camera[key] = old[key] + (camera[key] - old[key]) * k;
    }
    return Object.freeze({ energy01, motifId: phrase?.motifId || 'quiet',
      intensity01: phrase?.relEnergy01 ?? energy01, camera: Object.freeze(camera) });
  };
  return Object.freeze({ durationMs: duration, phrases, episodes: weather, freezeThroughMs, at: stateAt });
}

const cache = new WeakMap();
export function landscapeScoreFor(mgr) {
  let hit = cache.get(mgr);
  const timeline = mgr.conductor?.timeline;
  if (!hit || hit.curves !== mgr.energyCurves || hit.sections !== mgr.sections || hit.timeline !== timeline || hit.duration !== mgr.durationMs) {
    const previous = hit?.score || mgr.landscapeHistory?.previous || null;
    const committedThroughMs = hit ? (mgr.tSec || 0) * 1000 : mgr.landscapeHistory?.committedThroughMs ?? -1;
    const score = compileLandscapeScore({ energyCurves: mgr.energyCurves, sections: mgr.sections, timeline,
      durationMs: mgr.durationMs, seed: mgr.songSeed || 0, previous, committedThroughMs });
    hit = { curves: mgr.energyCurves, sections: mgr.sections, timeline, duration: mgr.durationMs, score };
    cache.set(mgr, hit);
    mgr.landscapeScore = score;
  }
  return hit.score;
}
