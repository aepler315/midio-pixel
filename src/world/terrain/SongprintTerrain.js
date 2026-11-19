// Comparisons use measured terrain outlines in the same west-to-east order
// as the song. Distances stay continuous as a performance's sound changes.
import { hashSeed } from '../../utils/math.js';
import { copySongprintSkyline } from '../../audio/SongprintData.js';
import { viewSkylines } from './songprintSkylines.js';

export function songprintOutline(songprint) {
  const skyline = copySongprintSkyline(songprint)?.skyline;
  if (!skyline) return null;
  const min = Math.min(...skyline), span = Math.max(...skyline) - min;
  return span > 0 ? skyline.map(n => (n - min) / span) : null;
}

export function measuredViewOutline(view) {
  const scan = viewSkylines[view.id];
  return scan?.terrain === view.terrainManifestSha256 && scan?.camera === hashSeed(JSON.stringify(view.camera))
    ? scan.outline : null;
}

function heightAt(outline, position) {
  const x = Math.max(0, Math.min(1, position)) * (outline.length - 1);
  const lo = Math.floor(x), hi = Math.min(outline.length - 1, lo + 1);
  return outline[lo] + (x - lo) * (outline[hi] - outline[lo]);
}

/** Mean musical height across one footprint. Sample throughout the slot so
 * a narrow musical peak changes the summit's relief in proportion to its width. */
export function songprintReliefScale(skyline, left, right) {
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += heightAt(skyline, left + (right - left) * (i + .5) / 8);
  return Math.round((.92 + .16 * sum / 8) * 10000) / 10000;
}

/** Mean squared height error against a 16-bin DEM outline, optionally
 * across only the part of the song occupied by a stage slot. */
export function outlineDistance(song, terrain, { left = 0, right = 1, mirrored = false } = {}) {
  let sum = 0;
  const last = song.length - 1;
  for (let i = 0; i <= last; i++) {
    const height = heightAt(song, left + (right - left) * i / last);
    const error = height - terrain[mirrored ? last - i : i] / 255;
    sum += error * error;
  }
  return sum / song.length;
}
