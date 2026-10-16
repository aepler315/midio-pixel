// Fuses the novelty-curve section schedule BiomeManager already builds
// (_buildSchedule's spectral-change cuts) with the structural sections read
// from lyrics (LyricStructure.labelBlocks). When lyrics are synced, lyric
// boundaries snap to the beat grid and merge with/insert into the novelty
// cuts; when lyrics are plain text only, novelty boundaries are the only
// truth and lyric labels are order-matched onto them at low confidence.
// Absent lyricSections keeps the exact input array when its intervals are
// valid. Every path independently guards the final schedule's timing.
import { clamp01 } from '../utils/math.js';
import { normalizeTimedSections } from './LyricStructure.js';

function nearestBarMs(barGrid, tMs) {
  if (!barGrid || barGrid.length === 0) return tMs;
  let best = barGrid[0].ms, bestDist = Math.abs(tMs - best);
  for (let i = 1; i < barGrid.length; i++) {
    const d = Math.abs(tMs - barGrid[i].ms);
    if (d < bestDist) { bestDist = d; best = barGrid[i].ms; }
  }
  return best;
}

function barWidthMs(barGrid) {
  if (!barGrid || barGrid.length < 2) return 2000;
  let sum = 0, n = 0;
  for (let i = 1; i < barGrid.length; i++) { sum += barGrid[i].ms - barGrid[i - 1].ms; n++; }
  return n > 0 ? sum / n : 2000;
}

/** Section (from `sections`, an array with .startMs/.endMs) whose range
 *  contains `tMs`, or the closest one if none contains it exactly (covers
 *  small rounding gaps at the fused boundaries). */
function sectionAt(sections, tMs) {
  for (const s of sections) if (tMs >= s.startMs && tMs < s.endMs) return s;
  let best = sections[0], bestDist = Infinity;
  for (const s of sections) {
    const mid = (s.startMs + s.endMs) / 2;
    const d = Math.abs(tMs - mid);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

const DEFAULT_LYRIC = {
  kind: null, kindConfidence: 0, lyricIntensity: 0.4, lyricValence: 0, lyricConfidence: 0,
};

// A lyric-timed boundary this unconfident is a hypothesis, not evidence a
// cut belongs there -- letting it insert an "authoritative" section anyway
// is exactly how zero-confidence lyrics used to fabricate structure.
const LYRIC_BOUNDARY_MIN_CONFIDENCE = 0.5;

function withLyric(base, lyricSection) {
  return {
    ...base,
    kind: lyricSection ? lyricSection.kind : DEFAULT_LYRIC.kind,
    // Confidence in the FUNCTION label, separate from `lyricConfidence`
    // (timing/alignment). Callers that turn `kind` into a dramatic effect
    // must scale it by this, not apply it unconditionally.
    kindConfidence: lyricSection ? (lyricSection.kindConfidence ?? DEFAULT_LYRIC.kindConfidence) : DEFAULT_LYRIC.kindConfidence,
    lyricIntensity: lyricSection ? lyricSection.intensity : DEFAULT_LYRIC.lyricIntensity,
    lyricValence: lyricSection ? lyricSection.valence : DEFAULT_LYRIC.lyricValence,
    lyricConfidence: lyricSection ? lyricSection.confidence : DEFAULT_LYRIC.lyricConfidence,
    lyricText: lyricSection ? (lyricSection.text || null) : null,
  };
}

/** Fuses `noveltySections` ({startMs,endMs,transition,barMs,label,profile,
 *  hueBias, ...}) with `lyricSections` (LyricStructure.labelBlocks output).
 *  Returns a new sections array; `noveltySections` itself is never
 *  mutated. Empty/absent lyrics retain the same array reference for valid
 *  schedules. Invalid/unknown duration returns no intervals. */
export function fuseSections(noveltySections, lyricSections, barGrid, durationMs) {
  if (!Array.isArray(noveltySections)) return noveltySections;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  noveltySections = normalizeTimedSections(noveltySections, durationMs);
  if (noveltySections.length === 0 || !Array.isArray(lyricSections) || lyricSections.length === 0) return noveltySections;

  const synced = lyricSections.some((s) => s?.startMs !== undefined || s?.endMs !== undefined);

  if (!synced) {
    // Plain lyrics carry no timing at all -- boundaries stay exactly the
    // novelty ones (never moved), labels/emotion order-matched on at low
    // confidence. Extra lyric blocks beyond the novelty section count are
    // simply unused; novelty sections beyond the lyric block count keep no
    // lyric label.
    return noveltySections.map((s, i) => withLyric(s, lyricSections[i] || null));
  }

  lyricSections = normalizeTimedSections(lyricSections, durationMs);
  if (lyricSections.length === 0) return noveltySections;
  // Reject malformed, negative and out-of-song grid points before snapping;
  // sort/dedup irregular grids so merge widths cannot be negative or NaN.
  barGrid = Array.isArray(barGrid) ? [...new Set(barGrid.filter((bar) => Number.isFinite(bar?.ms)
    && bar.ms >= 0 && bar.ms <= durationMs).map((bar) => bar.ms))]
    .sort((a, b) => a - b).map((ms) => ({ ms })) : [];
  const barW = barWidthMs(barGrid);
  const boundarySet = new Map(); // snapped ms -> true (Map keeps insertion-agnostic uniqueness via key)
  for (const s of noveltySections) boundarySet.set(s.startMs, true);
  for (const ls of lyricSections) {
    if (ls.startMs <= 0) continue; // the song start is always a boundary already
    if ((ls.confidence ?? 0) < LYRIC_BOUNDARY_MIN_CONFIDENCE) continue; // gate alignment: not enough evidence to insert a new cut
    const snapped = nearestBarMs(barGrid, ls.startMs);
    if (!Number.isFinite(snapped) || snapped <= 0 || snapped >= durationMs) continue;
    const alreadyClose = [...boundarySet.keys()].some((b) => Math.abs(b - snapped) <= barW);
    if (!alreadyClose) boundarySet.set(snapped, true);
  }

  const boundaries = [...boundarySet.keys()].sort((a, b) => a - b);
  if (boundaries[0] > 0) boundaries.unshift(0);

  return boundaries.map((startMs, i) => {
    const endMs = i + 1 < boundaries.length ? boundaries[i + 1] : durationMs;
    const noveltyMatch = sectionAt(noveltySections, (startMs + Math.min(endMs, startMs + 1)) / 2);
    const lyricMatch = sectionAt(lyricSections, (startMs + endMs) / 2);
    return withLyric(
      {
        ...noveltyMatch, startMs, endMs,
        // A lyric-only split retains parent identity/metadata, but this new
        // boundary cannot borrow its parent's musical admission evidence.
        ...(startMs !== noveltyMatch.startMs
          ? { provenance: 'decorative', boundaryEvidence: null } : {}),
      },
      lyricMatch,
    );
  });
}

/** Additive intensity bias (-1..1-ish, but callers should clamp/scale) for
 *  VibeDirector.epicBias, keyed by structural kind -- a bridge gets the
 *  strongest lift, a chorus a moderate one, instrumental/outro settle.
 *
 *  `confidence` (default 1, so existing callers that don't pass it keep
 *  today's behavior) scales the kind-based bonus itself: a kind label that
 *  is only a weak hypothesis -- a bridge called from position alone, or a
 *  lyric boundary too uncertain to trust -- must not escalate as hard as
 *  one backed by an explicit tag or strong alignment. At confidence 0 every
 *  kind reads exactly like an unbiased verse; a quiet, low-confidence
 *  "bridge" is represented as itself rather than forced epic. */
export function epicBiasForKind(kind, lyricIntensity, confidence = 1) {
  const base = { chorus: 0.25, bridge: 0.45, instrumental: 0.15, intro: -0.1, outro: -0.15, verse: 0 }[kind] ?? 0;
  const gated = base * clamp01(confidence);
  return clamp01(0.5 + gated + 0.3 * (lyricIntensity - 0.4)) * 2 - 1;
}
