// Shared SMF byte-builder helpers for both node --test unit tests and the
// Playwright smoke tests (tools/smoke-*.mjs) — one source of truth for how
// a test fixture MIDI file is assembled.

export function vlq(value) {
  let buffer = value & 0x7f;
  const bytes = [];
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= 0x80 | (value & 0x7f);
  }
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8; else break;
  }
  return bytes;
}

export function strBytes(s) { return [...s].map((c) => c.charCodeAt(0)); }

export function buildTrackChunk(events) {
  const bytes = [];
  for (const e of events) bytes.push(...e);
  const header = [0x4d, 0x54, 0x72, 0x6b]; // 'MTrk'
  const len = bytes.length;
  return [...header, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...bytes];
}

function smfHeader(format, ntrks, ppqn) {
  return [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6,
    (format >> 8) & 0xff, format & 0xff,
    (ntrks >> 8) & 0xff, ntrks & 0xff,
    (ppqn >> 8) & 0xff, ppqn & 0xff,
  ];
}

/**
 * Two SMF Type-1 tracks, hard-panned to opposite sides (CC#10), playing the
 * same `noteCount`-note rhythm in unison so their active time fully
 * overlaps — the "intertwined" pan-out fixture used by the
 * MidiAdapter/PanAnalysis unit tests (default 8 notes / 3.75s) and the
 * multitrack smoke test (which passes a larger count so the song comfortably
 * outlasts the test's own wall-clock time).
 */
export function buildMultiTrackPannedMidi(noteCount = 8) {
  const ppqn = 96;
  const noteGap = 96;
  const noteDur = 48;

  const trackA = [];
  trackA.push([...vlq(0), 0xff, 0x03, 4, ...strBytes('Left')]);
  trackA.push([...vlq(0), 0xff, 0x51, 3, 0x07, 0xa1, 0x20]); // 120 BPM
  trackA.push([...vlq(0), 0xff, 0x58, 4, 4, 2, 24, 8]);
  trackA.push([...vlq(0), 0xc0, 40]); // program 40 (violin) on ch0
  trackA.push([...vlq(0), 0xb0, 10, 0]); // pan hard left
  for (let i = 0; i < noteCount; i++) {
    trackA.push([...vlq(i === 0 ? 0 : noteGap - noteDur), 0x90, 60, 100]);
    trackA.push([...vlq(noteDur), 0x80, 60, 0]);
  }
  trackA.push([...vlq(0), 0xff, 0x2f, 0]);

  const trackB = [];
  trackB.push([...vlq(0), 0xff, 0x03, 5, ...strBytes('Right')]);
  trackB.push([...vlq(0), 0xc1, 42]); // program 42 (cello) on ch1
  trackB.push([...vlq(0), 0xb1, 10, 127]); // pan hard right
  for (let i = 0; i < noteCount; i++) {
    trackB.push([...vlq(i === 0 ? 0 : noteGap - noteDur), 0x91, 67, 100]);
    trackB.push([...vlq(noteDur), 0x81, 67, 0]);
  }
  trackB.push([...vlq(0), 0xff, 0x2f, 0]);

  const header = smfHeader(1, 2, ppqn);
  return new Uint8Array([...header, ...buildTrackChunk(trackA), ...buildTrackChunk(trackB)]).buffer;
}

/**
 * Four named SMF Type-1 tracks -- the casting fixture: a clean piano
 * melody, a synth lead line, a bass line, and channel-10 drums. Track
 * names + programs are exactly what Casting.laneForTrack keys on
 * (piano -> Midasus, lead -> Midio, bass -> Broshi, drums -> nobody).
 */
export function buildNamedEnsembleMidi(noteCount = 8) {
  const ppqn = 96;
  const gap = 96, dur = 48;

  const mkMelodic = (name, channel, program, basePitch) => {
    const t = [];
    t.push([...vlq(0), 0xff, 0x03, name.length, ...strBytes(name)]);
    if (channel === 0) {
      t.push([...vlq(0), 0xff, 0x51, 3, 0x07, 0xa1, 0x20]); // 120 BPM
      t.push([...vlq(0), 0xff, 0x58, 4, 4, 2, 24, 8]);
    }
    t.push([...vlq(0), 0xc0 | channel, program]);
    for (let i = 0; i < noteCount; i++) {
      const pitch = basePitch + (i % 5) * 2;
      t.push([...vlq(i === 0 ? 0 : gap - dur), 0x90 | channel, pitch, 100]);
      t.push([...vlq(dur), 0x80 | channel, pitch, 0]);
    }
    t.push([...vlq(0), 0xff, 0x2f, 0]);
    return t;
  };

  const drums = [];
  drums.push([...vlq(0), 0xff, 0x03, 5, ...strBytes('Drums')]);
  for (let i = 0; i < noteCount; i++) {
    drums.push([...vlq(i === 0 ? 0 : gap - 24), 0x99, 36, 110]);
    drums.push([...vlq(24), 0x89, 36, 0]);
  }
  drums.push([...vlq(0), 0xff, 0x2f, 0]);

  const header = smfHeader(1, 4, ppqn);
  return new Uint8Array([
    ...header,
    ...buildTrackChunk(mkMelodic('Grand Piano', 0, 0, 72)),
    ...buildTrackChunk(mkMelodic('Lead Synth', 1, 81, 76)),
    ...buildTrackChunk(mkMelodic('Bass', 2, 33, 36)),
    ...buildTrackChunk(drums),
  ]).buffer;
}

/**
 * A single SMF track multiplexing two channels (SMF Type 0 style): a
 * melodic voice on channel 0 interleaved with a drum hit on channel 9.
 */
export function buildType0MultiChannelMidi() {
  const ppqn = 96;
  const track = [];
  track.push([...vlq(0), 0xff, 0x51, 3, 0x07, 0xa1, 0x20]); // 120 BPM
  track.push([...vlq(0), 0xff, 0x58, 4, 4, 2, 24, 8]);
  track.push([...vlq(0), 0xc0, 73]); // program 73 (flute) on ch0
  track.push([...vlq(0), 0x90, 72, 100]);   // ch0 note on
  track.push([...vlq(48), 0x80, 72, 0]);    // ch0 note off (tick 48)
  track.push([...vlq(0), 0x99, 36, 110]);   // ch9 kick on (tick 48)
  track.push([...vlq(24), 0x89, 36, 0]);    // ch9 kick off (tick 72)
  track.push([...vlq(24), 0x90, 74, 90]);   // ch0 note on (tick 96)
  track.push([...vlq(48), 0x80, 74, 0]);    // ch0 note off (tick 144)
  track.push([...vlq(0), 0xff, 0x2f, 0]);

  const header = smfHeader(0, 1, ppqn);
  return new Uint8Array([...header, ...buildTrackChunk(track)]).buffer;
}
