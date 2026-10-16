// Turning a performance into a file.
//
// The app already draws the show; exporting it is a question of *what
// container and codec the browser will actually give us*, and of being
// straight with the player about what they ended up with. That second part
// is the whole reason this module exists rather than a one-line
// `new MediaRecorder(stream)`:
//
//   MediaRecorder.isTypeSupported('video/mp4') answers true in a Chromium
//   build with no proprietary codecs -- and then hands back VP9 inside an
//   MP4 container. That file has the right extension, opens fine in a
//   browser, and is rejected by a car head unit, a TV, and most hardware
//   players. Handing someone that file and calling it an MP4 is worse than
//   telling them their browser cannot make one.
//
// So the ladder below asks for codecs explicitly, and what comes back is
// labelled by the reach it actually has, not by its file extension.
//
// Everything here is pure. The recorder that uses it lives in
// SongRecorder.js.

/** The logical stage. Every world draws 16:9 at this size regardless of the
 *  backing-store resolution the perf governor picks. */
export const STAGE_W = 1280;
export const STAGE_H = 720;

/**
 * Output sizes worth offering.
 *
 * `car` is the odd one and the reason the letterbox maths below exists: a
 * double-DIN head unit is 800x480 (5:3), not 16:9, so the show has to be
 * fitted into it rather than stretched to it. The Pioneer DMH-W3000NEX and
 * most of its class are exactly this panel.
 *
 * Widths and heights are all even. H.264 chroma is subsampled 2x2, and an
 * odd dimension is either rejected outright or silently rounded by the
 * encoder.
 */
export const RENDER_PRESETS = [
  {
    id: 'car', label: 'Car display', width: 800, height: 480,
    note: 'Fits a double-DIN head unit (800×480). Letterboxed, not stretched.',
  },
  {
    id: '480p', label: '480p', width: 854, height: 480,
    note: 'Small file, fine on a phone.',
  },
  {
    id: '720p', label: '720p', width: 1280, height: 720,
    note: 'The stage at its own size — no rescaling at all.',
  },
  {
    id: '1080p', label: '1080p', width: 1920, height: 1080,
    note: 'Upscaled from the 1280×720 stage. Bigger file, not more detail.',
  },
];

export const DEFAULT_PRESET_ID = '720p';

export function presetById(id) {
  return RENDER_PRESETS.find((p) => p.id === id) || RENDER_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID);
}

/**
 * Container/codec candidates, best first.
 *
 * `reach` is the honest claim about where the resulting file will play:
 *
 *   'anywhere'  H.264 in MP4. Car head units, TVs, phones, editors.
 *   'unknown'   An MP4 container whose codec the browser chose for us --
 *               possibly VP9, which hardware players reject. Usable on a
 *               computer; not to be promised to a head unit.
 *   'browsers'  WebM. Fine on a computer, useless on most hardware.
 */
export const MIME_CANDIDATES = [
  { mimeType: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', ext: 'mp4', video: 'H.264', audio: 'AAC', reach: 'anywhere' },
  { mimeType: 'video/mp4;codecs="avc1.4D401F,mp4a.40.2"', ext: 'mp4', video: 'H.264', audio: 'AAC', reach: 'anywhere' },
  { mimeType: 'video/mp4;codecs=avc1', ext: 'mp4', video: 'H.264', audio: null, reach: 'anywhere' },
  { mimeType: 'video/mp4', ext: 'mp4', video: null, audio: null, reach: 'unknown' },
  { mimeType: 'video/webm;codecs="vp9,opus"', ext: 'webm', video: 'VP9', audio: 'Opus', reach: 'browsers' },
  { mimeType: 'video/webm;codecs="vp8,opus"', ext: 'webm', video: 'VP8', audio: 'Opus', reach: 'browsers' },
  { mimeType: 'video/webm', ext: 'webm', video: null, audio: null, reach: 'browsers' },
];

/**
 * The best type this browser will record, or null if it records nothing.
 *
 * `isSupported` is injected rather than reached for so the ladder can be
 * tested against every browser shape without running those browsers.
 */
export function pickMimeType(isSupported) {
  if (typeof isSupported !== 'function') return null;
  for (const candidate of MIME_CANDIDATES) {
    let ok;
    try { ok = !!isSupported(candidate.mimeType); } catch { ok = false; }
    if (ok) return candidate;
  }
  return null;
}

/** One sentence the UI can show before recording, and mean. */
export function reachSummary(candidate) {
  if (!candidate) return 'This browser cannot record video. Chrome or Edge can.';
  if (candidate.reach === 'anywhere') return 'H.264 MP4 — plays on car head units, TVs and phones.';
  if (candidate.reach === 'unknown') {
    return 'MP4, but this browser picks the codec and it may not be H.264 — fine on a computer, '
      + 'not guaranteed on a car head unit. Chrome or Edge will give you H.264.';
  }
  return 'WebM — plays in browsers, but not on most car head units or TVs. Chrome or Edge will give you MP4.';
}

/**
 * Fit a 16:9 source into any target without distorting it.
 *
 * Centred, aspect preserved, rounded to whole pixels. A 5:3 car panel gets
 * 800x450 of picture with a 15px bar top and bottom; a 16:9 target gets the
 * whole frame and no bars at all.
 */
export function fitLetterbox(srcW, srcH, dstW, dstH) {
  if (!(srcW > 0 && srcH > 0 && dstW > 0 && dstH > 0)) return { x: 0, y: 0, width: 0, height: 0 };
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const width = Math.round(srcW * scale);
  const height = Math.round(srcH * scale);
  return { x: Math.round((dstW - width) / 2), y: Math.round((dstH - height) / 2), width, height };
}

/** Does this target need bars? Used only to decide whether the compositor
 *  has to clear before drawing. */
export function needsLetterbox(srcW, srcH, dstW, dstH) {
  const fit = fitLetterbox(srcW, srcH, dstW, dstH);
  return fit.width !== dstW || fit.height !== dstH;
}

/** Bits per pixel per frame. Tuned up from the usual 0.07-0.08 for live
 *  action: this content is dark gradients, glows and particle fields, which
 *  is where banding shows first and where a stingy bitrate looks worst. */
const BITS_PER_PIXEL = 0.1;
/** Past this the file grows faster than the picture improves, and a long
 *  song stops fitting in memory -- the whole recording is held as chunks
 *  until it is saved. */
const MAX_BITS_PER_SECOND = 12_000_000;
const MIN_BITS_PER_SECOND = 800_000;

export function videoBitsPerSecond(width, height, fps = 60) {
  if (!(width > 0 && height > 0 && fps > 0)) return MIN_BITS_PER_SECOND;
  const raw = Math.round(width * height * fps * BITS_PER_PIXEL);
  return Math.min(MAX_BITS_PER_SECOND, Math.max(MIN_BITS_PER_SECOND, raw));
}

export const AUDIO_BITS_PER_SECOND = 160_000;

/** What the finished file will weigh, roughly. Shown before recording
 *  starts, because "1080p" and "this will be 400MB" are the same decision
 *  and the player should get to make it once. */
export function estimateBytes({ width, height, fps = 60, durationMs = 0 } = {}) {
  const seconds = Math.max(0, durationMs) / 1000;
  const bits = (videoBitsPerSecond(width, height, fps) + AUDIO_BITS_PER_SECOND) * seconds;
  return Math.round(bits / 8);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/** m:ss for a recording readout. */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * A filename someone can find again: the song, the size, the date.
 *
 * Every character a filesystem might object to is replaced rather than
 * dropped, so two songs whose names differ only in punctuation do not
 * collapse to the same file.
 */
export function exportFileName({ songName = 'song', presetId = '', ext = 'mp4', date = new Date() } = {}) {
  const base = String(songName)
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'song';
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  return [base, presetId, stamp].filter(Boolean).join(' - ') + '.' + ext;
}

/**
 * What codec actually ended up in the file.
 *
 * A heuristic, and deliberately one: the sample-entry four-character code
 * (`avc1`, `vp09`, `av01`...) appears in the `stsd` box, and scanning the
 * head of the file for it is enough to label what we produced without
 * shipping an MP4 parser. It is used to TELL the player what they have --
 * never to reject a file -- so a miss costs a vaguer sentence and nothing
 * else.
 *
 * MP4 writes its metadata at the front when the recorder finalises it;
 * WebM is reported from the container instead, since it has no `stsd`.
 */
export function sniffVideoCodec(bytes) {
  if (!bytes || !bytes.length) return null;
  const limit = Math.min(bytes.length, 65536);
  const fourcc = (offset, text) => {
    for (let i = 0; i < 4; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
    return true;
  };
  for (let i = 0; i + 4 <= limit; i++) {
    if (fourcc(i, 'avc1') || fourcc(i, 'avc3')) return 'H.264';
    if (fourcc(i, 'hvc1') || fourcc(i, 'hev1')) return 'HEVC';
    if (fourcc(i, 'vp09')) return 'VP9';
    if (fourcc(i, 'av01')) return 'AV1';
  }
  return null;
}

/**
 * The line shown once a file exists, from what it turned out to be rather
 * than what was asked for.
 *
 * This is where the VP9-in-MP4 trap is finally closed: the container said
 * mp4, the extension says mp4, and only the bytes know whether a head unit
 * will play it.
 */
export function describeResult({ candidate, codec, bytes, durationMs } = {}) {
  const size = formatBytes(bytes);
  const length = formatElapsed(durationMs);
  const container = (candidate?.ext || 'file').toUpperCase();
  if (codec === 'H.264') return `${container} · H.264 · ${length} · ${size} — plays anywhere, including car head units.`;
  if (codec) return `${container} · ${codec} · ${length} · ${size} — plays on computers and phones; most car head units and TVs will not decode ${codec}.`;
  return `${container} · ${length} · ${size}`;
}
