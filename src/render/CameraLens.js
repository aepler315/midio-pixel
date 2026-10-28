// A lens accent is a musical phrase, not a response to every frame's energy.
// Compile once from sections; sample heard time so pause, seek and export agree.
// Only a boundary the analysis trusts can punch the lens, by that trust; the
// Landscape score compiles these cues with its re-analysis handoff.
import { sectionTrust } from '../world/alpine/EffectsMusic.js';
import { boundaryLift01 } from '../world/WorldMusic.js';

const cache = new WeakMap();
const smooth = x => { const t = Math.max(0, Math.min(1, x)); return t * t * t * (t * (t * 6 - 15) + 10); };
const unit = x => Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
const roleOf = section => section?.role || section?.kind || null;
export const LENS_MIN_GAP_MS = 8000;
export const LENS_MIN_HALF_ANGLE_SCALE = .82;
// A cue's window: the anticipation before its boundary and the full release after.
export const LENS_ANTICIPATION_MS = 450;
export const LENS_RELEASE_MS = 2450;
export const NEUTRAL_LENS = Object.freeze({ halfAngleScale: 1, zoomPulse: 0, cueIndex: -1 });

/** Section trust, except that an inferred boundary keeps half a lens even
 * at confidence 0: without the self-similarity analysis every inferred
 * section has confidence 0, and the lens would never punch on those songs. */
export function lensTrust(section) {
  return Math.max(sectionTrust(section), section?.provenance === 'inferred' ? .5 : 0);
}

/** Frozen cues {timeMs, strength, index}, in time order. A loud chorus/drop
 * or a big rise selects a boundary; a returning part with no step in level
 * (chorus to chorus) is a continuation, not a turn. */
export function compileLensCues(sections, durationMs) {
  const duration = Number.isFinite(durationMs) ? durationMs : 0;
  const list = Array.isArray(sections)
    ? sections.filter(s => Number.isFinite(s?.startMs)).sort((a, b) => a.startMs - b.startMs) : [];
  const cues = [];
  let previousEnergy = .5;
  for (let i = 0; i < list.length; i++) {
    const section = list[i], prior = list[i - 1];
    const energy = unit(section.relEnergy01 ?? .5);
    const role = roleOf(section), trust = lensTrust(section);
    const meaningful = energy >= .65 && (['chorus', 'drop'].includes(role) || energy - previousEnergy >= .2);
    const repeat = role != null && role === roleOf(prior) && boundaryLift01(section, prior) === 0;
    if (meaningful && trust > 0 && !repeat && section.startMs >= 3000 && section.startMs < duration - 2500
        && section.startMs - (cues.at(-1)?.timeMs ?? -Infinity) >= LENS_MIN_GAP_MS) {
      cues.push(Object.freeze({ timeMs: section.startMs, strength: (.55 + .45 * energy) * trust, index: cues.length }));
    }
    previousEnergy = energy;
  }
  return Object.freeze(cues);
}

function cuesFor(sections, durationMs) {
  const saved = cache.get(sections);
  if (saved?.durationMs === durationMs) return saved.cues;
  const cues = compileLensCues(sections, durationMs);
  cache.set(sections, { durationMs, cues });
  return cues;
}

/** The lens at heard time from compiled cues. Allocates only inside a cue. */
export function lensFromCues(cues, timeMs, preview = false) {
  if (preview || !Array.isArray(cues) || !cues.length) return NEUTRAL_LENS;
  const cue = cues.find(c => timeMs >= c.timeMs - LENS_ANTICIPATION_MS && timeMs < c.timeMs + LENS_RELEASE_MS);
  if (!cue) return NEUTRAL_LENS;
  const age = timeMs - cue.timeMs;
  const envelope = age < 0 ? smooth((age + LENS_ANTICIPATION_MS) / LENS_ANTICIPATION_MS)
    : age <= 350 ? 1 : 1 - smooth((age - 350) / (LENS_RELEASE_MS - 350));
  const amount = cue.strength * envelope;
  if (!(amount > 0)) return NEUTRAL_LENS;
  return Object.freeze({ halfAngleScale: 1 - (1 - LENS_MIN_HALF_ANGLE_SCALE) * amount, zoomPulse: amount, cueIndex: cue.index });
}

/** Sections-only lens (no Landscape score): the same cue rule, no handoff. */
export function cameraLensAt({ sections = [], timeMs = 0, durationMs = 0, preview = false } = {}) {
  if (preview || !(durationMs > 0) || !Array.isArray(sections)) return NEUTRAL_LENS;
  return lensFromCues(cuesFor(sections, durationMs), timeMs);
}

export function applyLensFov(fovYDeg, effect = NEUTRAL_LENS) {
  const scale = Number.isFinite(effect?.halfAngleScale) ? Math.max(LENS_MIN_HALF_ANGLE_SCALE, Math.min(1, effect.halfAngleScale)) : 1;
  if (scale === 1) return fovYDeg;
  return Math.max(Math.min(12, fovYDeg), 2 * Math.atan(Math.tan(fovYDeg * Math.PI / 360) * scale) * 180 / Math.PI);
}
