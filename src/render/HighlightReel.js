// The end-of-song filmstrip: one frame at the peak of each major change in
// the picture's color scheme (high sun, sunset, deepest night, the storm...).
//
// The schedule is read ahead of time from the same pure functions the
// renderer paints with -- DayNight's sky clock and twilight, RangeStorm's
// squall, BiomeSchedule's cast palettes and the song's energy -- never from
// read-back pixels. A frame is only taken when a composed frame is drawn
// inside a peak's window and nothing (freeze, assembly, cut, arrival) hides
// the regime. Same song, seed and analysis => the same schedule, at any
// frame rate and across seeks.
import { FINALE_FREEZE_LEAD_MS } from '../core/SongFinale.js';
import { dayNight, twilightAt, cyclePhase01, songSkyClock, cycleMs as repeatingCycleMs } from '../world/DayNight.js';
import { blendSections } from '../world/BiomeSchedule.js';
import { stormAt } from '../world/alpine/RangeStorm.js';
import { landscapeScoreFor } from '../world/alpine/LandscapeScore.js';

export const MAX_FRAMES = 5;
export const MIN_GAP_MS = 5000;
/** The opening assembly veil and first-light fade-in end before this. */
export const START_MS = 1500;
const SAMPLE_MS = 250;
/** A regime holds for seconds: a frame anywhere in this window shows it. */
export const REGIME_WINDOW_MS = 1500;
/** A lightning flash decays in 65-165 ms; the window matches its attack. */
export const FLASH_WINDOW_MS = 100;
/** A curve whose peak rises less than this above its surroundings has no
 * real excursion, so the song never visibly reaches that regime. */
export const MIN_PROMINENCE = 0.2;
/** The peak is the middle of the hold within this much of the maximum. */
export const PEAK_TOLERANCE = 0.01;
const MAX_PEAKS_PER_REGIME = 4;
const ENERGY_SMOOTH_MS = 1000;
const THUMB_W = 320, THUMB_H = 180;
const JPEG_QUALITY = 0.72;

/** The color regimes, in order of how strongly each reads as its own look.
 * weight x prominence ranks the peaks; one frame per regime at most. */
export const REGIMES = Object.freeze({
  storm: Object.freeze({ label: 'Storm peak', weight: 1 }),
  sunset: Object.freeze({ label: 'Sunset', weight: .95 }),
  night: Object.freeze({ label: 'Deepest night', weight: .9 }),
  dawn: Object.freeze({ label: 'First light', weight: .85 }),
  noon: Object.freeze({ label: 'High sun', weight: .8 }),
  lightning: Object.freeze({ label: 'Lightning', weight: .75 }),
  clearing: Object.freeze({ label: 'After the storm', weight: .7 }),
  warmest: Object.freeze({ label: 'Warmest palette', weight: .65 }),
  coolest: Object.freeze({ label: 'Coolest palette', weight: .6 }),
  climax: Object.freeze({ label: 'Climax', weight: .55 }),
});
const WEATHER = new Set(['storm', 'lightning', 'clearing']);
const PALETTE = new Set(['warmest', 'coolest']);
const songCandidates = new WeakMap();
const historyCandidates = new WeakMap();

const unit = x => Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
const titleCase = name => String(name).toLowerCase().split(/[_\s]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

function validCandidate(event) {
  return !!event && Object.hasOwn(REGIMES, event.category) && typeof event.id === 'string'
    && Number.isFinite(event.eventAtMs) && Number.isFinite(event.visibleStartMs)
    && Number.isFinite(event.visibleEndMs) && event.visibleEndMs > event.visibleStartMs;
}

function compareScore(a, b) {
  return (b.score ?? 0) - (a.score ?? 0) || (b.holdMs ?? 0) - (a.holdMs ?? 0) || a.eventAtMs - b.eventAtMs
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const compareTime = (a, b) => a.eventAtMs - b.eventAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function* orders(items, prefix = []) {
  if (!items.length) { yield prefix; return; }
  for (let k = 0; k < items.length; k++) yield* orders([...items.slice(0, k), ...items.slice(k + 1)], [...prefix, items[k]]);
}

/** Times for every slot ({ pref, from, to }) at least MIN_GAP_MS apart,
 * each inside its own [from, to] and as near its preferred time as the
 * others allow, or null when no arrangement fits. Song order by preferred
 * time is tried first; at most MAX_FRAMES slots, so the search is tiny. */
function arrange(slots) {
  const byPref = slots.map((_, i) => i).sort((a, b) => slots[a].pref - slots[b].pref || a - b);
  for (const order of orders(byPref)) {
    const low = [];
    let prev = -Infinity, fits = true;
    for (const i of order) {
      const at = Math.max(slots[i].from, prev + MIN_GAP_MS);
      if (at > slots[i].to) { fits = false; break; }
      low.push(at); prev = at;
    }
    if (!fits) continue;
    const high = [];
    let next = Infinity;
    for (let k = order.length - 1; k >= 0; k--) { high[k] = Math.min(slots[order[k]].to, next - MIN_GAP_MS); next = high[k]; }
    const out = new Array(slots.length);
    prev = -Infinity;
    order.forEach((i, k) => {
      out[i] = Math.max(Math.min(Math.max(slots[i].pref, low[k]), high[k]), prev + MIN_GAP_MS);
      prev = out[i];
    });
    return out;
  }
  return null;
}

/** Up to MAX_FRAMES peaks, at most one per regime, at least MIN_GAP_MS
 * apart in song time. `fixed` (already reached or decided) keeps its exact
 * time. The pool then fills greedily by score: a peak is admitted when it
 * and everything already admitted still fit, each sliding as little as
 * needed within its near-maximum hold (holdFromMs..holdToMs); otherwise its
 * regime falls back to its next-best peak. Returned in song order, and
 * selecting a selection returns it unchanged. */
export function selectHighlightCandidates(events, fixed = []) {
  const chosen = [], ids = new Set(), categories = new Set();
  let times = [];
  const admit = (event, slide) => {
    if (chosen.length >= MAX_FRAMES || ids.has(event.id) || categories.has(event.category)) return;
    const slot = { pref: event.eventAtMs,
      from: slide && Number.isFinite(event.holdFromMs) ? Math.min(event.holdFromMs, event.eventAtMs) : event.eventAtMs,
      to: slide && Number.isFinite(event.holdToMs) ? Math.max(event.holdToMs, event.eventAtMs) : event.eventAtMs };
    const placed = arrange([...chosen.map(c => c.slot), slot]);
    if (!placed) return;
    chosen.push({ event, slot }); times = placed;
    ids.add(event.id); categories.add(event.category);
  };
  for (const event of fixed.filter(validCandidate).sort(compareTime)) admit(event, false);
  for (const event of [...events].filter(validCandidate).sort(compareScore)) admit(event, true);
  return Object.freeze(chosen.map(({ event }, i) => {
    const shift = times[i] - event.eventAtMs;
    if (shift === 0) return Object.isFrozen(event) ? event : Object.freeze({ ...event });
    return Object.freeze({ ...event, id: `${event.category}:${times[i]}`, eventAtMs: times[i],
      visibleStartMs: event.visibleStartMs + shift, visibleEndMs: event.visibleEndMs + shift });
  }).sort(compareTime));
}

/** Local maxima of a 0..1 curve sampled over the song, with topographic
 * prominence. Each peak's time is the middle of its near-maximum hold
 * (within PEAK_TOLERANCE), clipped to [startMs, endMs - windowMs] so the
 * whole visible window lies inside the playable, unfrozen song. */
export function curvePeaks(sample, { durationMs, startMs = START_MS, endMs = durationMs,
  windowMs = REGIME_WINDOW_MS, stepMs = SAMPLE_MS, tolerance = PEAK_TOLERANCE } = {}, stats = null) {
  if (!(durationMs > 0) || !Number.isFinite(durationMs)) return [];
  const times = [];
  for (let t = 0; t <= durationMs; t += stepMs) times.push(t);
  const values = times.map(t => unit(sample(t)));
  if (stats) stats.samples = (stats.samples || 0) + values.length;
  const n = values.length, latest = endMs - windowMs, peaks = [];
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && values[j + 1] === values[i]) j++;
    const v = values[i];
    const left = i > 0 ? values[i - 1] : -Infinity, right = j < n - 1 ? values[j + 1] : -Infinity;
    if (v > 0 && left < v && right < v) {
      // Prominence: the drop to the higher of the two bases, each base the
      // lowest point before the curve climbs above this peak on that side.
      const bases = [];
      if (i > 0) { let lo = v; for (let k = i - 1; k >= 0 && values[k] <= v; k--) lo = Math.min(lo, values[k]); bases.push(lo); }
      if (j < n - 1) { let lo = v; for (let k = j + 1; k < n && values[k] <= v; k++) lo = Math.min(lo, values[k]); bases.push(lo); }
      const prominence = bases.length ? v - Math.max(...bases) : 0;
      let lo = i, hi = j;
      while (lo > 0 && values[lo - 1] >= v - tolerance) lo--;
      while (hi < n - 1 && values[hi + 1] >= v - tolerance) hi++;
      const a = Math.max(times[lo], startMs), b = Math.min(times[hi], latest);
      if (prominence > 0 && a <= b) peaks.push({ atMs: Math.round((a + b) / 2), value: v, prominence,
        holdMs: b - a, holdFromMs: a, holdToMs: b, holdStartMs: times[lo], holdEndMs: times[hi] });
    }
    i = j + 1;
  }
  // Two summits inside one hold are one peak; keep the more prominent.
  peaks.sort((p, q) => q.prominence - p.prominence || q.holdMs - p.holdMs || p.atMs - q.atMs);
  return peaks.filter((p, k) => !peaks.slice(0, k).some(q => p.holdStartMs <= q.holdEndMs && q.holdStartMs <= p.holdEndMs));
}

const hexRgb = hex => /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) : null;

/** How warm a cast palette reads, 0 (icy blue) .. 1 (ember red): the mean
 * red-over-blue of the colors the sky and ranges are painted from (its
 * sky stops and silhouette). Null for a palette without them. */
export function paletteWarmth(profile) {
  const colors = [...(Array.isArray(profile?.sky) ? profile.sky : []), profile?.silhouette].map(hexRgb).filter(Boolean);
  if (!colors.length) return null;
  return unit(.5 + colors.reduce((sum, [r, , b]) => sum + (r - b) / 255, 0) / colors.length);
}

/** The song's regime curves (0..1 over heard time) from its evidence.
 * Absent regimes are left out: Trio has no squall, a single-palette song
 * has no warmest section, a song without energy curves has no climax. */
export function highlightRegimeCurves({ durationMs = 0, cycle = null, energyCurves = null,
  sections = null, palettes = null, travel = false, storm = null } = {}) {
  const warmth = Object.fromEntries((Array.isArray(palettes) ? palettes : [])
    .map(profile => [profile?.name, paletteWarmth(profile)]).filter(([name, value]) => name && value != null));
  const curves = {};
  const sky = cycle ?? songSkyClock(durationMs) ?? repeatingCycleMs(durationMs);
  const day = t => {
    const dn = dayNight(t, sky), tw = twilightAt(cyclePhase01(t, sky));
    return { dn, tw };
  };
  // The squall's overcast swallows the sun: sunlit regimes count only
  // where the deck leaves the sky clear.
  const clear = storm ? t => 1 - unit(storm.at(t).amount) : () => 1;
  curves.noon = t => day(t).dn.sunAlt * clear(t);
  curves.dawn = t => { const { tw } = day(t); return tw.rising ? tw.amount01 * clear(t) : 0; };
  curves.sunset = t => { const { tw } = day(t); return tw.rising ? 0 : tw.amount01 * clear(t); };
  // Dark sky with the twilight glow gone (it lingers after sunset).
  curves.night = t => { const { dn, tw } = day(t); return dn.night * (1 - tw.amount01); };
  if (storm) {
    curves.storm = t => storm.at(t).amount;
    // Sun through the torn deck: RangeStorm's own `sun` mix.
    curves.clearing = t => { const s = storm.at(t); return unit(s.break01) * (1 - unit(s.amount)); };
  }
  if (Array.isArray(sections) && sections.length > 1
      && sections.every(s => Number.isFinite(warmth[s.profile]))) {
    // The palettes crossfade exactly as BiomeManager blends them.
    const heat = t => {
      const b = blendSections(sections, t, { travel });
      return b ? warmth[b.from] + (warmth[b.to] - warmth[b.from]) * b.t : 0;
    };
    curves.warmest = heat;
    curves.coolest = t => 1 - heat(t);
  }
  const read = energyCurves?.globalEnergyNorm?.bind(energyCurves) || energyCurves?.globalEnergy?.bind(energyCurves);
  if (read && durationMs > 0) {
    const raw = [];
    for (let t = 0; t <= durationMs; t += SAMPLE_MS) raw.push(unit(read(t)));
    const reach = Math.round(ENERGY_SMOOTH_MS / SAMPLE_MS);
    const smooth = raw.map((_, i) => {
      let sum = 0, count = 0;
      for (let k = Math.max(0, i - reach); k <= Math.min(raw.length - 1, i + reach); k++) { sum += raw[k]; count++; }
      return sum / count;
    });
    curves.climax = t => smooth[Math.max(0, Math.min(smooth.length - 1, Math.round(t / SAMPLE_MS)))];
  }
  return curves;
}

function regimeEvent(category, atMs, windowMs, value, prominence,
  { detail = null, palette = null, holdMs = 0, holdFromMs = atMs, holdToMs = atMs } = {}) {
  const regime = REGIMES[category];
  return { id: `${category}:${atMs}`, category, label: regime.label, ...(detail ? { detail } : {}),
    ...(palette ? { palette } : {}),
    source: 'regime', eventAtMs: atMs, visibleStartMs: atMs, visibleEndMs: atMs + windowMs,
    holdFromMs, holdToMs, peakValue: value, prominence, holdMs, score: regime.weight * Math.min(1, prominence) };
}

/** Every regime's peaks from completed song evidence, then the selection.
 * `preserved` candidates at or before committedThroughMs stay exactly as
 * decided; only later peaks may be added. */
export function buildHighlightCandidates({ preserved = [], committedThroughMs = -Infinity, ...evidence } = {}, stats = null) {
  const events = highlightPeaks({ ...evidence, committedThroughMs }, stats);
  const selected = selectHighlightCandidates(events, preserved.filter(c => c.eventAtMs <= committedThroughMs));
  if (stats) Object.assign(stats, { peaks: events.length, selected: selected.length });
  return selected;
}

/** The candidate pool: up to MAX_PEAKS_PER_REGIME prominent peaks of each
 * regime the evidence can produce, after committedThroughMs. */
export function highlightPeaks({ durationMs = 0, finale = null, committedThroughMs = -Infinity, ...evidence } = {}, stats = null) {
  if (!(durationMs > 0) || !Number.isFinite(durationMs)) return [];
  // The finale freezes and shatters the picture: no regime frame after it.
  const endMs = Number.isFinite(finale?.freezeAtMs)
    ? Math.min(durationMs, Math.max(0, finale.freezeAtMs - FINALE_FREEZE_LEAD_MS)) : durationMs;
  const curves = highlightRegimeCurves({ durationMs, ...evidence });
  // Only the unheard future may gain a peak; a slide cannot reach back.
  const futureFromMs = Number.isFinite(committedThroughMs) ? Math.floor(committedThroughMs) + 1 : -Infinity;
  const events = [];
  for (const [category, curve] of Object.entries(curves)) {
    const peaks = curvePeaks(curve, { durationMs, endMs }, stats)
      .filter(peak => peak.prominence >= MIN_PROMINENCE && peak.atMs >= futureFromMs)
      .slice(0, MAX_PEAKS_PER_REGIME);
    for (const peak of peaks) {
      let detail = null, palette = null;
      if (PALETTE.has(category)) {
        palette = blendSections(evidence.sections, peak.atMs, { travel: !!evidence.travel })?.to ?? null;
        const profile = evidence.palettes?.find(p => p?.name === palette);
        detail = profile?.title || (palette ? titleCase(palette) : null);
      }
      events.push(regimeEvent(category, peak.atMs, REGIME_WINDOW_MS, peak.value, peak.prominence,
        { detail, palette, holdMs: peak.holdMs, holdFromMs: Math.max(peak.holdFromMs, futureFromMs), holdToMs: peak.holdToMs }));
    }
  }
  if (evidence.storm?.strikes?.length) {
    // A strike flashes at its attack: amp x the deck's amount (RangeStorm).
    const strikes = evidence.storm.strikes.map(strike => {
      const amount = evidence.storm.at(strike.tMs).amount;
      return { atMs: strike.tMs, value: amount > .2 ? unit(strike.amp) * amount : 0 };
    }).filter(s => s.value >= MIN_PROMINENCE && s.atMs >= START_MS && s.atMs + FLASH_WINDOW_MS <= endMs
      && s.atMs > committedThroughMs)
      .sort((a, b) => b.value - a.value || a.atMs - b.atMs).slice(0, MAX_PEAKS_PER_REGIME);
    for (const s of strikes) events.push(regimeEvent('lightning', s.atMs, FLASH_WINDOW_MS, s.value, s.value));
  }
  return events;
}

/** The song's highlight evidence as the renderer will paint it. */
function evidenceFor(sim) {
  const biomes = sim.biomes;
  const world = biomes?.world ?? null;
  const landscape = world?.realBiomes && biomes && !biomes.terrainPreview ? landscapeScoreFor(biomes) : null;
  return { durationMs: biomes?.durationMs ?? sim.conductor?.durationMs, cycle: biomes?._dayNightCycleMs ?? null,
    energyCurves: sim.energyCurves ?? biomes?.energyCurves ?? null, sections: biomes?.sections ?? null,
    palettes: biomes?.profiles ?? null, world, landscape, finale: sim.fracture?.finale ?? null };
}

function buildFromEvidence(sim, evidence, preserved, committedThroughMs) {
  const { world, landscape, ...rest } = evidence;
  const storm = landscape ? { at: t => stormAt(sim.biomes, t),
    strikes: landscape.episodes.flatMap(e => e.strikes || []) } : null;
  return buildHighlightCandidates({ ...rest, travel: !!world?.realBiomes, storm, preserved, committedThroughMs });
}

export function highlightCandidatesFor(sim, producerTimeMs = null) {
  const evidence = evidenceFor(sim);
  const session = sim.biomes?.ridgeMusicSession;
  const remember = record => {
    if (Number.isFinite(producerTimeMs)) record.producerThroughMs = Math.max(record.producerThroughMs, producerTimeMs);
    songCandidates.set(sim, record);
    if (session?.primary) historyCandidates.set(session.primary, {
      candidates: record.candidates, producerThroughMs: record.producerThroughMs,
    });
    return record.candidates;
  };
  const cached = songCandidates.get(sim);
  if (cached && Object.keys(evidence).every(key => evidence[key] === cached.evidence[key])) return remember(cached);
  let preserved = [], committedThroughMs = -Infinity;
  if (cached) {
    committedThroughMs = Math.max(sim.heardTimeMs ?? sim.timeMs, cached.producerThroughMs);
    preserved = cached.candidates.filter(candidate => candidate.eventAtMs <= committedThroughMs);
  } else if (session?.primary && historyCandidates.has(session.primary)) {
    const prior = historyCandidates.get(session.primary);
    return remember({ evidence, candidates: prior.candidates, producerThroughMs: prior.producerThroughMs });
  } else if (session?.previous) {
    // The song-owned history survives the full-analysis scene
    // reconstruction. Its public admission boundary fixes the heard past,
    // and a frame may already have shown a later heard time than that.
    // A missing prior snapshot still cannot admit invented full-analysis past.
    const prior = historyCandidates.get(session.previous);
    committedThroughMs = Math.max(session.stateKey.handoffStartMs, prior?.producerThroughMs ?? -Infinity);
    preserved = prior?.candidates.filter(candidate => candidate.eventAtMs <= committedThroughMs) ?? [];
  }
  const candidates = buildFromEvidence(sim, evidence, preserved, committedThroughMs);
  return remember({ evidence, candidates, producerThroughMs: committedThroughMs });
}

/** What this drawn frame can show, snapshotted when it is composed (before
 * the finale freeze consumes it). */
export function highlightFrameState(sim, biomeManager = sim?.biomes, { performers = true } = {}) {
  const fracture = sim?.fracture;
  const v2 = !!biomeManager?._rangeV2Active;
  return Object.freeze({
    live: !(fracture?.isFrozen || fracture?.isDone),
    assembled: !(performers && sim?.assembly?.active),
    arrived: !biomeManager?._awaitingTerrain && !(v2 && biomeManager.rangePresentation?.arriving),
    cutting: (biomeManager?._cutFlash ?? 0) > .05,
    // The cast palette fully on screen (no crossfade or travel under way).
    palette: (biomeManager?.currentBlend?.t ?? 1) >= .999 ? biomeManager?.currentBlend?.to ?? null : null,
    weather: v2 && !biomeManager.terrainPreview && biomeManager._pass?.('range-clouds') !== false,
  });
}

/** Whether a frame in that state shows the candidate's regime. */
export function highlightVisible(candidate, frame) {
  if (!frame?.live || !frame.assembled || !frame.arrived || frame.cutting) return false;
  if (WEATHER.has(candidate.category) && !frame.weather) return false;
  if (PALETTE.has(candidate.category) && (!frame.palette || (candidate.palette && candidate.palette !== frame.palette))) return false;
  return true;
}

export class HighlightReel {
  constructor() {
    this.frames = [];
    this.selections = Object.freeze([]);
    this._initialized = false;
    this._candidateInput = null;
    this._observed = new Set();
    this._captureFailed = new Set();
    this._lastCaptureMs = -Infinity;
    this._thumbCanvas = null;
  }

  canCapture(eventAtMs) {
    return this.frames.length < MAX_FRAMES && eventAtMs - this._lastCaptureMs >= MIN_GAP_MS;
  }

  /** Observe a composed frame. Visible windows are half-open in producer
   * (heard) time. A window passed without a visible frame is recorded as
   * missed (never drawn) or rejected (drawn, regime hidden); backseeks
   * cannot change a recorded decision or manufacture a new peak. */
  notify(candidates, canvas, heardTimeMs, { frameTimeMs = heardTimeMs,
    producerTimeMs = heardTimeMs, isVisible = () => true } = {}) {
    if (!this._initialized) {
      this.selections = Object.freeze(selectHighlightCandidates(candidates).map(candidate => Object.freeze({ ...candidate, status: 'pending' })));
      this._initialized = true;
    } else if (candidates !== this._candidateInput) {
      const past = this.selections.filter(candidate => candidate.eventAtMs <= producerTimeMs || candidate.status !== 'pending');
      const future = candidates.filter(candidate => candidate.eventAtMs > producerTimeMs);
      this.selections = Object.freeze(selectHighlightCandidates(future, past)
        .map(candidate => candidate.status ? candidate : Object.freeze({ ...candidate, status: 'pending' })));
    }
    this._candidateInput = candidates;
    let captured = false;
    const next = this.selections.map(candidate => {
      if (candidate.status !== 'pending' || producerTimeMs < candidate.visibleStartMs) return candidate;
      if (producerTimeMs >= candidate.visibleEndMs) {
        const status = this._captureFailed.has(candidate.id) ? 'failed'
          : this._observed.has(candidate.id) ? 'rejected' : 'missed';
        return Object.freeze({ ...candidate, status, observedAtMs: heardTimeMs, observedFrameMs: frameTimeMs });
      }
      this._observed.add(candidate.id);
      if (!isVisible(candidate)) return candidate;
      if (!this.capture(canvas, heardTimeMs, candidate.label, candidate, frameTimeMs)) {
        this._captureFailed.add(candidate.id);
        return candidate;
      }
      captured = true;
      return Object.freeze({ ...candidate, status: 'captured', observedAtMs: heardTimeMs,
        observedFrameMs: frameTimeMs, capturedAtMs: frameTimeMs });
    });
    if (next.some((candidate, index) => candidate !== this.selections[index])) this.selections = Object.freeze(next);
    if (this.selections.every(candidate => candidate.status !== 'pending')) this._releaseCanvas();
    return captured;
  }

  capture(canvas, heardTimeMs, label, candidate = null, frameTimeMs = heardTimeMs) {
    const eventAtMs = candidate?.eventAtMs ?? heardTimeMs;
    if (!this.canCapture(eventAtMs)) return false;
    try {
      if (!this._thumbCanvas) {
        this._thumbCanvas = document.createElement('canvas');
        this._thumbCanvas.width = THUMB_W; this._thumbCanvas.height = THUMB_H;
      }
      const ctx = this._thumbCanvas.getContext('2d');
      ctx.drawImage(canvas, 0, 0, THUMB_W, THUMB_H);
      const dataUrl = this._thumbCanvas.toDataURL('image/jpeg', JPEG_QUALITY);
      this.frames.push({ dataUrl, atMs: heardTimeMs, label, eventAtMs, detail: candidate?.detail ?? null,
        eventId: candidate?.id ?? null, category: candidate?.category ?? null, capturedAtMs: frameTimeMs });
      this._lastCaptureMs = eventAtMs;
      if (this.frames.length === MAX_FRAMES) this._releaseCanvas();
      return true;
    } catch {
      this._releaseCanvas();
      return false;
    }
  }

  _releaseCanvas() {
    if (this._thumbCanvas) { this._thumbCanvas.width = 0; this._thumbCanvas.height = 0; }
    this._thumbCanvas = null;
  }
}
