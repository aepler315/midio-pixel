// Standard MIDI File binary parser (spec §1.1.1, §1.1.3, §1.1.4).
// Chunks -> VLQ delta-times -> running status -> paired notes -> TempoMap ->
// absolute-ms NoteEvents. No tick ever escapes this module.
import { TempoMap, SmpteTempoMap } from './TempoMap.js';

class ByteReader {
  constructor(buf) {
    this.dv = new DataView(buf);
    this.o = 0;
  }
  u8() { return this.dv.getUint8(this.o++); }
  u16() { const v = this.dv.getUint16(this.o); this.o += 2; return v; }
  u32() { const v = this.dv.getUint32(this.o); this.o += 4; return v; }
  bytes(n) { const b = new Uint8Array(this.dv.buffer, this.o, n); this.o += n; return b; }
  str(n) { return String.fromCharCode(...this.bytes(n)); }
  vlq() {
    let v = 0, b;
    do { b = this.u8(); v = (v << 7) | (b & 0x7f); } while (b & 0x80);
    return v >>> 0;
  }
  get eof() { return this.o >= this.dv.byteLength; }
}

/**
 * @typedef {Object} RawTrackEvent
 * @property {number} tick
 * @property {number} status
 * @property {number} d1
 * @property {number} d2
 * @property {Uint8Array} [meta] raw meta/sysex payload
 */

function readTrack(r, trackEnd) {
  const events = [];
  let tick = 0;
  let runningStatus = 0;
  while (r.o < trackEnd) {
    const delta = r.vlq();
    tick += delta;
    let status = r.u8();
    if (status < 0x80) {
      // Running status: this byte is actually data; back up and reuse last status.
      r.o -= 1;
      status = runningStatus;
    } else if (status !== 0xff && status !== 0xf0 && status !== 0xf7) {
      runningStatus = status;
    } else {
      runningStatus = 0; // meta/sysex cancels running status
    }

    if (status === 0xff) {
      const type = r.u8();
      const len = r.vlq();
      const payload = r.bytes(len);
      events.push({ tick, status: 0xff, meta: payload, metaType: type });
    } else if (status === 0xf0 || status === 0xf7) {
      const len = r.vlq();
      r.bytes(len); // SysEx payload discarded — not relevant to gameplay
    } else {
      const type = status & 0xf0;
      const channel = status & 0x0f;
      if (type === 0xc0 || type === 0xd0) {
        // Program Change / Channel Pressure: single data byte
        const d1 = r.u8();
        events.push({ tick, status, channel, type, d1 });
      } else {
        const d1 = r.u8();
        const d2 = r.u8();
        events.push({ tick, status, channel, type, d1, d2 });
      }
    }
  }
  return events;
}

const GM_PROGRAM_NAMES = buildGmProgramTable();
function buildGmProgramTable() {
  // Coarse GM program-number -> family name, enough for role-classification keywords.
  const t = new Array(128).fill('');
  const fill = (lo, hi, name) => { for (let i = lo; i <= hi; i++) t[i] = name; };
  fill(0, 7, 'piano'); fill(8, 15, 'chrom percussion'); fill(16, 23, 'organ');
  fill(24, 31, 'guitar'); fill(32, 39, 'bass'); fill(40, 47, 'strings');
  fill(48, 54, 'ensemble string pad'); fill(55, 55, 'orchestra hit');
  fill(56, 63, 'brass'); fill(64, 71, 'reed'); fill(72, 79, 'pipe');
  fill(80, 87, 'synth lead melody'); fill(88, 95, 'synth pad ambient');
  fill(96, 103, 'synth effects'); fill(104, 111, 'ethnic');
  fill(112, 119, 'percussive'); fill(120, 127, 'sound effects');
  return t;
}

/**
 * Parse an SMF ArrayBuffer into { tracks, ppqn, tempoMap, division }.
 * Each track: { index, name, instrumentName, channel, program, rawEvents }
 */
export function parseMidi(arrayBuffer) {
  const r = new ByteReader(arrayBuffer);
  if (r.str(4) !== 'MThd') throw new Error('Not a MIDI file (missing MThd)');
  const hdrLen = r.u32();
  const hdrEnd = r.o + hdrLen;
  const format = r.u16();
  const ntrks = r.u16();
  const division = r.u16();
  r.o = hdrEnd;

  const smpte = (division & 0x8000) !== 0;
  const ppqn = smpte ? null : (division & 0x7fff);
  const fps = smpte ? -((division >> 8) << 24 >> 24) : null; // sign-extend int8
  const tpf = smpte ? (division & 0xff) : null;

  const tracks = [];
  const tempoEvents = [];
  const timeSigEvents = [];

  for (let i = 0; i < ntrks && !r.eof; i++) {
    const chunkType = r.str(4);
    const len = r.u32();
    const end = r.o + len;
    if (chunkType !== 'MTrk') { r.o = end; continue; }
    const rawEvents = readTrack(r, end);
    r.o = end;

    let name = '', instrumentName = '', program = -1, channel = -1;
    for (const e of rawEvents) {
      if (e.status === 0xff && e.metaType === 0x51 && e.meta.length === 3) {
        const usPerQN = (e.meta[0] << 16) | (e.meta[1] << 8) | e.meta[2];
        tempoEvents.push({ tick: e.tick, usPerQN });
      } else if (e.status === 0xff && e.metaType === 0x58 && e.meta.length >= 4) {
        timeSigEvents.push({
          tick: e.tick, numerator: e.meta[0], denominator: 2 ** e.meta[1],
        });
      } else if (e.status === 0xff && e.metaType === 0x03) {
        name = bytesToStr(e.meta);
      } else if (e.status === 0xff && e.metaType === 0x04) {
        instrumentName = bytesToStr(e.meta);
      } else if (e.type === 0xc0) {
        program = e.d1;
        channel = e.channel;
      } else if (e.channel !== undefined) {
        channel = e.channel;
      }
    }

    tracks.push({ index: i, name, instrumentName, channel, program, rawEvents });
  }

  if (tempoEvents.length === 0) tempoEvents.push({ tick: 0, usPerQN: 500000 });
  const tempoMap = smpte ? new SmpteTempoMap(fps, tpf) : new TempoMap(tempoEvents, ppqn);

  if (timeSigEvents.length === 0) timeSigEvents.push({ tick: 0, numerator: 4, denominator: 4 });
  timeSigEvents.sort((a, b) => a.tick - b.tick);

  return { format, tracks, ppqn, smpte, tempoMap, timeSigEvents, gmProgramName: (p) => GM_PROGRAM_NAMES[p] || '' };
}

function bytesToStr(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * Pair NoteOn/NoteOff per (channel,pitch) with a FIFO queue (spec §1.1.4),
 * correctly resolving overlapping same-pitch retriggers. Returns raw paired
 * notes in ticks: { tick, durTicks, pitch, vel, channel }.
 */
export function pairNotes(rawEvents, lastTick) {
  const fifo = new Map(); // key `${channel}:${pitch}` -> array of {tick, vel}
  const notes = [];

  const keyOf = (ch, p) => ch * 128 + p;

  for (const e of rawEvents) {
    if (e.type === 0x90) { // Note On
      const isOn = e.d2 > 0;
      const key = keyOf(e.channel, e.d1);
      if (isOn) {
        if (!fifo.has(key)) fifo.set(key, []);
        fifo.get(key).push({ tick: e.tick, vel: e.d2 });
      } else {
        closeNote(fifo, key, e.tick, notes, e.channel, e.d1);
      }
    } else if (e.type === 0x80) { // Note Off
      const key = keyOf(e.channel, e.d1);
      closeNote(fifo, key, e.tick, notes, e.channel, e.d1);
    }
  }

  // Force-close any unclosed notes at EOF (spec §1.1.4).
  for (const [key, queue] of fifo) {
    const channel = Math.floor(key / 128);
    const pitch = key % 128;
    while (queue.length) {
      const on = queue.shift();
      notes.push({ tick: on.tick, durTicks: Math.max(1, lastTick - on.tick), pitch, vel: on.vel, channel });
    }
  }

  notes.sort((a, b) => a.tick - b.tick);
  return notes;
}

function closeNote(fifo, key, offTick, out, channel, pitch) {
  const queue = fifo.get(key);
  if (!queue || queue.length === 0) return; // stray note-off, ignore
  const on = queue.shift();
  out.push({ tick: on.tick, durTicks: Math.max(1, offTick - on.tick), pitch, vel: on.vel, channel });
}

/**
 * Rescale a track's velocities so its 95th-percentile velocity maps to 1.0
 * (spec §1.1.4) — prevents one timidly-exported track from vanishing.
 */
export function rescaleVelocities(notes) {
  if (notes.length === 0) return notes;
  const sorted = notes.map((n) => n.vel).sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length));
  const p95 = Math.max(1, sorted[idx]);
  const scale = 127 / p95;
  for (const n of notes) n.velNorm = Math.min(1, (n.vel * scale) / 127);
  return notes;
}
