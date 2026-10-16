// Automatic track-role classification (spec §1.1.5): name heuristics first,
// statistical fallback second.
import { Role } from './NoteEvent.js';

const KEYWORDS = {
  [Role.RHYTHM]: /drum|perc|kick|snare|hat|cymbal|tom|rhythm|beat|808/i,
  [Role.BASS]: /bass|sub|low|contra/i,
  [Role.PAD]: /pad|string|choir|ambient|atmos|wash|synth str/i,
  [Role.MELODY]: /melody|lead|vox|vocal|solo|theme|arp|main/i,
};

function programHardRule(program) {
  if (program >= 32 && program <= 39) return Role.BASS;
  if ((program >= 48 && program <= 54) || (program >= 88 && program <= 95)) return Role.PAD;
  if (program >= 80 && program <= 87) return Role.MELODY;
  return null;
}

/** Stage A: name + GM-program scoring. Returns a role or null if ambiguous. */
function classifyByName(track, gmProgramName) {
  if (track.channel === 9) return Role.RHYTHM; // channel 10 (0-indexed 9) is always RHYTHM

  const text = `${track.name} ${track.instrumentName} ${gmProgramName(track.program)}`.toLowerCase();
  const scores = { [Role.RHYTHM]: 0, [Role.BASS]: 0, [Role.PAD]: 0, [Role.MELODY]: 0 };
  for (const role of Object.keys(scores)) {
    if (KEYWORDS[role].test(text)) scores[role] += 2;
  }
  const hard = track.program >= 0 ? programHardRule(track.program) : null;
  if (hard) scores[hard] += 2;

  let best = null, bestScore = 0;
  for (const role of Object.keys(scores)) {
    if (scores[role] > bestScore) { bestScore = scores[role]; best = role; }
  }
  return bestScore >= 2 ? best : null;
}

/** Stage B: statistical fallback for unnamed/ambiguous tracks (spec §1.1.5). */
function classifyByStatistics(notes, durationSec) {
  if (notes.length === 0) return Role.PAD;

  let sumPitch = 0;
  for (const n of notes) sumPitch += n.pitch;
  const meanPitch = sumPitch / notes.length;

  // Polyphony ratio: fraction of the track's duration where >=2 notes sound.
  const events = [];
  for (const n of notes) {
    events.push([n.startMs, 1]);
    events.push([n.startMs + n.durMs, -1]);
  }
  events.sort((a, b) => a[0] - b[0]);
  let poly = 0, lastT = 0, polyMs = 0;
  for (const [t, d] of events) {
    if (poly >= 2) polyMs += t - lastT;
    poly += d;
    lastT = t;
  }
  const polyRatio = durationSec > 0 ? polyMs / (durationSec * 1000) : 0;

  const density = durationSec > 0 ? notes.length / durationSec : 0;
  const durations = notes.map((n) => n.durMs).sort((a, b) => a - b);
  const medianDur = durations[Math.floor(durations.length / 2)];

  if (meanPitch < 48 && polyRatio < 0.15) return Role.BASS;
  if (density > 4.5 && medianDur < 140) return Role.RHYTHM;
  if (polyRatio > 0.55 && medianDur > 700) return Role.PAD;
  return Role.MELODY;
}

/**
 * Classify every track. Ensures exactly one MELODY track exists: if several
 * qualify, keeps the one with highest pitch-range x density, demotes rest to PAD.
 *
 * @param {Array<{track: object, notes: Array<{pitch:number,startMs:number,durMs:number,vel:number}>, durationSec:number}>} trackData
 * @param {(program:number)=>string} gmProgramName
 * @returns {Map<number, string>} track index -> Role
 */
export function classifyTracks(trackData, gmProgramName) {
  const roles = new Map();

  for (const { track, notes, durationSec } of trackData) {
    let role = classifyByName(track, gmProgramName);
    if (!role) role = classifyByStatistics(notes, durationSec);
    roles.set(track.index, role);
  }

  const melodyCandidates = trackData.filter((td) => roles.get(td.track.index) === Role.MELODY);
  if (melodyCandidates.length > 1) {
    let best = null, bestScore = -Infinity;
    for (const td of melodyCandidates) {
      if (td.notes.length === 0) continue;
      const pitches = td.notes.map((n) => n.pitch);
      const range = Math.max(...pitches) - Math.min(...pitches);
      const density = td.durationSec > 0 ? td.notes.length / td.durationSec : 0;
      const score = range * density;
      if (score > bestScore) { bestScore = score; best = td; }
    }
    for (const td of melodyCandidates) {
      if (td !== best) roles.set(td.track.index, Role.PAD);
    }
  }

  return roles;
}
