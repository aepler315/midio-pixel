import { copySongprintSkyline } from '../../audio/SongprintData.js';
import { clamp01 } from '../../utils/math.js';

export const INLAND_TERRAIN_VERSION = 3;

/** The recording's measured outline lays out the region: its orientation,
 * ridge spacing and relief, plus a stable seed. InlandRegion.js builds the
 * landform from this small, serialisable field. */
export function makeInlandTerrain(seed, songprint) {
  const print = copySongprintSkyline(songprint);
  if (!print) return null;

  const { skyline } = print;
  const last = skyline.length - 1;
  let mean = 0, variation = 0, balance = 0;
  for (const [i, height] of skyline.entries()) {
    mean += height / skyline.length;
    balance += height * (2 * i / last - 1) / skyline.length;
    if (i) variation += Math.abs(height - skyline[i - 1]) / last;
  }
  const spread = Math.max(...skyline) - Math.min(...skyline);
  // The outline's balance turns the region; the seed spreads songs around
  // the compass so different recordings do not share one orientation.
  const turn = ((seed >>> 0) % 3600) / 3600 * 2 * Math.PI;
  const direction = turn + 2.8 * balance + .72 * (skyline[last] - skyline[0]);

  return Object.freeze({
    version: INLAND_TERRAIN_VERSION,
    seed: seed >>> 0,
    skyline: Object.freeze(skyline),
    east: Math.cos(direction),
    north: Math.sin(direction),
    spacingM: 11200 - 5800 * clamp01(variation * 3.1),
    reliefM: 880 + 450 * spread + 500 * mean,
  });
}
