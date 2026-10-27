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

/** A selection decided without a frame (never drawn, regime hidden, or the
 * capture failed). It stays in the plan as a record but no longer holds a
 * slot, a regime or a gap, so a standby peak still ahead may take them. */
const LOST = new Set(['missed', 'rejected', 'failed']);

function pickHighlights(events, fixed) {
  const chosen = [], lost = [], ids = new Set(), categories = new Set();
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
  for (const event of fixed.filter(validCandidate).sort(compareTime)) {
    if (!LOST.has(event.status)) admit(event, false);
    else if (!ids.has(event.id)) { ids.add(event.id); lost.push(Object.isFrozen(event) ? event : Object.freeze({ ...event })); }
  }
  for (const event of [...events].filter(validCandidate).sort(compareScore)) admit(event, true);
  const list = chosen.map(({ event }, i) => {
    const shift = times[i] - event.eventAtMs;
    if (shift === 0) return Object.isFrozen(event) ? event : Object.freeze({ ...event });
    return Object.freeze({ ...event, id: `${event.category}:${times[i]}`, eventAtMs: times[i],
      visibleStartMs: event.visibleStartMs + shift, visibleEndMs: event.visibleEndMs + shift });
  });
  return { list: [...list, ...lost].sort(compareTime), used: new Set(chosen.map(c => c.event)) };
}

/** Up to MAX_FRAMES peaks, at most one per regime, at least MIN_GAP_MS
 * apart in song time. `fixed` (already reached or decided) keeps its exact
 * time; a fixed selection that was lost (missed, rejected, failed) is kept
 * as a record without holding a slot. The pool then fills greedily by
 * score: a peak is admitted when it and everything already admitted still
 * fit, each sliding as little as needed within its near-maximum hold
 * (holdFromMs..holdToMs); otherwise its regime falls back to its next-best
 * peak. Returned in song order, and selecting a selection returns it
 * unchanged. */
export function selectHighlightCandidates(events, fixed = []) {
  return Object.freeze(pickHighlights(events, fixed).list);
}

function sampleTimes(durationMs, stepMs = SAMPLE_MS) {
  const times = [];
  for (let t = 0; t <= durationMs; t += stepMs) times.push(t);
  return times;
}

/** Local maxima of a 0..1 curve sampled over the song, with topographic
 * prominence. `sample` is a function of song time, or the curve already
 * sampled every stepMs from 0. Each peak's time is the middle of its
 * near-maximum hold (within PEAK_TOLERANCE), clipped to [startMs, endMs -
 * windowMs] so the whole visible window lies inside the playable, unfrozen
 * song. */
export function curvePeaks(sample, { durationMs, startMs = START_MS, endMs = durationMs,
  windowMs = REGIME_WINDOW_MS, stepMs = SAMPLE_MS, tolerance = PEAK_TOLERANCE } = {}, stats = null) {
  if (!(durationMs > 0) || !Number.isFinite(durationMs)) return [];
  const times = sampleTimes(durationMs, stepMs);
  const values = typeof sample === 'function' ? times.map(t => unit(sample(t))) : times.map((_, k) => unit(sample[k]));
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
        holdMs: b - a, holdFromMs: a, holdToMs: b, holdStartMs: times[lo], holdEndMs: times[hi],
        holdIndex: [lo, hi], topIndex: [i, j] });
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

/** Whether the world paints sunrise and sunset with DayNight's twilight
 * (the Range narrative's sky, glow and crest light: Landscape). Trio, and
 * any world without that narrative, paints dayNight's flat dawn and dusk
 * washes instead. No world (pure evidence) reads as Landscape. */
export function paintsTwilight(world) {
  return !world || (world.kind === 'alpine' && world.experience !== 'trio');
}

/** Whether the cast palettes are painted in their own colors. Only real
 * biomes are; every other world hue-rotates each palette color by the live
 * key (One Spectrum, BiomeManager._rotated), a tonic only known as the song
 * plays, so a palette's painted warmth cannot be read ahead of time. */
export function paintsOwnPalette(world) {
  return !world || !!world.realBiomes;
}

// dayNight's dawn and dusk washes peak at these alphas.
const DAWN_WASH_MAX = 0.16, DUSK_WASH_MAX = 0.18;

/** The four sky regimes at one instant, before any storm overcast. */
function skyRegimesAt(t, sky, twilight) {
  const dn = dayNight(t, sky);
  // Night only once the sun is down: dayNight's night starts darkening
  // while the sun is still well up.
  const dark = dn.sunAlt > 0 ? 0 : dn.night;
  if (!twilight) {
    return { noon: dn.sunAlt, dawn: unit(dn.dawnAlpha / DAWN_WASH_MAX),
      sunset: unit(dn.duskAlpha / DUSK_WASH_MAX), night: dark };
  }
  const tw = twilightAt(cyclePhase01(t, sky));
  // The twilight glow lingers after sunset; night is the sky with it gone.
  return { noon: dn.sunAlt, dawn: tw.rising ? tw.amount01 : 0, sunset: tw.rising ? 0 : tw.amount01,
    night: dark * (1 - tw.amount01) };
}
const SKY_REGIMES = ['noon', 'dawn', 'sunset', 'night'];
const OVERCAST = new Set(['noon', 'dawn', 'sunset']);

const skyClockFor = (durationMs, cycle) => cycle ?? songSkyClock(durationMs) ?? repeatingCycleMs(durationMs);

function paletteSampler(sections, palettes, travel) {
  const warmth = Object.fromEntries((Array.isArray(palettes) ? palettes : [])
    .map(profile => [profile?.name, paletteWarmth(profile)]).filter(([name, value]) => name && value != null));
  if (!(Array.isArray(sections) && sections.length > 1 && sections.every(s => Number.isFinite(warmth[s.profile])))) return null;
  // The palettes crossfade exactly as BiomeManager blends them.
  return t => {
    const b = blendSections(sections, t, { travel });
    return b ? { heat: warmth[b.from] + (warmth[b.to] - warmth[b.from]) * b.t, settled: b.t === 1 ? b.to : null }
      : { heat: 0, settled: null };
  };
}

function smoothedEnergy(energyCurves, times) {
  const read = energyCurves?.globalEnergyNorm?.bind(energyCurves) || energyCurves?.globalEnergy?.bind(energyCurves);
  if (!read || !times.length) return null;
  const raw = times.map(t => unit(read(t)));
  const reach = Math.round(ENERGY_SMOOTH_MS / SAMPLE_MS);
  return raw.map((_, i) => {
    let sum = 0, count = 0;
    for (let k = Math.max(0, i - reach); k <= Math.min(raw.length - 1, i + reach); k++) { sum += raw[k]; count++; }
    return sum / count;
  });
}

/** The song's regime curves (0..1 over heard time) from its evidence, as
 * the active `world` paints them. Absent regimes are left out: Trio has no
 * squall and rotates its palettes by the live key, a single-palette song has
 * no warmest section, a song without energy curves has no climax. */
export function highlightRegimeCurves({ durationMs = 0, cycle = null, energyCurves = null,
  sections = null, palettes = null, travel = false, storm = null, world = null } = {}) {
  const curves = {};
  const sky = skyClockFor(durationMs, cycle), twilight = paintsTwilight(world);
  // The squall's overcast swallows the sun: sunlit regimes count only
  // where the deck leaves the sky clear.
  const clear = storm ? t => 1 - unit(storm.at(t).amount) : () => 1;
  for (const category of SKY_REGIMES) {
    curves[category] = OVERCAST.has(category) ? t => skyRegimesAt(t, sky, twilight)[category] * clear(t)
      : t => skyRegimesAt(t, sky, twilight)[category];
  }
  if (storm) {
    curves.storm = t => unit(storm.at(t).amount);
    // Sun through the torn deck: RangeStorm's own `sun` mix.
    curves.clearing = t => { const s = storm.at(t); return unit(s.break01) * (1 - unit(s.amount)); };
  }
  const palette = paintsOwnPalette(world) ? paletteSampler(sections, palettes, !!travel) : null;
  if (palette) {
    curves.warmest = t => palette(t).heat;
    curves.coolest = t => 1 - palette(t).heat;
  }
  const smooth = durationMs > 0 ? smoothedEnergy(energyCurves, sampleTimes(durationMs)) : null;
  if (smooth) curves.climax = t => smooth[Math.max(0, Math.min(smooth.length - 1, Math.round(t / SAMPLE_MS)))];
  return curves;
}

/** A palette peak narrowed to where one palette is fully on screen: the
 * longest settled run of the palette at the curve's maximum inside the
 * peak's hold, so its whole window misses every crossfade. Null when no
 * such run holds a full window. */
function settlePalettePeak(peak, settled, times, { startMs, latestMs, windowMs }) {
  let palette = null;
  for (let k = peak.topIndex[0]; k <= peak.topIndex[1] && !palette; k++) palette = settled[k];
  if (!palette) return null;
  let run = null;
  for (let k = peak.holdIndex[0]; k <= peak.holdIndex[1]; k++) {
    if (settled[k] !== palette) continue;
    let e = k;
    while (e + 1 <= peak.holdIndex[1] && settled[e + 1] === palette) e++;
    if (!run || e - k > run[1] - run[0]) run = [k, e];
    k = e;
  }
  const a = Math.max(times[run[0]], startMs), b = Math.min(times[run[1]] - windowMs, latestMs);
  if (a > b) return null;
  return { ...peak, palette, atMs: Math.round((a + b) / 2), holdMs: b - a, holdFromMs: a, holdToMs: b };
}

function regimeEvent(category, atMs, windowMs, value, prominence,
  { detail = null, palette = null, label = REGIMES[category].label, holdMs = 0, holdFromMs = atMs, holdToMs = atMs } = {}) {
  const regime = REGIMES[category];
  return { id: `${category}:${atMs}`, category, label, ...(detail ? { detail } : {}),
    ...(palette ? { palette } : {}),
    source: 'regime', eventAtMs: atMs, visibleStartMs: atMs, visibleEndMs: atMs + windowMs,
    holdFromMs, holdToMs, peakValue: value, prominence, holdMs, score: regime.weight * Math.min(1, prominence) };
}

/** Every regime's peaks from completed song evidence, then the selection.
 * `preserved` candidates at or before committedThroughMs stay exactly as
 * decided; only later peaks may be added. The returned selection carries
 * `standby`: the pool's other peaks, best first, which the reel promotes
 * when a selected peak is lost. `cache` (an object owned by the caller)
 * keeps each regime group's peaks across rebuilds whose evidence for that
 * group is unchanged. */
export function buildHighlightCandidates({ preserved = [], committedThroughMs = -Infinity, ...evidence } = {}, stats = null, cache = null) {
  const events = highlightPeaks({ ...evidence, committedThroughMs }, stats, cache);
  const { list, used } = pickHighlights(events, preserved.filter(c => c.eventAtMs <= committedThroughMs));
  const standby = events.filter(event => !used.has(event)).sort(compareScore).map(event => Object.freeze(event));
  Object.defineProperty(list, 'standby', { value: Object.freeze(standby) });
  if (stats) Object.assign(stats, { peaks: events.length, selected: list.length });
  return Object.freeze(list);
}

/** The candidate pool: up to MAX_PEAKS_PER_REGIME prominent peaks of each
 * regime the evidence can produce, after committedThroughMs. */
export function highlightPeaks({ durationMs = 0, finale = null, committedThroughMs = -Infinity, cycle = null,
  energyCurves = null, sections = null, palettes = null, travel = false, storm = null, world = null } = {},
  stats = null, cache = null) {
  if (!(durationMs > 0) || !Number.isFinite(durationMs)) return [];
  // The finale freezes and shatters the picture: no regime frame after it.
  const endMs = Number.isFinite(finale?.freezeAtMs)
    ? Math.min(durationMs, Math.max(0, finale.freezeAtMs - FINALE_FREEZE_LEAD_MS)) : durationMs;
  // Each regime group is cached under the evidence it reads, so (say) new
  // lyric sections re-read only the palettes, not the sky clock.
  const memo = (name, deps, compute) => {
    const hit = cache?.[name];
    if (hit && hit.deps.length === deps.length && hit.deps.every((dep, i) => Object.is(dep, deps[i]))) return hit.value;
    const value = compute();
    if (cache) cache[name] = { deps, value };
    return value;
  };
  const opts = { durationMs, endMs };
  const twilight = paintsTwilight(world);
  const times = memo('times', [durationMs], () => sampleTimes(durationMs));
  const skySamples = memo('sky', [times, cycle, twilight], () => {
    const sky = skyClockFor(durationMs, cycle), out = Object.fromEntries(SKY_REGIMES.map(c => [c, []]));
    for (const t of times) {
      const at = skyRegimesAt(t, sky, twilight);
      for (const category of SKY_REGIMES) out[category].push(at[category]);
    }
    return out;
  });
  const stormSamples = memo('storm', [times, storm ? storm.key ?? storm : null], () => {
    if (!storm) return null;
    const amount = [], clearing = [];
    for (const t of times) {
      const s = storm.at(t);
      amount.push(unit(s.amount)); clearing.push(unit(s.break01) * (1 - unit(s.amount)));
    }
    return { amount, clearing };
  });
  const skyPeaks = memo('skyPeaks', [skySamples, stormSamples, endMs], () => Object.fromEntries(SKY_REGIMES.map(category => {
    const raw = skySamples[category];
    const values = stormSamples && OVERCAST.has(category) ? raw.map((v, k) => v * (1 - stormSamples.amount[k])) : raw;
    return [category, curvePeaks(values, opts, stats)];
  })));
  const weatherPeaks = memo('weather', [stormSamples, endMs], () => {
    if (!stormSamples) return { peaks: {}, strikes: [] };
    // A strike flashes at its attack: amp x the deck's amount (RangeStorm).
    const strikes = (storm.strikes || []).map(strike => {
      const amount = storm.at(strike.tMs).amount;
      return { atMs: strike.tMs, value: amount > .2 ? unit(strike.amp) * amount : 0 };
    }).filter(s => s.value >= MIN_PROMINENCE && s.atMs >= START_MS && s.atMs + FLASH_WINDOW_MS <= endMs)
      .sort((a, b) => b.value - a.value || a.atMs - b.atMs);
    return { peaks: { storm: curvePeaks(stormSamples.amount, opts, stats), clearing: curvePeaks(stormSamples.clearing, opts, stats) }, strikes };
  });
  const ownPalette = paintsOwnPalette(world);
  const palettePeaks = memo('palette', [times, sections, palettes, !!travel, ownPalette, endMs], () => {
    const sampler = ownPalette ? paletteSampler(sections, palettes, !!travel) : null;
    if (!sampler) return {};
    const heat = [], settled = [];
    for (const t of times) { const s = sampler(t); heat.push(s.heat); settled.push(s.settled); }
    const settle = { startMs: START_MS, latestMs: endMs - REGIME_WINDOW_MS, windowMs: REGIME_WINDOW_MS };
    return Object.fromEntries([['warmest', heat], ['coolest', heat.map(h => 1 - h)]].map(([category, values]) => [category,
      curvePeaks(values, opts, stats).map(peak => settlePalettePeak(peak, settled, times, settle)).filter(Boolean)]));
  });
  const climaxPeaks = memo('climax', [times, energyCurves, endMs], () => {
    const smooth = smoothedEnergy(energyCurves, times);
    return smooth ? { climax: curvePeaks(smooth, opts, stats) } : {};
  });

  // Only the unheard future may gain a peak; a slide cannot reach back.
  const futureFromMs = Number.isFinite(committedThroughMs) ? Math.floor(committedThroughMs) + 1 : -Infinity;
  const events = [];
  const groups = { ...skyPeaks, ...weatherPeaks.peaks, ...palettePeaks, ...climaxPeaks };
  for (const [category, all] of Object.entries(groups)) {
    const peaks = all.filter(peak => peak.prominence >= MIN_PROMINENCE && peak.atMs >= futureFromMs)
      .slice(0, MAX_PEAKS_PER_REGIME);
    for (const peak of peaks) {
      let detail = null;
      if (peak.palette) {
        const profile = palettes?.find(p => p?.name === peak.palette);
        detail = profile?.title || titleCase(peak.palette);
      }
      // Trio's dusk is dayNight's indigo wash, not a burning sunset.
      const label = category === 'sunset' && !twilight ? 'Dusk' : REGIMES[category].label;
      events.push(regimeEvent(category, peak.atMs, REGIME_WINDOW_MS, peak.value, peak.prominence,
        { detail, label, palette: peak.palette ?? null, holdMs: peak.holdMs,
          holdFromMs: Math.max(peak.holdFromMs, futureFromMs), holdToMs: peak.holdToMs }));
    }
  }
  for (const s of weatherPeaks.strikes.filter(s => s.atMs > committedThroughMs).slice(0, MAX_PEAKS_PER_REGIME)) {
    events.push(regimeEvent('lightning', s.atMs, FLASH_WINDOW_MS, s.value, s.value));
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

function buildFromEvidence(sim, evidence, preserved, committedThroughMs, cache) {
  const { landscape, ...rest } = evidence;
  const storm = landscape ? { key: landscape, at: t => stormAt(sim.biomes, t),
    strikes: landscape.episodes.flatMap(e => e.strikes || []) } : null;
  return buildHighlightCandidates({ ...rest, travel: !!rest.world?.realBiomes, storm, preserved, committedThroughMs },
    null, cache);
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
  const peakCache = cached?.peakCache ?? {};
  let preserved = [], committedThroughMs = -Infinity;
  if (cached) {
    committedThroughMs = Math.max(sim.heardTimeMs ?? sim.timeMs, cached.producerThroughMs);
    preserved = cached.candidates.filter(candidate => candidate.eventAtMs <= committedThroughMs);
  } else if (session?.primary && historyCandidates.has(session.primary)) {
    const prior = historyCandidates.get(session.primary);
    return remember({ evidence, candidates: prior.candidates, producerThroughMs: prior.producerThroughMs, peakCache });
  } else if (session?.previous) {
    // The song-owned history survives the full-analysis scene
    // reconstruction. Its public admission boundary fixes the heard past,
    // and a frame may already have shown a later heard time than that.
    // A missing prior snapshot still cannot admit invented full-analysis past.
    const prior = historyCandidates.get(session.previous);
    committedThroughMs = Math.max(session.stateKey.handoffStartMs, prior?.producerThroughMs ?? -Infinity);
    preserved = prior?.candidates.filter(candidate => candidate.eventAtMs <= committedThroughMs) ?? [];
  }
  const candidates = buildFromEvidence(sim, evidence, preserved, committedThroughMs, peakCache);
  return remember({ evidence, candidates, producerThroughMs: committedThroughMs, peakCache });
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

  /** Every frame is taken: no later draw or evidence can change the reel. */
  get complete() {
    return this.frames.length >= MAX_FRAMES;
  }

  /** Observe a composed frame. Visible windows are half-open in producer
   * (heard) time. A window passed without a visible frame is recorded as
   * missed (never drawn) or rejected (drawn, regime hidden); backseeks
   * cannot change a recorded decision or manufacture a new peak. A lost
   * peak frees its slot: the best standby peak (`candidates.standby`) whose
   * window is still ahead and that fits the rest of the plan takes it. */
  notify(candidates, canvas, heardTimeMs, { frameTimeMs = heardTimeMs,
    producerTimeMs = heardTimeMs, isVisible = () => true } = {}) {
    let freed = false;
    if (!this._initialized) {
      this.selections = Object.freeze(selectHighlightCandidates(candidates).map(candidate => Object.freeze({ ...candidate, status: 'pending' })));
      this._initialized = true;
    } else if (candidates !== this._candidateInput) {
      const past = this.selections.filter(candidate => candidate.eventAtMs <= producerTimeMs || candidate.status !== 'pending');
      const future = candidates.filter(candidate => candidate.eventAtMs > producerTimeMs);
      this.selections = Object.freeze(selectHighlightCandidates(future, past)
        .map(candidate => candidate.status ? candidate : Object.freeze({ ...candidate, status: 'pending' })));
      freed = true;
    }
    this._candidateInput = candidates;
    let captured = false;
    const next = this.selections.map(candidate => {
      if (candidate.status !== 'pending' || producerTimeMs < candidate.visibleStartMs) return candidate;
      if (producerTimeMs >= candidate.visibleEndMs) {
        const status = this._captureFailed.has(candidate.id) ? 'failed'
          : this._observed.has(candidate.id) ? 'rejected' : 'missed';
        freed = true;
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
    if (freed) this._promoteStandby(candidates?.standby, producerTimeMs);
    if (this.selections.every(candidate => candidate.status !== 'pending')) this._releaseCanvas();
    return captured;
  }

  _promoteStandby(standby, producerTimeMs) {
    if (!standby?.length || !this.selections.some(candidate => LOST.has(candidate.status))) return;
    // Only the unheard future: a standby may not slide back into the past.
    const fromMs = Math.floor(producerTimeMs) + 1;
    const future = standby.filter(candidate => candidate.eventAtMs > producerTimeMs)
      .map(candidate => candidate.holdFromMs < fromMs ? { ...candidate, holdFromMs: fromMs } : candidate);
    if (!future.length) return;
    const filled = selectHighlightCandidates(future, this.selections);
    if (filled.length !== this.selections.length) {
      this.selections = Object.freeze(filled.map(candidate => candidate.status ? candidate
        : Object.freeze({ ...candidate, status: 'pending' })));
    }
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
