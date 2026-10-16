// Geography is a macro decision. Section labels remain available for motifs,
// including every returning chorus, regardless of the chapter it inhabits.
import { travelMs } from './BiomeSchedule.js';

export const CHAPTER_CONFIDENCE_MIN = .65;
export const CHAPTER_DWELL_MS = 45000;
export const CHAPTER_MAX_TRANSITIONS = 2;
export const CHAPTER_MAX_BIOMES = 3;
const clamp01 = x => Math.max(0, Math.min(1, x));
function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.every(Number.isFinite) || !b.every(Number.isFinite)) return null;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa > 1e-12 && bb > 1e-12 ? dot / Math.sqrt(aa * bb) : null;
}
function regimeFor(section) {
  const descriptors = section?.boundaryEvidence?.afterDescriptors;
  return Object.freeze({ label: section?.label, explicitIdentity: section?.chapterIdentity,
    shape: section?.shape ? Object.freeze([...section.shape]) : null,
    descriptors: descriptors ? Object.freeze(Object.fromEntries(Object.entries(descriptors)
      .map(([key, values]) => [key, Object.freeze([...values])]))) : null });
}
function differences(a, b) {
  return ['harmony', 'timbre', 'rhythm'].map(key => cosine(a?.descriptors?.[key], b?.descriptors?.[key]))
    .filter(value => value !== null).map(value => clamp01(1 - value));
}
function sameRegime(a, b) {
  if (!a || !b) return false;
  if (a.explicitIdentity !== undefined && b.explicitIdentity !== undefined) return a.explicitIdentity === b.explicitIdentity;
  const compared = differences(a, b);
  if (compared.length >= 2) return compared.every(value => value <= .1);
  // A recurrence label is supporting evidence of sameness only when the
  // arrangement also agrees; it never admits travel by itself.
  const similarity = cosine(a.shape, b.shape);
  return a.label !== undefined && a.label === b.label && similarity !== null && similarity >= .9;
}

export function chapterAt(chapters, timeMs) {
  if (!chapters?.length) return null;
  let result = chapters[0];
  for (const chapter of chapters) {
    if (chapter.startMs > timeMs) break;
    result = chapter;
  }
  return result;
}

function dwellMs(barGrid, freeTime, settledStartMs = 0) {
  if (freeTime || !barGrid?.length) return CHAPTER_DWELL_MS;
  // Count actual local bars when available, so a later slow movement or
  // variable meter cannot inherit the opening's shorter global median.
  const local = barGrid.filter(b => b.ms >= settledStartMs).slice(0, 17);
  if (local.length === 17 && local.every(b => (b.confidence ?? 1) >= CHAPTER_CONFIDENCE_MIN)) {
    return Math.max(CHAPTER_DWELL_MS, local[16].ms - settledStartMs);
  }
  const gaps = [];
  for (let i = 1; i < barGrid.length; i++) {
    const a = barGrid[i - 1], b = barGrid[i];
    if ((a.confidence ?? 1) < CHAPTER_CONFIDENCE_MIN || (b.confidence ?? 1) < CHAPTER_CONFIDENCE_MIN) continue;
    const gap = b.ms - a.ms;
    if (gap > 250 && gap < 16000) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  return gaps.length >= 3 ? Math.max(CHAPTER_DWELL_MS, 16 * gaps[gaps.length >> 1]) : CHAPTER_DWELL_MS;
}

function candidate(section, barGrid, freeTime) {
  if (!['detected', 'inferred', 'authored'].includes(section.provenance)) return null;
  if (section.shape && (!section.shape.every(Number.isFinite) || !section.shape.some(v => v > 1e-9))) return null;
  const evidence = section.boundaryEvidence;
  const confidence = Math.min(section.confidence ?? evidence?.confidence ?? 0, evidence?.confidence ?? 0);
  if (!Number.isFinite(confidence) || confidence < CHAPTER_CONFIDENCE_MIN) return null;
  // Dynamics and spectral centroid are supporting descriptors. They cannot
  // become additional independent votes beside the timbral/arrangement group.
  const groups = ['timbre', 'harmony', 'rhythm'].map(k => evidence.groups?.[k])
    .filter(v => Number.isFinite(v) && v >= .3).map(clamp01);
  if (groups.length < 2) return null;
  const travel = travelMs(section);
  const dwell = dwellMs(barGrid, freeTime, section.startMs + travel);
  if (!Number.isFinite(evidence.persistenceMs) || evidence.persistenceMs < dwell + travel) return null;
  if (!Number.isFinite(evidence.beforePersistenceMs) || evidence.beforePersistenceMs < CHAPTER_DWELL_MS) return null;
  const separation = groups.reduce((s, v) => s + v, 0) / groups.length;
  return { startMs: section.startMs, travelMs: travel, settledDwellMs: dwell, sourceSegmentId: section.sourceSegmentId,
    identity: section.chapterIdentity ?? section.sourceSegmentId ?? `chapter:${section.startMs}`, regime: regimeFor(section),
    benefit: 2 * confidence * separation * Math.min(1, evidence.persistenceMs / 90000) };
}

/** Compile a deterministic, immutable geographic journey. Duration changes
 * only the cost of an already legal change, never creates admission evidence.
 * `previous` and `committedThroughMs` freeze the visible home and all chapter
 * entries already reached, including any transition still travelling. */
export function planChapters({ sections = [], durationMs = 0, biomes = [], barGrid = [], freeTime = false,
  previous = null, committedThroughMs = -1 } = {}) {
  const choices = [...new Set(biomes)].slice(0, CHAPTER_MAX_BIOMES);
  const home = previous?.[0]?.biome ?? choices[0] ?? sections[0]?.profile ?? 'TWILIGHT';
  if (!choices.includes(home)) choices.unshift(home);
  const dwell = dwellMs(barGrid, freeTime);
  const fixed = previous?.length && committedThroughMs >= 0
    ? previous.filter(c => c.startMs <= committedThroughMs).map(c => ({ ...c }))
    : [];
  if (!fixed.length) fixed.push({ startMs: 0, biome: home, travelMs: 0, settledDwellMs: dwell,
    identity: sections[0]?.chapterIdentity ?? sections[0]?.sourceSegmentId ?? 'home', regime: regimeFor(sections[0]),
    sourceSegmentId: sections[0]?.sourceSegmentId });
  const anchor = fixed.at(-1);
  const candidates = sections.map(s => candidate(s, barGrid, freeTime)).filter(c => c && c.startMs > Math.max(anchor.startMs, committedThroughMs))
    .sort((a, b) => a.startMs - b.startMs);
  const penalty = Math.max(.2, .6 * Math.sqrt(240 / Math.max(durationMs / 1000, 60)));
  let best = fixed, bestScore = 0;
  function search(path, from, score) {
    const last = path.at(-1);
    if (score > bestScore + 1e-9) { best = path; bestScore = score; }
    if (path.length - 1 >= CHAPTER_MAX_TRANSITIONS) return;
    for (let i = from; i < candidates.length; i++) {
      const c = candidates[i];
      if (c.startMs - last.startMs < (last.travelMs || 0) + (last.settledDwellMs ?? dwell)) continue;
      if (durationMs - c.startMs < c.travelMs + c.settledDwellMs) continue;
      // Compare with the last admitted macro regime, never with a rejected
      // intervening fill. Local before/after separation alone cannot prove
      // that a return to the current place deserves another journey.
      if (sameRegime(last.regime, c.regime)) continue;
      const compared = differences(last.regime, c.regime);
      if (compared.length >= 2 && compared.filter(value => value >= .3).length < 2) continue;
      const prior = path.find(p => p.identity === c.identity || sameRegime(p.regime, c.regime));
      const used = new Set(path.map(p => p.biome));
      const biome = prior?.biome ?? choices.find(b => !used.has(b));
      if (!biome || biome === last.biome) continue;
      const isNew = !used.has(biome);
      if (isNew && used.size >= CHAPTER_MAX_BIOMES) continue;
      const next = { ...c, biome };
      search([...path, next], i + 1, score + c.benefit - (isNew ? penalty : 0) - .15);
    }
  }
  search(fixed, 0, 0);
  return Object.freeze(best.map((c, i) => Object.freeze({ id: `chapter:${i}`, startMs: c.startMs,
    endMs: i + 1 < best.length ? best[i + 1].startMs : durationMs, biome: c.biome,
    travelMs: c.travelMs ?? 0, settledDwellMs: c.settledDwellMs ?? dwell,
    sourceSegmentId: c.sourceSegmentId, identity: c.identity, regime: c.regime })));
}

/** Preserve fine sections, inserting chapter starts when a refined analyzer
 * no longer has the committed boundary in its section grid. */
export function sectionsWithChapters(sections, chapters) {
  const out = [];
  for (const section of sections) {
    const cuts = [section.startMs, ...chapters.map(c => c.startMs)
      .filter(t => t > section.startMs && t < section.endMs), section.endMs];
    for (let i = 0; i < cuts.length - 1; i++) {
      const chapter = chapterAt(chapters, cuts[i]);
      out.push({ ...section, startMs: cuts[i], endMs: cuts[i + 1],
        chapterId: chapter.id, profile: chapter.biome,
        ...(i ? { provenance: 'decorative', boundaryEvidence: null } : {}) });
    }
  }
  return out;
}
