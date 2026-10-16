// The skyline of the far terrain as drawn, read back from its partition's
// alpha at a small size: one height per column, as a fraction of the frame
// (0 top, 1 bottom). Sky that the aurora echoes should rhyme with the land
// actually on screen, deformation, glacier and all, not with a profile the
// renderer may have moved.

/** Alpha at or above this counts as land; sun shafts in open sky are fainter. */
const LAND_ALPHA = 128;

/** Topmost land row per column from RGBA `data` (w x h), as a fraction of
 *  the height; NaN where a column holds no land. */
export function skylineFromAlpha(data, w, h, threshold = LAND_ALPHA) {
  const ys = new Float32Array(w).fill(NaN);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (data[(y * w + x) * 4 + 3] >= threshold) { ys[x] = y / h; break; }
    }
  }
  return ys;
}

/** A soft version of the skyline: gaps are bridged linearly between the
 *  land on either side (held flat past the last land; the frame's foot if
 *  there is none at all), then a box blur `radius` columns wide keeps the
 *  massif's broad shape and drops its teeth. */
export function smoothSkyline(ys, radius) {
  const n = ys.length;
  const filled = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(ys[i])) { filled[i] = ys[i]; continue; }
    let l = i - 1, r = i + 1;
    while (l >= 0 && Number.isNaN(ys[l])) l--;
    while (r < n && Number.isNaN(ys[r])) r++;
    if (l < 0 && r >= n) filled[i] = 1;
    else if (l < 0) filled[i] = ys[r];
    else if (r >= n) filled[i] = ys[l];
    else filled[i] = ys[l] + (ys[r] - ys[l]) * ((i - l) / (r - l));
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) { sum += filled[j]; count++; }
    out[i] = sum / count;
  }
  return out;
}

/** Canvas-space y of a smoothed skyline at canvas x (linear between columns). */
export function skylineYAt(ys, canvas, x) {
  const n = ys.length;
  const u = Math.min(n - 1, Math.max(0, (x / canvas.width) * n - 0.5));
  const i = Math.floor(u), f = u - i;
  const y = i + 1 < n ? ys[i] + (ys[i + 1] - ys[i]) * f : ys[i];
  return y * canvas.height;
}
