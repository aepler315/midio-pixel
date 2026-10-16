// A lens accent is a musical phrase, not a response to every frame's energy.
// Compile once from sections; sample heard time so pause, seek and export agree.
const cache = new WeakMap();
const smooth = x => { const t = Math.max(0, Math.min(1, x)); return t * t * t * (t * (t * 6 - 15) + 10); };
export const LENS_MIN_GAP_MS = 8000;
export const LENS_MIN_HALF_ANGLE_SCALE = .82;
const NEUTRAL = Object.freeze({ halfAngleScale: 1, zoomPulse: 0 });
function cuesFor(sections, durationMs) {
  const saved = cache.get(sections);
  if (saved?.durationMs === durationMs) return saved.cues;
  const cues = [];
  let previousEnergy = .5;
  for (const section of [...sections].sort((a, b) => a.startMs - b.startMs)) {
    const energy = Math.max(0, Math.min(1, section.relEnergy01 ?? .5));
    const role = section.role || section.kind;
    const meaningful = energy >= .65 && (['chorus', 'drop'].includes(role) || energy - previousEnergy >= .2);
    if (meaningful && section.startMs >= 3000 && section.startMs < durationMs - 2500
        && section.startMs - (cues.at(-1)?.timeMs ?? -Infinity) >= LENS_MIN_GAP_MS) {
      cues.push({ timeMs: section.startMs, strength: .55 + .45 * energy });
    }
    previousEnergy = energy;
  }
  cache.set(sections, { durationMs, cues });
  return cues;
}
export function cameraLensAt({ sections = [], timeMs = 0, durationMs = 0, reducedMotion = false, preview = false } = {}) {
  if (reducedMotion || preview || !(durationMs > 0) || !Array.isArray(sections)) return NEUTRAL;
  const cue = cuesFor(sections, durationMs).find(c => timeMs >= c.timeMs - 450 && timeMs < c.timeMs + 2450);
  if (!cue) return NEUTRAL;
  const age = timeMs - cue.timeMs;
  const envelope = age < 0 ? smooth((age + 450) / 450) : age <= 350 ? 1 : 1 - smooth((age - 350) / 2100);
  const amount = cue.strength * envelope;
  return { halfAngleScale: 1 - (1 - LENS_MIN_HALF_ANGLE_SCALE) * amount, zoomPulse: amount };
}
export function applyLensFov(fovYDeg, effect = NEUTRAL) {
  const scale = Number.isFinite(effect?.halfAngleScale) ? Math.max(LENS_MIN_HALF_ANGLE_SCALE, Math.min(1, effect.halfAngleScale)) : 1;
  if (scale === 1) return fovYDeg;
  return Math.max(Math.min(12, fovYDeg), 2 * Math.atan(Math.tan(fovYDeg * Math.PI / 360) * scale) * 180 / Math.PI);
}
