// Scenic shot tours: the main-thread side of planning (docs/scenic-tours.md),
// like TourRuntime for the Teton tour. Section roles and the energy curve
// (every 100 ms) are read here from the song; the plan and timeline are built
// in shot-worker.js, and the result comes back as a timeline with poseAt().
// Nothing is transferred out of this thread: playback keeps using the
// library and the committed timeline while the worker plans.
import { sectionRoles } from './SectionRoles.js';
import { shotPlanningTables } from './ShotPlanner.js';
import { restoreShotTimeline, shotTimelineData } from './ShotTimeline.js';

export const SHOT_ENERGY_STEP_MS = 100;

/** A decoded library without its lookup Maps (the worker rebuilds them). */
export function cloneableShotLibrary(library) {
  return Object.fromEntries(Object.entries(library).filter(([, v]) => !(v instanceof Map)));
}

const planningTables = new WeakMap();
/** What a request posts: the cloneable library with its planning tables,
 *  computed once per decoded library on this thread, so that no request's
 *  fresh copy measures its links again (ShotPlanner.shotPlanningTables). */
export function plannableShotLibrary(library) {
  let tables = planningTables.get(library);
  if (!tables) planningTables.set(library, tables = shotPlanningTables(library));
  return { ...cloneableShotLibrary(library), planningTables: tables };
}

/** The worker request for one song: everything structured-cloneable. */
export function shotPlanRequest(library, mgr, { visible = null, previous = null, committedThroughMs = 0, seed = 0, tunables = {} } = {}) {
  const sections = mgr?.sections || [], durationMs = mgr?.durationMs || 0, curves = mgr?.energyCurves;
  const energy = new Float32Array(Math.ceil(durationMs / SHOT_ENERGY_STEP_MS) + 1);
  for (let i = 0; i < energy.length; i++) {
    const v = typeof curves?.globalEnergy === 'function' ? curves.globalEnergy(i * SHOT_ENERGY_STEP_MS) : .5;
    energy[i] = Number.isFinite(v) ? v : 0;
  }
  const roles = sectionRoles({ sections, durationMs, energyCurves: curves, conductorSchedule: mgr?.conductorSchedule || [], noteEvents: mgr?.conductor?.timeline || [] });
  return { library: plannableShotLibrary(library), sections, roles, energy, energyStepMs: SHOT_ENERGY_STEP_MS, durationMs,
    visible: visible || [{ startMs: 0, endMs: durationMs }], seed, previous: previous ? shotTimelineData(previous) : null, committedThroughMs, tunables };
}

/** Plan and build a song's shot timeline in a module worker. Resolves with
 *  the restored timeline; rejects on failure or abort (which terminates). */
export function prepareShotTimeline(library, mgr, { signal = null, ...options } = {}) {
  let request;
  try { request = shotPlanRequest(library, mgr, options); } catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Shot planning aborted', 'AbortError')); return; }
    const worker = new Worker(new URL('./shot-worker.js', import.meta.url), { type: 'module' });
    const finish = () => { signal?.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { finish(); reject(new DOMException('Shot planning aborted', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (e) => { finish(); if (e.data?.error) reject(new Error(e.data.error)); else resolve(restoreShotTimeline(e.data.timeline)); };
    worker.onerror = (e) => { finish(); reject(new Error(e.message || 'Shot worker failed')); };
    worker.postMessage(request);
  });
}
