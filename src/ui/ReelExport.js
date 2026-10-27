// Saving the highlight reel at 4K. The reel keeps 320x180 JPEG thumbnails
// while the song plays (HighlightReel.js); a frame saved from the COMPLETE
// panel is drawn again, at its heard time, through the bulk export clock
// (BulkExport.js), at 3840x2160 and saved as a lossless PNG. The page wiring
// lives in main.js. This module is the pure part, kept free of the DOM so it
// can be tested on its own: which moments to draw and in what order, the
// size ladder, the stepping chunks and the file names.
import { BULK_RESOLUTIONS } from '../render/BulkExport.js';

/** Output sizes, largest first: 3840x2160, then 2560x1440, then 1920x1080. */
export const REEL_SIZES = Object.freeze([...BULK_RESOLUTIONS]
  .sort((a, b) => b.width * b.height - a.width * a.height)
  .map((r) => Object.freeze({ w: r.width, h: r.height })));

/** The size a saved reel frame is drawn at when the device allows it. */
export const REEL_TARGET_SIZE = REEL_SIZES[0];

/** Draws leading into the saved instant, at 60 fps, so the renderer's
 *  frame history (motion-blur ring, echo) holds the frames before it, as it
 *  did when the thumbnail was taken. */
export const REEL_WARMUP_FRAMES = 6;
export const REEL_WARMUP_FPS = 60;

/** Sim time stepped between yields to the page while seeking forward. */
export const REEL_STEP_CHUNK_MS = 2000;

/** `target` first, then every smaller size in REEL_SIZES. A failure at one
 *  size moves on to the next, and the file is named with the size it was
 *  actually drawn at. */
export function sizeLadder(target = REEL_TARGET_SIZE) {
  const area = Number(target?.w) * Number(target?.h);
  if (!(area > 0)) return [...REEL_SIZES];
  const smaller = REEL_SIZES.filter((s) => s.w * s.h < area);
  const own = REEL_SIZES.find((s) => s.w === target.w && s.h === target.h) || Object.freeze({ w: target.w, h: target.h });
  return [own, ...smaller];
}

export const sizeLabel = (size) => `${size.w}×${size.h}`;

/** Lowercase words joined by dashes, at most `max` characters. */
export function slugify(text, fallback = 'frame', max = 48) {
  const slug = String(text ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, max)
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

/** Minutes and seconds with no separator, for a file name: 3:07 -> "0307". */
export function mmss(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}${String(s % 60).padStart(2, '0')}`;
}

/** midio_<song>_<regime>_<mmss>_<W>x<H>.png. The size is the one the frame
 *  was actually drawn at, never the one that was asked for. */
export function reelFileName({ songName = 'song', frame = {}, width, height } = {}) {
  const song = slugify(String(songName).replace(/\.[a-z0-9]{2,4}$/i, ''), 'song');
  const regime = slugify(frame.label || frame.category, 'highlight', 32);
  const at = frame.moment?.atMs ?? frame.atMs;
  return `midio_${song}_${regime}_${mmss(at)}_${width}x${height}.png`;
}

const isSeed = (seed) => (typeof seed === 'number' && Number.isFinite(seed)) || (typeof seed === 'string' && seed !== '');

/** What it takes to draw a reel frame again: its heard time, the seed and
 *  world of the run, and the display preferences and quality floor in
 *  effect when it was taken (HighlightReel.capture records them). Null for
 *  a frame without that record, which cannot be redrawn honestly. */
export function reelMoment(frame) {
  const m = frame?.moment;
  if (!m || typeof m !== 'object') return null;
  const atMs = Number.isFinite(m.atMs) ? m.atMs : frame.atMs;
  if (!Number.isFinite(atMs) || atMs < 0) return null;
  if (!isSeed(m.songSeed) || typeof m.worldId !== 'string' || !m.worldId) return null;
  if (!m.displayPrefs || typeof m.displayPrefs !== 'object') return null;
  return {
    atMs,
    songSeed: m.songSeed,
    worldId: m.worldId,
    displayPrefs: { ...m.displayPrefs },
    qualityLevel: Number.isInteger(m.qualityLevel) && m.qualityLevel >= 0 ? m.qualityLevel : null,
  };
}

const stable = (value) => (value && typeof value === 'object' && !Array.isArray(value)
  ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`
  : JSON.stringify(value ?? null));

/** Frames drawn in one rebuild share a run (seed, world) and a look. */
export function momentKey(moment) {
  return stable({ songSeed: moment.songSeed, worldId: moment.worldId, displayPrefs: moment.displayPrefs, qualityLevel: moment.qualityLevel });
}

/**
 * Which frames to draw, grouped so each group is one rebuild of the song
 * that steps forward through its frames in song order (the export clock
 * only moves forward). `indices` picks frames by position; omitted, every
 * frame. Frames without a usable record are listed as `unavailable`.
 * @returns {{ groups: Array<{ songSeed, worldId, displayPrefs, qualityLevel,
 *   items: Array<{ index: number, atMs: number, frame: object }> }>, unavailable: number[] }}
 */
export function planReelRenders(frames, { indices = null } = {}) {
  const list = Array.isArray(frames) ? frames : [];
  const picked = indices == null ? list.map((_, i) => i)
    : [...new Set(indices)].filter((i) => Number.isInteger(i) && i >= 0 && i < list.length);
  const groups = new Map();
  const unavailable = [];
  for (const index of picked) {
    const moment = reelMoment(list[index]);
    if (!moment) { unavailable.push(index); continue; }
    const key = momentKey(moment);
    if (!groups.has(key)) {
      groups.set(key, { songSeed: moment.songSeed, worldId: moment.worldId, displayPrefs: moment.displayPrefs,
        qualityLevel: moment.qualityLevel, items: [] });
    }
    groups.get(key).items.push({ index, atMs: moment.atMs, frame: list[index] });
  }
  const ordered = [...groups.values()];
  for (const group of ordered) group.items.sort((a, b) => a.atMs - b.atMs || a.index - b.index);
  ordered.sort((a, b) => a.items[0].atMs - b.items[0].atMs);
  return { groups: ordered, unavailable: unavailable.sort((a, b) => a - b) };
}

/** Intermediate targets from `fromMs` to `toMs`, at most `chunkMs` apart,
 *  ending exactly on `toMs`. Empty when there is nothing to step. Stepping
 *  to each in turn takes the same fixed steps as stepping straight to the
 *  end, so the page can breathe between chunks without changing the sim. */
export function stepTargets(fromMs, toMs, chunkMs = REEL_STEP_CHUNK_MS) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || !(chunkMs > 0) || toMs <= fromMs) return [];
  const out = [];
  for (let t = fromMs + chunkMs; t < toMs; t += chunkMs) out.push(t);
  out.push(toMs);
  return out;
}

/** The draws leading into `atMs`, oldest first, ending on `atMs` itself;
 *  none before `fromMs` (where the sim already is) or before 0. */
export function warmupTimes(atMs, { fromMs = 0, frames = REEL_WARMUP_FRAMES, fps = REEL_WARMUP_FPS } = {}) {
  const out = [];
  for (let k = frames; k >= 1; k--) {
    const t = atMs - (k * 1000) / fps;
    if (t >= Math.max(0, fromMs)) out.push(t);
  }
  out.push(atMs);
  return out;
}

/**
 * One line for the player about a finished save. `saved` holds
 * { index, width, height } per file, `failures` { size, reason } per size
 * that did not work, `unsaved` the indices nothing could draw, and
 * `unavailable` the frames with no record to redraw from.
 * @returns {{ ok: boolean, message: string }} ok when every frame asked for
 *   was saved at the target size.
 */
export function describeReelSave({ target = REEL_TARGET_SIZE, saved = [], failures = [], unsaved = [], unavailable = [] } = {}) {
  const parts = [];
  const small = saved.filter((s) => s.width !== target.w || s.height !== target.h);
  const reason = failures.length ? failures[0].reason : '';
  if (small.length) {
    const sizes = [...new Set(small.map((s) => `${s.width}×${s.height}`))].join(', ');
    parts.push(`${small.length === 1 ? 'One frame was' : `${small.length} frames were`} saved at ${sizes}, because ${sizeLabel(target)} did not work here${reason ? ` (${reason})` : ''}.`);
  }
  if (unsaved.length) {
    parts.push(`${unsaved.length === 1 ? 'One frame' : `${unsaved.length} frames`} could not be drawn at any size${reason ? `: ${failures[failures.length - 1].reason}` : ''}.`);
  }
  if (unavailable.length) {
    parts.push(`${unavailable.length === 1 ? 'One frame has' : `${unavailable.length} frames have`} no record of the moment and cannot be redrawn; the thumbnail is still available.`);
  }
  return { ok: parts.length === 0, message: parts.join(' ') };
}
