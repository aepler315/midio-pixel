// Generates the Range v2 motion-pilot song: a synthetic 16-bit PCM WAV with
// a calm opening (pad and sparse melody, no drums), an energetic middle
// (kick, hats, bass, busier melody) and a calm close, so one capture shows
// both musical states. Deterministic (fixed-seed noise).
//
//   node tools/gen-pilot-wav.mjs <out.wav> [seconds=60] [bpm=112]
//   sections: 0-35% calm, 35-75% energetic, 75-100% calm
import fs from 'node:fs';

const [,, outPath, secondsArg, bpmArg] = process.argv;
if (!outPath) throw new Error('usage: gen-pilot-wav.mjs <out.wav> [seconds] [bpm]');
const seconds = Number(secondsArg) || 60;
const bpm = Number(bpmArg) || 112;
const sr = 44100;
const n = Math.floor(sr * seconds);
const beat = 60 / bpm;
const data = new Float32Array(n);
let s = 0x2468ace;
const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

const calmEnd = seconds * 0.35, hotEnd = seconds * 0.75;
const energyAt = (t) => (t < calmEnd ? 0 : t < hotEnd ? 1 : 0);

function tone(t0, dur, freq, amp, attack = 0.01, release = 0.2) {
  const a = Math.floor(t0 * sr), len = Math.floor(dur * sr);
  for (let i = 0; i < len && a + i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, t / attack) * Math.min(1, Math.max(0, (dur - t) / release));
    data[a + i] += amp * env * Math.sin(2 * Math.PI * freq * t);
  }
}
function kick(t0) {
  const a = Math.floor(t0 * sr);
  for (let i = 0; i < 0.1 * sr && a + i < n; i++) {
    const t = i / sr;
    data[a + i] += 0.85 * Math.exp(-t / 0.05) * Math.sin(2 * Math.PI * (120 * Math.exp(-t / 0.015) + 48) * t);
  }
}
function hat(t0, amp) {
  const a = Math.floor(t0 * sr);
  for (let i = 0; i < 0.04 * sr && a + i < n; i++) data[a + i] += amp * Math.exp(-i / (0.012 * sr)) * (rand() * 2 - 1);
}

// Pad: slow chords throughout, louder when calm.
const chords = [[220, 277.2, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6], [196, 246.9, 311.1]];
for (let t = 0, k = 0; t < seconds; t += beat * 8, k++) {
  const amp = energyAt(t) ? 0.05 : 0.09;
  for (const f of chords[k % chords.length]) tone(t, beat * 8, f, amp, 1.2, 1.5);
}
// Melody: sparse when calm, busy when energetic.
const scale = [440, 493.9, 554.4, 587.3, 659.3, 740, 830.6, 880];
for (let t = 0; t < seconds; t += beat / 2) {
  const hot = energyAt(t);
  if (rand() < (hot ? 0.7 : 0.18)) tone(t, beat * (hot ? 0.45 : 1.6), scale[Math.floor(rand() * scale.length)], hot ? 0.18 : 0.14, 0.01, hot ? 0.1 : 0.6);
}
// Drums and bass only in the energetic section.
for (let t = calmEnd; t < hotEnd; t += beat) {
  kick(t);
  hat(t + beat / 2, 0.3);
  hat(t + beat / 4, 0.12); hat(t + (3 * beat) / 4, 0.12);
  tone(t, beat * 0.9, 55 * (Math.floor(t / (beat * 4)) % 2 ? 1.122 : 1), 0.3, 0.005, 0.1);
}

let peak = 0;
for (const v of data) peak = Math.max(peak, Math.abs(v));
const buf = Buffer.alloc(44 + n * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round((data[i] / (peak || 1)) * 0.9 * 32767), 44 + i * 2);
fs.writeFileSync(outPath, buf);
console.log(`${outPath}: ${seconds}s, calm 0-${calmEnd.toFixed(0)}s, energetic -${hotEnd.toFixed(0)}s, calm after`);
