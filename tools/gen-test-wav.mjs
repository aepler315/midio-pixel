// Generates a synthetic 16-bit PCM WAV test signal: a steady kick+hat
// pattern at a known BPM plus a wandering sine melody. Used to exercise the
// StemSeparator/OnsetDetector pipeline end-to-end without needing a real
// audio file (OfflineAudioContext only exists in a browser, so this signal
// gets driven through Playwright, not Node's test runner).
import fs from 'node:fs';

const [,, outPath, bpmArg, secondsArg] = process.argv;
const bpm = Number(bpmArg) || 120;
const seconds = Number(secondsArg) || 20;
const sampleRate = 44100;
const numSamples = Math.floor(sampleRate * seconds);
const beatSec = 60 / bpm;

const data = new Float32Array(numSamples);

function addKick(tSec, amp = 0.9) {
  const start = Math.floor(tSec * sampleRate);
  const dur = 0.09;
  for (let i = 0; i < dur * sampleRate; i++) {
    const idx = start + i;
    if (idx >= numSamples) break;
    const t = i / sampleRate;
    // A punchy kick: pitch collapses to its resting frequency fast (~15ms)
    // so there's no slow low-frequency tail to trip a second onset later.
    const freq = 130 * Math.exp(-t / 0.015) + 50;
    const env = Math.exp(-t / 0.045);
    data[idx] += amp * env * Math.sin(2 * Math.PI * freq * t);
  }
}

function addHat(tSec, amp = 0.35) {
  const start = Math.floor(tSec * sampleRate);
  const dur = 0.05;
  for (let i = 0; i < dur * sampleRate; i++) {
    const idx = start + i;
    if (idx >= numSamples) break;
    const env = Math.exp(-i / (0.015 * sampleRate));
    data[idx] += amp * env * (rand() * 2 - 1);
  }
}

let seed = 7;
function rand() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

for (let beat = 0; beat * beatSec < seconds; beat++) {
  const t = beat * beatSec;
  if (beat % 2 === 0) addKick(t);
  else addHat(t, 0.3);
  addHat(t + beatSec / 2, 0.18);
}

// Wandering sine melody, quarter notes on a pentatonic-ish scale.
const scaleHz = [261.6, 293.7, 329.6, 392.0, 440.0, 523.3];
for (let beat = 0; beat * beatSec < seconds; beat++) {
  if (rand() < 0.3) continue; // rests
  const t = beat * beatSec;
  const freq = scaleHz[Math.floor(rand() * scaleHz.length)];
  const start = Math.floor(t * sampleRate);
  const dur = beatSec * 0.8;
  for (let i = 0; i < dur * sampleRate; i++) {
    const idx = start + i;
    if (idx >= numSamples) break;
    const tt = i / sampleRate;
    const env = Math.min(1, tt / 0.02) * Math.exp(-tt / (dur * 0.6));
    data[idx] += 0.22 * env * Math.sin(2 * Math.PI * freq * tt);
  }
}

// Normalize to avoid clipping.
let peak = 0;
for (let i = 0; i < numSamples; i++) peak = Math.max(peak, Math.abs(data[i]));
const scale = peak > 0.98 ? 0.98 / peak : 1;

const bytesPerSample = 2;
const buffer = Buffer.alloc(44 + numSamples * bytesPerSample);
buffer.write('RIFF', 0);
buffer.writeUInt32LE(36 + numSamples * bytesPerSample, 4);
buffer.write('WAVE', 8);
buffer.write('fmt ', 12);
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20); // PCM
buffer.writeUInt16LE(1, 22); // mono
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
buffer.writeUInt16LE(bytesPerSample, 32);
buffer.writeUInt16LE(16, 34);
buffer.write('data', 36);
buffer.writeUInt32LE(numSamples * bytesPerSample, 40);
for (let i = 0; i < numSamples; i++) {
  const s = Math.max(-1, Math.min(1, data[i] * scale));
  buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
}

fs.writeFileSync(outPath, buffer);
console.log(`Wrote ${outPath}: ${seconds}s @ ${bpm}bpm, ${numSamples} samples`);
