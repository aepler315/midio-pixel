// Camera Studio is sampled in heard song time. No render delta, wall clock,
// mutable spring integrator or playback history enters a shot.
import { cameraBasis } from '../terrain/SceneTravel.js';
import { LAND_MAX_DISPLACEMENT_M } from './LandMotionLimits.js';

import { CAMERA_STUDIO_FIELDS, CAMERA_STUDIO_DEFAULTS, normalizeValue } from '../../config/settingsRegistry.js';
export { CAMERA_STUDIO_PRESETS, CAMERA_STUDIO_DEFAULTS } from '../../config/settingsRegistry.js';

const normalized = new WeakSet([CAMERA_STUDIO_DEFAULTS]);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = u => u * u * u * (u * (u * 6 - 15) + 10);
const DEG = Math.PI / 180;

/** Only known, finite settings survive storage or an export snapshot. */
export function normalizeCameraStudioSettings(raw = null) {
  if (!raw || typeof raw !== 'object') return CAMERA_STUDIO_DEFAULTS;
  if (raw && typeof raw === 'object' && normalized.has(raw)) return raw;
  const source = raw && typeof raw === 'object' ? raw : {};
  const result = Object.fromEntries(CAMERA_STUDIO_FIELDS.map(def =>
    [def.field, normalizeValue(def, source[def.field]) ?? def.default]));
  Object.freeze(result);
  normalized.add(result);
  return result;
}

/** Closed-form underdamped step, with a short terminal settle to an exact
 * hold. Overshoot zero selects a monotone ease with zero endpoint velocity. */
export function cameraStudioSpring(progress, overshoot = .15) {
  const u = clamp(progress, 0, 1);
  if (u === 0 || u === 1) return u;
  if (!(overshoot > 0)) return smooth(u);
  const log = -Math.log(clamp(overshoot, .001, .5));
  const damping = log / Math.hypot(Math.PI, log), omega = 14;
  const root = Math.sqrt(1 - damping * damping), w = omega * root;
  const response = 1 - Math.exp(-damping * omega * u) * (Math.cos(w * u) + damping / root * Math.sin(w * u));
  return mix(response, 1, smooth(clamp((u - .8) / .2, 0, 1)));
}

function motionAt(settings, timeMs) {
  const elapsed = Math.max(0, (Number(timeMs) || 0) / 1000 - settings.delaySec);
  const span = settings.durationSec + settings.holdSec;
  const leg = Math.floor(elapsed / span);
  const u = cameraStudioSpring(Math.min(1, (elapsed - leg * span) / settings.durationSec), settings.overshoot);
  const signed = settings.direction === 'cw' ? 1 : -1;
  const swing = leg % 2 ? 1 - u : u;
  if (settings.preset === 'orbit') return { yaw: signed * 15 * DEG * Math.sin((leg + u) * settings.durationSec / settings.orbitSeconds * Math.PI * 2), radius: 1 };
  if (settings.preset === 'sweep') return { yaw: signed * swing * 15 * DEG, radius: 1 };
  if (settings.preset === 'push') return { yaw: 0, radius: 1 - swing * .28 };
  return { yaw: 0, radius: 1 };
}

export function cameraStudioStatus(settings, { fullCoverage = false, pose = null, detailLimited = false,
  budgetFallback = false, maxErrorPx = null, summitMaxErrorPx = null } = {}) {
  const s = normalizeCameraStudioSettings(settings);
  const effectiveDistanceMax = fullCoverage ? 1.8 : 1;
  const effectiveFovMaxDeg = fullCoverage ? 70 : Math.min(70, Number.isFinite(pose?.fovYDeg) ? pose.fovYDeg : 70);
  return Object.freeze({ enabled: s.enabled, preset: s.preset,
    capability: !s.enabled ? 'off' : fullCoverage ? 'full' : 'crop',
    positionEnabled: s.enabled && fullCoverage,
    effectiveDistanceMax, effectiveFovMaxDeg,
    effectiveDistance: Math.min(s.distance, effectiveDistanceMax), effectiveFovDeg: Math.min(s.fovDeg, effectiveFovMaxDeg),
    detailLimited, budgetFallback, maxErrorPx, summitMaxErrorPx,
    reason: !s.enabled ? 'Camera Studio is off.' : budgetFallback
      ? 'Requested camera exceeds the terrain budget; using safe framing. Adjust the camera to try another view.' : fullCoverage
      ? `Full camera movement around the range center.${detailLimited ? ' Terrain detail is reduced to keep this view within the graphics budget.' : ''}`
      : `This authored view supports inward crops up to 1× distance and a ${Math.round(effectiveFovMaxDeg * 10) / 10}° lens. Orbit, position and focus need a full-coverage terrain tour.` });
}

const floorAt = (heightAt, waterLevelM, x, z) => {
  const ground = heightAt?.(x, z), water = Number.isFinite(waterLevelM) ? waterLevelM : -Infinity;
  return Math.max(Number.isFinite(ground) ? ground : -Infinity, water);
};
const clearanceFor = pose => Math.max(250, Math.hypot(...pose.eyeM.map((v, i) => v - pose.targetM[i])) * .01)
  + LAND_MAX_DISPLACEMENT_M + 50;

/** Apply a Studio shot. A pruned package can change only its projection:
 * retaining its eye and aim prevents revealing occluded, omitted terrain. */
export function applyCameraStudio(pose, settings, { timeMs = 0, referencePose = pose, fullCoverage = false,
  heightAt = null, waterLevelM = null } = {}) {
  const s = normalizeCameraStudioSettings(settings), status = cameraStudioStatus(s, { fullCoverage, pose });
  if (!s.enabled) return { pose, status };
  if (!fullCoverage) {
    const fov = Math.min(pose.fovYDeg, s.fovDeg);
    const fovYDeg = 2 * Math.atan(Math.tan(fov * DEG / 2) * Math.min(1, s.distance)) / DEG;
    return { pose: { ...pose, fovYDeg }, status };
  }
  const ref = s.preset === 'rail' ? pose : referencePose;
  const delta = ref.eyeM.map((v, i) => v - ref.targetM[i]);
  const radius = Math.max(10, Math.hypot(...delta));
  const motion = motionAt(s, timeMs);
  const yaw = Math.atan2(delta[0], delta[2]) - (s.azimuthDeg * DEG + motion.yaw);
  const pitch = clamp(Math.asin(clamp(delta[1] / radius, -1, 1)) + s.elevation * DEG, -40 * DEG, 75 * DEG);
  const distance = radius * s.distance * motion.radius;
  const targetM = ref.targetM.map((v, i) => v + [s.focusX, s.focusY, s.focusZ][i] * radius);
  const eyeM = [targetM[0] + Math.sin(yaw) * Math.cos(pitch) * distance,
    targetM[1] + Math.sin(pitch) * distance, targetM[2] + Math.cos(yaw) * Math.cos(pitch) * distance];
  const result = { ...pose, eyeM, targetM, fovYDeg: s.fovDeg };
  eyeM[1] = Math.max(eyeM[1], floorAt(heightAt, waterLevelM, eyeM[0], eyeM[2]) + clearanceFor(result));
  return { pose: result, status };
}

/** A canonical 100ms pose lattice shared by render, terrain planning and
 * forest placement. Each station clears both adjoining eye segments, so
 * interpolation cannot cut under the sampled terrain between stations. */
export function cameraStudioTour(tour, settings, { referencePose = tour.poseAt(tour.durationMs / 2),
  heightAt = null, waterLevelM = null, sampleStepM = 30 } = {}) {
  const s = normalizeCameraStudioSettings(settings);
  if (!s.enabled) return tour;
  const durationMs = Math.max(0, tour.durationMs || 0), cache = new Map();
  const rawAt = timeMs => applyCameraStudio(tour.poseAt(timeMs), s,
    { timeMs, referencePose, fullCoverage: true, heightAt, waterLevelM }).pose;
  const stationAt = timeMs => {
    if (cache.has(timeMs)) return cache.get(timeMs);
    const pose = rawAt(timeMs), clearance = clearanceFor(pose);
    for (const otherMs of [Math.max(0, timeMs - 100), Math.min(durationMs, timeMs + 100)]) {
      const other = rawAt(otherMs), length = Math.hypot(pose.eyeM[0] - other.eyeM[0], pose.eyeM[2] - other.eyeM[2]);
      const steps = Math.min(4096, Math.max(1, Math.ceil(length / Math.max(1, sampleStepM / 2))));
      for (let i = 0; i <= steps; i++) {
        const u = i / steps, x = mix(pose.eyeM[0], other.eyeM[0], u), z = mix(pose.eyeM[2], other.eyeM[2], u);
        pose.eyeM[1] = Math.max(pose.eyeM[1], floorAt(heightAt, waterLevelM, x, z) + clearance);
      }
    }
    if (cache.size >= 256) cache.delete(cache.keys().next().value);
    cache.set(timeMs, pose);
    return pose;
  };
  return { ...tour, durationMs, studioSettings: s, poseAt(timeMs) {
    const t = clamp(Number(timeMs) || 0, 0, durationMs), lo = Math.floor(t / 100) * 100, hi = Math.min(durationMs, lo + 100);
    const a = stationAt(lo), b = stationAt(hi), u = hi > lo ? (t - lo) / (hi - lo) : 0;
    const result = { ...a, eyeM: a.eyeM.map((v, i) => mix(v, b.eyeM[i], u)),
      targetM: a.targetM.map((v, i) => mix(v, b.targetM[i], u)), fovYDeg: mix(a.fovYDeg, b.fovYDeg, u), tour: true };
    // A valid world-up basis also guards against a malformed caller pose.
    if (!cameraBasis(result).right.every(Number.isFinite)) return { ...a, eyeM: [...a.eyeM], targetM: [...a.targetM], tour: true };
    return result;
  } };
}
