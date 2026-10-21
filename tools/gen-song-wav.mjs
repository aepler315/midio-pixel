// Generates a deterministic, structured 16-bit PCM WAV for tour and timing
// evaluation, plus a JSON sidecar naming the intended sections and their
// payoff moments (downbeats that open choruses and the final chorus).
//
// Unlike gen-test-wav.mjs (one uniform groove), each form here has audible
// section contrast: a pad-only intro, grooving verses, a rising pre-chorus,
// loud choruses opened by a crash, a sparse bridge and a fading outro. The
// sidecar is ground truth for "did the payoff land on the moment", never an
// input to the app.
//
//   node tools/gen-song-wav.mjs <out.wav> [form]   form: anthem | drop | short
import fs from 'node:fs';

const FORMS = {
  // 120 BPM, verse/chorus song with a bridge and a final chorus.
  anthem: { bpm: 120, sections: [
    ['intro', 16], ['verse', 24], ['pre-chorus', 8], ['chorus', 24], ['verse', 20],
    ['chorus', 16], ['bridge', 16], ['pre-chorus', 4], ['final-chorus', 24], ['outro', 16]] },
  // 128 BPM build/drop form.
  drop: { bpm: 128, sections: [
    ['intro', 15], ['verse', 22.5], ['build', 7.5], ['drop', 30], ['breakdown', 15],
    ['build', 7.5], ['final-drop', 30], ['outro', 15]] },
  // A one-minute song: little room for shots.
  short: { bpm: 100, sections: [['intro', 9.6], ['verse', 19.2], ['chorus', 19.2], ['outro', 12]] },
};

const LEVEL = {
  intro: { pad: .5, kick: 0, snare: 0, hat: .15, bass: 0, lead: 0 },
  verse: { pad: .35, kick: .8, snare: .45, hat: .3, bass: .5, lead: .25 },
  'pre-chorus': { pad: .5, kick: .8, snare: .6, hat: .4, bass: .55, lead: .3, riser: 1 },
  build: { pad: .4, kick: .7, snare: .7, hat: .45, bass: .3, lead: 0, riser: 1 },
  chorus: { pad: .7, kick: 1, snare: .8, hat: .5, bass: .8, lead: .6, crash: 1 },
  drop: { pad: .6, kick: 1, snare: .9, hat: .55, bass: 1, lead: .7, crash: 1 },
  'final-chorus': { pad: .8, kick: 1, snare: .9, hat: .6, bass: .9, lead: .75, crash: 1 },
  'final-drop': { pad: .7, kick: 1, snare: 1, hat: .6, bass: 1, lead: .8, crash: 1 },
  bridge: { pad: .55, kick: 0, snare: 0, hat: .1, bass: .25, lead: .3 },
  breakdown: { pad: .55, kick: 0, snare: 0, hat: .1, bass: .2, lead: .2 },
  outro: { pad: .45, kick: .3, snare: 0, hat: .12, bass: .2, lead: 0, fade: 1 },
};

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

export function renderSong(name = 'anthem', sampleRate = 44100) {
  const form = songForm(name);
  const n = Math.floor(sampleRate * form.durationMs / 1000), data = new Float32Array(n), beat = 60 / form.bpm;
  let seed = 315;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const add = (t0, dur, fn) => {
    const s = Math.floor(t0 * sampleRate), e = Math.min(n, s + Math.floor(dur * sampleRate));
    for (let i = Math.max(0, s); i < e; i++) data[i] += fn((i - s) / sampleRate);
  };
  const kick = (t, a) => add(t, .12, (x) => a * Math.exp(-x / .05) * Math.sin(2 * Math.PI * (120 * Math.exp(-x / .015) + 48) * x));
  const snare = (t, a) => add(t, .18, (x) => a * Math.exp(-x / .05) * (.6 * (rand() * 2 - 1) + .4 * Math.sin(2 * Math.PI * 190 * x)));
  const hat = (t, a) => add(t, .05, (x) => a * Math.exp(-x / .012) * (rand() * 2 - 1));
  const crash = (t, a) => add(t, 2.2, (x) => a * .5 * Math.exp(-x / .7) * (rand() * 2 - 1));
  const chords = [[220, 277.2, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6], [196, 246.9, 329.6]];
  const scale = [440, 493.9, 554.4, 659.3, 740, 880];
  for (const s of form.sections) {
    const lv = LEVEL[s.kind], t0 = s.startMs / 1000, t1 = s.endMs / 1000, len = t1 - t0;
    const fade = (t) => (lv.fade ? Math.max(0, 1 - (t - t0) / len) : 1);
    // Pads: one chord per bar, slow attack.
    for (let bar = 0, t = t0; t < t1 - 1e-6; bar++, t += 4 * beat) {
      const chord = chords[bar % chords.length], d = Math.min(4 * beat, t1 - t), g = lv.pad * .09 * fade(t);
      add(t, d, (x) => g * Math.min(1, x / .4) * Math.min(1, (d - x) / .3) * chord.reduce((v, f) => v + Math.sin(2 * Math.PI * f * x) + .3 * Math.sin(4 * Math.PI * f * x), 0));
      if (lv.bass) add(t, d, (x) => lv.bass * .28 * fade(t) * Math.min(1, x / .02) * Math.sin(2 * Math.PI * chord[0] / 4 * x));
    }
    for (let k = 0, t = t0; t < t1 - 1e-6; k++, t += beat) {
      const f = fade(t);
      if (lv.kick && (k % 2 === 0 || lv.kick >= 1)) kick(t, lv.kick * .9 * f);
      if (lv.snare && k % 2 === 1) snare(t, lv.snare * .45 * f);
      if (lv.hat) { hat(t + beat / 2, lv.hat * .3 * f); hat(t, lv.hat * .18 * f); }
      if (lv.lead && rand() > .25) {
        const fr = scale[Math.floor(rand() * scale.length)], d = beat * .8, g = lv.lead * .16 * f;
        add(t, d, (x) => g * Math.min(1, x / .01) * Math.exp(-x / (d * .7)) * (Math.sin(2 * Math.PI * fr * x) + Math.sin(6 * Math.PI * fr * x) / 3));
      }
    }
    if (lv.riser) add(t0, len, (x) => .25 * (x / len) ** 2 * ((rand() * 2 - 1) * .6 + Math.sin(2 * Math.PI * (200 + 800 * x / len) * x) * .4));
    if (lv.crash) crash(t0, lv.crash);
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

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`) {
  const [,, out, name = 'anthem'] = process.argv;
  if (!out) { console.error('usage: node tools/gen-song-wav.mjs <out.wav> [anthem|drop|short]'); process.exit(2); }
  const { form, wav } = renderSong(name);
  fs.writeFileSync(out, wav);
  fs.writeFileSync(out.replace(/\.wav$/i, '') + '.form.json', JSON.stringify(form, null, 1));
  console.log(`${out}: ${form.name} ${form.bpm} BPM ${form.durationMs / 1000}s, ${form.sections.length} sections, ${form.payoffs.length} payoffs`);
}
