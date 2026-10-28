// One heard-time response for light, sky and water. These are presentation
// channels, independent of terrain movement and of conductor dispatch cursors.
import { FLAT_WEIGHTS } from '../../audio/bands.js';
import { hashSeed } from '../../utils/math.js';
import { boundaryLift01 } from '../WorldMusic.js';

const unit = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const positive = value => Number.isFinite(value) ? Math.max(0, value) : 0;
const EMPTY_ACCENTS = Object.freeze([]);
const SILENT = Object.freeze({ energy: 0, bass: 0, treble: 0, kick: 0, snare: 0, melody: 0, lift: 0, accents: EMPTY_ACCENTS });
const EVENTS_MS = 2200;
const SCAN_LIMIT = 128;
const DECAY_MS = { kick: 240, snare: 125, melody: 650 };
const CHANNELS = ['energy', 'bass', 'treble', 'kick', 'snare', 'melody', 'lift'];
const timelineCache = new WeakMap();
const floorCache = new WeakMap();
const cadenceCache = new WeakMap();

function eventKind(event) {
  if (event.role === 'RHYTHM' || event.channel === 9) {
    if (event.kick || event.pitch === 35 || event.pitch === 36) return 'kick';
    if (event.snare || event.pitch === 38 || event.pitch === 40 || event.pitch === 39) return 'snare';
  }
  if (event.role === 'MELODY' && Number.isFinite(event.pitch) && event.pitchProvenance !== 'synthetic') return 'melody';
  return null;
}

// Analysis timelines are immutable for a generation. Retain only evidence we
// consume; replacing the timeline or appending live notes rebuilds this index.
function eventIndex(timeline) {
  if (!Array.isArray(timeline)) return { events: [], midi: [], bass: [] };
  let cached = timelineCache.get(timeline);
  if (cached?.length === timeline.length) return cached;
  const events = timeline.filter(e => e && Number.isFinite(e.tMs) && e.tMs >= 0 && unit(e.vel ?? e.velocity) > 0)
    .map(e => Object.freeze({ ...e, kind: eventKind(e), vel: unit(e.vel ?? e.velocity) }))
    .filter(e => e.kind || e.src === 'midi')
    .sort((a, b) => a.tMs - b.tMs);
  // Long held MIDI notes must survive the bounded recent-onset scan. A prefix
  // anchor identifies an authored sustain still alive without walking history.
  const midi = [], bass = [];
  const end = e => e ? e.tMs + positive(e.durMs) + 400 : -Infinity;
  let held = null, heldBass = null;
  for (const event of events) {
    if (event.src === 'midi') {
      if (end(event) > end(held)) held = event;
      if ((event.role === 'BASS' || event.kind === 'kick') && end(event) > end(heldBass)) heldBass = event;
    }
    midi.push(held); bass.push(heldBass);
  }
  cached = { length: timeline.length, events, midi, bass };
  timelineCache.set(timeline, cached);
  return cached;
}

function through(list, timeMs, key = 'tMs') {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const at = list[mid]?.[key];
    if (Number.isFinite(at) && at <= timeMs) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// The fallback uses the same physical quiet-floor policy as RidgeMotionHistory
// and RangeNarrative. Normalized bands alone cannot distinguish music from
// amplified recording hiss.
export function physicalFloor(curves) {
  if (!curves?.rmsBands) return null;
  let cached = floorCache.get(curves);
  if (cached?.bands === curves.rmsBands) return cached.floor;
  const n = Math.max(0, ...curves.rmsBands.map(b => b?.length || 0));
  const values = Array.from({ length: n }, (_, i) => Math.sqrt(curves.rmsBands
    .reduce((sum, band) => sum + positive(band?.[i]) ** 2, 0) / 7)).sort((a, b) => a - b);
  const low = values[Math.floor(values.length * .05)] || 0;
  const floor = low < 3e-5 ? Math.max(3e-5, low * 1.5) : low * .25;
  floorCache.set(curves, { bands: curves.rmsBands, floor });
  return floor;
}

function curveAt(curves, timeMs, floor) {
  if (!curves || timeMs < 0) return { energy: 0, bands: Array(7).fill(0), audible: false };
  const rate = Number.isFinite(curves.rateHz) && curves.rateHz > 0 ? curves.rateHz : 50;
  const index = Math.max(0, Math.floor(timeMs * rate / 1000 + 1e-10));
  const at = index * 1000 / rate;
  const read = band => positive(band?.[Math.min(index, Math.max(0, (band?.length || 0) - 1))]);
  const bands = Array.from({ length: 7 }, (_, b) => unit(curves.bands ? read(curves.bands[b]) : curves.sample?.(b, at)));
  const average = bands.reduce((sum, value) => sum + value, 0) / 7;
  const rms = floor == null ? null : Math.sqrt(curves.rmsBands.reduce((sum, band) => sum + read(band) ** 2, 0) / 7);
  const audible = average > 1e-9 && (rms == null || rms > floor);
  const energy = audible ? unit(curves.globalEnergyNorm?.(at, FLAT_WEIGHTS) ?? average) : 0;
  return { energy, bands: audible ? bands : Array(7).fill(0), audible };
}

/** The song's cadence: the end of the last analysis frame the shared silence
 * gate (curveAt) still hears, so the ending follows the music rather than the
 * file's padding. Without frame data, or with curves that stop short of the
 * declared duration (an opening analysis), the declared end is the only
 * honest one. Pure of the song analysis; cached per curves. */
export function lastAudibleMs(curves, durationMs) {
  const duration = positive(durationMs);
  if (!curves || !(duration > 0)) return duration;
  const cached = cadenceCache.get(curves);
  if (cached?.duration === duration && cached.bands === curves.bands && cached.rms === curves.rmsBands) return cached.value;
  const rate = Number.isFinite(curves.rateHz) && curves.rateHz > 0 ? curves.rateHz : 50;
  const lengths = [...(Array.isArray(curves.rmsBands) ? curves.rmsBands : []), ...(Array.isArray(curves.bands) ? curves.bands : [])]
    .map(band => band?.length || 0);
  const frames = lengths.length ? Math.max(...lengths) : Number.isInteger(curves.n) ? Math.max(0, curves.n) : 0;
  const readable = Array.isArray(curves.bands) || typeof curves.sample === 'function';
  let value = duration;
  if (readable && frames > 0 && (frames - 1) * 1000 / rate >= duration - 1000) {
    const floor = physicalFloor(curves);
    for (let i = Math.min(frames, Math.ceil(duration * rate / 1000)) - 1; i >= 0; i--) {
      if (!curveAt(curves, i * 1000 / rate, floor).audible) continue;
      value = Math.min(duration, (i + 1) * 1000 / rate);
      break;
    }
  }
  cadenceCache.set(curves, { duration, bands: curves.bands, rms: curves.rmsBands, value });
  return value;
}

/** How far a section boundary is musical evidence: decorative pacing cuts and
 * zero-confidence boundaries are none, inferred (band-energy novelty) half,
 * every other boundary full. Lift, the landscape score and the lens share it. */
export function sectionTrust(section) {
  if (!section || section.provenance === 'decorative' || section.confidence === 0) return 0;
  return section.provenance === 'inferred' ? .5 : 1;
}

function sectionLift(sections, timeMs) {
  if (!Array.isArray(sections)) return 0;
  const index = through(sections, timeMs, 'startMs') - 1;
  if (index < 1) return 0;
  const section = sections[index], prior = sections[index - 1];
  const age = timeMs - section.startMs;
  const trust = sectionTrust(section);
  if (!trust || age < 0 || age >= EVENTS_MS || !Number.isFinite(section.meanEnergy) || !Number.isFinite(prior?.meanEnergy)) return 0;
  const opening = unit(age / 100);
  const release = (1 - age / EVENTS_MS) ** 1.5;
  return unit(boundaryLift01(section, prior) * trust * opening * release);
}

/** Immutable, bounded musical controls evaluated at compensated heard time.
 * `accents[].strength` is onset strength (calm/audibility applied), while
 * `ageSec` lets each effect choose its spatial travel and release. Seed is
 * normalized [0,1]. No future notes, clock integration or dispatch side effects. */
export function sampleEffectsMusic({ timeMs = 0, ridgeSample = null, timeline = [], energyCurves = null,
  sections = [], seed = 0, calmLevel = 0, preview = false } = {}) {
  if (preview) return SILENT;
  const now = positive(timeMs), calm = unit(calmLevel);
  const accentGain = 1 - .45 * calm, pressureGain = 1 - .24 * calm;
  const floor = physicalFloor(energyCurves);
  const index = eventIndex(timeline), events = index.events, end = through(events, now);
  const recent = [];
  const midiBody = event => event ? event.vel * unit((positive(event.durMs) + 400 - (now - event.tMs)) / 400) : 0;
  let midiEnergy = midiBody(index.midi[end - 1]), midiBass = midiBody(index.bass[end - 1]);
  for (let i = end - 1, count = 0; i >= 0 && count < SCAN_LIMIT; i--, count++) {
    const event = events[i], age = now - event.tMs;
    if (age > 4000) break;
    if (event.src === 'midi') {
      const body = midiBody(event);
      midiEnergy = Math.max(midiEnergy, body);
      if (event.role === 'BASS' || event.kind === 'kick') midiBass = Math.max(midiBass, body);
    }
    if (!event.kind || age > EVENTS_MS) continue;
    // Canonical silence remains the master gate below; physical onset evidence
    // additionally rejects false audio hits while an older envelope releases.
    if (event.src !== 'midi' && energyCurves && !curveAt(energyCurves, event.tMs, floor).audible) continue;
    const confidence = event.kind !== 'melody' || event.src === 'midi' ? 1
      : unit(event.pitchConfidence ?? .35) * (event.pitchProvenance === 'tracked' ? 1 : .5);
    const strength = unit(event.vel * confidence);
    if (strength > 0) recent.push({ event, age, strength });
  }

  let energy = 0, bass = 0, treble = 0, presence;
  if (ridgeSample) {
    presence = Math.max(unit(ridgeSample.motionPresence01), unit(ridgeSample.activity01));
    energy = unit(ridgeSample.pressureEnergy01);
    bass = unit(ridgeSample.bassPressure01);
    treble = [4, 5, 6].reduce((sum, b) => sum + unit(ridgeSample.bands?.[b]), 0) / 3;
  } else {
    // Fixed trailing taps keep pressure slower than a transient, independent
    // of frame cadence. Flooring source time prevents interpolating future FFTs.
    for (let i = 0; i < 30; i++) {
      const frame = curveAt(energyCurves, now - i * 20, floor);
      energy += frame.energy / 30;
      bass += (frame.bands[0] + frame.bands[1]) / 60;
      if (i < 8) treble += (frame.bands[4] + frame.bands[5] + frame.bands[6]) / 24;
    }
    energy = Math.max(energy, midiEnergy);
    bass = Math.max(bass, midiBass);
    // Authored onsets count immediately, including the very first sample.
    const midiTail = recent.filter(r => r.event.src === 'midi')
      .reduce((value, r) => Math.max(value, r.strength * Math.exp(-r.age / 650)), 0);
    presence = energy > 0 || treble > 0 ? 1 : unit(midiTail);
  }
  if (!(presence > 0)) return SILENT;

  const hits = { kick: unit(ridgeSample?.kick01) * .8, snare: 0,
    melody: unit(ridgeSample?.motionMelody?.activity) * .72 };
  const onsets = new Map(), counts = { kick: 0, snare: 0, melody: 0 };
  for (const { event, age, strength } of recent) {
    const kind = event.kind;
    hits[kind] = Math.max(hits[kind], strength * Math.exp(-age / DECAY_MS[kind]));
    const key = `${kind}:${event.tMs}`, shown = unit(strength * accentGain * presence);
    if ((onsets.get(key)?.strength || 0) >= shown) continue;
    onsets.set(key, { ageSec: age / 1000, strength: shown, kind,
      // Refining a recorded pitch must not relocate an already-heard onset.
      seed: hashSeed(`${Number.isFinite(seed) ? seed : 0}:${event.tMs}:${kind}`) / 4294967296 });
  }
  const accents = [...onsets.values()].sort((a, b) => a.ageSec - b.ageSec || a.seed - b.seed)
    .filter(accent => counts[accent.kind]++ < 2).map(Object.freeze);
  return Object.freeze({
    energy: unit(energy * pressureGain * presence), bass: unit(bass * pressureGain * presence),
    treble: unit(treble * pressureGain * presence),
    kick: unit(hits.kick * accentGain * presence), snare: unit(hits.snare * accentGain * presence),
    melody: unit(hits.melody * accentGain * presence),
    lift: unit(sectionLift(sections, now) * accentGain * presence), accents: Object.freeze(accents),
  });
}

/** Crossfade generation-owned responses, keeping one trajectory per onset.
 * At capacity, each kind retains its two strongest weighted contributions;
 * faint incoming events cannot immediately evict a prominent releasing trail. */
export function blendEffectsMusic(previous = SILENT, primary = SILENT, mix = 1) {
  const amount = unit(mix);
  if (amount === 0) return previous;
  if (amount === 1) return primary;
  const merged = new Map();
  for (const [response, weight] of [[previous, 1 - amount], [primary, amount]]) {
    for (const accent of response.accents.slice(0, 6)) {
      if (!(accent.kind in DECAY_MS) || !Number.isFinite(accent.ageSec) || accent.ageSec < 0) continue;
      const strength = unit(accent.strength) * weight;
      if (!(strength > 0)) continue;
      const key = `${accent.kind}:${accent.ageSec}`;
      const existing = merged.get(key);
      if (existing) existing.strength = unit(existing.strength + strength);
      else merged.set(key, { ...accent, strength });
    }
  }
  const counts = { kick: 0, snare: 0, melody: 0 };
  const accents = [...merged.values()].sort((a, b) => b.strength - a.strength || a.ageSec - b.ageSec)
    .filter(accent => counts[accent.kind]++ < 2)
    .sort((a, b) => a.ageSec - b.ageSec || a.seed - b.seed).map(Object.freeze);
  return Object.freeze({ ...Object.fromEntries(CHANNELS.map(key => [key,
    unit(unit(previous[key]) * (1 - amount) + unit(primary[key]) * amount)])), accents: Object.freeze(accents) });
}
