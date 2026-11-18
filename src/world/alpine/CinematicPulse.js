// One bounded musical-turn envelope shared by the camera and by landscape
// construction. Compiled once from the same trusted sections as the score,
// sampled only at heard time. Nothing here integrates a render delta, reads
// the wall clock or keeps mutable state between samples, so pause, seek,
// replay, re-analysis and fixed-clock export all see the same pulse.
//
// The point is to stop a song from reading as one constant-speed dolly over a
// mountain that grows at one constant rate: quiet passages keep their pace,
// trusted drops and chorus entries push the build and the framing forward,
// and the accents alternate side so successive turns are not repetitive.
import { sectionTrust } from './EffectsMusic.js';

/** Two turns closer than this collapse into one, so the camera never
 *  stutters between competing accents. */
export const PULSE_MIN_GAP_MS = 6000;
/** Anticipation before a turn, exact hold at the turn, and release after it. */
export const PULSE_LEAD_MS = 900;
export const PULSE_HOLD_MS = 700;
export const PULSE_RELEASE_MS = 2200;
/** Quiet passages keep the normal rate; only trusted turns push past it. */
export const PULSE_QUIET_FLOOR = 1;
/** Largest gain a turn may apply to the construction pace. */
export const PULSE_PEAK = 1.6;
const ENERGY_TURN = 0.15;
const READY_MS = 3000;
const TAIL_MS = 2500;

const NEUTRAL = Object.freeze({ pace01: 1, accent01: 0, sign: 1, cueIndex: -1 });
const unit = (value) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const smooth = (u) => { const t = unit(u); return t * t * t * (t * (t * 6 - 15) + 10); };
const begins = (cue) => cue.timeMs - PULSE_LEAD_MS;

/** The envelope of one cue: 0 outside [timeMs - lead, timeMs + hold +
 *  release], a smooth approach, a short exact hold, and a smooth release. */
export function pulseEnvelopeAt(cue, timeMs) {
  const age = timeMs - cue.timeMs;
  if (age < -PULSE_LEAD_MS || age >= PULSE_HOLD_MS + PULSE_RELEASE_MS) return 0;
  if (age < 0) return smooth((age + PULSE_LEAD_MS) / PULSE_LEAD_MS);
  if (age <= PULSE_HOLD_MS) return 1;
  return 1 - smooth((age - PULSE_HOLD_MS) / PULSE_RELEASE_MS);
}

function cuesFrom(sections, read, durationMs, throughMs) {
  const raw = [];
  let priorEnergy = 0.5;
  for (const section of Array.isArray(sections) ? sections : []) {
    if (!(sectionTrust(section) > 0)) continue;
    const startMs = section.startMs;
    if (!(startMs >= READY_MS && startMs < throughMs - TAIL_MS)) continue;
    const energy = unit(section.relEnergy01 ?? (read ? read(startMs) : 0.5));
    const role = section.role || section.kind || section.motifId || null;
    const turn = Math.abs(energy - priorEnergy) >= ENERGY_TURN;
    const arrival = energy >= 0.65 && ['chorus', 'drop'].includes(String(role).toLowerCase());
    if (turn || arrival) raw.push({ timeMs: startMs, strength: 0.55 + 0.45 * energy });
    priorEnergy = energy;
  }
  const spaced = [];
  for (const cue of raw) {
    if (!spaced.length || cue.timeMs - spaced.at(-1).timeMs >= PULSE_MIN_GAP_MS) spaced.push(cue);
  }
  return spaced;
}

/**
 * Compile the pulse for one song. `previous` is an earlier compile's pulse;
 * cues that already began at `freezeThroughMs` keep their identity and side,
 * so a whole-song analysis cannot flip an accent the listener has heard.
 * `throughMs` keeps future accents out of the closing camera move.
 * Returns a frozen { cues, at(timeMs), paceAt(timeMs) }.
 */
export function compileCinematicPulse({ sections = [], read = null, durationMs = 0,
  throughMs = durationMs, previous = null, freezeThroughMs = -1 } = {}) {
  const duration = Math.max(0, Number(durationMs) || 0);
  const through = Math.min(duration, Number.isFinite(throughMs) ? throughMs : duration);
  const fresh = duration > 0 ? cuesFrom(sections, read, duration, through) : [];
  let cues;
  if (previous && freezeThroughMs >= 0) {
    const held = (Array.isArray(previous.cues) ? previous.cues : [])
      .filter((cue) => begins(cue) <= freezeThroughMs)
      .map((cue) => Object.freeze({ ...cue }));
    const last = held.at(-1);
    const added = fresh
      .filter((cue) => begins(cue) > freezeThroughMs && (!last || cue.timeMs - last.timeMs >= PULSE_MIN_GAP_MS))
      .map((cue, i) => Object.freeze({ ...cue, index: held.length + i, sign: (held.length + i) % 2 ? -1 : 1 }));
    cues = [...held, ...added];
  } else {
    cues = fresh.map((cue, i) => Object.freeze({ ...cue, index: i, sign: i % 2 ? -1 : 1 }));
  }
  cues = Object.freeze(cues);

  const at = (timeMs) => {
    if (!cues.length || !(duration > 0)) return NEUTRAL;
    const t = Math.max(0, Number(timeMs) || 0);
    let active = null, env = 0;
    for (const cue of cues) {
      if (t < begins(cue)) break;
      const e = pulseEnvelopeAt(cue, t);
      if (e > 0) { active = cue; env = e; }
    }
    const energy = unit(read ? read(Math.min(duration, t)) : 0.5);
    const quiet = PULSE_QUIET_FLOOR + (1 - PULSE_QUIET_FLOOR) * energy;
    if (!active) return Object.freeze({ pace01: quiet, accent01: 0, sign: 1, cueIndex: -1 });
    const gain = Math.min(PULSE_PEAK, quiet + (PULSE_PEAK - quiet) * active.strength * env);
    return Object.freeze({
      pace01: Math.max(PULSE_QUIET_FLOOR, Math.min(PULSE_PEAK, gain)),
      accent01: active.strength * env,
      sign: active.sign,
      cueIndex: active.index ?? -1,
    });
  };
  return Object.freeze({ cues, at, paceAt: (timeMs) => at(timeMs).pace01 });
}
