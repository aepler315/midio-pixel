// Generates a small but structurally complete SMF test fixture: a named
// drum track on channel 10, a bass track, a pad track, and a melody track,
// so the full pipeline (role classification, jump/combo/companions/biomes/
// fracture) gets exercised end-to-end with real MIDI input.
import fs from 'node:fs';

const [,, outPath, barsArg] = process.argv;
const bars = Number(barsArg) || 12;
const ppqn = 96;

function vlq(value) {
  let buffer = value & 0x7f;
  const bytes = [];
  while ((value >>= 7)) { buffer <<= 8; buffer |= 0x80 | (value & 0x7f); }
  while (true) { bytes.push(buffer & 0xff); if (buffer & 0x80) buffer >>= 8; else break; }
  return bytes;
}

function strBytes(s) { return [...s].map((c) => c.charCodeAt(0)); }

function buildTrack(name, events) {
  const bytes = [];
  bytes.push(...vlq(0), 0xff, 0x03, name.length, ...strBytes(name));
  let lastTick = 0;
  for (const e of events.sort((a, b) => a.tick - b.tick)) {
    bytes.push(...vlq(e.tick - lastTick), ...e.bytes);
    lastTick = e.tick;
  }
  bytes.push(...vlq(0), 0xff, 0x2f, 0);
  const header = strBytes('MTrk');
  const len = bytes.length;
  return [...header, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...bytes];
}

const beatTicks = ppqn;
const barTicks = beatTicks * 4;

// --- Tempo/meta track ---
const meta = [];
meta.push({ tick: 0, bytes: [0xff, 0x51, 3, 0x07, 0xa1, 0x20] }); // 120 BPM-ish (actual tempo below overrides)
meta.push({ tick: 0, bytes: [0xff, 0x58, 4, 4, 2, 24, 8] });
// set explicit tempo 132 BPM = 454545 us/qn
const usPerQn = Math.round(60000000 / 132);
meta[0] = { tick: 0, bytes: [0xff, 0x51, 3, (usPerQn >> 16) & 0xff, (usPerQn >> 8) & 0xff, usPerQn & 0xff] };

// --- Drum track (channel 9 = MIDI channel 10) ---
const drum = [];
for (let bar = 0; bar < bars; bar++) {
  const b0 = bar * barTicks;
  drum.push({ tick: b0, bytes: [0x99, 36, 100] }, { tick: b0 + 20, bytes: [0x89, 36, 0] }); // kick beat1
  drum.push({ tick: b0 + beatTicks, bytes: [0x99, 38, 90] }, { tick: b0 + beatTicks + 20, bytes: [0x89, 38, 0] }); // snare beat2
  drum.push({ tick: b0 + 2 * beatTicks, bytes: [0x99, 36, 100] }, { tick: b0 + 2 * beatTicks + 20, bytes: [0x89, 36, 0] }); // kick beat3
  drum.push({ tick: b0 + 3 * beatTicks, bytes: [0x99, 38, 90] }, { tick: b0 + 3 * beatTicks + 20, bytes: [0x89, 38, 0] }); // snare beat4
  for (let e = 0; e < 4; e++) {
    const t = b0 + e * (beatTicks / 2);
    drum.push({ tick: t, bytes: [0x99, 42, 70] }, { tick: t + 10, bytes: [0x89, 42, 0] });
  }
}

// --- Bass track ---
const bass = [];
const bassRoots = [40, 43, 45, 47]; // E A B D-ish ... just needs to be low register
for (let bar = 0; bar < bars; bar++) {
  const b0 = bar * barTicks;
  const root = bassRoots[bar % bassRoots.length];
  bass.push({ tick: b0, bytes: [0x90, root, 95] }, { tick: b0 + barTicks - 10, bytes: [0x80, root, 0] });
}

// --- Pad track (sustained chords, high polyphony) ---
const pad = [];
for (let bar = 0; bar < bars; bar++) {
  const b0 = bar * barTicks;
  const root = bassRoots[bar % bassRoots.length] + 12;
  for (const iv of [0, 4, 7]) {
    pad.push({ tick: b0, bytes: [0x90, root + iv, 60] }, { tick: b0 + barTicks - 5, bytes: [0x80, root + iv, 0] });
  }
}

// --- Melody track ---
const melody = [];
const scale = [60, 62, 64, 65, 67, 69, 71, 72];
let seed = 11;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (let bar = 0; bar < bars; bar++) {
  const b0 = bar * barTicks;
  const notesThisBar = 3 + Math.floor(rand() * 4);
  for (let i = 0; i < notesThisBar; i++) {
    if (rand() < 0.2) continue;
    const t = Math.round(b0 + (i / notesThisBar) * barTicks);
    const pitch = scale[Math.floor(rand() * scale.length)] + 12;
    const dur = Math.round((barTicks / notesThisBar) * 0.7);
    melody.push({ tick: t, bytes: [0x90, pitch, 80] }, { tick: t + dur, bytes: [0x80, pitch, 0] });
  }
}

const tracks = [
  buildTrack('Tempo', meta),
  buildTrack('Drums', drum),
  buildTrack('Bass', bass),
  buildTrack('Pad Strings', pad),
  buildTrack('Lead Melody', melody),
];

const header = [
  ...strBytes('MThd'), 0, 0, 0, 6,
  0, 1, // format 1
  0, tracks.length,
  (ppqn >> 8) & 0xff, ppqn & 0xff,
];

const out = Buffer.from([...header, ...tracks.flat()]);
fs.writeFileSync(outPath, out);
console.log(`Wrote ${outPath}: ${bars} bars @ 132bpm, ${tracks.length} tracks`);
