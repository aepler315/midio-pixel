// Renders buildDemoSong()'s timeline to PCM. Same notes the sim jumps to,
// so a peak in the waveform at tMs is the kick Midio leaves the ground on.
// Deterministic (seeded noise) so tests can pin energy at known onsets.
import { Role, GM_DRUM } from '../core/NoteEvent.js';
import { Lane } from '../core/Casting.js';
import { mulberry32 } from '../utils/math.js';

export const DEMO_SAMPLE_RATE = 44100;

function midiHz(p) { return 440 * Math.pow(2, (p - 69) / 12); }

function envAR(t, att, rel, dur) {
  if (t < 0 || t > dur) return 0;
  if (t < att) return t / att;
  const u = (t - att) / Math.max(1e-4, rel);
  return u >= 1 ? 0 : (1 - u) * (1 - u);
}

function envExp(t, decay) {
  return t < 0 ? 0 : Math.exp(-t / decay);
}

/**
 * @param {ReturnType<typeof import('../core/DemoSong.js').buildDemoSong>} song
 * @param {{sampleRate?: number, stereo?: boolean}} [opts]
 * @returns {{sampleRate:number, channels:number, length:number, left:Float32Array, right:Float32Array}}
 */
export function renderDemoSongPcm(song, { sampleRate = DEMO_SAMPLE_RATE, stereo = true } = {}) {
  const n = Math.ceil((song.durationMs / 1000) * sampleRate);
  const L = new Float32Array(n);
  const R = stereo ? new Float32Array(n) : L;
  const rand = mulberry32(0x50700f);

  const mix = (i, l, r) => {
    if (i < 0 || i >= n) return;
    L[i] += l;
    if (stereo) R[i] += r;
  };

  for (const e of song.timeline) {
    const start = Math.floor((e.tMs / 1000) * sampleRate);
    if (e.role === Role.RHYTHM) {
      if (e.kick || e.pitch === GM_DRUM.KICK) addKick(mix, start, sampleRate, e.vel, n);
      else if (e.pitch === GM_DRUM.SNARE) addSnare(mix, start, sampleRate, e.vel, n, rand);
      else addHat(mix, start, sampleRate, e.vel, n, rand);
    } else if (e.role === Role.BASS) {
      addBass(mix, start, sampleRate, e.pitch, e.vel, e.durMs, n);
    } else if (e.role === Role.PAD) {
      addPad(mix, start, sampleRate, e.pitch, e.vel, e.durMs, n);
    } else if (e.role === Role.MELODY) {
      const lead = e.lane === Lane.MIDIO;
      addMelody(mix, start, sampleRate, e.pitch, e.vel, e.durMs, n, lead);
    }
  }

  // Gentle limiter.
  let peak = 1e-6;
  for (let i = 0; i < n; i++) {
    peak = Math.max(peak, Math.abs(L[i]), stereo ? Math.abs(R[i]) : 0);
  }
  const g = peak > 0.97 ? 0.97 / peak : 1;
  if (g < 1) {
    for (let i = 0; i < n; i++) { L[i] *= g; if (stereo) R[i] *= g; }
  }

  return { sampleRate, channels: stereo ? 2 : 1, length: n, left: L, right: R };
}

function addKick(mix, start, sr, vel, n) {
  const dur = Math.floor(0.22 * sr);
  for (let i = 0; i < dur && start + i < n; i++) {
    const t = i / sr;
    const freq = 150 * Math.exp(-t / 0.018) + 42;
    const body = Math.sin(2 * Math.PI * freq * t) * envExp(t, 0.055);
    const click = Math.sin(2 * Math.PI * 1800 * t) * envExp(t, 0.004) * 0.35;
    const s = (0.95 * vel) * (body + click);
    mix(start + i, s, s);
  }
}

function addSnare(mix, start, sr, vel, n, rand) {
  const dur = Math.floor(0.16 * sr);
  for (let i = 0; i < dur && start + i < n; i++) {
    const t = i / sr;
    const tone = Math.sin(2 * Math.PI * 190 * t) * envExp(t, 0.05);
    const noise = (rand() * 2 - 1) * envExp(t, 0.04);
    const s = (0.45 * vel) * (0.35 * tone + 0.65 * noise);
    mix(start + i, s * 0.9, s * 1.05);
  }
}

function addHat(mix, start, sr, vel, n, rand) {
  const dur = Math.floor(0.045 * sr);
  for (let i = 0; i < dur && start + i < n; i++) {
    const t = i / sr;
    const s = (0.22 * vel) * (rand() * 2 - 1) * envExp(t, 0.012);
    mix(start + i, s * 0.7, s * 1.15);
  }
}

function addBass(mix, start, sr, pitch, vel, durMs, n) {
  const hz = midiHz(pitch);
  const dur = Math.floor((durMs / 1000) * sr);
  const att = 0.008, rel = durMs / 1000 * 0.85;
  for (let i = 0; i < dur && start + i < n; i++) {
    const t = i / sr;
    const ph = 2 * Math.PI * hz * t;
    // Soft square: odd partials, rolled off.
    const wave = Math.sin(ph) + 0.28 * Math.sin(3 * ph) + 0.12 * Math.sin(5 * ph);
    const s = (0.34 * vel) * wave * envAR(t, att, rel, durMs / 1000);
    mix(start + i, s, s);
  }
}

function addPad(mix, start, sr, pitch, vel, durMs, n) {
  const hz = midiHz(pitch);
  const dur = Math.floor((durMs / 1000) * sr);
  const att = 0.08, rel = durMs / 1000 * 0.7;
  for (let i = 0; i < dur && start + i < n; i++) {
    const t = i / sr;
    const a = Math.sin(2 * Math.PI * hz * 0.997 * t);
    const b = Math.sin(2 * Math.PI * hz * 1.004 * t);
    const c = Math.sin(2 * Math.PI * hz * 0.5 * t) * 0.25;
    const e = envAR(t, att, rel, durMs / 1000);
    const s = (0.11 * vel) * (a + b + c) * e;
    mix(start + i, s * 0.85, s * 1.1);
  }
}

function addMelody(mix, start, sr, pitch, vel, durMs, n, lead) {
  const hz = midiHz(pitch);
  const dur = Math.floor((durMs / 1000) * sr);
  const att = lead ? 0.004 : 0.012;
  const rel = durMs / 1000 * (lead ? 0.45 : 0.65);
  const peak = lead ? 0.28 : 0.20;
  for (let i = 0; i < dur && start + i < n; i++) {
    const t = i / sr;
    const ph = 2 * Math.PI * hz * t;
    const wave = Math.sin(ph) + (lead ? 0.45 : 0.22) * Math.sin(2 * ph);
    const s = (peak * vel) * wave * envAR(t, att, rel, durMs / 1000);
    mix(start + i, s * (lead ? 1.1 : 1.15), s * (lead ? 0.85 : 0.8));
  }
}

/** Fill an AudioBuffer (browser) from the PCM render. */
export function renderDemoSongToAudioBuffer(ctx, song) {
  const pcm = renderDemoSongPcm(song, { sampleRate: ctx.sampleRate || DEMO_SAMPLE_RATE, stereo: true });
  const buf = ctx.createBuffer(2, pcm.length, pcm.sampleRate);
  buf.getChannelData(0).set(pcm.left);
  buf.getChannelData(1).set(pcm.right);
  return buf;
}

/** 16-bit stereo WAV bytes — Node tests / the gen tool. */
export function renderDemoSongWav(song) {
  const pcm = renderDemoSongPcm(song, { sampleRate: DEMO_SAMPLE_RATE, stereo: true });
  const n = pcm.length;
  const bytesPerSample = 2;
  const dataBytes = n * 2 * bytesPerSample;
  const buf = new Uint8Array(44 + dataBytes);
  const view = new DataView(buf.buffer);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * 2 * bytesPerSample, true);
  view.setUint16(32, 2 * bytesPerSample, true);
  view.setUint16(34, 16, true);
  w(36, 'data');
  view.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const ls = Math.max(-1, Math.min(1, pcm.left[i]));
    const rs = Math.max(-1, Math.min(1, pcm.right[i]));
    view.setInt16(o, Math.round(ls * 32767), true);
    view.setInt16(o + 2, Math.round(rs * 32767), true);
    o += 4;
  }
  return buf;
}
