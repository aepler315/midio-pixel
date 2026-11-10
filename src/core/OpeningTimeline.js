// The first seconds of every song, on one heard-time clock.
//
//   0.0 s  title card (song, artist) over the not-yet-risen landscape
//   1.8 s  the range surges up from flat ground to most of its relief
//   2.0 s  the card starts to fade, revealing the surge already underway
//   2.7 s  card gone; the land is already past half its relief
//   4.0 s  surge complete; the rest of the climb follows the music
//   ~4.2 s the first place caption fades in
//
// The flat, featureless opening (fog over level ground through a tight lens)
// used to last most of a song's first twenty seconds. It now lives almost
// entirely under the title card. Everything here is a pure function of song
// time, so seeking, restarting, exports and highlights all agree.

/** The card is fully up for this long... */
export const TITLE_CARD_HOLD_MS = 2000;
/** ...then fades out over this. */
export const TITLE_CARD_FADE_MS = 700;
export const TITLE_CARD_END_MS = TITLE_CARD_HOLD_MS + TITLE_CARD_FADE_MS;

/** The opening surge starts just before the card fades, so the reveal shows
 *  land already rising rather than the flat ground beneath it. */
export const RISE_SURGE_START_MS = 1800;
export const RISE_SURGE_MS = 2200;
/** Relief share the surge alone reaches. Matches the camera's settle point
 *  (LandRiseCamera BUILD_CAMERA.settleRise), so the tight opening lens has
 *  widened to the authored lens by the time the surge completes. */
export const RISE_SURGE_RELIEF = 0.7;

const unit = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

/** Title card opacity at song time `songMs`: held, then eased out. */
export function titleCardAlpha(songMs) {
  const t = Number(songMs);
  if (!Number.isFinite(t) || t < 0) return 1;
  if (t <= TITLE_CARD_HOLD_MS) return 1;
  const u = unit((t - TITLE_CARD_HOLD_MS) / TITLE_CARD_FADE_MS);
  return 1 - u * u * (3 - 2 * u);
}

/** 0..1 progress of the opening surge at song time `songMs` (ease-out: the
 *  land leaps up, then settles). */
export function riseSurge01(songMs) {
  const u = unit((Number(songMs) - RISE_SURGE_START_MS) / RISE_SURGE_MS);
  return 1 - (1 - u) ** 3;
}
