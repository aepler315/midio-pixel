import { copySongprint, copySongprintSkyline } from '../../audio/SongprintData.js';
import { clamp01 } from '../../utils/math.js';

export const INLAND_TERRAIN_VERSION = 4;

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
  const song = songTimeline(songprint, skyline);
  // The key turns the region, so takes of one song share a compass; the
  // seed only spreads songs without a measured key.
  const turn = song.key ? (song.key.tonic + (song.key.major ? 0 : .5)) / 12 * 2 * Math.PI
    : ((seed >>> 0) % 3600) / 3600 * 2 * Math.PI;
  const direction = turn + .6 * balance;

  return Object.freeze({
    version: INLAND_TERRAIN_VERSION,
    seed: seed >>> 0,
    skyline: Object.freeze(skyline),
    east: Math.cos(direction),
    north: Math.sin(direction),
    spacingM: 11200 - 5800 * clamp01(variation * 3.1),
    reliefM: 880 + 450 * spread + 500 * mean,
    song,
  });
}

/** The song in heard time, as terrain lays it out: the measured timeline,
 *  passages and phrase families. Prints without a timeline get a gentle
 *  stand-in drawn from the outline so the region still builds. */
function songTimeline(songprint, skyline) {
  const print = copySongprint(songprint);
  const t = print?.timeline;
  const freeze = o => Object.freeze(o);
  if (t) {
    const n = t.loudness.length, durationMs = n * t.stepMs;
    return freeze({
      measured: true, stepMs: t.stepMs, durationMs, key: freeze({ ...t.key }), dynamics: t.dynamics,
      loudness: freeze(t.loudness), tension: freeze(t.tension), novelty: freeze(t.novelty),
      brightness: freeze(t.brightness), major: freeze(t.major),
      passages: freeze(print.passages.map(p => freeze([p.timeMs, p.landmark01, p.strength]))),
      families: freeze((print.phraseFamilies?.families ?? []).map(f => freeze({
        landmark01: f.landmark01, times: freeze(f.occurrences.map(o => o.timeMs)) }))),
    });
  }
  const n = 90, stepMs = 2000;
  const at = i => skyline[Math.min(skyline.length - 1, Math.floor(i / n * skyline.length))];
  const series = f => freeze(Array.from({ length: n }, (_, i) => f(i)));
  return freeze({
    measured: false, stepMs, durationMs: n * stepMs, key: null, dynamics: .5,
    loudness: series(at), tension: series(i => .3 + .4 * at(n - 1 - i)), novelty: series(i => i % 22 === 0 && i ? .8 : .1),
    brightness: series(() => .5), major: series(() => .5), passages: freeze([]), families: freeze([]),
  });
}
