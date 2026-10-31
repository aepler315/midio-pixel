// Pixel detail stepping and the "save this moment at every detail level"
// snapshot. The page wiring lives in main.js; this module is the order of the
// levels, the file names and the capture sequence, kept free of the DOM so it
// can be tested on its own.

/** Coarsest to finest, the order of the Display menu's Pixel detail. */
export const DETAIL_LEVELS = Object.freeze(['classic', 'classicPlus', 'medium', 'mediumPlus', 'detailed']);

/** Android head units have limited memory and often block multiple downloads.
 * Save the current frame once, at its live size, instead of allocating five
 * full-HD render targets and starting five downloads in quick succession. */
export function snapshotCapturePlan(userAgent, currentLevel) {
  if (/Android/i.test(userAgent || '')) {
    return { levels: [DETAIL_LEVELS.includes(currentLevel) ? currentLevel : 'classic'], size: null };
  }
  return { levels: DETAIL_LEVELS, size: { w: 1920, h: 1080 } };
}

/** The level `delta` steps from `current`, held at either end. */
export function stepDetail(current, delta) {
  const at = DETAIL_LEVELS.indexOf(current);
  const from = at < 0 ? 0 : at;
  return DETAIL_LEVELS[Math.max(0, Math.min(DETAIL_LEVELS.length - 1, from + Math.sign(delta)))];
}

const pad = (n) => String(n).padStart(2, '0');

/** midio_YYYYMMDD_<level>.png in local time: one file per detail level. */
export function snapshotFileName(date, level) {
  return `midio_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${level}.png`;
}

/**
 * Renders and saves the same held moment once per level, in order.
 *   render(level) -> Promise<canvas>   draw that level, resolve the finished output
 *   save(level, canvas) -> Promise     encode and hand the file over
 * Stops at the first failure; the caller restores its own state.
 */
export async function captureDetailSnapshots({ levels = DETAIL_LEVELS, render, save }) {
  const saved = [];
  for (const level of levels) {
    const output = await render(level);
    await save(level, output);
    saved.push(level);
  }
  return saved;
}

/** Lossless PNG of a canvas (full quality: no scaling, no JPEG). */
export function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('the frame could not be encoded'))), 'image/png');
    } catch (error) {
      reject(error);
    }
  });
}
