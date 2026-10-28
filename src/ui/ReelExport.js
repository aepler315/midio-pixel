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
 *  a frame without that record, which cannot be redrawn honestly.
 *
 *  It also carries what the redraw cannot reproduce: `sceneStartMs` (where
 *  the scene that drew the frame started; above 0 after a seek, a mid-song
 *  rebuild on the whole analysis, an in-room start or a world switch),
 *  `continued` (that scene carried on a previous scene's chapter plan,
 *  camera tours or landscape history) and `analysis` ('opening' or 'full',
 *  the analysis the scene was built on). */
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
    sceneStartMs: Number.isFinite(m.sceneStartMs) && m.sceneStartMs > 0 ? m.sceneStartMs : 0,
    continued: m.continued === true,
    analysis: m.analysis === 'opening' || m.analysis === 'full' ? m.analysis : null,
  };
}

/**
 * Why a redraw of `moment` is not the frame that was captured, as a list of
 * reasons (empty when it is faithful). The redraw always rebuilds the song
 * from 0 on the analysis the song holds now (`analysis`, 'opening' or
 * 'full'), so:
 * - 'scene': the frame was drawn by a scene built part-way through the song
 *   (a seek, the mid-song rebuild on the whole analysis, an in-room start,
 *   a world or tour switch) or one that continued an earlier scene's camera
 *   tours and landscape history. The from-0 performance can take another
 *   shot route or landscape score at that heard time.
 * - 'analysis': the frame was drawn on a different analysis than the song
 *   holds now (it ended on its opening analysis and the whole analysis
 *   landed later, upgrading the song in place). Palette, sections, sky
 *   clock and regime peaks can differ. An unknown analysis on either side
 *   counts as different.
 */
export function approximationReasons(moment, { analysis = null } = {}) {
  const reasons = [];
  if (!moment) return reasons;
  if (moment.sceneStartMs > 0 || moment.continued) reasons.push('scene');
  if (!moment.analysis || !analysis || moment.analysis !== analysis) reasons.push('analysis');
  return reasons;
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
 * `analysis` is the analysis the song holds now ('opening' or 'full'); each
 * item lists in `approximate` why its redraw may differ from the capture
 * (approximationReasons).
 * @returns {{ groups: Array<{ songSeed, worldId, displayPrefs, qualityLevel,
 *   items: Array<{ index: number, atMs: number, frame: object, approximate: string[] }> }>, unavailable: number[] }}
 */
export function planReelRenders(frames, { indices = null, analysis = 'full' } = {}) {
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
    groups.get(key).items.push({ index, atMs: moment.atMs, frame: list[index],
      approximate: approximationReasons(moment, { analysis }) });
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
 * { index, width, height, approximate } per file, `failures`
 * { size, reason } per size that did not work, `unsaved` the indices
 * nothing could draw, `unavailable` the frames with no record to redraw
 * from, and `error` the reason a save stopped early (not a size problem).
 * @returns {{ ok: boolean, message: string }} ok when every frame asked for
 *   was drawn at the target size, faithfully, with nothing left over.
 */
export function describeReelSave({ target = REEL_TARGET_SIZE, saved = [], failures = [], unsaved = [], unavailable = [], error = null } = {}) {
  const parts = [];
  const frames = (n, one, many) => (n === 1 ? one : many.replace('#', n));
  if (error) parts.push(`The save stopped: ${error}.`);
  const small = saved.filter((s) => s.width !== target.w || s.height !== target.h);
  const reason = failures.length ? failures[0].reason : '';
  if (small.length) {
    const sizes = [...new Set(small.map((s) => `${s.width}×${s.height}`))].join(', ');
    parts.push(`${frames(small.length, 'One frame was', '# frames were')} drawn at ${sizes}, because ${sizeLabel(target)} did not work here${reason ? ` (${reason})` : ''}.`);
  }
  const scene = saved.filter((s) => s.approximate?.includes('scene')).length;
  if (scene) {
    parts.push(`${frames(scene, 'One frame was', '# frames were')} captured in a scene rebuilt part-way through the song (a seek, a world switch or the whole analysis arriving); the redraw plays the song from the start, so the camera and landscape may differ from the thumbnail.`);
  }
  const analysis = saved.filter((s) => s.approximate?.includes('analysis')).length;
  if (analysis) {
    parts.push(`${frames(analysis, 'One frame was', '# frames were')} captured on a different analysis of the song than it holds now, so colors and sections may differ from the thumbnail.`);
  }
  if (unsaved.length) {
    const last = failures.length ? failures[failures.length - 1].reason : '';
    parts.push(`${frames(unsaved.length, 'One frame', '# frames')} could not be drawn${error ? '' : ' at any size'}${last && !error ? `: ${last}` : ''}.`);
  }
  if (unavailable.length) {
    parts.push(`${frames(unavailable.length, 'One frame has', '# frames have')} no record of the moment and cannot be redrawn; the thumbnail is still available.`);
  }
  return { ok: parts.length === 0, message: parts.join(' ') };
}

/** Thrown by a save's `check` when something else took the page. */
export class ReelSaveCancelled extends Error {
  constructor(message = 'superseded') { super(message); this.name = 'ReelSaveCancelled'; }
}

/** A failure that a smaller size may avoid: the stage could not be armed
 *  at the size, the frame did not finish drawing, or the PNG could not be
 *  encoded. Any other error stops the save instead of using up the ladder. */
export class ReelSizeError extends Error {
  constructor(message) { super(message); this.name = 'ReelSizeError'; }
}

/** Classify an error thrown while arming the rebuild at `size`. The first
 *  frame failing to present (the export tears itself down before throwing,
 *  so the error carries `presentationFailure`) and a stage armed at another
 *  size are size failures; anything else is thrown as it is. */
export function classifyArmError(err, { armed = false, stage = null, size = null } = {}) {
  if (err instanceof ReelSizeError || err instanceof ReelSaveCancelled) return err;
  if (err?.presentationFailure) return new ReelSizeError(err.message || 'the first frame did not present');
  if (armed && stage && size && (stage.w !== size.w || stage.h !== size.h)) {
    return new ReelSizeError(`the stage came up at ${stage.w}×${stage.h}, not ${size.w}×${size.h}`);
  }
  return err;
}

/**
 * The save loop, with the page's work passed in as callbacks so it can be
 * tested without a DOM. One saver runs one save at a time: `run` while a
 * save is running resolves to { status: 'busy' } and does nothing.
 *
 * For each group of the plan, each size of the ladder (largest first) gets
 * a fresh rebuild (`begin(group, size)`); its pending frames are drawn in
 * song order (`draw(item, size)`), encoded (`encode(item, size)` resolving
 * to { blob, width, height }) and handed to `save(item, file)`. A
 * ReelSizeError moves the frames not yet saved to the next size, from a new
 * rebuild; frames already saved stay at the size they were drawn at. Any
 * other error stops the save. `check()` throws ReelSaveCancelled when the
 * page was taken; then `cancel()` runs and neither `end` nor a report does.
 * Otherwise `end()` always runs (restore the page) and the result carries
 * the report (describeReelSave).
 *
 * `available(group)`, when given, returns false for a group that cannot be
 * rebuilt at all (its world is gone); its frames are unsaved.
 */
export function createReelSaver() {
  let busy = false;
  return {
    get busy() { return busy; },
    async run({ plan, target = REEL_TARGET_SIZE, begin, draw, encode, save, check = () => {}, end = () => {},
      cancel = () => {}, available = null, onProgress = null }) {
      if (busy) return { status: 'busy' };
      busy = true;
      const saved = [], failures = [], unsaved = [];
      const groups = plan?.groups || [];
      const total = groups.reduce((n, g) => n + g.items.length, 0);
      let error = null, cancelled = false, gi = 0, pending = [];
      try {
        for (; gi < groups.length; gi++) {
          const group = groups[gi];
          pending = [...group.items];
          if (available && !available(group)) {
            failures.push({ size: target, reason: 'the world it was drawn in is no longer available' });
            unsaved.push(...pending.map((item) => item.index));
            pending = [];
            continue;
          }
          for (const size of sizeLadder(target)) {
            if (!pending.length) break;
            try {
              await begin(group, size);
              check();
              for (const item of [...pending]) {
                await draw(item, size);
                check();
                const file = await encode(item, size);
                check();
                await save(item, file);
                saved.push({ index: item.index, width: file.width, height: file.height, approximate: item.approximate || [] });
                pending = pending.filter((p) => p !== item);
                onProgress?.({ saved: saved.length, total });
              }
            } catch (err) {
              // A failure while the page was being taken is the cancel.
              check();
              if (!(err instanceof ReelSizeError)) throw err;
              failures.push({ size, reason: err.message });
            }
          }
          unsaved.push(...pending.map((item) => item.index));
          pending = [];
        }
      } catch (err) {
        cancelled = err instanceof ReelSaveCancelled;
        if (!cancelled) {
          try { check(); } catch (cause) { cancelled = cause instanceof ReelSaveCancelled; }
        }
        if (!cancelled) {
          error = err?.message || String(err);
          // Everything not saved yet is left unsaved.
          unsaved.push(...pending.map((item) => item.index));
          for (const g of groups.slice(gi + 1)) unsaved.push(...g.items.map((item) => item.index));
        }
      }
      try {
        if (cancelled) await cancel();
        else await end();
      } finally {
        busy = false;
      }
      if (cancelled) return { status: 'cancelled', saved };
      const report = describeReelSave({ target, saved, failures, unsaved, unavailable: plan?.unavailable || [], error });
      return { status: 'done', saved, failures, unsaved, error, report };
    },
  };
}
