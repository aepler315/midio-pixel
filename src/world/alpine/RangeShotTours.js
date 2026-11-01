// Range v2: scenic shot tours for the song's views (docs/scenic-tours.md).
//
// RangePresentation owns one of these. For every view the song may show
// that carries an approved shot library, it loads the library (once per
// page: libraries are song-independent), hands the scene the library's
// camera footprint before preparation (forest, LOD and rivers then never
// depend on a song), plans the song's camera in a worker over the schedule
// windows where the view is on screen, and gives the scene the finished
// timeline before the view's first drawn frame. Until a plan has settled
// the view is not ready; a missing or invalid library, a failed or late
// plan leave the view on its authored rail with the reason recorded --
// never a camera that switches mid-song, never a blank frame. Once a camera
// has been heard, its keys are history: a rewind, a late worker reply or a
// failed replan keeps them, through the keys that interpolate the last heard
// pose.
import { loadShotLibrary, shotLibraryBytes, cameraFootprint } from '../terrain/ShotLibrary.js';
import { shotTourIdentityErrors } from '../terrain/SceneCatalog.js';
import { prepareShotTimeline } from '../terrain/ShotRuntime.js';
import { sceneViewWindows } from '../terrain/SceneRailPlan.js';
import { SHOT_KEY_MS } from '../terrain/ShotTimeline.js';
export { cameraFootprint };

/** Planning may take this long (wall clock) before the rail is kept. */
export const SHOT_PLAN_TIMEOUT_MS = 8000;

/** Whether a catalog view may play its shot tour. Candidates play only
 *  for diagnostics (?rangeShots=all), mirroring forcedCandidate. */
export function shotTourEligible(view, { allowCandidates = false } = {}) {
  if (shotTourIdentityErrors(view).length) return false;
  if (allowCandidates) return true;
  const a = view.shotTour.approval;
  return view.status === 'approved' && view.shotTour.status === 'approved'
    && Array.isArray(a?.evidence) && a.evidence.length > 0 && a.evidence.every((s) => typeof s === 'string' && s.length > 0);
}

/** Heard-time intervals where `viewId` can be on screen: the scheduled
 *  appearances (`occurrences`, or the sections' own runs before a schedule
 *  exists) from their first frame through the outgoing allowance. */
export function visibleIntervals(viewId, mgr, choiceFor, occurrences = null) {
  const durationMs = mgr?.durationMs || 0;
  const windows = occurrences || sceneViewWindows(mgr?.sections, choiceFor, durationMs);
  const raw = windows.filter((w) => w.viewId === viewId).map((w) => [w.startMs, w.endMs]);
  if (!raw.length) return [{ startMs: 0, endMs: durationMs }];
  raw.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of raw) {
    if (out.length && a <= out.at(-1).endMs) out.at(-1).endMs = Math.max(out.at(-1).endMs, b);
    else out.push({ startMs: a, endMs: b });
  }
  return out;
}

/** Whether `after` keeps `before`'s eye, target and FOV keys exactly through
 *  time `heardMs`, and the two later keys poseAt's Catmull-Rom reads there. */
export function retainsHeardCamera(before, after, heardMs) {
  const durationMs = Math.min(before.durationMs, after.durationMs), last = Math.floor(heardMs / SHOT_KEY_MS) + 2;
  for (let i = 0; i <= last; i++) {
    const t = Math.min(i * SHOT_KEY_MS, durationMs), a = before.poseAt(t), b = after.poseAt(t);
    if (a.fovYDeg !== b.fovYDeg || ['eyeM', 'targetM'].some((k) => a[k].some((v, q) => v !== b[k][q]))) return false;
    if (t >= durationMs) break;
  }
  return true;
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
    this.heardThroughMs = 0;
  }

  /** Heard time only rises: a rewind replays history, it does not reopen it. */
  reach(heardMs) {
    if (!this.exportMode && Number.isFinite(heardMs)) this.heardThroughMs = Math.max(this.heardThroughMs, heardMs);
  }

  /** A new song (or a rebuild of the same one). `continuation` carries the
   *  previous timelines and the committed horizon when the same song is
   *  rebuilt in place (a seek or full-analysis adoption), so committed motion
   *  holds. `occurrences` is the rail schedule that decides what is on screen. */
  setSong({ mgr = null, views = [], choiceFor = () => null, generation, exportMode = false, continuation = null, occurrences = null } = {}) {
    for (const s of this.views.values()) { s.abort?.abort(); s.refineAbort?.abort(); }
    this.views.clear();
    this.generation = generation;
    this.mgr = mgr;
    this.choiceFor = choiceFor;
    this.exportMode = exportMode;
    this.occurrences = occurrences;
    this.heardThroughMs = Math.max(0, continuation?.committedThroughMs ?? 0);
    this.sections = mgr?.sections;
    if (!this.enabled || !(mgr?.durationMs > 0)) return;
    for (const view of views) {
      if (!shotTourEligible(view, { allowCandidates: this.allowCandidates })) continue;
      // A committed timeline of another length belongs to another song.
      const kept = continuation?.timelines?.get?.(view.id), previous = kept?.durationMs === mgr.durationMs ? kept : null;
      this.views.set(view.id, { viewId: view.id, state: 'loading', reason: null, timeline: null, library: null, view,
        previous, startedAt: this._now(), abort: null });
      this._library(view).then((lib) => this._onLibrary(view.id, generation, lib));
    }
  }

  _library(view) {
    const url = new URL(view.shotsManifestUrl, this.assetBase).href;
    let entry = this.libraries.get(url);
    if (!entry || entry.state === 'failed') {
      entry = { state: 'loading', library: null, reason: null, key: `range:shots:${view.id}` };
      entry.promise = this._load(url, { expectManifestSha256: view.shotsManifestSha256, viewId: view.id })
        .then(({ library }) => {
          if (library.terrainManifestSha256 !== view.terrainManifestSha256) throw new Error('terrain identity differs from the shot library');
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

  _heardMs() { return Math.max(this.heardThroughMs, (this.mgr?.tSec || 0) * 1000); }

  _visible(s, mgr = this.mgr) { return visibleIntervals(s.viewId, mgr, this.choiceFor, this.occurrences); }

  /** Keep the camera already heard; `retry` replans from the newest horizon. */
  _hold(s, previous, reason, retry = false) {
    s.timeline = previous; s.state = 'ready'; s.reason = null;
    s.refinement = { state: 'held', reason };
    if (retry) this.sections = null;
  }

  _startPlan(s, generation, { previous = s.previous } = {}) {
    const controller = new AbortController();
    s.abort?.abort();
    s.abort = controller;
    const mgr = this.mgr;
    const visible = this._visible(s);
    s.visible = visible;
    const started = this._now();
    return this._plan(s.library, mgr, { signal: controller.signal, visible, seed: mgr?.songSeed ?? 0,
      previous: previous || null, committedThroughMs: previous ? this._heardMs() : -1 })
      .then((timeline) => {
        if (controller.signal.aborted || generation !== this.generation) return;
        s.planMs = this._now() - started;
        if (previous && (timeline.fallback || !retainsHeardCamera(previous, timeline, this._heardMs()))) { this._hold(s, previous, 'replan arrived beyond its committed camera', true); return; }
        if (timeline.fallback) { s.state = 'failed'; s.reason = `shot plan: ${timeline.fallback}`; s.timeline = null; return; }
        s.timeline = timeline; s.state = 'ready'; s.reason = null;
      }).catch((error) => {
        if (controller.signal.aborted || generation !== this.generation) return;
        if (previous) { this._hold(s, previous, error.message); return; }
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
      if (s.previous) { this._hold(s, s.previous, 'replan timed out'); return true; }
      s.state = 'failed'; s.reason = 'shot plan: timed out; the rail is kept for this song';
      return true;
    }
    return false;
  }

  /** The camera timeline a view draws with (null: its rail). */
  timeline(viewId) { return this.views.get(viewId)?.timeline || null; }

  /** Replan the unheard tail when the song's sections are refined. The result
   *  is admitted only if it keeps every camera key heard by the time it lands. */
  refine(mgr) {
    if (!this.views.size || mgr.sections === this.sections) return;
    this.sections = mgr.sections;
    const generation = this.generation, heardMs = this._heardMs();
    for (const s of this.views.values()) {
      if (s.state !== 'ready' || !s.timeline) continue;
      const before = s.timeline;
      s.refinement = { state: 'pending', reason: null };
      const controller = new AbortController();
      s.refineAbort?.abort(); s.refineAbort = controller;
      this._plan(s.library, mgr, { signal: controller.signal, visible: this._visible(s, mgr),
        seed: mgr?.songSeed ?? 0, previous: before, committedThroughMs: heardMs })
        .then((timeline) => {
          if (controller.signal.aborted || generation !== this.generation || s.timeline !== before) return;
          if (timeline.fallback || !retainsHeardCamera(before, timeline, this._heardMs())) { this._hold(s, before, 'refinement arrived beyond its committed camera', true); return; }
          s.timeline = timeline; s.refinement = { state: 'applied', reason: null };
          this.onTimelineChange?.(s.viewId, timeline);
        }).catch((error) => {
          if (controller.signal.aborted || generation !== this.generation) return;
          s.refinement = { state: 'held', reason: error.message };
        });
    }
  }

  /** The current timelines and a committed horizon, for an in-place rebuild.
   *  A view still replanning hands on the camera its plan continues. */
  continuation(committedThroughMs = 0) {
    const timelines = new Map();
    for (const [id, s] of this.views) if (s.timeline || s.previous) timelines.set(id, s.timeline || s.previous);
    return timelines.size ? { timelines, committedThroughMs: Math.max(committedThroughMs, this.heardThroughMs) } : null;
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
