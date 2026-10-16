import { DEFAULT_DISPLAY_PREFS } from './DisplayProfile.js';
// Planning for tools/bulk-export.mjs.
//
// The live recorder (SongRecorder.js) captures whatever the screen managed
// to draw, in real time, and holds the whole file in memory. Bulk export
// does the other thing: the page steps the sim on the audio clock, one
// output frame at a time, and ffmpeg muxes those frames with the source
// audio into an H.264 MP4. 2160p60 takes as long as those frames take to
// draw, and each one is the frame that was asked for.

/** Output sizes the bulk tool will render. All even, all 16:9. */
export const BULK_RESOLUTIONS = [
  { id: '1080p', width: 1920, height: 1080 },
  { id: '1440p', width: 2560, height: 1440 },
  { id: '2160p', width: 3840, height: 2160 },
];

export const BULK_FRAME_RATES = [60, 30];

export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac'];

const X264_PRESETS = [
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast',
  'medium', 'slow', 'slower', 'veryslow',
];

const RESOLUTION_ALIASES = {
  '1080': '1080p', '1080p': '1080p', fhd: '1080p',
  '1440': '1440p', '1440p': '1440p', qhd: '1440p',
  '2160': '2160p', '2160p': '2160p', '4k': '2160p', uhd: '2160p',
};

export function resolutionById(id) {
  return BULK_RESOLUTIONS.find((r) => r.id === id) || null;
}

/**
 * Validate a frame size for export, or return null if it cannot be used.
 *
 * Sizes arrive from two untrusted-ish places: a caller's arguments and the
 * `exportW`/`exportH` query parameters, which are whatever was typed. So this
 * has to survive NaN, strings, fractions, negatives and a missing argument
 * entirely.
 *
 * Odd sizes are rejected rather than nudged. Every common video encoder needs
 * even dimensions for chroma subsampling, and silently exporting 1279 wide
 * when 1280 was asked for -- or, worse, silently changing the aspect ratio --
 * is the kind of surprise that is only discovered after a long render. The
 * callers turn a null into an error naming the size they were given.
 *
 * @param {{ w: number, h: number } | null | undefined} size
 * @returns {{ w: number, h: number } | null} The same size, normalized to
 *   numbers, or null if it is not an even pair of at least 2x2.
 */
export function evenExportSize(size) {
  if (!size || typeof size !== 'object') return null;
  const w = Number(size.w);
  const h = Number(size.h);
  if (!isEvenDimension(w) || !isEvenDimension(h)) return null;
  return { w, h };
}

/** A usable dimension: a whole, even number of pixels, at least 2. */
function isEvenDimension(value) {
  return Number.isInteger(value) && value >= 2 && value % 2 === 0;
}

/**
 * `all`, a comma/space list, or null. Unknown tokens throw.
 * Result is the canonical order (1080, then 1440, then 2160), duplicates dropped.
 */
export function parseResolutions(text) {
  if (text == null || String(text).trim() === '' || String(text).trim().toLowerCase() === 'all') {
    return BULK_RESOLUTIONS.map((r) => r.id);
  }
  const ids = [];
  for (const part of String(text).split(/[, ]+/)) {
    if (!part) continue;
    const id = RESOLUTION_ALIASES[part.trim().toLowerCase()];
    if (!id) throw new Error(`Unknown resolution "${part}". Use 1080, 1440, or 2160.`);
    ids.push(id);
  }
  if (!ids.length) throw new Error('Name at least one resolution: 1080, 1440, or 2160.');
  return BULK_RESOLUTIONS.map((r) => r.id).filter((id) => ids.includes(id));
}

/** `all`, or a list of 30 and 60. Higher rates come first so a pass can draw once. */
export function parseFrameRates(text) {
  if (text == null || String(text).trim() === '' || String(text).trim().toLowerCase() === 'all') {
    return [...BULK_FRAME_RATES];
  }
  const rates = [];
  for (const part of String(text).split(/[, ]+/)) {
    if (!part) continue;
    const n = Number(part);
    if (n !== 30 && n !== 60) throw new Error(`Unknown frame rate "${part}". Use 30 or 60.`);
    if (!rates.includes(n)) rates.push(n);
  }
  if (!rates.length) throw new Error('Name at least one frame rate: 30 or 60.');
  return rates.sort((a, b) => b - a);
}

export function isAudioPath(filePath) {
  const base = String(filePath).split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot < 1) return false;
  return AUDIO_EXTENSIONS.includes(base.slice(dot).toLowerCase());
}

/** How many frames cover `durationMs` at a constant rate. */
export function frameCount(durationMs, fps) {
  if (!(durationMs > 0) || !(fps > 0)) return 0;
  return Math.max(1, Math.round((durationMs / 1000) * fps));
}

/** Presentation time of frame `index` on a constant-rate timeline. */
export function frameTimeMs(index, fps) {
  return index * 1000 / fps;
}

/**
 * One drawing pass per resolution. When 60 and 30 are both requested, the
 * pass draws at 60 and the 30fps file keeps every other frame: those
 * timestamps are the same instants a 30fps clock would have stepped to,
 * and the sim ticks between them are the same ticks.
 */
export function passesFor(resolutionIds, fpsList) {
  const resolutions = BULK_RESOLUTIONS.filter((r) => resolutionIds.includes(r.id));
  const outputs = [...fpsList].sort((a, b) => b - a);
  if (!resolutions.length) throw new Error('No resolutions to render.');
  if (!outputs.length) throw new Error('No frame rates to render.');
  const drawFps = outputs[0];
  return resolutions.map((resolution) => ({
    resolution,
    drawFps,
    outputs: outputs.map((fps) => {
      const every = drawFps / fps;
      if (!Number.isInteger(every)) {
        throw new Error(`Cannot derive ${fps}fps from a ${drawFps}fps draw.`);
      }
      return { fps, every };
    }),
  }));
}

/**
 * Advance an offline simulation to `targetMs` in whole fixed steps.
 *
 * Only whole steps are taken, so `simTime` can land up to one step behind the
 * requested time. That is the point rather than a rounding bug: the exporter
 * asks for frames on the video's cadence (33.37ms at 29.97fps, say) while the
 * simulation must keep its own fixed step, or every physical quantity would
 * depend on the frame rate being exported to. Callers draw at -- and report --
 * the returned `simTime`, which is the instant actually simulated.
 *
 * A target at or behind the current time takes no steps. The clock never runs
 * backwards, and asking twice for the same frame is not an error.
 *
 * @param {object} args
 * @param {number} args.simTime Current simulation time, in milliseconds.
 * @param {number} args.targetMs Time the caller wants drawn, in milliseconds.
 * @param {number} args.stepMs Fixed step size, in milliseconds. Must be > 0.
 * @param {(dtMs: number, atMs: number) => void} args.step Advances the sim by
 *   one step. Called with the same (dt, at) shape the live loop uses.
 * @returns {{ simTime: number, steps: number }} The reached time, and how many
 *   steps it took to get there.
 */
export function stepExportClock({ simTime, targetMs, stepMs, step }) {
  if (!Number.isFinite(simTime)) throw new Error('Export clock time is not a number.');
  if (!Number.isFinite(targetMs)) throw new Error('Export frame time is not a number.');
  // A zero or negative step would never reach the target: the loop below would
  // spin forever rather than fail, which is the worst way for this to break.
  if (!Number.isFinite(stepMs) || stepMs <= 0) throw new Error('Export step must be a positive number of milliseconds.');
  if (typeof step !== 'function') throw new Error('Export clock needs a step function.');

  // Frame times are products (i * 1000/fps) while simTime is a running sum of
  // stepMs, so over a long render the two drift apart by float rounding. A
  // frame owed exactly two steps then misses one by ~1e-12 ms and the next
  // frame takes three: a periodic 8ms stutter in the file. The tolerance is
  // relative to the clock's own magnitude and nine orders below the clock,
  // so it forgives rounding, never a real shortfall.
  const tolerance = Math.max(1, Math.abs(targetMs)) * 1e-9;
  let nextSimTime = simTime;
  let steps = 0;
  while (nextSimTime + stepMs <= targetMs + tolerance) {
    nextSimTime += stepMs;
    step(stepMs, nextSimTime);
    steps += 1;
  }
  return { simTime: nextSimTime, steps };
}

/** Stable file name: the song, the size, the rate. Punctuation is kept as dashes. */
export function bulkFileName({ songName = 'song', resolutionId = '1080p', fps = 60 } = {}) {
  const base = String(songName)
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'song';
  return `${base} - ${resolutionId}${fps}.mp4`;
}

/**
 * Two files whose basenames match get the parent folder in the label so
 * a batch does not write one mp4 on top of the other.
 */
export function songLabels(filePaths) {
  const bases = filePaths.map((file) => String(file).split(/[\\/]/).pop() || 'song');
  return filePaths.map((file, i) => {
    const base = bases[i];
    const collision = bases.some((other, j) => j !== i && other.toLowerCase() === base.toLowerCase());
    if (!collision) return base;
    const parts = String(file).split(/[\\/]/).filter(Boolean);
    const parent = parts.length >= 2 ? parts[parts.length - 2] : 'song';
    return `${parent} - ${base}`;
  });
}

export function ffmpegRawArgs({
  width, height, fps, audioPath, outPath, crf = 16, preset = 'medium', encoder = 'libx264', pixels = 'raw',
} = {}) {
  const size = evenExportSize({ w: width, h: height });
  if (!size) throw new Error(`Bad export frame size ${width}x${height}.`);
  if (fps !== 30 && fps !== 60) throw new Error(`Bulk export frame rate must be 30 or 60 (got ${fps}).`);
  const q = Number(crf);
  if (!Number.isInteger(q) || q < 0 || q > 51) throw new Error(`CRF must be an integer from 0 to 51 (got ${crf}).`);
  // NVENC takes the same frames and keeps up with a 4K draw. libx264 at
  // 2160p60 falls behind by more than a second per frame.
  const videoArgs = encoder === 'h264_nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(Math.min(q, 51)), '-b:v', '0', '-profile:v', 'high']
    : ['-c:v', 'libx264', '-preset', preset, '-crf', String(q), '-profile:v', 'high'];
  if (encoder === 'libx264' && !X264_PRESETS.includes(preset)) throw new Error(`Unknown x264 preset "${preset}".`);
  if (encoder !== 'libx264' && encoder !== 'h264_nvenc') {
    throw new Error(`Unknown video encoder "${encoder}". Use libx264 or h264_nvenc.`);
  }
  if (pixels !== 'raw' && pixels !== 'jpeg') throw new Error(`Unknown frame packing "${pixels}".`);
  // JPEG packing is what makes 2160p practical: a raw frame is 33MB and the
  // browser spends longer posting it than drawing it. 0.97 is encoded in
  // the page; ffmpeg only sees the resulting JPEGs.
  const frameInput = pixels === 'jpeg'
    ? ['-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(fps), '-i', 'pipe:0']
    : ['-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${size.w}x${size.h}`, '-framerate', String(fps), '-i', 'pipe:0'];
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...frameInput,
    '-i', audioPath,
    '-map', '0:v:0',
    '-map', '1:a:0?',
    ...videoArgs,
    '-pix_fmt', 'yuv420p',
    '-fps_mode', 'cfr',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-ac', '2',
    '-shortest',
    '-movflags', '+faststart',
    outPath,
  ];
}

function takeOption(args, index, name) {
  const token = args[index];
  const eq = token.indexOf('=');
  if (eq !== -1) return { value: token.slice(eq + 1), next: index + 1 };
  const value = args[index + 1];
  if (value == null || value.startsWith('--')) throw new Error(`${name} needs a value.`);
  return { value, next: index + 2 };
}

/** argv after the node script name. `--help` sets `help`. */
export function parseBulkArgs(argv) {
  const opts = {
    help: false,
    out: 'exports',
    resolutions: null,
    frameRates: null,
    world: null,
    seed: null,
    crf: 16,
    preset: 'medium',
    encoder: 'libx264',
    url: 'http://127.0.0.1:8080',
    maxSeconds: null,
    lyrics: false,
    inputs: [],
    presentation: null,
  };
  const args = [...argv];
  for (let i = 0; i < args.length;) {
    const token = args[i];
    if (token === '--help' || token === '-h') {
      opts.help = true;
      i++;
      continue;
    }
    if (token === '--lyrics') {
      opts.lyrics = true;
      i++;
      continue;
    }
    if (token === '--out' || token.startsWith('--out=')) {
      const got = takeOption(args, i, '--out');
      opts.out = got.value;
      i = got.next;
      continue;
    }
    if (token === '--res' || token === '--resolution' || token.startsWith('--res=') || token.startsWith('--resolution=')) {
      const got = takeOption(args, i, '--res');
      opts.resolutions = parseResolutions(got.value);
      i = got.next;
      continue;
    }
    if (token === '--fps' || token.startsWith('--fps=')) {
      const got = takeOption(args, i, '--fps');
      opts.frameRates = parseFrameRates(got.value);
      i = got.next;
      continue;
    }
    if (token === '--world' || token.startsWith('--world=')) {
      const got = takeOption(args, i, '--world');
      opts.world = got.value;
      i = got.next;
      continue;
    }
    if (token === '--seed' || token.startsWith('--seed=')) {
      const got = takeOption(args, i, '--seed');
      const n = Number(got.value);
      if (!Number.isInteger(n) || n < 0) throw new Error(`--seed must be a non-negative integer (got ${got.value}).`);
      opts.seed = n;
      i = got.next;
      continue;
    }
    if (token === '--crf' || token.startsWith('--crf=')) {
      const got = takeOption(args, i, '--crf');
      const n = Number(got.value);
      if (!Number.isInteger(n) || n < 0 || n > 51) throw new Error(`--crf must be an integer from 0 to 51 (got ${got.value}).`);
      opts.crf = n;
      i = got.next;
      continue;
    }
    if (token === '--encoder' || token.startsWith('--encoder=')) {
      const got = takeOption(args, i, '--encoder');
      if (got.value === 'nvenc' || got.value === 'h264_nvenc') opts.encoder = 'h264_nvenc';
      else if (got.value === 'x264' || got.value === 'libx264') opts.encoder = 'libx264';
      else throw new Error(`--encoder must be x264 or nvenc (got ${got.value}).`);
      i = got.next;
      continue;
    }
    if (token === '--preset' || token.startsWith('--preset=')) {
      const got = takeOption(args, i, '--preset');
      if (!X264_PRESETS.includes(got.value)) {
        throw new Error(`--preset must be one of ${X264_PRESETS.join(', ')} (got ${got.value}).`);
      }
      opts.preset = got.value;
      i = got.next;
      continue;
    }
    if (token === '--url' || token.startsWith('--url=')) {
      const got = takeOption(args, i, '--url');
      opts.url = got.value;
      i = got.next;
      continue;
    }
    if (token === '--max-seconds' || token.startsWith('--max-seconds=')) {
      const got = takeOption(args, i, '--max-seconds');
      const n = Number(got.value);
      if (!(n > 0)) throw new Error(`--max-seconds must be a positive number (got ${got.value}).`);
      opts.maxSeconds = n;
      i = got.next;
      continue;
    }
    const displayKey = ['look', 'quality', 'palette', 'dither', 'dither-mode', 'pixel-grid', 'scaling'].find(key => token === `--${key}` || token.startsWith(`--${key}=`));
    if (displayKey) {
      const got = takeOption(args, i, `--${displayKey}`);
      const choices = { look: ['natural', 'pixel', 'palette'], quality: ['auto', 'economy'], palette: ['world', 'range32', 'chroma32', 'rgb332'], dither: ['off', 'subtle', 'full'], 'dither-mode': ['ordered', 'selective'], 'pixel-grid': ['classic', 'detailed'], scaling: ['fit', 'integer'] };
      if (!choices[displayKey].includes(got.value)) throw new Error(`--${displayKey} must be ${choices[displayKey].join(', ')}`);
      opts.presentation ??= { ...DEFAULT_DISPLAY_PREFS };
      const key = { 'dither-mode': 'ditherMode', 'pixel-grid': 'pixelGrid' }[displayKey] || displayKey;
      opts.presentation[key] = displayKey === 'dither' ? { off: 0, subtle: .35, full: 1 }[got.value] : got.value;
      i = got.next;
      continue;
    }
    if (token.startsWith('--')) throw new Error(`Unknown option ${token}.`);
    opts.inputs.push(token);
    i++;
  }
  if (!opts.resolutions) opts.resolutions = parseResolutions('all');
  if (!opts.frameRates) opts.frameRates = parseFrameRates('all');
  return opts;
}

export const BULK_EXPORT_HELP = `Bulk-render Midio shows to H.264 MP4.

Usage
  node tools/bulk-export.mjs [options] <audio files or folders...>

Each input is rendered at every requested size and frame rate. Default is
the full matrix: 1080p, 1440p, and 2160p, at both 60fps and 30fps. A pass
that asks for both rates draws at 60 and writes the 30fps file from every
other frame. The app must be served (npm start); this starts it on the
given URL when nothing is already listening.

Options
  --out <dir>           Output folder (default: exports)
  --res <list>          1080, 1440, 2160, 4k, or all (default: all)
  --fps <list>          30, 60, or all (default: all)
  --world <id|name>     World id (alpine, city, ...) or card name.
                        Default: the world's own recommendation.
  --seed <n>            Same performance seed for every file in the batch
  --crf <0-51>          Quality. x264 CRF, or NVENC CQ (default: 16)
  --preset <name>       x264 preset (default: medium)
  --encoder <name>      x264 or nvenc (default: x264). nvenc is the
                        NVIDIA encoder and is what makes 2160p60 practical.
  --max-seconds <n>     Stop each file after n seconds of the song
  --url <origin>        App origin (default: http://127.0.0.1:8080)
  --lyrics              Look up timed lyrics. Off by default, so a batch
                        does not wait on the network.
  --look <mode>        natural, pixel, or palette (default: remembered look)
  --quality <mode>     auto or economy
  --palette <name>     world, range32, chroma32, or rgb332
  --dither <amount>    off, subtle, or full
  --dither-mode <mode> selective or ordered (RGB332 always uses ordered)
  --pixel-grid <grid>  classic (320×180) or detailed (640×360, four times the pixel work)
  --scaling <mode>     fit or integer
  --help

Needs ffmpeg on PATH with libx264. Audio is re-encoded to AAC at 192 kbps.
`;
