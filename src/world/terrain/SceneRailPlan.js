import { travelMs } from '../BiomeSchedule.js';
import { sceneProgressAt } from './SceneTravel.js';

export const DEFAULT_RAIL_PACE = 3;
export const RAIL_PACES = Object.freeze([1, 2, 3, 4]);
const STEP_MS = 20;
const VISIBLE_ALLOWANCE_MS = 8200;
const clamp01 = value => Math.max(0, Math.min(1, value));
const durationOf = value => Number.isFinite(value) && value > 0 ? value : 0;

export function normalizeRailPace(value) {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof numeric === 'number' && RAIL_PACES.includes(numeric) ? numeric : DEFAULT_RAIL_PACE;
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// Two independent 32-bit content hashes keep IDs small without rounding any
// stored coefficients. IDs depend on the full JSON content, never a run clock.
function identity(prefix, value) {
  const source = JSON.stringify(value);
  let a = 2166136261, b = 3339675911;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    a = Math.imul(a ^ code, 16777619);
    b = Math.imul(b ^ code, 2246822519);
  }
  return `${prefix}-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

function makeBase(durationMs, curves, response) {
  const progress = [];
  if (!durationMs) progress.push(.5);
  else {
    for (let timeMs = 0; timeMs < durationMs; timeMs += STEP_MS) {
      progress.push(sceneProgressAt({ timeMs, curves, durationMs, response }));
    }
    progress.push(sceneProgressAt({ timeMs: durationMs, curves, durationMs, response }));
  }
  if (!progress.every(Number.isFinite)) throw new Error('invalid scene rail base: non-finite progress');
  const data = { durationMs, stepMs: STEP_MS, progress };
  return freeze({ id: identity('base', data), ...data });
}

function sampleBase(base, timeMs) {
  if (!base.durationMs) return .5;
  const t = Math.max(0, Math.min(base.durationMs, timeMs));
  const i = Math.min(Math.floor(t / STEP_MS), base.progress.length - 1);
  if (i === base.progress.length - 1) return base.progress[i];
  const end = Math.min((i + 1) * STEP_MS, base.durationMs);
  const fraction = (t - i * STEP_MS) / (end - i * STEP_MS);
  return base.progress[i] + (base.progress[i + 1] - base.progress[i]) * fraction;
}

function fitWindow(base, startMs, endMs, multiplier) {
  const baseStart = sampleBase(base, startMs);
  const baseDelta = Math.max(0, sampleBase(base, endMs) - baseStart);
  const targetDelta = Math.min(multiplier * baseDelta, 1);
  const gain = baseDelta > 0 ? targetDelta / baseDelta : 1;
  return freeze({
    baseStart, baseDelta, targetDelta,
    start: Math.max(0, Math.min(baseStart, 1 - targetDelta)),
    gain, effectiveMultiplier: gain,
    coverage01: baseDelta > 0 ? targetDelta / (multiplier * baseDelta) : 1,
    capped: multiplier * baseDelta > 1,
  });
}

function mergeRuns(runs) {
  const merged = [];
  for (const run of runs) {
    const last = merged.at(-1);
    if (last && run.viewId !== null && last.viewId === run.viewId && last.nominalEndMs === run.startMs) {
      last.nominalEndMs = run.nominalEndMs;
    } else merged.push({ ...run });
  }
  return merged;
}

function resolveRuns(sections, choiceFor, durationMs) {
  const valid = (Array.isArray(sections) ? sections : [])
    .filter(section => section && Number.isFinite(section.startMs))
    .map(section => ({ ...section, startMs: Math.max(0, section.startMs) }))
    .filter(section => !durationMs || section.startMs < durationMs)
    .sort((a, b) => a.startMs - b.startMs);
  const resolve = section => {
    const biome = typeof section.profile === 'string' ? section.profile : section.profile?.name ?? null;
    const viewId = choiceFor(biome)?.view?.id ?? null;
    return { viewId, biome, transitionMs: travelMs(section) };
  };
  if (!valid.length) return [];
  if (!durationMs) return [{ ...resolve(valid[0]), startMs: 0, nominalEndMs: 0, transitionMs: 0 }];
  const ordered = [];
  for (const section of valid) {
    if (ordered.at(-1)?.startMs === section.startMs) ordered.pop();
    ordered.push(section);
  }
  const runs = [];
  const gap = (startMs, nominalEndMs) => runs.push({ viewId: null, biome: null, startMs, nominalEndMs, transitionMs: 3000 });
  if (ordered[0].startMs > 0) gap(0, ordered[0].startMs);
  ordered.forEach((section, index) => {
    const next = ordered[index + 1]?.startMs ?? durationMs;
    const end = Number.isFinite(section.endMs) ? Math.max(section.startMs, Math.min(next, section.endMs)) : next;
    if (end > section.startMs) runs.push({ ...resolve(section), startMs: section.startMs, nominalEndMs: end });
    if (end < next) gap(end, next);
  });
  const merged = mergeRuns(runs);
  if (merged.length) merged[0].transitionMs = 0;
  return merged;
}

function makeOccurrence(run, base, requestedMultiplier, durationMs, seed, worldId) {
  const endMs = run.nominalEndMs >= durationMs ? durationMs : Math.min(durationMs, run.nominalEndMs + VISIBLE_ALLOWANCE_MS);
  const data = {
    viewId: run.viewId, biome: run.biome, startMs: run.startMs,
    nominalEndMs: run.nominalEndMs, endMs, transitionMs: run.transitionMs,
  };
  return freeze({
    id: identity('occ', { ...data, seed, worldId }), ...data,
    baseId: base.id, requestedMultiplier,
    fit: fitWindow(base, data.startMs, endMs, requestedMultiplier),
  });
}

function makePlan({ durationMs, seed, worldId, requestedMultiplier, bases, occurrences }) {
  // Drop fresh/old tables that are no longer referenced after a splice.
  const used = new Set(occurrences.map(occurrence => occurrence.baseId));
  const unique = new Map(bases.filter(base => used.has(base.id)).map(base => [base.id, base]));
  const data = { version: 1, durationMs, seed, worldId, requestedMultiplier, bases: [...unique.values()], occurrences };
  const snapshot = freeze({ id: identity('rail', data), ...data });
  const byId = new Map(occurrences.map(occurrence => [occurrence.id, occurrence]));
  return Object.freeze({
    snapshot,
    occurrences: snapshot.occurrences,
    selectionAt(timeMs) {
      if (!occurrences.length) return null;
      const t = Number.isFinite(timeMs) ? timeMs : 0;
      let index = 0;
      while (index + 1 < occurrences.length && occurrences[index + 1].startMs <= t) index++;
      const to = occurrences[index];
      if (!index) return Object.freeze({ from: to, to, travelP: 1, transition01: 1 });
      const travelP = to.transitionMs > 0 ? clamp01((t - to.startMs) / to.transitionMs) : 1;
      const transition01 = travelP * travelP * (3 - 2 * travelP);
      // Match BiomeSchedule's completion threshold as well as its smoothstep.
      const from = travelP >= 1 || transition01 >= .999 ? to : occurrences[index - 1];
      return Object.freeze({ from, to, travelP: from === to ? 1 : travelP, transition01: from === to ? 1 : transition01 });
    },
    railStateAt(occurrenceId, timeMs) {
      const occurrence = byId.get(occurrenceId);
      if (!occurrence) return null;
      const base = unique.get(occurrence.baseId);
      const fit = occurrence.fit;
      const t = Math.max(occurrence.startMs, Math.min(occurrence.endMs, Number.isFinite(timeMs) ? timeMs : 0));
      const progress01 = clamp01(fit.start + fit.gain * (sampleBase(base, t) - fit.baseStart));
      return Object.freeze({
        occurrenceId, viewId: occurrence.viewId, progress01,
        requestedMultiplier: occurrence.requestedMultiplier,
        effectiveMultiplier: fit.effectiveMultiplier,
        coverage01: fit.coverage01, capped: fit.capped, policy: 'rail',
      });
    },
  });
}

/** Compile a detached whole-song base and actual-view schedule. High-water is
 * supplied by the run owner; neither sampling nor restoration commits history. */
export function compileSceneRailPlan({
  sections = [], choiceFor = () => null, durationMs = 0, curves = null,
  response = null, requestedMultiplier = DEFAULT_RAIL_PACE, seed = 0,
  worldId = null, previous = null, committedThroughMs = -1,
} = {}) {
  const duration = durationOf(durationMs);
  const multiplier = normalizeRailPace(requestedMultiplier);
  const safeSeed = Number.isFinite(seed) ? seed : 0;
  const safeWorld = typeof worldId === 'string' ? worldId : null;
  const base = makeBase(duration, curves, response);
  const runs = resolveRuns(sections, choiceFor, duration);
  // A midpoint preview has no heard motion to protect. Once song bounds are
  // known, its zero-length occurrence cannot serve as its own splice anchor.
  const old = duration > 0 && !(previous?.snapshot?.durationMs > 0) ? null : previous?.snapshot;
  const protectedRuns = old?.occurrences.filter(occurrence => occurrence.startMs <= committedThroughMs) ?? [];
  let tail = runs;
  if (protectedRuns.length) {
    const seam = protectedRuns.at(-1).nominalEndMs;
    tail = [];
    if (seam < duration) {
      const anchor = old.occurrences.find(occurrence => occurrence.startMs === seam);
      if (anchor) {
        const later = runs.filter(run => run.startMs > seam);
        const firstChange = later.findIndex(run => run.viewId !== anchor.viewId);
        const following = firstChange < 0 ? [] : later.slice(firstChange);
        tail = mergeRuns([
          { viewId: anchor.viewId, biome: anchor.biome, startMs: seam,
            nominalEndMs: following[0]?.startMs ?? duration, transitionMs: anchor.transitionMs },
          ...following,
        ]);
      }
    }
  }
  const occurrences = [...protectedRuns, ...tail.map(run => makeOccurrence(run, base, multiplier, duration, safeSeed, safeWorld))];
  return makePlan({ durationMs: duration, seed: safeSeed, worldId: safeWorld,
    requestedMultiplier: multiplier, bases: [...(old?.bases ?? []), base], occurrences });
}

/** Refit only occurrences whose starts have never been heard/committed. */
export function withSceneRailPace(plan, requestedMultiplier, committedThroughMs = -1) {
  const snapshot = plan.snapshot;
  const multiplier = normalizeRailPace(requestedMultiplier);
  const bases = new Map(snapshot.bases.map(base => [base.id, base]));
  const occurrences = snapshot.occurrences.map(occurrence => {
    if (occurrence.startMs <= committedThroughMs || occurrence.requestedMultiplier === multiplier) return occurrence;
    return freeze({ ...occurrence, requestedMultiplier: multiplier,
      fit: fitWindow(bases.get(occurrence.baseId), occurrence.startMs, occurrence.endMs, multiplier) });
  });
  return makePlan({ ...snapshot, requestedMultiplier: multiplier, occurrences });
}

function invalid(detail) { throw new Error(`invalid scene rail snapshot: ${detail}`); }
const isId = value => typeof value === 'string' && value.length > 0;
const finite = (value, label) => { if (!Number.isFinite(value)) invalid(label); };

/** Restore only plain data; no curve identity or original sampler is retained. */
export function sceneRailPlanFromSnapshot(snapshot) {
  if (snapshot?.version !== 1) invalid('unsupported version');
  if (!Number.isFinite(snapshot.durationMs) || snapshot.durationMs < 0) invalid('duration');
  if (!Number.isFinite(snapshot.seed) || !(snapshot.worldId === null || typeof snapshot.worldId === 'string')) invalid('seed/world');
  if (!RAIL_PACES.includes(snapshot.requestedMultiplier)) invalid('pace');
  if (!Array.isArray(snapshot.bases) || !Array.isArray(snapshot.occurrences)) invalid('tables/occurrences');
  const ids = new Set();
  const bases = snapshot.bases.map(base => {
    if (!isId(base?.id) || ids.has(base.id)) invalid('base id');
    ids.add(base.id);
    if (!Number.isFinite(base.durationMs) || base.durationMs < 0 || base.stepMs !== STEP_MS) invalid('base timing');
    if (!Array.isArray(base.progress) || base.progress.length !== Math.ceil(base.durationMs / STEP_MS) + 1) invalid('base samples');
    base.progress.forEach((value, index) => {
      if (!Number.isFinite(value) || value < 0 || value > 1 || index > 0 && value < base.progress[index - 1]) invalid('non-finite or non-monotone curve');
    });
    if (!base.durationMs && base.progress[0] !== .5) invalid('preview curve');
    const data = { durationMs: base.durationMs, stepMs: STEP_MS, progress: [...base.progress] };
    if (identity('base', data) !== base.id) invalid('base content id');
    return freeze({ id: base.id, ...data });
  });
  const occurrenceIds = new Set();
  let previousStart = -1;
  const occurrences = snapshot.occurrences.map(occurrence => {
    if (!isId(occurrence?.id) || occurrenceIds.has(occurrence.id)) invalid('occurrence id');
    occurrenceIds.add(occurrence.id);
    if (!ids.has(occurrence.baseId)) invalid('base reference');
    if (!(occurrence.viewId === null || isId(occurrence.viewId)) || !(occurrence.biome === null || typeof occurrence.biome === 'string')) invalid('view/biome');
    for (const key of ['startMs', 'nominalEndMs', 'endMs', 'transitionMs']) finite(occurrence[key], key);
    if (occurrence.startMs < 0 || occurrence.startMs <= previousStart || occurrence.nominalEndMs < occurrence.startMs || occurrence.endMs < occurrence.nominalEndMs || occurrence.transitionMs < 0) invalid('occurrence timing');
    previousStart = occurrence.startMs;
    if (!RAIL_PACES.includes(occurrence.requestedMultiplier)) invalid('occurrence pace');
    const fit = occurrence.fit;
    if (!fit || typeof fit.capped !== 'boolean') invalid('fit');
    for (const key of ['baseStart', 'baseDelta', 'targetDelta', 'start', 'gain', 'effectiveMultiplier', 'coverage01']) finite(fit[key], `fit.${key}`);
    if (fit.baseStart < 0 || fit.baseStart > 1 || fit.baseDelta < 0 || fit.targetDelta < 0 || fit.targetDelta > 1 || fit.start < 0 || fit.start > 1 || fit.gain < 0 || fit.effectiveMultiplier < 0 || fit.coverage01 < 0 || fit.coverage01 > 1) invalid('fit bounds');
    return freeze({
      id: occurrence.id, viewId: occurrence.viewId, biome: occurrence.biome,
      startMs: occurrence.startMs, nominalEndMs: occurrence.nominalEndMs, endMs: occurrence.endMs,
      transitionMs: occurrence.transitionMs, baseId: occurrence.baseId,
      requestedMultiplier: occurrence.requestedMultiplier,
      fit: { baseStart: fit.baseStart, baseDelta: fit.baseDelta, targetDelta: fit.targetDelta,
        start: fit.start, gain: fit.gain, effectiveMultiplier: fit.effectiveMultiplier,
        coverage01: fit.coverage01, capped: fit.capped },
    });
  });
  const plan = makePlan({ durationMs: snapshot.durationMs, seed: snapshot.seed, worldId: snapshot.worldId,
    requestedMultiplier: snapshot.requestedMultiplier, bases, occurrences });
  if (plan.snapshot.id !== snapshot.id) invalid('content id');
  return plan;
}
