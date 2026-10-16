// The authored demo song — a choreography oracle, not a random timeline.
//
// Because we wrote the notes, we know exactly when Midio should jump, when
// a lead stab should pop a double-jump, when the trio should spin into a
// disc, when the drop hits, and when everyone should stand still. The test
// harness (ChoreoHarness) steps the same jump / disc / hype / performer
// path Simulation uses and diffs the log against expectedChoreography().
// When they disagree, the song is right and the logic is what we refine.
import { Role, GM_DRUM, makeNoteEvent, sortNoteEvents } from './NoteEvent.js';
import { Lane } from './Casting.js';
import { CueKind, splitCues } from './ConductorTrack.js';

export const DEMO_BPM = 120;
export const DEMO_BARS = 48;
export const DEMO_TITLE = 'Proof';

const BEAT_MS = 60000 / DEMO_BPM;       // 500
const BAR_MS = BEAT_MS * 4;             // 2000
export const DEMO_DURATION_MS = DEMO_BARS * BAR_MS;

// A minor / C major diatonic. Melody lives in the upper octave so Midasus
// has a wide pitch-space; bass sits two octaves down for Broshi.
const SCALE = [57, 60, 62, 64, 67, 69, 72, 74]; // A C D E G A C D
const CHORDS = {
  Am: [57, 60, 64],
  F:  [53, 57, 60],
  C:  [48, 52, 55],
  G:  [55, 59, 62],
  Dm: [50, 53, 57],
  E:  [52, 56, 59],
};

/**
 * Named sections. `density` is the kick pattern:
 *   sparse  kick on 1
 *   half    kick on 1 + 3
 *   full    four-on-the-floor
 *   rest    no kicks at all
 *   fill    kick on 1 + 3, plus a Lane.MIDIO stab on 2 (the double-jump)
 *
 * Cues are conductor-track events that skip probability rolls (Simulation
 * honors them as authored instructions). Energy is a 0..1 mix hint for the
 * renderer and for expectedChoreography's "hot" windows.
 */
export const SECTIONS = Object.freeze([
  { id: 'intro',   bar0: 0,  bars: 4, density: 'half',   energy: 0.28, chord: ['Am', 'Am', 'Am', 'Am'] },
  { id: 'verse',   bar0: 4,  bars: 8, density: 'half',   energy: 0.36, chord: ['Am', 'Am', 'F', 'F', 'C', 'C', 'G', 'G'] },
  { id: 'build',   bar0: 12, bars: 2, density: 'half',   energy: 0.52, chord: ['Dm', 'E'] },
  { id: 'hush',    bar0: 14, bars: 2, density: 'sparse', energy: 0.12, chord: ['Am', 'Am'] },
  { id: 'drop',    bar0: 16, bars: 8, density: 'full',   energy: 1.00, chord: ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G'],
    cues: [{ kind: CueKind.DROP, atBeat: 0, bucket: 8 }, { kind: CueKind.SECTION, atBeat: 0, bucket: 8 }] },
  { id: 'break',   bar0: 24, bars: 4, density: 'rest',   energy: 0.08, chord: ['Am', 'Am', 'Am', 'Am'] },
  { id: 'fill',    bar0: 28, bars: 4, density: 'fill',   energy: 0.78, chord: ['Am', 'Am', 'F', 'F'] },
  { id: 'chorus2', bar0: 32, bars: 8, density: 'full',   energy: 0.92, chord: ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G'],
    cues: [{ kind: CueKind.FLOURISH, atBeat: 0, bucket: 8 }, { kind: CueKind.SECTION, atBeat: 0, bucket: 5 }] },
  { id: 'coda',    bar0: 40, bars: 8, density: 'sparse', energy: 0.28, chord: ['Am', 'Am', 'F', 'F', 'Am', 'Am', 'Am', 'Am'],
    cues: [{ kind: CueKind.CALM, atBeat: 0, bucket: 6 }, { kind: CueKind.SECTION, atBeat: 0, bucket: 2 }] },
]);

const CUE_PITCH = {
  [CueKind.SECTION]: 49,
  [CueKind.DROP]: 57,
  [CueKind.FLOURISH]: 55,
  [CueKind.CALM]: 51,
};

function sectionAtBar(bar) {
  for (const s of SECTIONS) if (bar >= s.bar0 && bar < s.bar0 + s.bars) return s;
  return SECTIONS[SECTIONS.length - 1];
}

function push(timeline, opts) {
  timeline.push(makeNoteEvent({ src: 'audio', ...opts }));
}

function pushCue(cues, { tMs, kind, bucket = 8 }) {
  const value = kind === CueKind.SECTION
    ? (bucket >= 7 ? 'shutter' : bucket >= 4 ? 'cut' : 'fade')
    : bucket / 8;
  cues.push({
    tMs, kind, bucket, value,
    durMs: 80, pitch: CUE_PITCH[kind] || 49,
  });
}

/** Verse motif: a small rising cell. Chorus: a wider answering phrase. */
function melodyPitches(section, barInSection, beat) {
  if (section.id === 'break' || section.id === 'hush') return null;
  if (section.id === 'intro') {
    return beat === 0 ? 69 : beat === 2 ? 64 : null;
  }
  if (section.id === 'coda') {
    return beat === 0 ? 69 : beat === 2 ? 64 : null;
  }
  const verse = [69, null, 72, null, 76, 74, 72, 69];
  const chorus = [76, 79, 81, 79, 76, 74, 72, 69];
  const build = [69, 72, 74, 76, 77, 76, 74, 81];
  const table = section.id === 'drop' || section.id === 'chorus2' ? chorus
    : section.id === 'build' ? build
    : verse;
  const i = (barInSection * 4 + beat) % table.length;
  return table[i];
}

/**
 * Build the full song: NoteEvent timeline, bar grid, conductor cue sheet,
 * and the named-section table. Pure and deterministic — no RNG.
 */
export function buildDemoSong() {
  const timeline = [];
  const barGrid = [];
  const cues = [];

  for (let bar = 0; bar < DEMO_BARS; bar++) {
    const barStart = bar * BAR_MS;
    barGrid.push({ tick: bar * 4, ms: barStart, numerator: 4, denominator: 4 });
    const section = sectionAtBar(bar);
    const barIn = bar - section.bar0;
    const chord = CHORDS[section.chord[barIn % section.chord.length]] || CHORDS.Am;
    const e = section.energy;

    if (section.cues && barIn === 0) {
      for (const c of section.cues) {
        pushCue(cues, { tMs: barStart + c.atBeat * BEAT_MS, kind: c.kind, bucket: c.bucket });
      }
    }

    for (let beat = 0; beat < 4; beat++) {
      const t = barStart + beat * BEAT_MS;
      const isKick = (
        (section.density === 'sparse' && beat === 0) ||
        (section.density === 'half' && (beat === 0 || beat === 2)) ||
        (section.density === 'fill' && (beat === 0 || beat === 2)) ||
        (section.density === 'full')
      );
      if (isKick) {
        const dropKick = section.id === 'drop' && barIn === 0 && beat === 0;
        push(timeline, {
          tMs: t, durMs: 90, pitch: GM_DRUM.KICK,
          vel: dropKick ? 1 : 0.45 + 0.50 * e,
          role: Role.RHYTHM, kick: true, channel: 0,
        });
      } else if (section.density !== 'rest' && section.density !== 'sparse') {
        push(timeline, {
          tMs: t, durMs: 70, pitch: GM_DRUM.SNARE,
          vel: 0.35 + 0.35 * e,
          role: Role.RHYTHM, kick: false, channel: 0,
        });
      }

      if (section.density === 'full' || section.density === 'fill' || section.density === 'half') {
        for (let e8 = 0; e8 < 2; e8++) {
          if (section.density === 'half' && beat % 2 === 1 && e8 === 1) continue;
          push(timeline, {
            tMs: t + e8 * (BEAT_MS / 2), durMs: 40, pitch: GM_DRUM.HAT,
            vel: 0.18 + 0.22 * e,
            role: Role.RHYTHM, kick: false, channel: 0,
          });
        }
      }
    }

    // Bass: half notes on 1 and 3 (or just 1 when sparse). Broshi's lane.
    // Never on 2/4 — those sit mid-arc on half-time jumps and would steal
    // the air-jump budget via Simulation's accent-line listener.
    const bassBeats = section.density === 'sparse' || section.density === 'rest' || section.id === 'coda'
      ? [0] : [0, 2];
    if (section.density !== 'rest') {
      for (const beat of bassBeats) {
        push(timeline, {
          tMs: barStart + beat * BEAT_MS,
          durMs: BEAT_MS * 1.6,
          pitch: chord[0] - 12,
          vel: 0.55 + 0.35 * e,
          role: Role.BASS, kick: false, channel: 1, lane: Lane.BROSHI, program: 33,
        });
      }
    }

    // Pad: the whole bar, quiet in the intro, wide in the drop.
    if (section.density !== 'rest') {
      for (const p of chord) {
        push(timeline, {
          tMs: barStart, durMs: BAR_MS * 0.96, pitch: p,
          vel: 0.18 + 0.28 * e,
          role: Role.PAD, kick: false, channel: 2, program: 89,
        });
      }
    } else {
      // A single held root so the break isn't digital silence — just empty.
      push(timeline, {
        tMs: barStart, durMs: BAR_MS * 0.9, pitch: 57,
        vel: 0.12, role: Role.PAD, kick: false, channel: 2, program: 89,
      });
    }

    // Melody: Midasus's clean lane. Rests on intro/break.
    for (let beat = 0; beat < 4; beat++) {
      const pitch = melodyPitches(section, barIn, beat);
      if (pitch == null) continue;
      push(timeline, {
        tMs: barStart + beat * BEAT_MS,
        durMs: BEAT_MS * 0.85,
        pitch,
        vel: 0.50 + 0.40 * e,
        role: Role.MELODY, kick: false, channel: 3, lane: Lane.MIDASUS, program: 4,
      });
    }

    // Lead stabs (Midio's lane) — ONLY in the fill, and only on beat 2 of
    // even bars. Kick is on 1+3 so D ≈ 1000ms; beat 2 is the apex; a lead
    // onset while airborne is Simulation's double-jump path.
    if (section.density === 'fill' && barIn % 2 === 0) {
      push(timeline, {
        tMs: barStart + BEAT_MS, // beat 2
        durMs: 180,
        pitch: 81, // A5, a bright stab
        vel: 0.95,
        role: Role.MELODY, kick: false, channel: 4, lane: Lane.MIDIO, program: 81,
      });
    }
  }

  sortNoteEvents(timeline);
  cues.sort((a, b) => a.tMs - b.tMs);
  const { schedule: scheduleCues, live: liveCues } = splitCues(cues);

  return {
    title: DEMO_TITLE,
    bpm: DEMO_BPM,
    bars: DEMO_BARS,
    durationMs: DEMO_DURATION_MS,
    timeline,
    barGrid,
    sections: SECTIONS,
    conductor: {
      names: ['Conductor'],
      cues,
      scheduleCues,
      liveCues,
    },
  };
}

/** Section covering a song time. */
export function sectionAtMs(tMs) {
  const bar = Math.max(0, Math.min(DEMO_BARS - 1, Math.floor(tMs / BAR_MS)));
  return sectionAtBar(bar);
}

/**
 * Ground-truth choreography derived from the score, not from running the
 * sim. The harness log is compared against this. Times are exact onsets;
 * tests allow one sim step (~8ms) of dispatch slack.
 */
export function expectedChoreography(song = buildDemoSong()) {
  const kicks = song.timeline.filter((e) => e.kick).map((e) => ({ tMs: e.tMs, vel: e.vel }));
  const leadStabs = song.timeline.filter((e) => e.lane === Lane.MIDIO).map((e) => e.tMs);
  const bassNotes = song.timeline.filter((e) => e.lane === Lane.BROSHI).map((e) => e.tMs);
  const melodyNotes = song.timeline.filter((e) => e.lane === Lane.MIDASUS).map((e) => e.tMs);

  const restWindows = SECTIONS
    .filter((s) => s.density === 'rest')
    .map((s) => ({ fromMs: s.bar0 * BAR_MS, toMs: (s.bar0 + s.bars) * BAR_MS, id: s.id }));

  const hotWindows = SECTIONS
    .filter((s) => s.energy >= 0.85)
    .map((s) => ({ fromMs: s.bar0 * BAR_MS, toMs: (s.bar0 + s.bars) * BAR_MS, id: s.id }));

  const discs = song.conductor.liveCues
    .filter((c) => c.kind === CueKind.DROP || c.kind === CueKind.FLOURISH)
    .map((c) => ({ tMs: c.tMs, kind: c.kind }));

  const drops = song.conductor.liveCues
    .filter((c) => c.kind === CueKind.DROP)
    .map((c) => c.tMs);

  const calms = song.conductor.liveCues
    .filter((c) => c.kind === CueKind.CALM)
    .map((c) => c.tMs);

  return {
    bpm: song.bpm,
    durationMs: song.durationMs,
    kicks,
    jumpOnsets: kicks.map((k) => k.tMs), // every kick is a takeoff or a landing-tie relaunch
    airJumpOnsets: leadStabs,
    leadStabs,
    bassNotes,
    melodyNotes,
    restWindows,
    hotWindows,
    discs,
    drops,
    calms,
  };
}

export { BEAT_MS, BAR_MS };
