// Range v2: scenic shot tours for the song's views (docs/scenic-tours.md).
//
// RangePresentation owns one of these. For every view the song may show
// that carries an approved shot library, it loads the library (once per
// page: libraries are song-independent), hands the scene the library's
// camera footprint before preparation (forest, LOD and rivers then never
// depend on a song), plans the song's camera in a worker over the chapter
// intervals where the view is on screen, and gives the scene the finished
// timeline before the view's first drawn frame. Until a plan has settled
// the view is not ready; a missing or invalid library, a failed or late
// plan leave the view on its authored rail with the reason recorded --
// never a camera that switches mid-song, never a blank frame.
import { loadShotLibrary, shotLibraryBytes, cameraFootprint } from '../terrain/ShotLibrary.js';
import { prepareShotTimeline } from '../terrain/ShotRuntime.js';
export { cameraFootprint };

/** Planning may take this long (wall clock) before the rail is kept. */
export const SHOT_PLAN_TIMEOUT_MS = 8000;
/** Heard-time margin around a chapter's sections (travel seams). */
const SEAM_MARGIN_MS = 6000;

/** Whether a catalog view may play its shot tour. Candidates play only
 *  for diagnostics (?rangeShots=all), mirroring forcedCandidate. */
export function shotTourEligible(view, { allowCandidates = false } = {}) {
  if (!view?.shotsManifestUrl || !/^[a-f0-9]{64}$/.test(view.shotsManifestSha256 || '')) return false;
  return view.status === 'approved' || allowCandidates;
}

/** Heard-time intervals where `viewId` can be on screen: sections whose
 *  chapter biome maps to it, widened by the travel seam on both sides. */
export function visibleIntervals(viewId, mgr, choiceFor) {
  const durationMs = mgr?.durationMs || 0, sections = mgr?.sections || [];
  const name = (p) => (typeof p === 'string' ? p : p?.name ?? null);
  const raw = [];
  for (const s of sections) {
    const view = choiceFor(name(s.profile))?.view;
    if (view?.id === viewId) raw.push([Math.max(0, s.startMs - SEAM_MARGIN_MS), Math.min(durationMs, s.endMs + SEAM_MARGIN_MS)]);
  }
  if (!raw.length) return [{ startMs: 0, endMs: durationMs }];
  raw.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of raw) {
    if (out.length && a <= out.at(-1).endMs) out.at(-1).endMs = Math.max(out.at(-1).endMs, b);
    else out.push({ startMs: a, endMs: b });
  }
  return out;
}

export class RangeShotTours {
  constructor({ enabled = true, allowCandidates = false, assetBase, residency = null,
    load = loadShotLibrary, plan = prepareShotTimeline, now = () => Date.now() } = {}) {
    this.enabled = enabled;
    this.allowCandidates = allowCandidates;
    this.assetBase = assetBase;
    this.residency = residency;
    this._load = load;
    this._plan = plan;
    this._now = now;
    this.libraries = new Map(); // manifest URL -> { promise, state, library, reason, key }
    this.views = new Map(); // viewId -> per-song state
    this.generation = 0;
  }

  /** A new song (or a rebuild of the same one). `continuation` carries the
   *  previous timelines and the committed horizon when the same song is
   *  rebuilt in place (full-analysis adoption), so committed motion holds. */
  setSong({ mgr = null, views = [], choiceFor = () => null, generation, exportMode = false, continuation = null } = {}) {
    for (const s of this.views.values()) s.abort?.abort();
    this.views.clear();
    this.generation = generation;
    this.mgr = mgr;
    this.choiceFor = choiceFor;
    this.exportMode = exportMode;
    this.sections = mgr?.sections;
    if (!this.enabled || !(mgr?.durationMs > 0)) return;
    for (const view of views) {
      if (!shotTourEligible(view, { allowCandidates: this.allowCandidates })) continue;
      const previous = continuation?.timelines?.get?.(view.id) || null;
      this.views.set(view.id, { viewId: view.id, state: 'loading', reason: null, timeline: null, library: null, view,
        previous, committedThroughMs: previous ? continuation.committedThroughMs : null, startedAt: this._now(), abort: null });
      this._library(view).then((lib) => this._onLibrary(view.id, generation, lib));
    }
  }

  _library(view) {
    const url = new URL(view.shotsManifestUrl, this.assetBase).href;
    let entry = this.libraries.get(url);
    if (!entry || entry.state === 'failed') {
      entry = { state: 'loading', library: null, reason: null, key: `range:shots:${view.id}` };
      entry.promise = this._load(url, { expectManifestSha256: view.shotsManifestSha256, viewId: view.terrainSourceId || view.id })
        .then(({ library }) => {
          const bytes = shotLibraryBytes(library);
          // Libraries stay resident for the page: they are small and every
          // later song in this view reuses them.
          if (this.residency) {
            this.residency.release(entry.key);
            const reservation = this.residency.reserve({ key: entry.key, bytes, owner: 'range-shot-library', generation: 0, evictable: false });
            if (!reservation) throw new Error('no room for the shot library');
            this.residency.commit(reservation, library);
          }
          entry.state = 'ready'; entry.library = library; entry.footprint = cameraFootprint(library);
          return entry;
        }).catch((error) => { entry.state = 'failed'; entry.reason = `shot library: ${error.message}`; return entry; });
      this.libraries.set(url, entry);
    }
    return entry.promise;
  }

  _onLibrary(viewId, generation, entry) {
    const s = this.views.get(viewId);
    if (!s || generation !== this.generation) return;
    if (entry.state !== 'ready') { s.state = 'failed'; s.reason = entry.reason; return; }
    s.library = entry.library; s.footprint = entry.footprint;
    s.state = 'planning';
    this._startPlan(s, generation);
  }

  _startPlan(s, generation, { previous = s.previous, committedThroughMs = s.committedThroughMs } = {}) {
    const controller = new AbortController();
    s.abort?.abort();
    s.abort = controller;
    const mgr = this.mgr;
    const visible = visibleIntervals(s.viewId, mgr, this.choiceFor);
    s.visible = visible;
    const started = this._now();
    return this._plan(s.library, mgr, { signal: controller.signal, visible, seed: mgr?.songSeed ?? 0,
      previous: previous || null, committedThroughMs: previous ? committedThroughMs : -1 })
      .then((timeline) => {
        if (controller.signal.aborted || generation !== this.generation) return;
        s.planMs = this._now() - started;
        if (timeline.fallback) { s.state = 'failed'; s.reason = `shot plan: ${timeline.fallback}`; s.timeline = null; return; }
        s.timeline = timeline; s.state = 'ready'; s.reason = null;
      }).catch((error) => {
        if (controller.signal.aborted || generation !== this.generation) return;
        s.state = 'failed'; s.reason = `shot plan: ${error.message}`; s.timeline = null;
      });
  }

  /** The view as the scene should prepare it: with its library footprint
   *  once known. Null while the library is still loading (prepare later). */
  prepareView(view) {
    const s = this.views.get(view.id);
    if (!s) return view;
    if (s.state === 'loading') return null;
    return s.footprint ? { ...view, cameraPaths: s.footprint } : view;
  }

  /** Whether the view's camera has settled for this song: a ready plan or
   *  a recorded fallback. A plan that outlives SHOT_PLAN_TIMEOUT_MS falls
   *  back to the rail (except in export, which waits for its plan). */
  settled(viewId) {
    const s = this.views.get(viewId);
    if (!s) return true;
    if (s.state === 'ready' || s.state === 'failed') return true;
    if (!this.exportMode && this._now() - s.startedAt > SHOT_PLAN_TIMEOUT_MS) {
      s.abort?.abort();
      s.state = 'failed'; s.reason = 'shot plan: timed out; the rail is kept for this song';
      return true;
    }
    return false;
  }

  /** The camera timeline a view draws with (null: its rail). */
  timeline(viewId) { return this.views.get(viewId)?.timeline || null; }

  /** Replan the uncommitted tail when the song's sections are refined. The
   *  result is admitted only if it matches the camera heard now. */
  refine(mgr) {
    if (!this.views.size || mgr.sections === this.sections) return;
    this.sections = mgr.sections;
    const generation = this.generation, nowMs = (mgr.tSec || 0) * 1000;
    for (const s of this.views.values()) {
      if (s.state !== 'ready' || !s.timeline) continue;
      const before = s.timeline;
      s.refinement = { state: 'pending', reason: null };
      const controller = new AbortController();
      s.refineAbort?.abort(); s.refineAbort = controller;
      this._plan(s.library, mgr, { signal: controller.signal, visible: visibleIntervals(s.viewId, mgr, this.choiceFor),
        seed: mgr?.songSeed ?? 0, previous: before, committedThroughMs: nowMs })
        .then((timeline) => {
          if (controller.signal.aborted || generation !== this.generation || s.timeline !== before) return;
          const at = (this.mgr?.tSec || 0) * 1000, a = before.poseAt(at), b = timeline.poseAt(at);
          const continuous = !timeline.fallback && ['eyeM', 'targetM'].every((k) => a[k].every((v, i) => Math.abs(v - b[k][i]) < 0.1))
            && Math.abs(a.fovYDeg - b.fovYDeg) < 0.01;
          if (!continuous) { s.refinement = { state: 'held', reason: 'refinement arrived beyond its committed camera' }; this.sections = null; return; }
          s.timeline = timeline; s.refinement = { state: 'applied', reason: null };
          this.onTimelineChange?.(s.viewId, timeline);
        }).catch((error) => {
          if (controller.signal.aborted || generation !== this.generation) return;
          s.refinement = { state: 'held', reason: error.message };
        });
    }
  }

  /** The current timelines and a committed horizon, for an in-place rebuild. */
  continuation(committedThroughMs) {
    const timelines = new Map();
    for (const [id, s] of this.views) if (s.timeline) timelines.set(id, s.timeline);
    return timelines.size ? { timelines, committedThroughMs } : null;
  }

  /** Diagnostics for one view at a heard time. */
  stateAt(viewId, timeMs) {
    const s = this.views.get(viewId);
    if (!s) return null;
    return { state: s.state, reason: s.reason, ...(s.timeline?.stateAt ? { shot: s.timeline.stateAt(timeMs) } : {}) };
  }

  status() {
    const out = {};
    for (const [id, s] of this.views) {
      out[id] = { state: s.state, reason: s.reason, planMs: s.planMs ?? null, refinement: s.refinement || null,
        visible: s.visible || null,
        ...(s.library ? { shots: s.library.shots.length, links: s.library.links.length } : {}),
        ...(s.timeline ? { items: s.timeline.items?.length ?? null, payoffs: s.timeline.payoffs || [], diagnostics: s.timeline.diagnostics || null } : {}) };
    }
    return out;
  }

  dispose() {
    for (const s of this.views.values()) { s.abort?.abort(); s.refineAbort?.abort(); }
    this.views.clear();
  }
}
