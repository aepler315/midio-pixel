// Scenic shot tours: the planning worker (docs/scenic-tours.md). Plans one
// song against a view's shot library and builds its timeline away from the
// render thread; ShotRuntime.prepareShotTimeline posts the request. A replan
// continues the committed timeline (`previous`) from where it is at the
// commit horizon (committedThroughMs plus a 3 s lead) and keeps every key
// up to there bit for bit; when it finds no feasible continuation it keeps
// the committed timeline whole ("Refinement deferred") rather than ship the
// planner's unchecked fallback.
import { planShotTour, restoreShotLibrary } from './ShotPlanner.js';
import { buildShotTimeline, shotContinuation, shotTimelineData } from './ShotTimeline.js';

export const SHOT_COMMIT_LEAD_MS = 3000;
const LANES = ['eye', 'target', 'fov', 'meta', 'progress', 'speed', 'accel'];

const reply = (timeline) => ({ message: { timeline }, transfer: [...new Set(LANES.map((k) => timeline[k]?.buffer).filter(Boolean))] });

/** One request -> { message: {timeline} | {error}, transfer } for postMessage. */
export function handleShotMessage(data) {
  try {
    const { sections = [], roles = [], energy = null, energyStepMs = 100, durationMs = 0, visible = null, seed = 0,
      committedThroughMs = 0, tunables = {} } = data || {};
    const library = restoreShotLibrary(data.library);
    // A committed timeline of another length belongs to another song.
    const previous = data.previous?.fov?.length && data.previous.durationMs === durationMs ? data.previous : null;
    const defer = (why) => reply({ ...previous, notes: [...(previous.notes || []), `Refinement deferred: ${why}`] });
    let start = null;
    if (previous) {
      start = shotContinuation(previous, committedThroughMs, { leadMs: SHOT_COMMIT_LEAD_MS });
      if (!start) return defer('nothing left to replan');
    }
    const plan = planShotTour(library, { durationMs, sections, roles, energy, energyStepMs, visible, seed, start, tunables });
    if (start && plan.fallback) return defer(plan.fallback);
    return reply(shotTimelineData(buildShotTimeline(library, plan, { previous, frozenThroughMs: start ? start.timeMs : -1, tunables })));
  } catch (error) {
    return { message: { error: error?.message || String(error) }, transfer: [] };
  }
}

// Only a real worker scope listens; importing this module elsewhere (tests,
// the main thread) touches nothing.
if (typeof globalThis.WorkerGlobalScope === 'function' && globalThis instanceof globalThis.WorkerGlobalScope) {
  self.onmessage = (e) => { const { message, transfer } = handleShotMessage(e.data); self.postMessage(message, transfer); };
}
