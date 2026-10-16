// Designs a small "soundfont" of oscillator-synth patches, one per MIDI
// channel actually present in a song's timeline -- tuned to that channel's
// own register, density, velocity, and phrasing rather than the fixed
// sine/sawtooth/triangle SimpleSynth used for every song before this.
//
// A patch never touches note timing/pitch/velocity -- it only decides HOW a
// channel's notes are voiced (oscillator blend, filter, envelope, unison,
// vibrato). Percussion (Role.RHYTHM) keeps SimpleSynth's existing dedicated
// kick/snare/hat voices, which already differ by GM pitch; this only covers
// melodic/harmonic channels.
import { clamp, clamp01 } from '../utils/math.js';
import { Role } from '../core/NoteEvent.js';

function statsFor(timeline) {
  const groups = new Map();
  for (const e of timeline) {
    if (e.role === Role.RHYTHM) continue;
    let g = groups.get(e.channel);
    if (!g) {
      g = {
        channel: e.channel, role: e.role, notes: 0, pitchSum: 0,
        pitchMin: 127, pitchMax: 0, velSum: 0, durSum: 0,
        prevEnd: -Infinity, gapSum: 0, gapCount: 0, maxConcurrent: 1, activeEnds: [],
      };
      groups.set(e.channel, g);
    }
    g.notes++;
    g.pitchSum += e.pitch;
    if (e.pitch < g.pitchMin) g.pitchMin = e.pitch;
    if (e.pitch > g.pitchMax) g.pitchMax = e.pitch;
    g.velSum += e.vel;
    g.durSum += e.durMs;
    // Actual silence between this note's onset and the latest previous note
    // in this channel to have already ended (not onset-to-onset, which would
    // read a channel's own note DURATION as if it were rest between notes).
    if (g.prevEnd > -Infinity) {
      g.gapSum += Math.max(0, e.tMs - g.prevEnd);
      g.gapCount++;
    }
    g.prevEnd = Math.max(g.prevEnd, e.tMs + (e.durMs || 90));
    g.role = e.role || g.role;
    // Rough concurrency: how many notes in this channel are still sounding
    // when this one starts -- a cheap proxy for "is this line chordal."
    g.activeEnds = g.activeEnds.filter((end) => end > e.tMs);
    g.activeEnds.push(e.tMs + (e.durMs || 90));
    if (g.activeEnds.length > g.maxConcurrent) g.maxConcurrent = g.activeEnds.length;
  }
  return groups;
}

/**
 * One channel's stats -> one synth patch. Every parameter is a continuous
 * function of that channel's own register/density/duration/velocity, so two
 * different channels in the same song -- let alone two different songs --
 * land on genuinely different patches rather than picking from a fixed set.
 */
function buildPatch(g, durationMs) {
  const meanPitch = g.pitchSum / g.notes;
  const meanVel = clamp01(g.velSum / g.notes);
  const meanDurMs = g.durSum / g.notes;
  const meanGapMs = g.gapCount ? g.gapSum / g.gapCount : meanDurMs;
  const density = g.notes / Math.max(1, durationMs / 1000); // notes/sec
  // Legato: the note's own sustain relative to the silence after it. Near 1
  // for held/overlapping lines, near 0 for short stabs with long rests.
  const legato = clamp01(meanDurMs / Math.max(1, meanDurMs + meanGapMs));
  const register01 = clamp01((meanPitch - 28) / 76); // ~A0..G7 mapped 0..1
  const chordal = clamp01((g.maxConcurrent - 1) / 3);

  // Brightness/edge: how much harmonic bite this voice should carry. High
  // register, loud, dense/staccato lines read as bright leads; low, quiet,
  // legato lines read as warm pads/bass.
  const edge = clamp01(0.4 * register01 + 0.3 * meanVel + 0.3 * (1 - legato));

  let type;
  if (g.role === Role.BASS) type = edge > 0.55 ? 'sawtooth' : 'square';
  else if (g.role === Role.PAD) type = edge > 0.6 ? 'triangle' : 'sine';
  else type = edge > 0.68 ? 'sawtooth' : edge > 0.38 ? 'triangle' : 'sine';

  // A second, slightly detuned voice for chordal/dense lines -- reads as a
  // small ensemble rather than one thin oscillator. Silent (gain 0) for a
  // clean single-note melody.
  const unisonGain = chordal > 0.15 ? clamp01(0.18 + 0.35 * chordal) : 0;
  const unisonDetuneCents = 4 + 10 * chordal;

  // Envelope: legato/sustained lines get a slower attack and a release that
  // trails past the note's own duration; staccato/percussive-feeling lines
  // (short notes, short gaps, high density) snap in and out fast.
  const attack = clamp(0.003 + 0.09 * legato * (1 - clamp01(density / 8)), 0.003, 0.14);
  const release = clamp(0.03 + meanDurMs / 1000 * (0.25 + 0.5 * legato), 0.03, 1.4);

  // Filter: brighter/louder/higher lines get a more open lowpass; warm pads
  // and bass stay darker so they sit under the lead instead of buzzing.
  const cutoffHz = clamp(420 + edge * 5200 + register01 * 1800, 380, 9000);
  const resonanceQ = clamp(0.5 + chordal * 1.2 + (g.role === Role.BASS ? 0.6 : 0), 0.4, 3.2);

  // Vibrato: only earns its keep on sustained, legato, non-bass lines --
  // exactly where a real player's vibrato would show up.
  const vibratoDepthCents = g.role !== Role.BASS && legato > 0.55 && meanDurMs > 260
    ? clamp(6 + 10 * legato, 6, 20)
    : 0;
  const vibratoRateHz = 4.5 + 2 * clamp01(density / 6);

  const peakGain = (g.role === Role.PAD ? 0.10 : g.role === Role.BASS ? 0.15 : 0.16)
    * (0.75 + 0.4 * meanVel);

  return {
    type, attack, release, cutoffHz, resonanceQ,
    unisonGain, unisonDetuneCents, vibratoDepthCents, vibratoRateHz, peakGain,
  };
}

/**
 * @param {import('../core/NoteEvent.js').NoteEvent[]} timeline
 * @param {number} durationMs
 * @returns {Object<number, object>} synth patch keyed by MIDI channel
 */
export function designSynthPatches(timeline, durationMs) {
  if (!Array.isArray(timeline) || !timeline.length) return {};
  const groups = statsFor(timeline);
  const patches = {};
  for (const [channel, g] of groups) {
    if (!g.notes) continue;
    patches[channel] = buildPatch(g, durationMs);
  }
  return patches;
}
