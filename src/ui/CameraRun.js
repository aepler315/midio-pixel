import { normalizeRailPace, sceneRailPlanFromSnapshot, withSceneRailPace } from '../world/terrain/SceneRailPlan.js';

/** URL presence is authoritative, even when its value is invalid. */
export function readRailPace(search = '', storage = null) {
  const params = new URLSearchParams(search);
  if (params.has('rangePace')) return normalizeRailPace(params.get('rangePace'));
  try { return normalizeRailPace(storage?.getItem('range-pace')); }
  catch { return 3; }
}

export function persistRailPace(value, { href, storage = null, replace = () => {} } = {}) {
  const pace = normalizeRailPace(value);
  try { storage?.setItem('range-pace', String(pace)); } catch { /* Private/blocked storage. */ }
  const url = new URL(href);
  url.searchParams.set('rangePace', String(pace));
  replace(url);
  return url;
}

export function railPaceControlState({ tourMode = null, policy = 'rail' } = {}) {
  if (tourMode || policy === 'tour') return { disabled: false, text: 'Camera tours use music timing. Pace is saved for ordinary landscapes or replay.' };
  if (policy === 'glacier') return { disabled: false, text: 'Glacier uses its authored timing. Pace is saved for ordinary landscapes or replay.' };
  return { disabled: false, text: 'Applies to the next unplayed landscape or replay.' };
}

/** Lives outside the disposable Simulation. Schedules are immutable; only the
 * owner's pointer and maximum reached heard time change. World keys prevent
 * an incompatible world's camera choices leaking into a later rebuild. */
export class CameraRun {
  constructor({ data, seed, requestedMultiplier = 3 } = {}) {
    this.data = data;
    this.seed = seed;
    this.requestedMultiplier = normalizeRailPace(requestedMultiplier);
    this.highWaterMs = 0;
    this.schedules = new Map();
    this.refinePending = new Set();
    this.tours = new Map();
    this.railKept = new Map();
  }

  reach(heardTimeMs) {
    if (Number.isFinite(heardTimeMs)) this.highWaterMs = Math.max(this.highWaterMs, heardTimeMs);
  }

  /** Shot-tour timelines and camera choices die with each rebuild's
   *  presentation state, so the run keeps them for the next seek, by view:
   *  the heard timelines, and the views the gate kept on their rail (a fresh
   *  plan after a seek must not swap that rail for a tour mid-song). */
  retainTours(continuation) {
    for (const [viewId, timeline] of continuation?.timelines || []) { this.tours.set(viewId, timeline); this.railKept.delete(viewId); }
    for (const [viewId, reason] of continuation?.railKept || []) { this.railKept.set(viewId, reason); this.tours.delete(viewId); }
  }

  /** A listener's tour-mode change starts the tours and choices over. */
  forgetTours() { this.tours.clear(); this.railKept.clear(); }

  tourContinuation() {
    if (!this.tours.size && !this.railKept.size) return null;
    return { timelines: new Map(this.tours), railKept: new Map(this.railKept), committedThroughMs: this.highWaterMs };
  }

  scheduleFor(worldId) { return this.schedules.get(worldId) || null; }

  install(worldId, snapshot) {
    if (!snapshot) return null;
    const frozen = sceneRailPlanFromSnapshot(snapshot).snapshot;
    this.schedules.set(worldId, frozen);
    this.refinePending.delete(worldId);
    if (this.data) this.data.cameraSchedule = frozen;
    return frozen;
  }

  setPace(value, worldId) {
    this.requestedMultiplier = normalizeRailPace(value);
    for (const [key, previous] of this.schedules) {
      this.schedules.set(key, withSceneRailPace(sceneRailPlanFromSnapshot(previous), this.requestedMultiplier, this.highWaterMs).snapshot);
    }
    const current = this.scheduleFor(worldId);
    if (current && this.data) this.data.cameraSchedule = current;
    return current;
  }
}

/** Explicit intent distinguishes seek(0) from same-seed Replay. */
export function openCameraRun(previous, { data, seed, intent = 'fresh', requestedMultiplier = 3, tours = null } = {}) {
  if (intent !== 'fresh' && previous?.data === data && previous.seed === seed) {
    previous.retainTours(tours);
    if (intent === 'adopt') for (const key of previous.schedules.keys()) previous.refinePending.add(key);
    return previous;
  }
  if (data) delete data.cameraSchedule;
  return new CameraRun({ data, seed, requestedMultiplier });
}

/** Exports supply an immutable override; live rebuilds restore or refine the
 * run's matching world without relying on disposable presentation state. */
export function cameraSongOptions(run, worldId, intent, override = undefined) {
  const cameraSchedule = override !== undefined ? override : run?.scheduleFor(worldId) || null;
  return {
    cameraSchedule,
    requestedMultiplier: run?.requestedMultiplier ?? 3,
    cameraRefineThroughMs: override === undefined && cameraSchedule && (intent === 'adopt' || run?.refinePending.has(worldId)) ? run.highWaterMs : null,
  };
}
