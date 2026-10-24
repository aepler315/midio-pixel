// World-quality evaluation: what “looks good” means, without a public score.
//
// Song measurement, world adaptation, internal recommendation, and the
// gallery stay separate. This module records the current heuristic privately,
// picks the same quiet / transition / peak clock for every world, and emits
// a review sheet whose ratings a human fills. Diagnostics are not beauty.
// An empty sheet must not claim the 80% target has been met.
import { clamp, clamp01, hashSeed } from '../utils/math.js';
import { listWorlds } from '../world/Worlds.js';
import { scoreWorlds } from '../world/WorldScore.js';
import { pickPreviewPassages, PREVIEW_SPAN_MS } from '../ui/WorldPreview.js';

export const EVAL_VERSION = 1;
export const EVAL_SPAN_MS = PREVIEW_SPAN_MS;

/** Capture settings. Fixed so a still is a still, not a quality surprise. */
export const EVAL_QUALITY = Object.freeze({
  phenomenaFull: true,
  particleMul: 1,
  contactShadowsEnabled: true,
  rimLightEnabled: true,
  brushEnabled: true,
});

export const REQUIRED_FAMILIES = Object.freeze([
  'sparse-piano', 'ambient', 'warm-bass', 'fast-percussion',
  'dense-guitars', 'orchestral', 'loose-rhythm',
]);

export const RATING_AXES = Object.freeze([
  'appeal', 'musicalTiming', 'identity', 'quietInterest', 'climaxHeadroom', 'clutter',
]);

/** Target to validate. Not a claimed result. */
export const ACCEPTANCE_TARGET = Object.freeze({
  appealMin: 4,
  timingMin: 4,
  holdoutShare: 0.8,
  noBlocking: true,
  note: 'Recommended results: no blocking visual defects, and at least 4/5 for appeal and musical timing in at least 80% of held-out reviewed cases. Calmness is a legitimate outcome.',
});

const TUNE = 'tune';
const HOLDOUT = 'holdout';

export function viewingOrder(worlds = listWorlds()) {
  return worlds.map((w) => w.id);
}

export function evaluationSeed(track) {
  if (Number.isFinite(track?.seed)) return track.seed >>> 0;
  return hashSeed(String(track?.id || 'eval'));
}

export function splitTracks(tracks, split = 'all') {
  const all = Array.isArray(tracks) ? tracks : [];
  if (split === TUNE) return all.filter((t) => t.split === TUNE);
  if (split === HOLDOUT) return all.filter((t) => t.split === HOLDOUT);
  return all;
}

function waveAsCurves(wave, durationMs) {
  if (!Array.isArray(wave) || !wave.length) return null;
  const dur = Math.max(1, durationMs || 1);
  const last = wave.length - 1;
  return {
    globalEnergyNorm(t) {
      const u = clamp01((Number(t) || 0) / dur);
      const x = u * last;
      const i = Math.min(last, Math.max(0, Math.floor(x)));
      const f = x - i;
      const a = Number(wave[i]) || 0;
      const b = Number(wave[Math.min(i + 1, last)]) || a;
      return a + (b - a) * f;
    },
  };
}

function energySample(track) {
  if (track?.energyCurves && typeof track.energyCurves.globalEnergyNorm === 'function') {
    return track.energyCurves;
  }
  return waveAsCurves(track?.energyWave, track?.durationMs);
}

export function pickEvaluationPassages(track = {}) {
  const durationMs = Math.max(0, Number(track.durationMs) || 0);
  const annotated = track.passages || null;
  const span = Math.min(EVAL_SPAN_MS, durationMs);
  const maxStart = Math.max(0, durationMs - span);
  const curves = energySample(track);
  const derived = pickPreviewPassages({ energyCurves: curves, durationMs });
  const source = annotated && Number.isFinite(annotated.quietMs) && Number.isFinite(annotated.peakMs)
    ? 'annotated'
    : curves ? 'derived' : 'fallback';
  const quietMs = source === 'annotated'
    ? clamp(Math.round(annotated.quietMs), 0, maxStart)
    : derived.quietMs;
  const peakMs = source === 'annotated'
    ? clamp(Math.round(annotated.peakMs), 0, maxStart)
    : derived.peakMs;
  const transitionMs = pickTransitionMs({
    durationMs, quietMs, peakMs, spanMs: span, sample: curves, structure: track.structure, annotated,
  });
  return {
    quietMs, transitionMs, peakMs,
    durationMs, spanMs: span, source,
  };
}

function pickTransitionMs({ durationMs, quietMs, peakMs, spanMs, sample, structure, annotated }) {
  if (Number.isFinite(annotated?.transitionMs)) {
    return Math.round(clamp(annotated.transitionMs, 0, Math.max(0, durationMs - spanMs)));
  }
  const duration = Math.max(0, durationMs || 0);
  const span = spanMs ?? Math.min(EVAL_SPAN_MS, duration);
  const maxStart = Math.max(0, duration - span);
  const read = sample && typeof sample.globalEnergyNorm === 'function'
    ? (t) => sample.globalEnergyNorm(t)
    : null;
  const bounds = Array.isArray(structure?.boundariesMs)
    ? structure.boundariesMs
    : (structure?.sections || []).map((s) => s.startMs).filter(Number.isFinite);
  const lo = duration * 0.08;
  const hi = duration * 0.92;
  let best = null;
  let bestDelta = -1;
  if (read && bounds.length) {
    for (const b of bounds) {
      if (!(b > lo && b < hi - span * 0.25)) continue;
      const delta = Math.abs(read(Math.min(duration, b + 1500)) - read(Math.max(0, b - 1500)));
      if (delta > bestDelta) { bestDelta = delta; best = b; }
    }
  }
  if (best == null && read && duration > span + 1000) {
    for (let t = lo; t <= hi - span; t += 200) {
      const delta = read(t + span * 0.45) - read(t);
      if (delta > bestDelta) { bestDelta = delta; best = t; }
    }
  }
  if (best == null) {
    const mid = Math.round(((quietMs || 0) + (peakMs || 0)) / 2);
    if (Math.abs(mid - quietMs) >= span * 0.4 && Math.abs(mid - peakMs) >= span * 0.4) best = mid;
    else best = duration * 0.35;
  }
  return Math.round(clamp(best, 0, maxStart));
}

export function privateScores(features, options = {}) {
  if (!features || typeof features.drive !== 'number') return null;
  const ranked = scoreWorlds(features, undefined, options);
  const pick = ranked.find((r) => r.recommended) || ranked[0];
  return {
    recommendedId: pick?.id || null,
    pickReason: pick?.pickReason || null,
    byWorld: ranked.map((r) => ({
      id: r.id,
      name: r.name,
      fit: r.fit,
      score: r.score,
      tied: !!r.tied,
      eligible: r.eligible !== false,
      parts: r.parts,
      recommended: !!r.recommended,
    })),
    note: 'Internal fit heuristic, not visual quality or a probability. Ranked on continuous fit after response adaptation; integer score is display-only.',
  };
}

export function seventyEightyCases(heuristic) {
  if (!heuristic?.byWorld) return [];
  const winner = heuristic.recommendedId;
  return heuristic.byWorld
    .filter((w) => w.score >= 70 && w.score <= 80)
    .map((w) => ({ id: w.id, score: w.score, isWinner: w.id === winner }));
}

export function diagnosticsFromFeatures(features = {}, passages = null) {
  const onset = clamp01(features.onset);
  const energyMean = clamp01(features.energyMean);
  const groove = clamp01(features.groove);
  const drive = clamp01(features.drive);
  return {
    eventDensity: onset,
    pulse: clamp01(features.pulse),
    drive,
    saturation: Math.max(onset, energyMean, groove, drive),
    contrast: clamp01(features.contrast),
    bass: clamp01(features.bass),
    transitionMs: passages?.transitionMs ?? null,
    frameMs: null,
    previewLatencyMs: null,
    sceneVisibility: null,
    note: 'Diagnostics, not an automatic beauty score. Null capture fields wait for a still/session dump.',
  };
}

function emptyReview(worldId) {
  return {
    worldId,
    appeal: null,
    musicalTiming: null,
    identity: null,
    quietInterest: null,
    climaxHeadroom: null,
    clutter: null,
    blockingDefect: false,
    notes: '',
  };
}

export function capturePlan(track, passages, worlds = listWorlds()) {
  const seed = evaluationSeed(track);
  const span = passages?.spanMs ?? EVAL_SPAN_MS;
  const shots = [
    ['quiet', passages.quietMs],
    ['transition', passages.transitionMs],
    ['peak', passages.peakMs],
  ];
  return {
    trackId: track.id,
    seed,
    quality: EVAL_QUALITY,
    spanMs: span,
    worlds: worlds.map((w) => ({
      worldId: w.id,
      stills: shots.map(([passage, tMs]) => ({ passage, tMs, seed })),
    })),
  };
}

export function evaluateTrack(track, { worlds = listWorlds() } = {}) {
  const order = viewingOrder(worlds);
  const passages = pickEvaluationPassages(track);
  const heuristic = privateScores(track.features);
  return {
    protocol: EVAL_VERSION,
    track: {
      id: track.id,
      split: track.split,
      family: track.family,
      representation: track.representation,
      title: track.title || track.id,
      durationMs: track.durationMs || 0,
    },
    seed: evaluationSeed(track),
    quality: EVAL_QUALITY,
    passages,
    viewingOrder: order,
    heuristic,
    seventyEighty: seventyEightyCases(heuristic),
    diagnostics: diagnosticsFromFeatures(track.features || {}, passages),
    capture: capturePlan(track, passages, worlds),
    reviews: order.map(emptyReview),
  };
}

export function validateCorpus(corpus) {
  const tracks = Array.isArray(corpus?.tracks) ? corpus.tracks : Array.isArray(corpus) ? corpus : [];
  const errors = [];
  if (tracks.length < 12 || tracks.length > 20) {
    errors.push(`need 12–20 tracks, got ${tracks.length}`);
  }
  const ids = new Set();
  const bySplit = { [TUNE]: new Set(), [HOLDOUT]: new Set() };
  const families = { [TUNE]: new Set(), [HOLDOUT]: new Set() };
  const reps = { [TUNE]: new Set(), [HOLDOUT]: new Set() };
  for (const t of tracks) {
    if (!t?.id) errors.push('track missing id');
    else if (ids.has(t.id)) errors.push(`duplicate id ${t.id}`);
    else ids.add(t.id);
    if (t.split !== TUNE && t.split !== HOLDOUT) errors.push(`${t.id || '?'} split must be tune or holdout`);
    if (t.split === TUNE || t.split === HOLDOUT) {
      bySplit[t.split].add(t.id);
      if (t.family) families[t.split].add(t.family);
      if (t.representation) reps[t.split].add(t.representation);
    }
    if (!t.family) errors.push(`${t.id} missing family`);
    if (!t.representation) errors.push(`${t.id} missing representation`);
    if (!Number.isFinite(t.durationMs) || t.durationMs <= 0) errors.push(`${t.id} needs a duration`);
    if (!t.source || !t.source.kind) errors.push(`${t.id} needs a source.kind (no audio is stored in-repo)`);
  }
  for (const fam of REQUIRED_FAMILIES) {
    if (!families[TUNE].has(fam)) errors.push(`tune split missing family ${fam}`);
    if (!families[HOLDOUT].has(fam)) errors.push(`holdout split missing family ${fam}`);
  }
  if (!reps[TUNE].has('midi') || !reps[TUNE].has('audio')) errors.push('tune split needs both midi and audio');
  if (!reps[HOLDOUT].has('midi') || !reps[HOLDOUT].has('audio')) errors.push('holdout split needs both midi and audio');
  return { ok: errors.length === 0, errors, n: tracks.length };
}

export function evaluateCorpus(corpus, { split = 'all', worlds = listWorlds() } = {}) {
  const tracks = splitTracks(Array.isArray(corpus?.tracks) ? corpus.tracks : corpus, split);
  const sheets = tracks.map((t) => evaluateTrack(t, { worlds }));
  return {
    protocol: EVAL_VERSION,
    split,
    acceptance: ACCEPTANCE_TARGET,
    validation: validateCorpus(corpus),
    sheets,
    summary: summarizeAcceptance(sheets, { split }),
  };
}

/** Why a review cannot count, or [] when it is well formed. Missing or null
 *  axes are an incomplete review, not an invalid one; a present axis must
 *  be an integer from 1 to 5. */
export function reviewErrors(review) {
  if (!review || typeof review !== 'object') return ['review is not an object'];
  const errors = [];
  for (const axis of RATING_AXES) {
    const v = review[axis];
    if (v == null) continue;
    if (!Number.isInteger(v) || v < 1 || v > 5) errors.push(`${axis} must be an integer 1-5 or null (got ${JSON.stringify(v) ?? String(v)})`);
  }
  if (review.blockingDefect !== undefined && typeof review.blockingDefect !== 'boolean') errors.push('blockingDefect must be a boolean');
  if (review.notes !== undefined && typeof review.notes !== 'string') errors.push('notes must be a string');
  return errors;
}

function ratingComplete(review) {
  return RATING_AXES.every((axis) => Number.isInteger(review?.[axis]));
}

function reviewPasses(review) {
  return review.appeal >= ACCEPTANCE_TARGET.appealMin
    && review.musicalTiming >= ACCEPTANCE_TARGET.timingMin;
}

function recommendedReviews(pool) {
  return pool.map((s) => {
    const id = s.heuristic?.recommendedId;
    return { sheet: s, worldId: id, review: (s.reviews || []).find((r) => r.worldId === id) || null };
  });
}

/**
 * Acceptance comes only from valid ratings of the recommended world on
 * HOLDOUT tracks. Tune reviews are diagnostics (met: null). A known blocking
 * defect on any recommended holdout case fails acceptance even when that
 * review is otherwise incomplete. A malformed review is reported and keeps
 * the result unknown; it never counts. The 80% share is over reviewed
 * holdout cases, with coverage reported beside it. Never `claimed`.
 */
export function summarizeAcceptance(sheets, { split = 'all' } = {}) {
  const relevant = (sheets || []).filter((s) => split === 'all' || s.track.split === split);
  const tuneOnly = split === TUNE;
  const pool = relevant.filter((s) => s.track.split === (tuneOnly ? TUNE : HOLDOUT));
  const cases = recommendedReviews(pool);
  const invalid = [], blocking = [], filled = [];
  for (const c of cases) {
    if (!c.review) continue;
    const errors = reviewErrors(c.review);
    if (errors.length) { invalid.push({ trackId: c.sheet.track.id, worldId: c.worldId, errors }); continue; }
    if (c.review.blockingDefect === true) blocking.push({ trackId: c.sheet.track.id, worldId: c.worldId, complete: ratingComplete(c.review) });
    else if (ratingComplete(c.review)) filled.push(c.review);
  }
  const passing = filled.filter(reviewPasses);
  const share = filled.length ? passing.length / filled.length : null;
  let met = null;
  if (!tuneOnly) {
    if (blocking.length) met = false;
    else if (filled.length && !invalid.length) met = share >= ACCEPTANCE_TARGET.holdoutShare;
  }
  const evidence = filled.length + blocking.length > 0;
  return {
    target: ACCEPTANCE_TARGET,
    split: tuneOnly ? TUNE : HOLDOUT,
    tracks: pool.length,
    reviewed: filled.length,
    passing: passing.length,
    share,
    coverage: { reviewed: filled.length + blocking.length, total: pool.length, complete: pool.length > 0 && filled.length + blocking.length === pool.length },
    blocking,
    invalid,
    met,
    claimed: false,
    calibration: tuneOnly ? (evidence ? 'tune-reviews' : 'empty-tune') : (evidence ? 'holdout-reviews' : 'empty-holdout'),
    exclusions: autoExclusions(sheets),
  };
}

/** Track/world pairs with a blocking-defect review. Exported diagnostics:
 *  nothing wires them into world selection automatically. */
export function autoExclusions(sheets) {
  const out = [];
  for (const s of sheets || []) {
    for (const r of s.reviews || []) {
      if (r.blockingDefect === true) {
        out.push({ trackId: s.track.id, worldId: r.worldId, reason: 'blocking-defect' });
      }
    }
  }
  return out;
}

export function applyReviews(sheet, reviewsByWorld) {
  if (!sheet || !reviewsByWorld) return sheet;
  return {
    ...sheet,
    reviews: sheet.reviews.map((r) => {
      const next = reviewsByWorld[r.worldId];
      return next ? { ...r, ...next, worldId: r.worldId } : r;
    }),
  };
}

const REVIEW_FIELDS = [...RATING_AXES, 'blockingDefect', 'notes'];

/**
 * Merge a filled review book (this module's own report envelope:
 * {protocol, split, sheets:[{track:{id,split}, reviews:[...]}]}) into freshly
 * generated sheets. Only review fields are taken: heuristics, ordering and
 * metadata in the book are never authoritative. Returns {sheets, errors};
 * any error means nothing should be reported from the merge.
 */
export function mergeReviewBook(sheets, book) {
  const errors = [];
  if (!book || typeof book !== 'object') return { sheets, errors: ['review book is not a JSON object'] };
  if (book.protocol !== EVAL_VERSION) errors.push(`protocol must be ${EVAL_VERSION} (got ${JSON.stringify(book.protocol)})`);
  if (!['all', TUNE, HOLDOUT].includes(book.split)) errors.push(`split must be all, tune or holdout (got ${JSON.stringify(book.split)})`);
  if (!Array.isArray(book.sheets)) errors.push('sheets must be an array');
  if (errors.length) return { sheets, errors };
  const fresh = new Map(sheets.map((s) => [s.track.id, s]));
  const byTrack = new Map();
  for (const [i, entry] of book.sheets.entries()) {
    const id = entry?.track?.id;
    const at = `sheets[${i}]`;
    if (typeof id !== 'string') { errors.push(`${at}: track.id missing`); continue; }
    const sheet = fresh.get(id);
    if (!sheet) { errors.push(`${at}: unknown track ${id} for this corpus/split`); continue; }
    if (entry.track.split !== sheet.track.split) { errors.push(`${at}: track ${id} is ${sheet.track.split}, book says ${JSON.stringify(entry.track.split)}`); continue; }
    if (byTrack.has(id)) { errors.push(`${at}: duplicate track ${id}`); continue; }
    if (!Array.isArray(entry.reviews)) { errors.push(`${at}: reviews must be an array`); continue; }
    const worlds = new Set(sheet.reviews.map((r) => r.worldId));
    const reviews = {};
    for (const [j, r] of entry.reviews.entries()) {
      const where = `${at}.reviews[${j}]`;
      if (typeof r?.worldId !== 'string' || !worlds.has(r.worldId)) { errors.push(`${where}: unknown world ${JSON.stringify(r?.worldId)}`); continue; }
      if (reviews[r.worldId]) { errors.push(`${where}: duplicate world ${r.worldId}`); continue; }
      const bad = reviewErrors(r);
      if (r.blockingDefect === undefined) bad.push('blockingDefect must be a boolean');
      if (bad.length) { errors.push(...bad.map((e) => `${where} (${id}/${r.worldId}): ${e}`)); continue; }
      reviews[r.worldId] = Object.fromEntries(REVIEW_FIELDS.filter((k) => k in r).map((k) => [k, r[k] ?? null]));
    }
    byTrack.set(id, reviews);
  }
  if (errors.length) return { sheets, errors };
  return { sheets: sheets.map((s) => (byTrack.has(s.track.id) ? applyReviews(s, byTrack.get(s.track.id)) : s)), errors };
}
