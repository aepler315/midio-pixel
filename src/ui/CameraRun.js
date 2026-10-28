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

export function railPaceControlState({ experience = 'landscape', tourMode = null, policy = 'rail' } = {}) {
  if (experience === 'trio') return { disabled: true, text: 'Available in Landscape' };
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
  }

  reach(heardTimeMs) {
    if (Number.isFinite(heardTimeMs)) this.highWaterMs = Math.max(this.highWaterMs, heardTimeMs);
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
export function openCameraRun(previous, { data, seed, intent = 'fresh', requestedMultiplier = 3 } = {}) {
  if (intent !== 'fresh' && previous?.data === data && previous.seed === seed) {
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
