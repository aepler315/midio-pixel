// Generates a deterministic, structured 16-bit PCM WAV for tour and timing
// evaluation, plus a JSON sidecar naming the intended sections and their
// payoff moments (downbeats that open choruses and drops).
//
// Unlike gen-test-wav.mjs (one uniform groove), each section here has its
// own chord progression, register, voices and groove, and repeated sections
// repeat their material (every chorus plays the same progression and hook),
// as real songs do -- the app's section detection and form labels need that
// novelty and repetition to find the boundaries. The sidecar is ground truth
// for "did the payoff land on the moment", never an input to the app.
//
//   node tools/gen-song-wav.mjs <out.wav> [form]   form: anthem | drop | short
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const FORMS = {
  // 120 BPM verse/chorus song with a bridge and a final chorus.
  anthem: { bpm: 120, sections: [
    ['intro', 16], ['verse', 24], ['pre-chorus', 8], ['chorus', 24], ['verse', 16],
    ['pre-chorus', 8], ['chorus', 16], ['bridge', 16], ['final-chorus', 24], ['outro', 16]] },
  // 128 BPM build/drop form.
  drop: { bpm: 128, sections: [
    ['intro', 15], ['verse', 22.5], ['build', 7.5], ['drop', 30], ['breakdown', 15],
    ['build', 7.5], ['final-drop', 30], ['outro', 15]] },
  // A one-minute song: little room for shots.
  short: { bpm: 100, sections: [['intro', 9.6], ['verse', 19.2], ['chorus', 19.2], ['outro', 12]] },
};

const N = { C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196, Ab3: 207.65, A3: 220, Bb3: 233.08, B3: 246.94,
  C4: 261.63, Db4: 277.18, D4: 293.66, Eb4: 311.13, E4: 329.63, F4: 349.23, G4: 392, Ab4: 415.3, A4: 440, Bb4: 466.16, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99 };
const chord = (...names) => names.map((n) => N[n]);
// Progressions (one chord per bar) and hooks (one note per beat, 0 = rest).
const ARRANGE = {
  intro: { prog: [chord('C3', 'G3', 'E4'), chord('A3', 'E4', 'C4'), chord('F3', 'C4', 'A4'), chord('G3', 'D4', 'B3')], pad: 'sine', padGain: .55 },
  verse: { prog: [chord('A3', 'C4', 'E4'), chord('F3', 'A3', 'C4'), chord('C4', 'E4', 'G4'), chord('G3', 'B3', 'D4')], pad: 'pluck', padGain: .4,
    drums: 'backbeat', bass: .55, hook: ['A4', 0, 'C5', 0, 'E5', 'D5', 0, 'C5'], lead: 'triangle', leadGain: .22 },
  'pre-chorus': { prog: [chord('D3', 'F3', 'A3'), chord('E3', 'G3', 'B3'), chord('F3', 'A3', 'C4'), chord('G3', 'B3', 'D4')], pad: 'saw', padGain: .45,
    drums: 'build', bass: .5, riser: true },
  chorus: { prog: [chord('C4', 'E4', 'G4'), chord('G3', 'B3', 'D4'), chord('A3', 'C4', 'E4'), chord('F3', 'A3', 'C4')], pad: 'saw', padGain: .7,
    drums: 'four', bass: .9, hook: ['E5', 'G5', 'E5', 'D5', 'C5', 'D5', 'E5', 0], lead: 'saw', leadGain: .3, crash: true },
  bridge: { prog: [chord('F3', 'Ab3', 'C4'), chord('Db4', 'F4', 'Ab4'), chord('Ab3', 'C4', 'Eb4'), chord('Eb4', 'G4', 'Bb4')], pad: 'sine', padGain: .6,
    bass: .25, hook: ['C5', 0, 0, 'Ab4', 0, 0, 'G4', 0], lead: 'bell', leadGain: .25 },
  build: { prog: [chord('F3', 'A3', 'C4'), chord('G3', 'B3', 'D4')], pad: 'saw', padGain: .35, drums: 'build', bass: .3, riser: true },
  drop: { prog: [chord('A3', 'C4', 'E4'), chord('F3', 'A3', 'C4'), chord('C4', 'E4', 'G4'), chord('G3', 'B3', 'D4')], pad: 'stab', padGain: .8,
    drums: 'four', bass: 1.1, hook: ['A4', 'A4', 'C5', 'A4', 'E5', 'D5', 'C5', 'A4'], lead: 'saw', leadGain: .32, crash: true },
  breakdown: { prog: [chord('F3', 'A3', 'C4'), chord('C4', 'E4', 'G4'), chord('D3', 'F3', 'A3'), chord('E3', 'G3', 'B3')], pad: 'sine', padGain: .55,
    hook: ['E5', 0, 0, 0, 'D5', 0, 'C5', 0], lead: 'bell', leadGain: .2 },
  outro: { prog: [chord('C3', 'G3', 'E4'), chord('A3', 'E4', 'C4'), chord('F3', 'C4', 'A4'), chord('C3', 'G3', 'C4')], pad: 'sine', padGain: .5,
    drums: 'sparse', bass: .2, fade: true },
};
ARRANGE['final-chorus'] = { ...ARRANGE.chorus, padGain: .8, leadGain: .34, bass: 1 };
ARRANGE['final-drop'] = { ...ARRANGE.drop, padGain: .9, leadGain: .36 };

export function songForm(name = 'anthem') {
  const form = FORMS[name];
  if (!form) throw new Error(`unknown form ${name}`);
  let at = 0;
  const sections = form.sections.map(([kind, seconds]) => {
    const s = { kind, startMs: Math.round(at * 1000), endMs: Math.round((at + seconds) * 1000) };
    at += seconds;
    return s;
  });
  // Payoffs: the first downbeat of every chorus/drop. The final one is the
  // song's climax.
  const payoffs = sections.filter((s) => /chorus|drop/.test(s.kind) && !/pre-chorus/.test(s.kind))
    .map((s) => ({ timeMs: s.startMs, kind: s.kind, climax: s.kind.startsWith('final') }));
  return { name, bpm: form.bpm, durationMs: Math.round(at * 1000), sections, payoffs };
}

const TWO_PI = 2 * Math.PI;
const VOICES = {
  sine: (f, x) => Math.sin(TWO_PI * f * x),
  triangle: (f, x) => [1, 3, 5, 7].reduce((v, k) => v + ((k % 4 === 1 ? 1 : -1) / (k * k)) * Math.sin(TWO_PI * f * k * x), 0),
  saw: (f, x) => [1, 2, 3, 4, 5, 6, 7, 8].reduce((v, k) => v + Math.sin(TWO_PI * f * k * x) / k, 0) * .6,
  bell: (f, x) => Math.sin(TWO_PI * f * x) + .5 * Math.sin(TWO_PI * f * 2.76 * x) * Math.exp(-x / .3) + .25 * Math.sin(TWO_PI * f * 5.4 * x) * Math.exp(-x / .12),
};

export function renderSong(name = 'anthem', sampleRate = 44100) {
  const form = songForm(name);
  const n = Math.floor(sampleRate * form.durationMs / 1000), data = new Float32Array(n), beat = 60 / form.bpm;
  let seed = 315;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const add = (t0, dur, fn) => {
    const s = Math.floor(t0 * sampleRate), e = Math.min(n, s + Math.floor(dur * sampleRate));
    for (let i = Math.max(0, s); i < e; i++) data[i] += fn((i - s) / sampleRate);
  };
  const kick = (t, a) => add(t, .14, (x) => a * Math.exp(-x / .055) * Math.sin(TWO_PI * (120 * Math.exp(-x / .015) + 46) * x));
  const snare = (t, a) => add(t, .2, (x) => a * Math.exp(-x / .055) * (.65 * (rand() * 2 - 1) + .35 * Math.sin(TWO_PI * 185 * x)));
  const hat = (t, a, open = false) => add(t, open ? .25 : .05, (x) => a * Math.exp(-x / (open ? .09 : .012)) * (rand() * 2 - 1));
  const crash = (t, a) => add(t, 2.6, (x) => a * .55 * Math.exp(-x / .8) * (rand() * 2 - 1));
  for (const s of form.sections) {
    const arr = ARRANGE[s.kind], t0 = s.startMs / 1000, t1 = s.endMs / 1000, len = t1 - t0;
    const fade = (t) => (arr.fade ? Math.max(0, 1 - (t - t0) / len) : 1);
    for (let bar = 0, t = t0; t < t1 - 1e-6; bar++, t += 4 * beat) {
      const c = arr.prog[bar % arr.prog.length], d = Math.min(4 * beat, t1 - t), g = arr.padGain * .08 * fade(t);
      if (arr.pad === 'pluck') {
        // Eighth-note arpeggio.
        for (let k = 0; k < 8 && t + k * beat / 2 < t1; k++) {
          const f = c[k % 3] * (k >= 4 ? 2 : 1);
          add(t + k * beat / 2, beat / 2, (x) => g * 1.6 * Math.exp(-x / .12) * VOICES.triangle(f, x));
        }
      } else if (arr.pad === 'stab') {
        for (const k of [0, 1.5, 3]) add(t + k * beat, beat * .45, (x) => g * 1.4 * Math.exp(-x / .15) * c.reduce((v, f) => v + VOICES.saw(f, x), 0));
      } else {
        const voice = VOICES[arr.pad];
        add(t, d, (x) => g * Math.min(1, x / .35) * Math.min(1, (d - x) / .25) * c.reduce((v, f) => v + voice(f, x), 0));
      }
      if (arr.bass) {
        const f = c[0] / 2;
        for (let k = 0; k < 4 && t + k * beat < t1; k++) add(t + k * beat, beat * .9, (x) => arr.bass * .3 * fade(t) * Math.min(1, x / .01) * Math.exp(-x / .5)
          * (Math.sin(TWO_PI * f * x) + .3 * Math.sin(TWO_PI * 2 * f * x)));
      }
    }
    for (let k = 0, t = t0; t < t1 - 1e-6; k++, t += beat) {
      const f = fade(t), progress = (t - t0) / len;
      switch (arr.drums) {
        case 'backbeat': if (k % 2 === 0) kick(t, .8 * f); else snare(t, .4 * f); hat(t + beat / 2, .1 * f); break;
        case 'four': kick(t, .95 * f); if (k % 2 === 1) snare(t, .5 * f); hat(t + beat / 2, .16 * f, true); break;
        case 'build': kick(t, .6 * f); for (let r = 0; r < 1 + Math.floor(progress * 4); r++) snare(t + r * beat / (1 + Math.floor(progress * 4)), (.15 + .4 * progress) * f); break;
        case 'sparse': if (k % 4 === 0) kick(t, .45 * f); break;
        default: break;
      }
      if (arr.hook) {
        const note = arr.hook[k % arr.hook.length];
        if (note) add(t, beat * .85, (x) => arr.leadGain * .2 * f * Math.min(1, x / .008) * Math.exp(-x / (beat * .6)) * VOICES[arr.lead](N[note], x));
      }
    }
    if (arr.riser) add(t0, len, (x) => .22 * (x / len) ** 2 * ((rand() * 2 - 1) * .5 + .5 * Math.sin(TWO_PI * (180 + 900 * x / len) * x)));
    if (arr.crash) crash(t0, 1);
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(data[i]));
  const scaleBy = peak > .98 ? .98 / peak : 1;
  const buffer = Buffer.alloc(44 + n * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + n * 2, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, data[i] * scaleBy)) * 32767), 44 + i * 2);
  return { form, wav: buffer };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1].replace(/\//g, '\\') || fileURLToPath(import.meta.url) === process.argv[1]) {
  const [,, out, name = 'anthem'] = process.argv;
  if (!out) { console.error('usage: node tools/gen-song-wav.mjs <out.wav> [anthem|drop|short]'); process.exit(2); }
  const { form, wav } = renderSong(name);
  fs.writeFileSync(out, wav);
  fs.writeFileSync(out.replace(/\.wav$/i, '') + '.form.json', JSON.stringify(form, null, 1));
  console.log(`${out}: ${form.name} ${form.bpm} BPM ${form.durationMs / 1000}s, ${form.sections.length} sections, ${form.payoffs.length} payoffs`);
}
