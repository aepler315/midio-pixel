// The unified event timeline (spec §0.3). MIDI and raw audio are both
// adapters emit the same shape. Musical evidence consumers retain source
// and pitch provenance so inferred choreography never overrides authored
// notes or measured recording chroma.
//
// @typedef {Object} NoteEvent
// @property {number} tMs      absolute onset, milliseconds
// @property {number} durMs    sustain length (transients default to 90 ms)
// @property {number} pitch    MIDI 0-127 (audio transients map to GM drum pitches)
// @property {number} vel      normalized 0-1
// @property {'MELODY'|'RHYTHM'|'BASS'|'PAD'} role
// @property {boolean} kick    true -> may drive a Midio jump
// @property {'midi'|'audio'} src
// @property {'authored'|'tracked'|'inferred'|'synthetic'|'unpitched'} pitchProvenance
// @property {number} pitchConfidence measured support 0..1; zero for placeholders
// @property {number} channel  midi channel or band index
// @property {number} pan      stereo placement, -1 (hard left) .. 1 (hard right), 0 = center
// @property {number} program  GM instrument 0-127 from the source MIDI, -1 if unknown/non-MIDI
// @property {?string} lane    which character performs this note (Casting.js:
//                             'MIDASUS' clean melody | 'MIDIO' lead | 'BROSHI'
//                             bass), null = nobody's line. Roles stay the
//                             world's contract; lanes only route choreography.

export const Role = Object.freeze({
  MELODY: 'MELODY',
  RHYTHM: 'RHYTHM',
  BASS: 'BASS',
  PAD: 'PAD',
});

// GM drum-map pitches used by both the MIDI channel-10 path and the audio
// onset classifier so the two inputs are indistinguishable downstream.
export const GM_DRUM = Object.freeze({
  KICK: 36,
  SNARE: 38,
  HAT: 42,
});

/** @returns {NoteEvent} */
export function makeNoteEvent({
  tMs, durMs = 90, pitch, vel, role, kick = false, src, channel = 0, pan = 0, program = -1, lane = null, pitchProvenance = null, pitchConfidence = null,
}) {
  return {
    tMs, durMs, pitch, vel: Math.max(0, Math.min(1, vel)), role, kick, src, channel,
    pan: Math.max(-1, Math.min(1, pan)), program, lane,
    pitchProvenance: pitchProvenance ?? (src === 'midi' ? 'authored' : role === Role.RHYTHM ? 'unpitched' : 'inferred'),
    pitchConfidence: pitchConfidence ?? (src === 'midi' ? 1 : 0),
  };
}

export function sortNoteEvents(events) {
  events.sort((a, b) => a.tMs - b.tMs);
  return events;
}
