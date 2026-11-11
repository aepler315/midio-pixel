#!/usr/bin/env node
// How much of a rendered clip moves WITH the music.
//
// Reads one landscape-review grid directory (report.json, its frame PNGs and
// review-audio/audio.wav), builds an onset envelope from the audio, and
// correlates it with frame-to-frame change in a 3x3 grid of screen regions.
// A region whose change rises on onsets reads as reactive; change that
// ignores the music (camera drift, weather) correlates near zero.
//
//   node tools/reactivity-meter.mjs .smoke/<run>/<grid> [--json out.json]
//
// Use a continuous clip at 12 fps or more (e.g. review:landscape --seconds 8
// --fps 24): at 1 fps a frame interval spans several beats and the number
// means nothing. Compare a change against a baseline run of the same clip.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const W = 64, H = 36, REGIONS = 3;

/** Decode an 8-bit, non-interlaced RGB/RGBA PNG (what canvas writes). */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, type = 0, depth = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), kind = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace || (type !== 6 && type !== 2)) throw new Error(`unsupported PNG (depth ${depth}, type ${type})`);
  const bpp = type === 6 ? 4 : 3, stride = width * bpp, raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride), line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let p = 0;
      if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = (src[i] + p) & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = line[x * bpp]; out[o + 1] = line[x * bpp + 1]; out[o + 2] = line[x * bpp + 2]; out[o + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    [prev, line] = [line, prev];
  }
  return { width, height, data: out };
}

/** Box-downsampled luminance (W x H) and mean chroma of an RGBA image. */
export function thumb({ width, height, data }) {
  const lum = new Float32Array(W * H), count = new Float32Array(W * H);
  for (let y = 0; y < height; y++) {
    const ty = Math.min(H - 1, Math.floor(y * H / height));
    for (let x = 0; x < width; x++) {
      const tx = Math.min(W - 1, Math.floor(x * W / width)), o = (y * width + x) * 4;
      lum[ty * W + tx] += .2126 * data[o] + .7152 * data[o + 1] + .0722 * data[o + 2];
      count[ty * W + tx]++;
    }
  }
  for (let i = 0; i < lum.length; i++) lum[i] /= Math.max(1, count[i]);
  return lum;
}

/** PCM WAV (16-bit or 32-bit float) -> mono Float32Array. */
export function decodeWav(buf) {
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4), len = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    if (id === 'data') { data = buf.subarray(pos + 8, pos + 8 + len); break; }
    pos += 8 + len + (len & 1);
  }
  if (!fmt || !data) throw new Error('not a PCM WAV');
  const bytes = fmt.bits / 8, frames = Math.floor(data.length / (bytes * fmt.channels)), mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const o = (i * fmt.channels + c) * bytes;
      s += fmt.bits === 16 ? data.readInt16LE(o) / 32768 : fmt.format === 3 ? data.readFloatLE(o) : data.readInt32LE(o) / 2147483648;
    }
    mono[i] = s / fmt.channels;
  }
  return { rate: fmt.rate, samples: mono };
}

/** Onset strength per hop: rectified rise of log energy of the high-passed
 *  signal (a broadband spectral-flux stand-in). Returns { hopMs, values }. */
export function onsetEnvelope({ rate, samples }, hop = 512) {
  const n = Math.floor(samples.length / hop), values = new Float32Array(n);
  let prevLog = 0, prevSample = 0;
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) { const d = samples[j] - prevSample; prevSample = samples[j]; e += d * d; }
    const log = Math.log10(1e-9 + e / hop);
    values[i] = i ? Math.max(0, log - prevLog) : 0;
    prevLog = log;
  }
  return { hopMs: hop * 1000 / rate, values };
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 1e-12 && sbb > 1e-12 ? sab / Math.sqrt(saa * sbb) : 0;
}

/** Measure one review grid directory. */
export async function measure(dir) {
  const report = JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8'));
  const song = report.songs?.[0];
  if (!song?.frames?.length) throw new Error('no frames in report.json');
  const frames = song.frames.filter(f => f.png).sort((a, b) => a.timeMs - b.timeMs);
  const audio = decodeWav(await fs.readFile(path.join(dir, song.audio || 'review-audio/audio.wav')));
  const env = onsetEnvelope(audio);
  const thumbs = [];
  for (const f of frames) thumbs.push(thumb(decodePng(await fs.readFile(path.join(dir, f.png)))));
  const onset = [], change = Array.from({ length: REGIONS * REGIONS }, () => []), whole = [];
  for (let k = 1; k < frames.length; k++) {
    // Strongest onset heard during this frame interval.
    const a = Math.floor(frames[k - 1].timeMs / env.hopMs), b = Math.max(a + 1, Math.floor(frames[k].timeMs / env.hopMs));
    let o = 0;
    for (let i = a; i < b && i < env.values.length; i++) o = Math.max(o, env.values[i]);
    onset.push(o);
    const sums = new Float64Array(REGIONS * REGIONS), counts = new Float64Array(REGIONS * REGIONS);
    let total = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const d = Math.abs(thumbs[k][y * W + x] - thumbs[k - 1][y * W + x]);
      const r = Math.floor(y * REGIONS / H) * REGIONS + Math.floor(x * REGIONS / W);
      sums[r] += d; counts[r]++; total += d;
    }
    for (let r = 0; r < sums.length; r++) change[r].push(sums[r] / counts[r]);
    whole.push(total / (W * H));
  }
  const intervalMs = (frames.at(-1).timeMs - frames[0].timeMs) / Math.max(1, frames.length - 1);
  const names = ['sky-left', 'sky', 'sky-right', 'mid-left', 'mid', 'mid-right', 'ground-left', 'ground', 'ground-right'];
  const regions = change.map((series, r) => ({ region: names[r], meanChange: series.reduce((s, v) => s + v, 0) / series.length,
    onsetCorrelation: pearson(series, onset) }));
  return { frames: frames.length, startMs: frames[0].timeMs, endMs: frames.at(-1).timeMs, intervalMs,
    warning: intervalMs > 85 ? `frame interval ${intervalMs.toFixed(0)} ms is too coarse; use >= 12 fps` : null,
    whole: { meanChange: whole.reduce((s, v) => s + v, 0) / whole.length, onsetCorrelation: pearson(whole, onset) }, regions };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}` || process.argv[1]?.endsWith('reactivity-meter.mjs')) {
  const args = process.argv.slice(2);
  if (!args[0] || args[0] === '--help') { console.log('node tools/reactivity-meter.mjs <review grid dir> [--json out.json]'); process.exit(args[0] ? 0 : 1); }
  const result = await measure(path.resolve(args[0]));
  const j = args.indexOf('--json');
  if (j >= 0 && args[j + 1]) await fs.writeFile(args[j + 1], JSON.stringify(result, null, 2));
  const f = (v) => (v == null ? '  n/a' : (v >= 0 ? ' ' : '') + v.toFixed(2));
  console.log(`${result.frames} frames, ${result.startMs}-${result.endMs} ms, ${result.intervalMs.toFixed(0)} ms apart${result.warning ? `  WARNING: ${result.warning}` : ''}`);
  console.log(`whole frame  change ${result.whole.meanChange.toFixed(2)}  onset r ${f(result.whole.onsetCorrelation)}`);
  for (const r of result.regions) console.log(`${r.region.padEnd(12)} change ${r.meanChange.toFixed(2)}  onset r ${f(r.onsetCorrelation)}`);
}
