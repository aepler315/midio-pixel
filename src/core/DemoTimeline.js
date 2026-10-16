// Procedural demo timeline — lets the game run with zero file input. Emits
// the exact same NoteEvent[] shape the MIDI/audio adapters produce, so every
// downstream system (jump, combo, companions, biomes) is exercised for real.
import { Role, makeNoteEvent, sortNoteEvents } from './NoteEvent.js';
import { mulberry32 } from '../utils/math.js';

export function buildDemoTimeline({ bpm = 120, bars = 96, seed = 1337 } = {}) {
  const rand = mulberry32(seed);
  const beatMs = 60000 / bpm;
  const barMs = beatMs * 4;
  const timeline = [];
  const barGrid = [];

  const scale = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64]; // C-major-ish, low to mid

  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * barMs;
    barGrid.push({ tick: bar * 4, ms: barStart, numerator: 4, denominator: 4 });

    const energyPhase = 0.5 + 0.5 * Math.sin((bar / bars) * Math.PI * 1.3);
    const surge = bar % 8 === 7;
    // Every 5th bar drops to a sparse one-kick pattern, opening a >1.5-beat
    // gap so the obstacle spawner (spec §2.2.3) has room to seed a hazard —
    // a dense four-on-the-floor pattern never leaves that much daylight.
    const sparse = bar % 5 === 4;

    // RHYTHM: kick on 1 & 3 (or just 1 on sparse bars), snare fills, hats on every 8th note.
    for (let beat = 0; beat < 4; beat++) {
      const t = barStart + beat * beatMs;
      const isKickBeat = beat === 0 || (!sparse && beat === 2);
      if (isKickBeat) {
        timeline.push(makeNoteEvent({
          tMs: t, durMs: 90, pitch: 36, vel: 0.75 + 0.2 * energyPhase + (surge ? 0.15 : 0),
          role: Role.RHYTHM, kick: true, src: 'audio', channel: 0,
        }));
      } else {
        timeline.push(makeNoteEvent({
          tMs: t, durMs: 90, pitch: 38, vel: 0.55 + 0.2 * rand(),
          role: Role.RHYTHM, kick: false, src: 'audio', channel: 0,
        }));
      }
      if (!sparse) {
        for (let e = 0; e < 2; e++) {
          const th = t + e * (beatMs / 2);
          timeline.push(makeNoteEvent({
            tMs: th, durMs: 40, pitch: 42, vel: 0.3 + 0.25 * rand(),
            role: Role.RHYTHM, kick: false, src: 'audio', channel: 0,
          }));
        }
      }
    }

    // BASS: root on the downbeat, walking approach on beat 4.
    const root = scale[bar % 4] - 12;
    timeline.push(makeNoteEvent({
      tMs: barStart, durMs: beatMs * 2.5, pitch: root, vel: 0.7,
      role: Role.BASS, kick: false, src: 'audio', channel: 1,
    }));

    // PAD: a sustained chord for the whole bar.
    timeline.push(makeNoteEvent({
      tMs: barStart, durMs: barMs * 0.95, pitch: root + 12, vel: 0.4,
      role: Role.PAD, kick: false, src: 'audio', channel: 2,
    }));

    // MELODY: sparse-to-dense arpeggio depending on section energy, rests sometimes.
    if (rand() < 0.8) {
      const notesThisBar = 2 + Math.floor(rand() * (2 + energyPhase * 4));
      for (let i = 0; i < notesThisBar; i++) {
        const t = barStart + (i / notesThisBar) * barMs + rand() * 20;
        const pitch = scale[Math.floor(rand() * scale.length)] + 12;
        timeline.push(makeNoteEvent({
          tMs: t, durMs: (barMs / notesThisBar) * 0.8, pitch, vel: 0.5 + 0.4 * rand(),
          role: Role.MELODY, kick: false, src: 'audio', channel: 3,
        }));
      }
    }
  }

  sortNoteEvents(timeline);
  const durationMs = bars * barMs;
  return { timeline, barGrid, durationMs, bpm };
}
