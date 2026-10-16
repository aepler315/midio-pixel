// The crest a scanned strip is baked with, at the size the game draws.
// generateSilhouette stores these ridgeYs on the bitmap; the pixels are
// only a softened fill under that same line. Reading the line along the
// whole pass, one stage-width view at a time, is the check — not one frame.
import { resampleHeights, layoutRidgeYs, ALPINE_AMP_GAIN } from '../SilhouetteGenerator.js';

// One south-to-north pass. BiomeManager bakes every scanned layer at this.
export const TERRAIN_STRIP_WIDTH = 8192;

/** A scanned ridge is not the spectrum equalizer. Full-strength rim on it
 *  reads as neon piping over the real shape. */
export function crestRimAlpha(layerAlpha, terrainStrip) {
  return terrainStrip ? Math.min(layerAlpha, 0.4) : layerAlpha;
}
export const STRIP_SAMPLE_STEP = 4;

/** Ridge samples for one layer, in strip pixels (y down). Alpine gain included. */
export function bakedCrest({
  units, width = TERRAIN_STRIP_WIDTH, height, amplitude, baseline,
  step = STRIP_SAMPLE_STEP,
}) {
  const n = Math.floor(width / step) + 1;
  const heights = resampleHeights(units, n);
  const footY = height * baseline;
  const laid = layoutRidgeYs(heights, {
    height, footY, hanging: false, amplitude: amplitude * ALPINE_AMP_GAIN,
    profile: 'alpine', preserveScale: false,
  });
  return { ridgeYs: laid.ridgeYs, step, width, height, n };
}

/** Pixels of crest above the shared foot, after the draw-height cap. */
export function heightAboveFoot(ridgeYs, stripHeight, drawHeight) {
  const scale = drawHeight / stripHeight;
  const out = new Float64Array(ridgeYs.length);
  for (let i = 0; i < ridgeYs.length; i++) out[i] = (stripHeight - ridgeYs[i]) * scale;
  return out;
}

/** Local summits whose drop to the higher saddle is at least `minProm` px. */
export function prominentPeaks(above, minProm) {
  const peaks = [];
  for (let i = 1; i < above.length - 1; i++) {
    if (above[i] < above[i - 1] || above[i] < above[i + 1]) continue;
    if (above[i] === above[i - 1]) continue;
    let left = above[i];
    let right = above[i];
    for (let j = i - 1; j >= 0; j--) {
      if (above[j] > above[i]) break;
      if (above[j] < left) left = above[j];
    }
    for (let j = i + 1; j < above.length; j++) {
      if (above[j] > above[i]) break;
      if (above[j] < right) right = above[j];
    }
    const prom = above[i] - Math.max(left, right);
    if (prom >= minProm) peaks.push({ i, h: above[i], prom });
  }
  return peaks;
}

/** Relief inside each stage-width window, including a short tail. */
export function viewRelief(above, { step, stripWidth, view }) {
  const windows = [];
  for (let x0 = 0; x0 < stripWidth; x0 += view) {
    const x1 = Math.min(stripWidth, x0 + view);
    const i0 = Math.min(above.length - 1, Math.floor(x0 / step));
    const i1 = Math.min(above.length, Math.ceil(x1 / step));
    let max = -Infinity;
    let min = Infinity;
    for (let i = i0; i < i1; i++) {
      if (above[i] > max) max = above[i];
      if (above[i] < min) min = above[i];
    }
    windows.push({ x0, x1, max, min, relief: max - min, full: x1 - x0 >= view });
  }
  return windows;
}
