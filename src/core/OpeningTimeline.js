// The first seconds of every song, on one heard-time clock.
//
//   0.0 s  title card (song, artist) over the one-third-built landscape
//   2.0 s  the card starts to fade and the opening close-up starts to widen
//   2.7 s  card gone
//   ~4.2 s the first place caption fades in
//   5.0 s  the lens is back at the authored framing
//
// The mountains keep building with the music for the whole song
// (LandRise.js). What made the old opening dull was the camera: it held its
// tight close-up until the land reached its settle height
// (LandRiseCamera BUILD_CAMERA.settleRise), which a gradual build takes most
// of twenty seconds to reach. The close-up now also lets go on this clock.
// Everything here is a pure function of song time, so seeking, restarting,
// exports and highlights all agree.

/** The card is fully up for this long... */
export const TITLE_CARD_HOLD_MS = 2000;
/** ...then fades out over this. */
export const TITLE_CARD_FADE_MS = 700;
export const TITLE_CARD_END_MS = TITLE_CARD_HOLD_MS + TITLE_CARD_FADE_MS;

/** The opening close-up starts widening as the card starts to fade... */
export const OPENING_ZOOM_START_MS = TITLE_CARD_HOLD_MS;
/** ...and reaches the authored lens this much later, whatever the land's height. */
export const OPENING_ZOOM_MS = 3000;

const unit = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

/** Title card opacity at song time `songMs`: held, then eased out. */
export function titleCardAlpha(songMs) {
  const t = Number(songMs);
  if (!Number.isFinite(t) || t < 0) return 1;
  if (t <= TITLE_CARD_HOLD_MS) return 1;
  const u = unit((t - TITLE_CARD_HOLD_MS) / TITLE_CARD_FADE_MS);
  return 1 - u * u * (3 - 2 * u);
}

/** 0..1 release of the opening close-up at song time `songMs` (eased in and
 *  out): 0 keeps the land-rise lens, 1 is the authored one. An unknown time
 *  releases nothing, so callers without a clock keep the rise-only framing. */
export function openingZoomRelease01(songMs) {
  const t = Number(songMs);
  if (!Number.isFinite(t)) return 0;
  const u = unit((t - OPENING_ZOOM_START_MS) / OPENING_ZOOM_MS);
  return u * u * (3 - 2 * u);
}
