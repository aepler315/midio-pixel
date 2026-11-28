// The worker, persisted bundle and terrain share this small versioned shape.
// The library needs only the composition's skyline, never its passage timeline.
export const SONGPRINT_VERSION = 1;
export const SONGPRINT_PHRASE_VERSION = 1;
export const SONGPRINT_FABLE_VERSION = 1;
export const MAX_PHRASE_FAMILIES = 4;
export const MAX_PHRASE_OCCURRENCES = 8;
import { copySongprintTimeline } from './SongprintTimeline.js';
const unit = value => Number.isFinite(value) && value >= 0 && value <= 1;

export function copySongprintSkyline(print) {
  if (print?.version !== SONGPRINT_VERSION || !Array.isArray(print.skyline) || print.skyline.length !== 16) return null;
  const skyline = Array.from(print.skyline);
  return skyline.every(unit) ? { version: SONGPRINT_VERSION, skyline } : null;
}

function copyPhraseFamilies(data, durationMs) {
  if (data?.version !== SONGPRINT_PHRASE_VERSION || !Array.isArray(data.families)
    || data.families.length > MAX_PHRASE_FAMILIES) return null;
  const families = [];
  for (const family of data.families) {
    if (!family || !unit(family.landmark01) || !Array.isArray(family.occurrences)
      || family.occurrences.length < 2 || family.occurrences.length > MAX_PHRASE_OCCURRENCES) return null;
    const occurrences = [];
    let previous = -1;
    for (const cue of family.occurrences) {
      if (!cue || !Number.isSafeInteger(cue.timeMs) || cue.timeMs <= previous
        || cue.timeMs > Math.ceil(durationMs) || !unit(cue.strength)) return null;
      occurrences.push({ timeMs: cue.timeMs, strength: cue.strength });
      previous = cue.timeMs;
    }
    families.push({ landmark01: family.landmark01, occurrences });
  }
  return { version: SONGPRINT_PHRASE_VERSION, families };
}

function copyFableDescriptor(data) {
  if (!data || data.version !== SONGPRINT_FABLE_VERSION) return null;
  const slices = data.slices;
  if (!Number.isInteger(slices) || slices < 1 || slices > 1200) return null;
  const chromaLen = slices * 12;
  const toneLen = slices * 3;
  const toArray = (value, len) => {
    if (value instanceof Float32Array || Array.isArray(value)) {
      if (value.length !== len) return null;
      const out = new Array(len);
      for (let i = 0; i < len; i++) {
        const v = Number(value[i]);
        if (!Number.isFinite(v)) return null;
        out[i] = v;
      }
      return out;
    }
    // tolerate JSONified Float32Array {"0":...}
    if (value && typeof value === 'object') {
      const out = new Array(len);
      for (let i = 0; i < len; i++) {
        const v = Number(value[i]);
        if (!Number.isFinite(v)) return null;
        out[i] = v;
      }
      return out;
    }
    return null;
  };
  const chroma = toArray(data.chroma, chromaLen);
  const tone = toArray(data.tone, toneLen);
  if (!chroma || !tone) return null;
  const sliceSeconds = Number(data.sliceSeconds);
  const lastFraction = Number(data.lastFraction);
  const keyAngle = Number(data.keyAngle);
  if (!Number.isFinite(sliceSeconds) || sliceSeconds <= 0 || !Number.isFinite(lastFraction) || lastFraction <= 0 || lastFraction > 1.0001) return null;
  if (!Number.isFinite(keyAngle)) return null;
  return {
    version: SONGPRINT_FABLE_VERSION,
    slices,
    sliceSeconds,
    lastFraction: Math.min(1, Math.max(1e-3, lastFraction)),
    keyAngle,
    chroma,
    tone,
    ...(Number.isFinite(data.keyStrength) ? { keyStrength: Number(data.keyStrength) } : {}),
    ...(Number.isFinite(data.tuningCents) ? { tuningCents: Number(data.tuningCents) } : {}),
    ...(Number.isFinite(data.stereoWidth) ? { stereoWidth: Number(data.stereoWidth) } : {}),
  };
}

export function copySongprint(print, durationMs = Infinity) {
  const compact = copySongprintSkyline(print);
  // One candidate every two seconds in a recording of up to twenty minutes.
  if (!compact || !Array.isArray(print.passages) || print.passages.length > 601) return null;
  const passages = [];
  let previous = -1;
  for (const point of print.passages) {
    if (!point || !Number.isSafeInteger(point.timeMs) || point.timeMs < 0 || point.timeMs <= previous
      || point.timeMs > Math.ceil(durationMs) || !unit(point.landmark01) || !unit(point.strength)) return null;
    const { timeMs, landmark01, strength } = point;
    passages.push({ timeMs, landmark01, strength });
    previous = timeMs;
  }
  const phraseFamilies = copyPhraseFamilies(print.phraseFamilies, durationMs);
  const timeline = copySongprintTimeline(print.timeline, durationMs);
  const fable = copyFableDescriptor(print.fable);
  return { ...compact, passages, ...(phraseFamilies ? { phraseFamilies } : {}), ...(timeline ? { timeline } : {}), ...(fable ? { fable } : {}) };
}
