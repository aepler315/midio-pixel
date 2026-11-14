// Offline, fixed-clock H.264/AAC export. The page owns rebuilding/restoring
// the song; this module owns encoding the exact frames it asks the page for.
// No microphone, captureStream, live audio clock or server is involved.
import { MP4_EXPORT_DEFAULTS, MP4_EXPORT_RESOLUTIONS, normalizeValue, settingDefinition } from '../config/settingsRegistry.js';
export { MP4_EXPORT_DEFAULTS, MP4_EXPORT_RESOLUTIONS } from '../config/settingsRegistry.js';

// Maximum encoded file bytes retained by the memory sink. This is not a cap
// on total browser memory: canvas/codec/muxer work and a Blob snapshot add
// overhead. Fixed pages avoid BufferTarget's power-of-two growth allocations.
export const MAX_MP4_BUFFER_BYTES = 512 * 1024 * 1024;
const AUDIO_BITRATE = 192_000;
const AUDIO_CHUNK_FRAMES = 4096;
const MP4_MEMORY_PAGE_BYTES = 1024 * 1024;

/** A seekable, bounded output sink for MP4 header backpatches. Every write's
 * final offset is admitted before allocating or copying any destination page.
 * Each backing allocation is at most pageBytes; no full-film ArrayBuffer is
 * created. toBlob() snapshots the pages, then releases our page references. */
export function createMp4MemorySink({ maxBytes = MAX_MP4_BUFFER_BYTES, pageBytes = MP4_MEMORY_PAGE_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(pageBytes) || pageBytes <= 0) {
    throw new Error('MP4 output byte and page limits must be positive integers.');
  }
  let pages = [], size = 0, allocated = 0;
  const clear = () => { pages = []; size = 0; allocated = 0; };
  const writable = new WritableStream({
    write({ type, position, data }) {
      if (type !== 'write' || !(data instanceof Uint8Array) || !Number.isSafeInteger(position) || position < 0) {
        throw new Error('Invalid MP4 output write.');
      }
      // Subtraction also rejects lengths that would overflow the safe range.
      if (position > maxBytes - data.byteLength) {
        throw new Error(`The video exceeded the ${maxBytes} byte encoded-output limit. Save directly to a file, or choose a smaller resolution.`);
      }
      if (!data.byteLength) return;
      const end = position + data.byteLength;
      while (pages.length < Math.ceil(end / pageBytes)) {
        const count = Math.min(pageBytes, maxBytes - allocated);
        pages.push(new Uint8Array(count));
        allocated += count;
      }
      let copied = 0;
      while (copied < data.byteLength) {
        const at = position + copied, index = Math.floor(at / pageBytes), offset = at % pageBytes;
        const count = Math.min(data.byteLength - copied, pages[index].byteLength - offset);
        pages[index].set(data.subarray(copied, copied + count), offset);
        copied += count;
      }
      size = Math.max(size, end);
    },
    abort: clear,
  });
  return {
    writable, clear,
    get bytes() { return size; },
    get allocatedBytes() { return allocated; },
    toBlob() {
      const blob = new Blob(pages.map((page, index) => page.subarray(0, Math.min(page.byteLength, size - index * pageBytes))),
        { type: 'video/mp4' });
      clear();
      return blob;
    },
  };
}

export function resolveMp4ExportSettings(settings = {}) {
  const raw = String(settings.resolutionId ?? MP4_EXPORT_DEFAULTS.resolutionId).toLowerCase();
  const id = raw === '4k' ? '2160p' : /^\d+$/.test(raw) ? `${raw}p` : raw;
  const resolution = MP4_EXPORT_RESOLUTIONS.find(item => item.id === id);
  if (!resolution) throw new Error(`Unknown video resolution "${raw}".`);
  const fps = normalizeValue(settingDefinition('mp4Fps'), settings.fps ?? MP4_EXPORT_DEFAULTS.fps);
  if (fps === undefined) throw new Error('Video export needs 30 or 60 fps.');
  return {
    resolutionId: resolution.id, width: resolution.width, height: resolution.height, fps,
    videoBitrate: Math.round(Math.max(1_000_000, Math.min(80_000_000, resolution.width * resolution.height * fps * .12))),
    audioBitrate: AUDIO_BITRATE,
  };
}

/** A conservative estimate for choosing a disk destination before rendering.
 * Actual byte growth is checked too; variable-bitrate encoders can exceed it. */
export function estimateMp4ExportBytes(settings, durationMs) {
  const resolved = resolveMp4ExportSettings(settings);
  return Math.ceil((resolved.videoBitrate + resolved.audioBitrate) * Math.max(0, Number(durationMs) || 0) / 8000 * 1.2);
}

export function mp4ExportFileName({ songName = 'song', settings = MP4_EXPORT_DEFAULTS } = {}) {
  const resolved = resolveMp4ExportSettings(settings);
  const name = String(songName).replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '-').replace(/\p{Cc}/gu, '-').replace(/\s+/g, ' ').trim().slice(0, 100) || 'song';
  return `${name} - ${resolved.resolutionId}${resolved.fps}.mp4`;
}

const abortError = () => new DOMException('Video export cancelled.', 'AbortError');
const defaultYield = () => new Promise(resolve => setTimeout(resolve, 0));
const loadLibrary = () => import('../vendor/export/mediabunny.module.js');

function audioInfo(buffer) {
  const { sampleRate, length, numberOfChannels } = buffer || {};
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isInteger(length) || length <= 0
    || !Number.isInteger(numberOfChannels) || numberOfChannels < 1 || typeof buffer.getChannelData !== 'function') {
    throw new Error('Load a song with decoded audio before exporting a video.');
  }
  return { sampleRate, length, numberOfChannels, durationMs: length / sampleRate * 1000 };
}

/** Probe the exact requested video size/cadence and the song's audio format
 * before the page spends time rebuilding its landscape. No output is opened. */
export async function checkMp4ExportSupport({ settings = MP4_EXPORT_DEFAULTS, audioBuffer, library = null } = {}) {
  const resolved = resolveMp4ExportSettings(settings), audio = audioInfo(audioBuffer);
  const media = library || await loadLibrary();
  const quality = new media.Quality({ bitrate: resolved.videoBitrate });
  const audioQuality = new media.Quality({ bitrate: resolved.audioBitrate });
  const [videoSupported, audioSupported] = await Promise.all([
    media.canEncodeVideo('avc', { width: resolved.width, height: resolved.height, frameRate: resolved.fps,
      quality, latencyMode: 'quality' }),
    media.canEncodeAudio('aac', { sampleRate: audio.sampleRate, numberOfChannels: audio.numberOfChannels, quality: audioQuality }),
  ]);
  if (!videoSupported) throw new Error(`This browser cannot encode H.264 at ${resolved.width}×${resolved.height} and ${resolved.fps} fps. Try a smaller export or another browser.`);
  if (!audioSupported) throw new Error('This browser cannot encode the song as AAC audio. Try another browser with AAC encoding support.');
  return { settings: resolved, media, quality, audioQuality };
}

/**
 * Encode the current song from its decoded original audio and completed canvas.
 * `renderFrame(timeMs)` must draw that exact heard time, settle asynchronous
 * terrain if necessary, and return {presented:true,width,height}. It is awaited
 * before reading the canvas. All timestamps are generated here, independently
 * of the speed at which rendering or encoding completes.
 *
 * Pass a FileSystemWritableFileStream as `writable` for large movies. Otherwise
 * the result contains a video/mp4 Blob, capped at 512 MiB of encoded output.
 * Browser/codec/muxer allocations and the Blob snapshot require extra memory.
 * The supplied writable belongs to this call: success closes it, any failure
 * (including preflight) aborts it. The caller must not close it a second time.
 * A rejected/cancelled export never returns or commits a partial movie.
 */
export async function exportMp4(options = {}) {
  // StreamTarget closes its stream even when Output.cancel() is called. Keep
  // the actual file transaction outside that lifecycle so Cancel rolls it back.
  const writer = options.writable?.getWriter();
  try {
    const writable = writer ? new WritableStream({ write: chunk => writer.write(chunk) }) : null;
    const result = await encodeMp4({ ...options, writable });
    if (writer) await writer.close();
    return result;
  } catch (err) {
    if (writer) await writer.abort(err).catch(() => {});
    throw err;
  } finally {
    writer?.releaseLock();
  }
}

async function encodeMp4({
  canvas, audioBuffer, settings = MP4_EXPORT_DEFAULTS, renderFrame,
  signal = null, onProgress = () => {}, yieldControl = defaultYield,
  writable = null, library = null,
} = {}) {
  const check = () => { if (signal?.aborted) throw abortError(); };
  check();
  const resolved = resolveMp4ExportSettings(settings);
  const audio = audioInfo(audioBuffer);
  if (typeof renderFrame !== 'function') throw new Error('Video export needs a frame renderer.');
  if (canvas?.width !== resolved.width || canvas?.height !== resolved.height) {
    throw new Error(`Video canvas size must be ${resolved.width}×${resolved.height}.`);
  }
  if (!writable && estimateMp4ExportBytes(resolved, audio.durationMs) > MAX_MP4_BUFFER_BYTES) {
    throw new Error('This video is too large to hold in memory. Save directly to a file, or choose a smaller resolution.');
  }
  const { media, quality, audioQuality } = await checkMp4ExportSupport({ settings: resolved, audioBuffer, library });
  check();
  const videoOptions = { codec: 'avc', quality, latencyMode: 'quality', keyFrameInterval: 2, sizeChangeBehavior: 'deny' };

  let bytes = 0;
  const memory = writable ? null : createMp4MemorySink();
  const target = new media.StreamTarget(writable || memory.writable, { chunked: true, chunkSize: MP4_MEMORY_PAGE_BYTES });
  target.onwrite = (start, end) => {
    bytes = Math.max(bytes, end);
    if (!writable && bytes > MAX_MP4_BUFFER_BYTES) throw new Error('The video exceeded the 512 MiB encoded-output limit. Save directly to a file, or choose a smaller resolution.');
  };
  const output = new media.Output({ target, format: new media.Mp4OutputFormat({ fastStart: false }) });
  let cancelPromise = null;
  const cancel = () => (cancelPromise ||= Promise.resolve().then(() => output.cancel()).catch(() => {}));
  let rejectAbort;
  const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
  // The rejection is also observed when an abort arrives between awaits.
  aborted.catch(() => {});
  const onAbort = () => { rejectAbort(abortError()); void cancel(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const wait = async promise => { const value = await Promise.race([promise, aborted]); check(); return value; };
  const totalFrames = Math.max(1, Math.ceil(audio.length * resolved.fps / audio.sampleRate));
  const report = (phase, frame) => onProgress({ phase, frame, totalFrames, progress: frame / totalFrames,
    timeMs: Math.min(audio.durationMs, frame * 1000 / resolved.fps), durationMs: audio.durationMs, bytes });
  try {
    check();
    const video = new media.CanvasSource(canvas, videoOptions);
    const sound = new media.AudioSampleSource({ codec: 'aac', quality: audioQuality });
    output.addVideoTrack(video, { frameRate: resolved.fps });
    output.addAudioTrack(sound);
    await wait(output.start());
    report('encoding', 0);
    let audioAt = 0;
    for (let i = 0; i < totalFrames; i++) {
      check();
      const frame = await wait(Promise.resolve(renderFrame(i * 1000 / resolved.fps)));
      if (!frame?.presented) throw new Error('The export frame did not finish drawing.');
      if (frame.width !== resolved.width || frame.height !== resolved.height
        || canvas.width !== resolved.width || canvas.height !== resolved.height) {
        throw new Error(`The export frame size changed; expected ${resolved.width}×${resolved.height}.`);
      }
      await wait(video.add(i / resolved.fps, 1 / resolved.fps));
      // Feed both tracks together. Adding the entire audio first would let
      // the MP4 interleaver hold all of its encoded packets until video caught up.
      const audioEnd = Math.min(audio.length, Math.round((i + 1) * audio.sampleRate / resolved.fps));
      while (audioAt < audioEnd) {
        const count = Math.min(AUDIO_CHUNK_FRAMES, audioEnd - audioAt);
        const data = new Float32Array(count * audio.numberOfChannels);
        for (let ch = 0; ch < audio.numberOfChannels; ch++) {
          data.set(audioBuffer.getChannelData(ch).subarray(audioAt, audioAt + count), ch * count);
        }
        const sample = new media.AudioSample({ data, format: 'f32-planar', sampleRate: audio.sampleRate,
          numberOfChannels: audio.numberOfChannels, timestamp: audioAt / audio.sampleRate });
        try { await wait(sound.add(sample)); } finally { sample.close(); }
        audioAt += count;
      }
      report('encoding', i + 1);
      // Promise backpressure bounds queued frames. A task yield also keeps
      // Cancel and the status display responsive when encoders resolve instantly.
      if (i % 4 === 0 || i === totalFrames - 1) await wait(Promise.resolve(yieldControl()));
    }
    video.close(); sound.close();
    report('finalizing', totalFrames);
    await wait(output.finalize());
    const blob = memory?.toBlob() ?? null;
    bytes = blob?.size ?? bytes;
    report('complete', totalFrames);
    return { blob, bytes, frames: totalFrames, width: resolved.width, height: resolved.height, fps: resolved.fps,
      durationMs: audio.durationMs, settings: resolved };
  } catch (err) {
    await cancel();
    throw signal?.aborted ? abortError() : err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    memory?.clear();
  }
}
