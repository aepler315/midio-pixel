import { copySongprint, copySongprintSkyline } from '../../audio/SongprintData.js';
import { clamp01 } from '../../utils/math.js';

export const INLAND_TERRAIN_VERSION = 4;

// The fine noise every region is carved from. One fixed ground for every
// song, like bedrock: it never depends on a recording, so it adds no hash.
export const INLAND_GROUND = 0x6d1d4e5;

// Centre and spread of the outline's first eight cosine coefficients over
// 181 studio, live and demo recordings (Songprint 1 outlines). One fixed
// calibration for every song, so each standardised coefficient spans about
// -2..2 across a library. Within one song's recordings each moves about a
// third as much (c8 about half, so the region does not use it).
const OUTLINE_CAL = Object.freeze({
  mean: [.115, .196, .237, .067, .375, .178, .249, .043],
  spread: [.150, .154, .228, .210, .271, .276, .283, .258],
});
// The angle of (c1, c3) centres on 60 degrees across the same library.
const DIRECTION_CENTRE = 60 * Math.PI / 180;

/** Orthonormal cosine coefficients of the outline, mean removed. A close
 *  outline gives close coefficients, so everything derived from them moves
 *  a little when a different recording of the song moves the outline a
 *  little. A hash of the outline would move everything at once. */
function outlineCoefficients(skyline) {
  const n = skyline.length;
  const mean = skyline.reduce((a, b) => a + b) / n;
  return Array.from({ length: 8 }, (_, j) => {
    const k = j + 1;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += (skyline[i] - mean) * Math.cos(Math.PI * k * (i + .5) / n);
    return Math.sqrt(2 / n) * sum;
  });
}

/** The recording's measured outline lays out the region: its orientation,
 * ridge spacing, relief and character. InlandRegion.js builds the landform
 * from this small, serialisable field. Every value is a continuous function
 * of the outline, with no seed: other recordings of a song, whose outlines
 * lie close together, get a nearly identical landform. */
export function makeInlandTerrain(songprint) {
  const print = copySongprintSkyline(songprint);
  if (!print) return null;

  const { skyline } = print;
  const last = skyline.length - 1;
  let mean = 0, variation = 0;
  for (const [i, height] of skyline.entries()) {
    mean += height / skyline.length;
    if (i) variation += Math.abs(height - skyline[i - 1]) / last;
  }
  const spread = Math.max(...skyline) - Math.min(...skyline);
  const coefficients = outlineCoefficients(skyline);
  const shape = coefficients.map((c, k) => (c - OUTLINE_CAL.mean[k]) / OUTLINE_CAL.spread[k]);
  // The first and third contrasts of the outline turn the region. Over real
  // studio, live and demo recordings their angle spreads across about 150
  // degrees between songs and typically 10 degrees between versions of one
  // song. A larger gain would spread songs further round the compass but
  // turn versions apart as fast. The region is built in its own frame, so a
  // small turn rotates the same land rather than changing it. The quarter
  // turn is one fixed offset for every song: measured over 47 outlines, it
  // keeps both returning summits in view from the opening rail about as
  // often as random turns did (19 of 47 against 20; 15 without it).
  const song = songTimeline(songprint);
  const balance = skyline.reduce((sum, height, i) => sum + height * (2 * i / last - 1), 0) / skyline.length;
  const direction = song?.key
    ? (song.key.tonic + (song.key.major ? 0 : .5)) / 12 * 2 * Math.PI + .6 * balance
    : Math.atan2(coefficients[2], coefficients[0]) - DIRECTION_CENTRE - Math.PI / 2;

  return Object.freeze({
    version: INLAND_TERRAIN_VERSION,
    ground: INLAND_GROUND,
    skyline: Object.freeze(skyline),
    shape: Object.freeze(shape),
    east: Math.cos(direction),
    north: Math.sin(direction),
    spacingM: 11200 - 5800 * clamp01(variation * 3.1),
    reliefM: 880 + 450 * spread + 500 * mean,
    ...(song ? { song } : {}),
  });
}

/** The song in heard time, as terrain lays it out: the measured timeline,
 *  passages and phrase families. Older prints keep the outline-only field. */
function songTimeline(songprint) {
  const print = copySongprint(songprint);
  const t = print?.timeline;
  const freeze = o => Object.freeze(o);
  if (!t) return null;
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
