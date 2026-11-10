// Casting: which musical line a note belongs to. Three lanes, whose ids
// keep the names of the characters that once performed them:
//
//   MIDASUS  <- clean melodies (piano, clean electric, acoustic, mallets,
//               harp).
//   BROSHI   <- the bass.
//   MIDIO    <- lead melodies that are NOT clean (synth leads, driven
//               guitars, horns, whistles).
//
// Sources of truth, in order: explicit instrument text (stem FILENAMES),
// then the tracked melody's spectrum, then role. Lanes are stamped on
// timeline events as `lane`; roles and every director keep reading `role`
// exactly as before.
import { Role } from './NoteEvent.js';

export const Lane = Object.freeze({
  MIDASUS: 'MIDASUS',
  MIDIO: 'MIDIO',
  BROSHI: 'BROSHI',
});

// Keyword families for instrument text. Order matters below: kit first
// (a "Kick" track must never read as anything melodic), bass second, then
// clean BEFORE lead -- "Clean Lead Gtr" is a clean sound and belongs to
// Midasus per the casting rule, so clean wins ties.
const KIT_RE = /\bdrum|perc|kick|snare|hi-?hat|\bhat\b|cymbal|\btom\b|clap|shaker|tambourine|\bkit\b|beat\b/i;
const BASS_RE = /bass|\bsub\b|808(?!\s*(crash|cymbal|tom))|low\s*end|contra/i;
const CLEAN_RE = /piano|keys\b|rhodes|wurli|e[.\s-]?piano|clean|acoustic|nylon|steel\s*(str|gtr|guitar)|classical\s*g|harp\b|vibraphone|vibes\b|marimba|glocken|celest|kalimba|music\s*box|bell\b|mallet/i;
const LEAD_RE = /lead|solo\b|\bsaw\b|square\b|synth(?!\s*(str|pad))|distort|overdri|drive\s*g|fuzz|shred|scream|\bsax|trumpet|trombone|horn\b|brass|flute|whistle|recorder|ocarina|vox\b|vocal|voice|arp\b|pluck/i;
const PAD_RE = /\bpad\b|string(s|\s*ens)|ensemble|choir|ambient|atmos|wash|drone|texture/i;

/**
 * Classify free instrument text (a stem FILENAME) into a sound family. Returns 'kit'|'bass'|'clean'|'lead'|'pad'
 * or null when the text says nothing usable.
 */
export function classifyInstrumentText(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  if (KIT_RE.test(t)) return 'kit';
  if (BASS_RE.test(t)) return 'bass';
  if (CLEAN_RE.test(t)) return 'clean';
  if (LEAD_RE.test(t)) return 'lead';
  if (PAD_RE.test(t)) return 'pad';
  return null;
}

/** A sound family -> its lane (or null: kit and pads have none). */
export function laneForFamily(family) {
  switch (family) {
    case 'clean': return Lane.MIDASUS;
    case 'bass': return Lane.BROSHI;
    case 'lead': return Lane.MIDIO;
    default: return null; // kit and pad drive the world, not a lane
  }
}

/**
 * The audio path's clean/lead split for a single tracked melody note: no
 * names exist inside one mixed file, but the spectrum says what the
 * instrument is. `brightness01` is the frame's log-frequency centroid
 * (PitchTracker, 0..1 across 50 Hz..8 kHz); a fundamental at `pitchMidi`
 * sits at a known position on that same axis, so the EXCESS of centroid
 * over fundamental measures how harmonically rich the tone is. Clean
 * instruments (piano, acoustic) keep their centroid near the fundamental;
 * saws, driven guitars, and horns throw it far above.
 */
export const LEAD_BRIGHTNESS_EXCESS = 0.16;

export function melodyLaneForNote(pitchMidi, brightness01) {
  if (!Number.isFinite(brightness01)) return Lane.MIDASUS;
  const hz = 440 * Math.pow(2, (pitchMidi - 69) / 12);
  const pos01 = Math.max(0, Math.min(1, Math.log(Math.max(50, hz) / 50) / Math.log(8000 / 50)));
  return brightness01 - pos01 > LEAD_BRIGHTNESS_EXCESS ? Lane.MIDIO : Lane.MIDASUS;
}

/** A stem filename -> its lane (drops the extension first so ".mp3" can't
 *  feed the classifier). */
export function laneForStemName(fileName) {
  const stripped = String(fileName || '').replace(/\.[a-z0-9]+$/i, '');
  return laneForFamily(classifyInstrumentText(stripped));
}

/**
 * Stem-vote delegation: when the user drops SEPARATE stem files, each
 * melodic/bass timeline event goes to the lane of whichever lane-carrying
 * stem is loudest at that moment -- the filenames say who owns which
 * sound, the audio says who is actually playing right now.
 *
 * @param {Array<object>} timeline  NoteEvents (mutated in place: `lane`)
 * @param {Array<{lane: string|null, env: Float32Array}>} stems  activity
 *   envelopes at `rate` frames/sec, one per dropped file
 * @param {number} rate  envelope frame rate (frames per second)
 * @returns {number} how many events a stem vote re-assigned
 */
export function delegateByStemActivity(timeline, stems, rate) {
  const voters = stems.filter((s) => s.lane && s.env && s.env.length);
  if (!voters.length) return 0;
  // Per-stem peak so a quiet-but-mixed-low stem still gets a fair vote.
  const peaks = voters.map((s) => {
    let m = 0;
    for (let i = 0; i < s.env.length; i++) if (s.env[i] > m) m = s.env[i];
    return m > 1e-9 ? m : 1;
  });
  let reassigned = 0;
  for (const evt of timeline) {
    if (evt.role !== Role.MELODY && evt.role !== Role.BASS) continue;
    const frame = Math.max(0, Math.round((evt.tMs / 1000) * rate));
    let bestLane = null, bestLevel = 0.12; // a stem must be audibly ON to claim a note
    for (let s = 0; s < voters.length; s++) {
      const env = voters[s].env;
      const level = env[Math.min(env.length - 1, frame)] / peaks[s];
      if (level > bestLevel) { bestLevel = level; bestLane = voters[s].lane; }
    }
    if (bestLane && evt.lane !== bestLane) { evt.lane = bestLane; reassigned++; }
  }
  return reassigned;
}

/** Per-lane note counts for a timeline -- the wiring decisions in
 *  Simulation (real lane vs role fallback) read these. */
export function laneCounts(timeline) {
  const counts = { [Lane.MIDASUS]: 0, [Lane.MIDIO]: 0, [Lane.BROSHI]: 0 };
  for (const evt of timeline) {
    if (evt.lane && counts[evt.lane] != null) counts[evt.lane]++;
  }
  return counts;
}
