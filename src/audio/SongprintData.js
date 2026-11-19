// The worker, persisted bundle and terrain share this small versioned shape.
// The library needs only the composition's skyline, never its passage timeline.
export const SONGPRINT_VERSION = 1;
export const SONGPRINT_PHRASE_VERSION = 1;
export const MAX_PHRASE_FAMILIES = 4;
export const MAX_PHRASE_OCCURRENCES = 8;
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
  return { ...compact, passages, ...(phraseFamilies ? { phraseFamilies } : {}) };
}
