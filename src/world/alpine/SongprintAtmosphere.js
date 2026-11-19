import { clamp01, smoothstep } from '../../utils/math.js';

const GATHER_MS = 3000;
const RELEASE_MS = 5000;
const MIN_CONFIDENCE = .43;
const MAX_RETURNS = 3;
const VALLEY_SEARCH_M = 3500;
const valleyAreas = new WeakMap();

/** A peak is the address of the phrase. The actual mist responds near the
 * closest strong, low drainage cell in the prepared view's flow field. */
export function songprintMistArea(field, pointM) {
  if (!field || !pointM) return null;
  let landmarks = valleyAreas.get(field);
  if (!landmarks) {
    landmarks = new WeakMap();
    valleyAreas.set(field, landmarks);
  }
  if (landmarks.has(pointM)) return landmarks.get(pointM);
  const { width, height, originM, extentM, texture } = field;
  const [peakX, , peakZ] = pointM;
  const dx = extentM[0] / (width - 1), dz = extentM[1] / (height - 1);
  const gx = (peakX - originM[0]) / dx, gz = (peakZ - originM[1]) / dz;
  const xMin = Math.max(0, Math.ceil(gx - VALLEY_SEARCH_M / dx));
  const xMax = Math.min(width - 1, Math.floor(gx + VALLEY_SEARCH_M / dx));
  const zMin = Math.max(0, Math.ceil(gz - VALLEY_SEARCH_M / dz));
  const zMax = Math.min(height - 1, Math.floor(gz + VALLEY_SEARCH_M / dz));
  let best = 0, area = null;
  for (let z = zMin; z <= zMax; z++) {
    for (let x = xMin; x <= xMax; x++) {
      const cell = (z * width + x) * 4;
      const affinity = texture[cell + 1] / 255;
      if (texture[cell + 3] !== 255 || affinity < .42) continue;
      const distance2 = ((x - gx) * dx) ** 2 + ((z - gz) * dz) ** 2;
      const score = affinity * (1 - distance2 / VALLEY_SEARCH_M ** 2);
      if (score <= best) continue;
      best = score;
      area = [originM[0] + x * dx, originM[1] + z * dz, Math.max(1350, Math.min(2250, 5 * Math.max(dx, dz)))];
    }
  }
  landmarks.set(pointM, area ? Object.freeze(area) : null);
  return landmarks.get(pointM);
}

function phraseDynamics(read, curves, timeMs) {
  let sum = 0, peak = 0, power = 0, rmsSamples = 0;
  const bands = typeof curves?.sampleRms === 'function' ? curves.rmsBands?.length ?? 0 : 0;
  for (let dt = -3000; dt <= 2000; dt += 1000) {
    const energy = clamp01(read(timeMs + dt));
    sum += energy;
    peak = Math.max(peak, energy);
    if (energy > .05) {
      for (let band = 0; band < bands; band++) {
        power += (curves.sampleRms(band, timeMs + dt) || 0) ** 2;
        rmsSamples++;
      }
    }
  }
  if (bands && power / Math.max(1, rmsSamples) < .000009) return 0;
  return smoothstep(.08, .65, sum / 6) * .75 + smoothstep(.15, .9, peak) * .25;
}

/** One recurring phrase family owns the gesture. Whole-song replans keep
 * every flourish that has already started, then use its original family
 * only if the identified occurrences still agree. */
export function compileSongprintWeather(phraseFamilies, {
  read, curves, admittedMs, throughMs, previous = [], committedThroughMs = -1,
}) {
  const held = previous.filter(gesture => gesture.startMs <= committedThroughMs);
  const intervals = phraseFamilies?.version === 1 ? phraseFamilies.families : null;
  if (!intervals?.length || held.length >= MAX_RETURNS) return Object.freeze(held);
  const lastHeldMs = held.at(-1)?.endMs ?? -Infinity;
  const afterMs = Math.max(8000, admittedMs, committedThroughMs, lastHeldMs);
  let best = [], bestSupport = -Infinity;
  for (const [familyIndex, family] of intervals.entries()) {
    const first = family.occurrences[0];
    if (!first || (held.length && held[0].firstMs !== first.timeMs)) continue;
    const fresh = [];
    let confidence = first.strength;
    for (const occurrence of family.occurrences.slice(1)) {
      const { timeMs, strength } = occurrence;
      const startMs = timeMs - GATHER_MS, endMs = timeMs + RELEASE_MS;
      if (startMs < afterMs || endMs > throughMs || strength < MIN_CONFIDENCE) continue;
      if (fresh.length && startMs < fresh.at(-1).endMs + 4000) continue;
      const dynamics = phraseDynamics(read, curves, timeMs);
      if (dynamics < .08) continue;
      const intensity = (.25 + .75 * dynamics) * (.65 + .35 * strength);
      fresh.push(Object.freeze({ familyIndex, landmark01: family.landmark01, firstMs: first.timeMs, timeMs, startMs, endMs, intensity }));
      confidence += strength;
      if (fresh.length + held.length === MAX_RETURNS) break;
    }
    if (!fresh.length) continue;
    // Several returns establish a pattern. Break ties by the strength of
    // matches and prefer a listener hearing that evidence closer together.
    const spanMs = fresh.at(-1).timeMs - first.timeMs;
    const support = confidence / Math.sqrt(1 + spanMs / 60000);
    if (fresh.length > best.length || fresh.length === best.length && support > bestSupport) {
      best = fresh;
      bestSupport = support;
    }
  }
  return Object.freeze([...held, ...best]);
}

/** Sample on the heard clock. Wind phase and direction remain world-owned. */
export function songprintWeatherAt(gestures, timeMs) {
  const cue = gestures.find(gesture => timeMs > gesture.startMs && timeMs < gesture.endMs);
  if (!cue) return null;
  const envelope = smoothstep(cue.startMs, cue.timeMs, timeMs) * (1 - smoothstep(cue.timeMs, cue.endMs, timeMs));
  const amount = cue.intensity * envelope;
  return Object.freeze({
    familyIndex: cue.familyIndex,
    landmark01: cue.landmark01,
    timeMs: cue.timeMs,
    mistDensityMul: 1 - .38 * amount,
    windGust01: .7 * amount,
  });
}
